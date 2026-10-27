// Moderation console: listing queue with document checklist, reports, disputes, accounts, audit, integrations.
import { bad, notFound, conflict } from './http.js';
import { requireRole, publicUser } from './auth.js';
import { listingView } from './listings.js';
import { loadTxn, txnView, applyTransition } from './transactions.js';
import { integrationStatus } from './config.js';
import * as E from './escrow.js';

const admin = requireRole('admin');
export const REQUIRED_CHECKS = { rent: ['lease_names_lister'], sale: ['name_matches', 'parcel_matches', 'search_recent'], land: ['name_matches', 'parcel_matches', 'search_recent'] };

export function registerAdminRoutes(r, db) {
  r.get('/admin/integrations', ctx => { admin(ctx); return integrationStatus(); });

  r.get('/admin/listings', ctx => {
    const u = admin(ctx), status = ctx.query.status || 'pending';
    return db.all('SELECT * FROM listings WHERE status = ? ORDER BY created_at', status).map(l => {
      const v = listingView(db, l, u);
      const dupes = db.all('SELECT DISTINCT p2.listing_id FROM listing_photos p1 JOIN listing_photos p2 ON p1.content_hash = p2.content_hash AND p2.listing_id <> p1.listing_id WHERE p1.listing_id = ?', l.id).map(x => x.listing_id);
      return { ...v, required_checks: REQUIRED_CHECKS[l.type], duplicate_photo_listings: dupes, owner_verified: v.owner.verified };
    });
  });

  r.post('/admin/listings/:id/review', ctx => {
    const u = admin(ctx), l = db.get('SELECT * FROM listings WHERE id = ?', ctx.params.id); if (!l) throw notFound('listing not found');
    if (l.status !== 'pending') throw conflict('listing is not pending');
    const owner = db.get('SELECT * FROM users WHERE id = ?', l.owner_id);
    if (ctx.body.decision === 'approve') {
      const docs = db.all('SELECT * FROM ownership_documents WHERE listing_id = ?', l.id);
      if (l.type !== 'rent' && !docs.length) throw new (class extends Error { constructor() { super('sale and land listings need an ownership document'); this.status = 422; this.code = 'checks_incomplete'; } })();
      if (!(owner.kyc_status === 'verified' && owner.phone_verified_at)) throw conflict('lister is not verified');
      const checks = ctx.body.checks || {}, missing = REQUIRED_CHECKS[l.type].filter(k => checks[k] !== true);
      if (missing.length) { const e = new Error(`complete every check: ${missing.join(', ')}`); e.status = 422; e.code = 'checks_incomplete'; e.extra = { missing }; throw e; }
      db.tx(() => {
        db.run("UPDATE listings SET status = 'approved', reviewed_by = ?, reviewed_at = ?, created_at = ? WHERE id = ?", u.id, Date.now(), Date.now(), l.id);
        for (const d of docs) db.run('UPDATE ownership_documents SET checks = ?, checked_by = ?, checked_at = ? WHERE id = ?', JSON.stringify(checks), u.id, Date.now(), d.id);
      });
      db.audit(u.id, 'listing_approved', 'listing', l.id, { checks }, ctx.ip);
    } else if (ctx.body.decision === 'reject') {
      const reason = String(ctx.body.reject_reason || '').trim(); if (reason.length < 5) throw bad('reject_reason is required');
      db.run("UPDATE listings SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", reason, u.id, Date.now(), l.id);
      db.audit(u.id, 'listing_rejected', 'listing', l.id, { reason }, ctx.ip);
    } else throw bad('decision must be approve or reject');
    return listingView(db, db.get('SELECT * FROM listings WHERE id = ?', l.id), u);
  });

  r.get('/admin/reports', ctx => { admin(ctx); return db.all("SELECT r.*, l.title listing_title, u.full_name reporter_name FROM reports r LEFT JOIN listings l ON l.id = r.listing_id JOIN users u ON u.id = r.reporter_id WHERE r.status = ? ORDER BY r.created_at", ctx.query.status || 'open'); });
  r.post('/admin/reports/:id/resolve', ctx => {
    const u = admin(ctx), rep = db.get('SELECT * FROM reports WHERE id = ?', ctx.params.id); if (!rep) throw notFound('report not found');
    const a = ctx.body.action; if (!['dismiss', 'take_down'].includes(a)) throw bad('action must be dismiss or take_down');
    db.tx(() => {
      db.run('UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?', a === 'dismiss' ? 'dismissed' : 'actioned', u.id, Date.now(), rep.id);
      if (a === 'take_down' && rep.listing_id) db.run("UPDATE listings SET status = 'removed' WHERE id = ?", rep.listing_id);
    });
    db.audit(u.id, a === 'dismiss' ? 'report_dismissed' : 'listing_taken_down', 'report', rep.id, { listing: rep.listing_id }, ctx.ip);
    return { ok: true };
  });

  r.get('/admin/transactions', ctx => { const u = admin(ctx); return db.all('SELECT * FROM transactions WHERE state = ? ORDER BY updated_at', ctx.query.state || 'disputed').map(row => txnView(db, row, JSON.parse(row.data), u)); });
  r.post('/admin/transactions/:id/resolve', async ctx => {
    const u = admin(ctx), name = ctx.body.transition;
    if (!['release', 'admin_refund'].includes(name)) throw bad('transition must be release or admin_refund');
    await applyTransition(db, ctx.params.id, name, { actor: E.ACTORS.ADMIN, actorId: u.id, now: Date.now(), note: ctx.body.note });
    const { row, txn } = loadTxn(db, ctx.params.id); return txnView(db, row, txn, u);
  });

  r.get('/admin/users', ctx => { admin(ctx); return db.all('SELECT * FROM users ORDER BY created_at DESC LIMIT 500').map(x => ({ ...publicUser(db, x), phone_e164: x.phone_e164, listings: db.get('SELECT COUNT(*) n FROM listings WHERE owner_id = ?', x.id).n })); });
  r.post('/admin/users/:id/suspend', ctx => {
    const u = admin(ctx), x = db.get('SELECT * FROM users WHERE id = ?', ctx.params.id); if (!x) throw notFound('user not found');
    if (x.role === 'admin') throw bad('admins are managed out of band');
    const on = ctx.body.suspended !== false;
    db.run('UPDATE users SET suspended_at = ?, suspended_reason = ? WHERE id = ?', on ? Date.now() : null, on ? String(ctx.body.reason || 'policy') : null, x.id);
    if (on) db.run('DELETE FROM sessions WHERE user_id = ?', x.id);
    db.audit(u.id, on ? 'user_suspended' : 'user_reinstated', 'user', x.id, { reason: ctx.body.reason }, ctx.ip);
    return publicUser(db, db.get('SELECT * FROM users WHERE id = ?', x.id));
  });

  r.get('/admin/audit', ctx => {
    admin(ctx); const off = +(ctx.query.cursor || 0);
    const rows = ctx.query.target_id ? db.all('SELECT * FROM audit_log WHERE target_id = ? ORDER BY id DESC LIMIT 100 OFFSET ?', ctx.query.target_id, off) : db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100 OFFSET ?', off);
    return { items: rows.map(a => ({ ...a, detail: JSON.parse(a.detail), created_at: new Date(a.created_at).toISOString() })), next_cursor: rows.length === 100 ? String(off + 100) : null };
  });
}
