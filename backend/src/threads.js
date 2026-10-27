// In-app messaging: threads per listing and buyer; text (masked), offers and viewing proposals with decisions.
import { bad, forbidden, notFound, conflict, tooMany } from './http.js';
import { requireUser, requireVerified, publicUser } from './auth.js';
import { notify } from './notifications.js';

const mask = s => s.replace(/\+?\d[\d\s().-]{7,}\d/g, '[number hidden]').replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/gi, '[email hidden]').replace(/\b(whatsapp|telegram|signal)\b\s*[:\-]?\s*\S+/gi, '[contact hidden]');

function msgView(m) { return { id: m.id, kind: m.kind, sender_id: m.sender_id, body: m.body, offer_minor: m.offer_minor, viewing_at: m.viewing_at ? new Date(Number(m.viewing_at)).toISOString() : null, decision: m.decision, created_at: new Date(Number(m.created_at)).toISOString() }; }
async function threadView(db, t) {
  const l = await db.get('SELECT id, title, type, currency, price_minor, status FROM listings WHERE id = ?', t.listing_id);
  return { id: t.id, listing: l, buyer: await publicUser(db, await db.get('SELECT * FROM users WHERE id = ?', t.buyer_id)), owner: await publicUser(db, await db.get('SELECT * FROM users WHERE id = ?', t.owner_id)), messages: (await db.all('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at', t.id)).map(msgView) };
}
const party = (t, u) => u.id === t.buyer_id || u.id === t.owner_id || u.role === 'admin';
const sys = (db, threadId, text) => db.run("INSERT INTO messages (id, thread_id, sender_id, kind, body, created_at) VALUES (?,?,NULL,'system',?,?)", db.uuid(), threadId, text, Date.now());

export function registerThreadRoutes(r, db) {
  r.post('/threads', async ctx => {
    const u = requireVerified(ctx), l = await db.get('SELECT * FROM listings WHERE id = ?', ctx.body.listing_id);
    if (!l || !['approved', 'paused'].includes(l.status)) throw notFound('listing not found');
    if (l.owner_id === u.id) throw bad('this is your own listing');
    let t = await db.get('SELECT * FROM threads WHERE listing_id = ? AND buyer_id = ?', l.id, u.id);
    if (!t) { const id = db.uuid(); await db.run('INSERT INTO threads (id, listing_id, buyer_id, owner_id, created_at) VALUES (?,?,?,?,?)', id, l.id, u.id, l.owner_id, Date.now()); t = await db.get('SELECT * FROM threads WHERE id = ?', id); }
    return threadView(db, t);
  });
  r.get('/threads', async ctx => { const u = requireUser(ctx); const ts = await db.all('SELECT * FROM threads WHERE buyer_id = ? OR owner_id = ? ORDER BY created_at DESC', u.id, u.id); return Promise.all(ts.map(t => threadView(db, t))); });
  r.get('/threads/:id', async ctx => { const u = requireUser(ctx), t = await db.get('SELECT * FROM threads WHERE id = ?', ctx.params.id); if (!t || !party(t, u)) throw notFound('thread not found'); return threadView(db, t); });

  r.post('/threads/:id/messages', async ctx => {
    const u = requireVerified(ctx), t = await db.get('SELECT * FROM threads WHERE id = ?', ctx.params.id);
    if (!t || !party(t, u)) throw notFound('thread not found');
    if (!(await db.allow(u.id, 'messages_30s', 6, 30e3))) throw tooMany('slow down: 6 messages per 30 seconds');
    const b = ctx.body, id = db.uuid(), now = Date.now();
    if (b.kind === 'text') {
      const raw = String(b.body || '').trim(); if (!raw || raw.length > 2000) throw bad('body must be 1 to 2000 characters');
      const masked = mask(raw);
      await db.tx(async () => { await db.run("INSERT INTO messages (id, thread_id, sender_id, kind, body, created_at) VALUES (?,?,?,'text',?,?)", id, t.id, u.id, masked, now); if (masked !== raw) { await db.run('INSERT INTO messages_raw (message_id, body) VALUES (?,?)', id, raw); await sys(db, t.id, 'Contact details were hidden. Keep chat and payments on Noble so escrow protects both of you.'); } });
    } else if (b.kind === 'offer') {
      const amt = Math.round(+b.offer_minor); if (!(amt > 0)) throw bad('offer_minor must be a positive integer');
      await db.run("INSERT INTO messages (id, thread_id, sender_id, kind, offer_minor, decision, created_at) VALUES (?,?,?,'offer',?,'pending',?)", id, t.id, u.id, amt, now);
    } else if (b.kind === 'viewing') {
      const at = Date.parse(b.viewing_at); if (!at || at < now + 30 * 60e3) throw bad('viewing_at must be an ISO datetime at least 30 minutes ahead');
      await db.run("INSERT INTO messages (id, thread_id, sender_id, kind, viewing_at, decision, created_at) VALUES (?,?,?,'viewing',?,'pending',?)", id, t.id, u.id, at, now);
    } else throw bad('kind must be text, offer or viewing');
    const other = u.id === t.buyer_id ? t.owner_id : t.buyer_id, lt = await db.get('SELECT title FROM listings WHERE id = ?', t.listing_id);
    await notify(db, other, b.kind === 'text' ? `New message from ${u.full_name} about “${lt.title}”.` : b.kind === 'offer' ? `${u.full_name} made an offer on “${lt.title}”.` : `${u.full_name} proposed a viewing of “${lt.title}”.`, { link: '#messages', sms: b.kind !== 'text' });
    return [201, msgView(await db.get('SELECT * FROM messages WHERE id = ?', id))];
  });

  r.post('/messages/:id/decision', async ctx => {
    const u = requireVerified(ctx), m = await db.get('SELECT * FROM messages WHERE id = ?', ctx.params.id); if (!m) throw notFound('message not found');
    const t = await db.get('SELECT * FROM threads WHERE id = ?', m.thread_id);
    if (!party(t, u) || m.sender_id === u.id) throw forbidden('only the other party can decide');
    if (!['offer', 'viewing'].includes(m.kind) || m.decision !== 'pending') throw conflict('nothing to decide');
    const d = ctx.body.decision; if (!['accepted', 'declined'].includes(d)) throw bad('decision must be accepted or declined');
    await db.run('UPDATE messages SET decision = ? WHERE id = ?', d, m.id);
    const l = await db.get('SELECT currency FROM listings WHERE id = ?', t.listing_id);
    if (m.kind === 'offer') await sys(db, t.id, `${u.full_name} ${d} the offer of ${l.currency} ${(m.offer_minor / 100).toLocaleString('en-US')}.${d === 'accepted' ? ' The buyer can now pay into escrow at this price.' : ''}`);
    else await sys(db, t.id, d === 'accepted' ? `Viewing agreed for ${new Date(Number(m.viewing_at)).toUTCString()}. Both sides confirm it happened from the escrow screen afterwards.` : `${u.full_name} asked for another time.`);
    await notify(db, m.sender_id, `${u.full_name} ${d} your ${m.kind === 'offer' ? 'offer' : 'viewing proposal'}.`, { link: '#messages', sms: true });
    return msgView(await db.get('SELECT * FROM messages WHERE id = ?', m.id));
  });
}
