// In-app notifications: every SMS-worthy event also lands in the user's inbox, so the web and mobile
// apps have a bell to show, and nothing is lost when SMS is sandboxed or undelivered.
import { requireUser } from './auth.js';
import { smsFor } from './adapters/sms.js';

/** Store a notification and, when `sms` is true, also text it. Never throws: notifications must not break the main action. */
export async function notify(db, userId, text, { link = null, sms = false } = {}) {
  try {
    await db.run('INSERT INTO notifications (id, user_id, text, link, created_at) VALUES (?,?,?,?,?)', db.uuid(), userId, text, link, Date.now());
    if (sms) { const u = await db.get('SELECT phone_e164 FROM users WHERE id = ?', userId); if (u?.phone_e164) smsFor(u.phone_e164).send(u.phone_e164, text).catch(() => {}); }
  } catch (e) { /* logged by the caller's request log; the inbox is best-effort */ }
}

export function registerNotificationRoutes(r, db) {
  r.get('/notifications', async ctx => {
    const u = requireUser(ctx);
    const items = await db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', u.id);
    return { unread: items.filter(n => !n.read_at).length, items: items.map(n => ({ id: n.id, text: n.text, link: n.link, read: !!n.read_at, created_at: new Date(Number(n.created_at)).toISOString() })) };
  });
  r.post('/notifications/read', async ctx => {
    const u = requireUser(ctx);
    const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids.map(String) : null;
    if (ids) { for (const id of ids) await db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL', Date.now(), id, u.id); }
    else await db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', Date.now(), u.id);
    return { ok: true };
  });
}
