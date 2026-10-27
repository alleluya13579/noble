// Database layer over node:sqlite. Small helpers; SQL stays in the services.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function openDatabase(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec(fs.readFileSync(path.join(here, '..', 'schema.sqlite.sql'), 'utf8'));
  const db = {
    raw,
    run: (sql, ...p) => raw.prepare(sql).run(...p),
    get: (sql, ...p) => raw.prepare(sql).get(...p) ?? null,
    all: (sql, ...p) => raw.prepare(sql).all(...p),
    tx(fn) { raw.exec('BEGIN'); try { const r = fn(); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; } },
    uuid: () => crypto.randomUUID(),
    now: () => Date.now(),
    country(code) {
      const c = raw.prepare('SELECT * FROM countries WHERE code = ?').get(code);
      if (!c) return null;
      return { ...c, id_document_types: JSON.parse(c.id_document_types), payment_methods: JSON.parse(c.payment_methods),
        policy: { depositPctSale: c.deposit_pct_sale, rentDepositMonths: c.rent_deposit_months, viewingDays: c.viewing_days, handoverDays: c.handover_days, commissionPct: c.commission_pct } };
    },
    audit(actorId, action, targetType, targetId, detail = {}, ip) {
      raw.prepare('INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, ip_hash, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(actorId, action, targetType, String(targetId), JSON.stringify(detail), ip ? crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32) : null, Date.now());
    },
    /** Fixed-window rate limit. Returns true when allowed. */
    allow(userKey, bucket, limit, windowMs) {
      const ws = Math.floor(Date.now() / windowMs) * windowMs;
      const row = raw.prepare('SELECT count FROM rate_limits WHERE user_key = ? AND bucket = ? AND window_start = ?').get(userKey, bucket, ws);
      if (row && row.count >= limit) return false;
      raw.prepare('INSERT INTO rate_limits (user_key, bucket, window_start, count) VALUES (?,?,?,1) ON CONFLICT(user_key, bucket, window_start) DO UPDATE SET count = count + 1').run(userKey, bucket, ws);
      return true;
    }
  };
  return db;
}
