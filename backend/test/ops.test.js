// Operational safety: production guard, image sniffing, migrations, rate limiter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productionProblems } from '../src/config.js';
import { sniffImage } from '../src/listings.js';
import { memoryLimiter } from '../src/http.js';
import { openDatabase } from '../src/db.js';

test('production guard lists every development default that must change', () => {
  const problems = productionProblems({ isDev: false, sessionSecret: 'dev-session-secret', idHashSecret: 'short', baseUrl: 'http://localhost:8080', corsOrigins: ['*'], adminPhones: [], storage: { s3: { configured: false } } });
  for (const key of ['SESSION_SECRET', 'ID_HASH_SECRET', 'DOCS_ENCRYPTION_KEY', 'PUBLIC_BASE_URL', 'CORS_ORIGINS', 'ADMIN_PHONES']) assert.ok(problems.some(p => p.includes(key)), key);
  assert.deepEqual(productionProblems({ isDev: true }), [], 'development is never blocked');
});

test('image sniffing accepts real image headers and rejects everything else', () => {
  assert.equal(sniffImage(Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(16)])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(8)])), 'image/png');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0')), 'image/heic');
  assert.equal(sniffImage(Buffer.from('<?php echo 1; ?>')), null);
  assert.equal(sniffImage(Buffer.from('GIF89a......')), null, 'GIF is not accepted');
});

test('memory limiter allows up to the limit per window and blocks after', () => {
  const allow = memoryLimiter({ limit: 3, windowMs: 60e3 });
  assert.deepEqual([allow('a'), allow('a'), allow('a'), allow('a'), allow('b')], [true, true, true, false, true]);
});

test('migrations run once and are recorded', async () => {
  const db = await openDatabase(':memory:');
  const rows = await db.all('SELECT name FROM schema_migrations ORDER BY name');
  assert.deepEqual(rows.map(r => r.name), ['001_notifications']);
  assert.ok(await db.get("SELECT 1 FROM sqlite_master WHERE name = 'notifications'"));
  const { migrate } = await import('../src/db.js');
  assert.deepEqual(await migrate(db), [], 'second run applies nothing');
  await db.close();
});
