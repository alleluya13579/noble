// Scheduler: applies system transitions when deadlines pass (auto-refund, expired collections) and
// expires stale offers and viewing proposals. Runs every minute inside the API process; in a
// multi-instance deployment run it in exactly one worker (or move it to a cron job calling runOnce).
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
  return { applied, expired };
}

export function startScheduler(db, intervalMs = 60e3, logger = console) {
  const timer = setInterval(() => runOnce(db, Date.now(), logger).catch(e => logger.error('scheduler', e)), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
