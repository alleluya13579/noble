// Moderation console: listing queue with document checklist, reports, disputes, accounts, audit, integrations.
import { bad, notFound, conflict, HttpError } from './http.js';
import { requireRole, publicUser } from './auth.js';
import { listingView } from './listings.js';
import { loadTxn, txnView, applyTransition } from './transactions.js';
import { integrationStatus } from './config.js';
import { notify } from './notifications.js';
import * as E from './escrow.js';

const admin = requireRole('admin');
export const REQUIRED_CHECKS = { rent: ['lease_names_lister'], sale: ['name_matches', 'parcel_matches', 'search_recent'], land: ['name_matches', 'parcel_matches', 'search_recent'] };
const incomplete = (msg, extra) => new HttpError(422, 'checks_incomplete', msg, extra);

export function registerAdminRoutes(r, db) {
  r.get('/admin/integrations', ctx => { admin(ctx); return integrationStatus(); });

  r.get('/admin/listings', async ctx => {
    const u = admin(ctx), status = ctx.query.status || 'pending';
    const rows = await db.all('SELECT * FROM listings WHERE status = ? ORDER BY created_at', status);
    return Promise.all(rows.map(async l => {
      const v = await listingView(db, l, u);
      const dupes = (await db.all('SELECT DISTINCT p2.listing_id FROM listing_photos p1 JOIN listing_photos p2 ON p1.content_hash = p2.content_hash AND p2.listing_id <> p1.listing_id WHERE p1.listing_id = ?', l.id)).map(x => x.listing_id);
      return { ...v, required_checks: REQUIRED_CHECKS[l.type], duplicate_photo_listings: dupes, owner_verified: v.owner.verified };
    }));
  });

  r.post('/admin/listings/:id/review', async ctx => {
    const u = admin(ctx), l = await db.get('SELECT * FROM listings WHERE id = ?', ctx.params.id); if (!l) throw notFound('listing not found');
    if (l.status !== 'pending') throw conflict('listing is not pending');
    const owner = await db.get('SELECT * FROM users WHERE id = ?', l.owner_id);
    if (ctx.body.decision === 'approve') {
      const docs = await db.all('SELECT * FROM ownership_documents WHERE listing_id = ?', l.id);
      if (l.type !== 'rent' && !docs.length) throw incomplete('sale and land listings need an ownership document');
      if (!(owner.kyc_status === 'verified' && owner.phone_verified_at)) throw conflict('lister is not verified');
      const checks = ctx.body.checks || {}, missing = REQUIRED_CHECKS[l.type].filter(k => checks[k] !== true);
      if (missing.length) throw incomplete(`complete every check: ${missing.join(', ')}`, { missing });
      await db.tx(async () => {
        await db.run("UPDATE listings SET status = 'approved', reviewed_by = ?, reviewed_at = ?, created_at = ? WHERE id = ?", u.id, Date.now(), Date.now(), l.id);
        for (const d of docs) await db.run('UPDATE ownership_documents SET checks = ?, checked_by = ?, checked_at = ? WHERE id = ?', JSON.stringify(checks), u.id, Date.now(), d.id);
      });
      await db.audit(u.id, 'listing_approved', 'listing', l.id, { checks }, ctx.ip);
      await notify(db, l.owner_id, `“${l.title}” was approved and is now live.`, { link: '#' + l.id, sms: true });
    } else if (ctx.body.decision === 'reject') {
      const reason = String(ctx.body.reject_reason || '').trim(); if (reason.length < 5) throw bad('reject_reason is required');
      await db.run("UPDATE listings SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", reason, u.id, Date.now(), l.id);
      await db.audit(u.id, 'listing_rejected', 'listing', l.id, { reason }, ctx.ip);
      await notify(db, l.owner_id, `“${l.title}” was not approved: ${reason}. Fix it and relist.`, { link: '#sell', sms: true });
    } else throw bad('decision must be approve or reject');
    return listingView(db, await db.get('SELECT * FROM listings WHERE id = ?', l.id), u);
  });

  r.get('/admin/reports', async ctx => { admin(ctx); return db.all('SELECT r.*, l.title listing_title, u.full_name reporter_name FROM reports r LEFT JOIN listings l ON l.id = r.listing_id JOIN users u ON u.id = r.reporter_id WHERE r.status = ? ORDER BY r.created_at', ctx.query.status || 'open'); });
  r.post('/admin/reports/:id/resolve', async ctx => {
    const u = admin(ctx), rep = await db.get('SELECT * FROM reports WHERE id = ?', ctx.params.id); if (!rep) throw notFound('report not found');
    const a = ctx.body.action; if (!['dismiss', 'take_down'].includes(a)) throw bad('action must be dismiss or take_down');
    await db.tx(async () => {
      await db.run('UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?', a === 'dismiss' ? 'dismissed' : 'actioned', u.id, Date.now(), rep.id);
      if (a === 'take_down' && rep.listing_id) await db.run("UPDATE listings SET status = 'removed' WHERE id = ?", rep.listing_id);
    });
    await db.audit(u.id, a === 'dismiss' ? 'report_dismissed' : 'listing_taken_down', 'report', rep.id, { listing: rep.listing_id }, ctx.ip);
    if (a === 'take_down' && rep.listing_id) { const l = await db.get('SELECT owner_id, title FROM listings WHERE id = ?', rep.listing_id); if (l) await notify(db, l.owner_id, `“${l.title}” was taken down after a report. Contact support if you think this is wrong.`, { sms: true }); await notify(db, rep.reporter_id, 'Thanks for your report. The listing has been taken down.'); }
    return { ok: true };
  });

  r.get('/admin/transactions', async ctx => { const u = admin(ctx); const rows = await db.all('SELECT * FROM transactions WHERE state = ? ORDER BY updated_at', ctx.query.state || 'disputed'); return Promise.all(rows.map(row => txnView(db, row, JSON.parse(row.data), u))); });
  r.post('/admin/transactions/:id/resolve', async ctx => {
    const u = admin(ctx), name = ctx.body.transition;
    if (!['release', 'admin_refund'].includes(name)) throw bad('transition must be release or admin_refund');
    await applyTransition(db, ctx.params.id, name, { actor: E.ACTORS.ADMIN, actorId: u.id, now: Date.now(), note: ctx.body.note });
    const { row, txn } = await loadTxn(db, ctx.params.id); return txnView(db, row, txn, u);
  });

  r.get('/admin/users', async ctx => { admin(ctx); const rows = await db.all('SELECT * FROM users ORDER BY created_at DESC LIMIT 500'); return Promise.all(rows.map(async x => ({ ...(await publicUser(db, x)), phone_e164: x.phone_e164, listings: (await db.get('SELECT COUNT(*) n FROM listings WHERE owner_id = ?', x.id)).n }))); });
  r.post('/admin/users/:id/suspend', async ctx => {
    const u = admin(ctx), x = await db.get('SELECT * FROM users WHERE id = ?', ctx.params.id); if (!x) throw notFound('user not found');
    if (x.role === 'admin') throw bad('admins are managed out of band');
    const on = ctx.body.suspended !== false;
    await db.run('UPDATE users SET suspended_at = ?, suspended_reason = ? WHERE id = ?', on ? Date.now() : null, on ? String(ctx.body.reason || 'policy') : null, x.id);
    if (on) await db.run('DELETE FROM sessions WHERE user_id = ?', x.id);
    await db.audit(u.id, on ? 'user_suspended' : 'user_reinstated', 'user', x.id, { reason: ctx.body.reason }, ctx.ip);
    return publicUser(db, await db.get('SELECT * FROM users WHERE id = ?', x.id));
  });

  r.get('/admin/audit', async ctx => {
    admin(ctx); const off = +(ctx.query.cursor || 0);
    const rows = ctx.query.target_id ? await db.all('SELECT * FROM audit_log WHERE target_id = ? ORDER BY id DESC LIMIT 100 OFFSET ?', ctx.query.target_id, off) : await db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100 OFFSET ?', off);
    return { items: rows.map(a => ({ ...a, detail: JSON.parse(a.detail), created_at: new Date(Number(a.created_at)).toISOString() })), next_cursor: rows.length === 100 ? String(off + 100) : null };
  });
}
