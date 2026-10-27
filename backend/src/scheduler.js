// Scheduler: applies system transitions when deadlines pass (auto-refund, expired collections),
// expires stale offers and viewing proposals, and prunes expired sessions and OTP codes.
// Runs every minute inside the API process. With PostgreSQL, instances compete for an advisory
// lock so exactly one of them runs it; with SQLite there is one process anyway.
import * as E from './escrow.js';
import { applyTransition } from './transactions.js';

export async function runOnce(db, now = Date.now(), logger = console) {
  const rows = await db.all("SELECT id, data FROM transactions WHERE state IN ('held','viewing_confirmed','payment_pending','initiated')");
  let applied = 0;
  for (const row of rows) {
    const txn = JSON.parse(row.data);
    const due = E.dueSystemTransition(txn, now);
    if (!due) continue;
    try { await applyTransition(db, row.id, due, { actor: E.ACTORS.SYSTEM, now, note: 'scheduler' }); applied++; }
    catch (e) { logger.error(`scheduler: ${due} on ${txn.reference} failed: ${e.message}`); }
  }
  const expired = (await db.run("UPDATE messages SET decision = 'expired' WHERE decision = 'pending' AND ((kind = 'offer' AND created_at < ?) OR (kind = 'viewing' AND viewing_at < ?))", now - 7 * 86400e3, now)).changes;
  await db.run('DELETE FROM sessions WHERE expires_at < ?', now);
  await db.run('DELETE FROM otp_codes WHERE expires_at < ?', now);
  await db.run('DELETE FROM rate_limits WHERE window_start < ?', now - 2 * 86400e3);
  return { applied, expired };
}

export function startScheduler(db, intervalMs = 60e3, logger = console) {
  let leader = false;
  const tick = async () => {
    if (!leader) leader = await db.tryLock('noble-scheduler');
    if (!leader) return;
    await runOnce(db, Date.now(), logger);
  };
  const timer = setInterval(() => tick().catch(e => logger.error('scheduler', e)), intervalMs);
  timer.unref();
  return () => { clearInterval(timer); if (leader) db.unlock('noble-scheduler').catch(() => {}); };
}
