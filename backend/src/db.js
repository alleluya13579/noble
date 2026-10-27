// Database layer with two backends behind one async interface:
//   - SQLite (node:sqlite, zero dependencies) when DATABASE_PATH is a file path or ':memory:'
//   - PostgreSQL (the `pg` driver) when DATABASE_URL / DATABASE_PATH is a postgres:// URL
// Application SQL is written once, in the SQLite dialect with `?` placeholders; the Postgres
// backend rewrites placeholders to $n and `INSERT OR IGNORE` to `ON CONFLICT DO NOTHING`.
//
// Interface: run(sql, ...params) -> {changes}, get(sql, ...params) -> row|null, all(sql, ...params) -> rows,
//            tx(async fn) (statements inside fn run in one transaction), uuid(), country(code), audit(...), allow(...), close()
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const isPostgres = target => /^postgres(ql)?:\/\//i.test(target);

export async function openDatabase(target = ':memory:') {
  const core = isPostgres(target) ? await openPostgres(target) : await openSqlite(target);
  return withHelpers(core);
}

/* ---------- SQLite ---------- */
async function openSqlite(file) {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec(fs.readFileSync(path.join(here, '..', 'schema.sqlite.sql'), 'utf8'));
  let depth = 0;
  return {
    dialect: 'sqlite',
    async run(sql, ...p) { const r = raw.prepare(sql).run(...p); return { changes: Number(r.changes) }; },
    async get(sql, ...p) { return raw.prepare(sql).get(...p) ?? null; },
    async all(sql, ...p) { return raw.prepare(sql).all(...p); },
    async tx(fn) { if (depth++) { try { return await fn(); } finally { depth--; } } raw.exec('BEGIN'); try { const r = await fn(); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; } finally { depth--; } },
    async close() { raw.close(); }
  };
}

/* ---------- PostgreSQL ---------- */
async function openPostgres(url) {
  let pg; try { pg = (await import('pg')).default; } catch { throw new Error('PostgreSQL selected but the `pg` driver is not installed: run `npm install pg` in backend/'); }
  pg.types.setTypeParser(20, v => Number(v));      // int8 -> number (epoch ms, counts, money in minor units)
  pg.types.setTypeParser(1700, v => parseFloat(v)); // numeric (AVG) -> number
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  await pool.query(fs.readFileSync(path.join(here, '..', 'schema.sql'), 'utf8'));
  const als = new AsyncLocalStorage();
  const translate = sql => {
    let i = 0; let s = sql.replace(/\?/g, () => '$' + (++i));
    if (/^\s*INSERT OR IGNORE INTO/i.test(s)) s = s.replace(/^\s*INSERT OR IGNORE INTO/i, 'INSERT INTO') + ' ON CONFLICT DO NOTHING';
    return s;
  };
  const q = (sql, p) => (als.getStore() || pool).query(translate(sql), p);
  return {
    dialect: 'postgres',
    async run(sql, ...p) { const r = await q(sql, p); return { changes: r.rowCount ?? 0 }; },
    async get(sql, ...p) { const r = await q(sql, p); return r.rows[0] ?? null; },
    async all(sql, ...p) { return (await q(sql, p)).rows; },
    async tx(fn) {
      if (als.getStore()) return fn();
      const client = await pool.connect();
      try { await client.query('BEGIN'); const r = await als.run(client, fn); await client.query('COMMIT'); return r; }
      catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }
    },
    async close() { await pool.end(); }
  };
}

/* ---------- Shared helpers ---------- */
function withHelpers(db) {
  db.uuid = () => crypto.randomUUID();
  db.now = () => Date.now();
  db.country = async code => {
    const c = await db.get('SELECT * FROM countries WHERE code = ?', code);
    if (!c) return null;
    return { ...c, id_document_types: JSON.parse(c.id_document_types), payment_methods: JSON.parse(c.payment_methods),
      policy: { depositPctSale: c.deposit_pct_sale, rentDepositMonths: c.rent_deposit_months, viewingDays: c.viewing_days, handoverDays: c.handover_days, commissionPct: c.commission_pct } };
  };
  db.audit = (actorId, action, targetType, targetId, detail = {}, ip) =>
    db.run('INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, ip_hash, created_at) VALUES (?,?,?,?,?,?,?)',
      actorId, action, targetType, String(targetId), JSON.stringify(detail), ip ? crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32) : null, Date.now());
  /** Fixed-window rate limit. Resolves true when allowed. */
  db.allow = async (userKey, bucket, limit, windowMs) => {
    const ws = Math.floor(Date.now() / windowMs) * windowMs;
    const row = await db.get('SELECT count FROM rate_limits WHERE user_key = ? AND bucket = ? AND window_start = ?', userKey, bucket, ws);
    if (row && row.count >= limit) return false;
    await db.run('INSERT INTO rate_limits (user_key, bucket, window_start, count) VALUES (?,?,?,1) ON CONFLICT(user_key, bucket, window_start) DO UPDATE SET count = rate_limits.count + 1', userKey, bucket, ws);
    return true;
  };
  /** True when an error is a unique-constraint violation on either backend. */
  db.isUnique = e => /UNIQUE|duplicate key/i.test(e.message || '');
  return db;
}
