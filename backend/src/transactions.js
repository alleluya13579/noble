// Escrow service: persists the transaction process, talks to gateways, handles webhooks and payouts.
import crypto from 'node:crypto';
import { config } from './config.js';
import { bad, forbidden, notFound, conflict } from './http.js';
import { requireUser, requireVerified, publicUser } from './auth.js';
import * as E from './escrow.js';
import { gatewayForMethod, gatewayById } from './adapters/payments.js';
import { smsFor } from './adapters/sms.js';

const cbSecret = id => crypto.createHmac('sha256', config.sessionSecret).update('cb:' + id).digest('hex').slice(0, 24);
const iso = t => (t ? new Date(Number(t)).toISOString() : null);

export async function loadTxn(db, id) { const row = await db.get('SELECT * FROM transactions WHERE id = ? OR reference = ?', id, id); if (!row) throw notFound('transaction not found'); return { row, txn: JSON.parse(row.data) }; }

export async function saveTxn(db, id, txn, note) {
  const prev = (await db.get('SELECT COUNT(*) n FROM transaction_transitions WHERE transaction_id = ?', id)).n;
  await db.tx(async () => {
    await db.run('UPDATE transactions SET state = ?, gateway = ?, gateway_ref = ?, amount_minor = ?, data = ?, updated_at = ? WHERE id = ?', txn.state, txn.gateway || null, txn.gatewayRef || null, txn.amountMinor, JSON.stringify(txn), Date.now(), id);
    for (const h of txn.history.slice(prev)) await db.run('INSERT INTO transaction_transitions (transaction_id, from_state, to_state, transition, actor_id, note, created_at) VALUES (?,?,?,?,?,?,?)', id, h.from, h.to, h.transition, h.actorId, note || null, h.at);
  });
}

export function actorFor(user, txn) { return user.role === 'admin' ? E.ACTORS.ADMIN : user.id === txn.buyerId ? E.ACTORS.BUYER : user.id === txn.sellerId ? E.ACTORS.SELLER : null; }

export async function txnView(db, row, txn, user) {
  const actor = user ? actorFor(user, txn) : null;
  return { id: row.id, reference: txn.reference, listing_id: txn.listingId, state: txn.state, agreed_price_minor: txn.agreedPriceMinor, amount_minor: txn.amountMinor, commission_minor: txn.commissionMinor ?? null, payout_minor: txn.payoutMinor ?? null, currency: txn.currency,
    gateway: txn.gateway, gateway_ref: txn.gatewayRef || null, redirect_url: txn.redirectUrl || null, paid_at: iso(txn.paidAt), viewing_deadline: iso(txn.viewingDeadline), handover_deadline: iso(txn.handoverDeadline), released_at: iso(txn.releasedAt), refunded_at: iso(txn.refundedAt), refund_reason: txn.refundReason || null,
    buyer: await publicUser(db, await db.get('SELECT * FROM users WHERE id = ?', txn.buyerId)), seller: await publicUser(db, await db.get('SELECT * FROM users WHERE id = ?', txn.sellerId)),
    confirmations: { viewing_buyer: !!txn.viewing_buyer_at, viewing_seller: !!txn.viewing_seller_at, handover_buyer: !!txn.handover_buyer_at, handover_seller: !!txn.handover_seller_at },
    dispute: txn.disputeReason ? { reason: txn.disputeReason, opened_by: txn.disputeOpenedBy, opened_at: iso(txn.disputeOpenedAt) } : null,
    available_transitions: actor ? E.available(txn, actor).filter(n => !['confirm_collection', 'both_confirmed_viewing', 'auto_refund', 'expire_collection'].includes(n)) : [],
    my_rating: user ? ((await db.get('SELECT stars FROM ratings WHERE transaction_id = ? AND from_user_id = ?', row.id, user.id))?.stars ?? null) : null,
    agreement_ref: txn.agreementRef || null, history: txn.history.map(h => ({ at: iso(h.at), from: h.from, to: h.to, transition: h.transition, actor: h.actor })) };
}

/** Create a transaction for a listing and request collection from the chosen gateway. */
export async function startEscrow(db, { user, listing, method, payerAccount, idempotencyKey, returnUrl }) {
  if (listing.status !== 'approved') throw conflict('listing is not live');
  if (listing.owner_id === user.id) throw forbidden('you cannot pay for your own listing');
  const existing = await db.get('SELECT id FROM transactions WHERE idempotency_key = ?', idempotencyKey);
  if (existing) { const { row, txn } = await loadTxn(db, existing.id); return txnView(db, row, txn, user); }
  const country = await db.country(listing.country_code);
  if (!country.payment_methods.includes(method)) throw bad(`payment method must be one of ${country.payment_methods.join(', ')}`);
  const open = await db.get("SELECT id FROM transactions WHERE listing_id = ? AND buyer_id = ? AND state NOT IN ('refunded','expired','released')", listing.id, user.id);
  if (open) throw conflict('you already have an open escrow on this listing');
  const accepted = await db.get("SELECT m.offer_minor FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.listing_id = ? AND t.buyer_id = ? AND m.kind = 'offer' AND m.decision = 'accepted' ORDER BY m.created_at DESC LIMIT 1", listing.id, user.id);
  const agreedPriceMinor = accepted ? Number(accepted.offer_minor) : Number(listing.price_minor);
  const id = db.uuid(), reference = 'ESC-' + String(20000 + (await db.get('SELECT COUNT(*) n FROM transactions')).n + 1);
  let txn = E.createTransaction({ reference, listing: { id: listing.id, type: listing.type }, buyerId: user.id, sellerId: listing.owner_id, agreedPriceMinor, currency: listing.currency, policy: country.policy });
  const gateway = gatewayForMethod(method);
  txn = E.transition(txn, 'request_collection', { actor: E.ACTORS.BUYER, actorId: user.id, now: Date.now(), gateway: gateway.id, idempotencyKey });
  txn.method = method; txn.country = listing.country_code;
  await db.run('INSERT INTO transactions (id, reference, listing_id, buyer_id, seller_id, state, currency, amount_minor, gateway, idempotency_key, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, reference, listing.id, user.id, listing.owner_id, txn.state, txn.currency, txn.amountMinor, gateway.id, idempotencyKey, JSON.stringify(txn), Date.now(), Date.now());
  await saveTxn(db, id, txn);
  const callbackUrl = `${config.baseUrl}/webhooks/payments/${gateway.id}?txn=${id}&s=${cbSecret(id)}`;
  const res = await gateway.collect({ idempotencyKey, reference, amountMinor: txn.amountMinor, currency: txn.currency, payerAccount, payerEmail: user.email, method, callbackUrl, returnUrl: returnUrl || callbackUrl });
  await recordEvent(db, id, gateway.id, 'collect_requested', res.gatewayRef + ':requested', txn.amountMinor, res);
  txn.gatewayRef = res.gatewayRef; txn.redirectUrl = res.redirectUrl || null; await saveTxn(db, id, txn);
  if (res.status === 'confirmed') await applyGatewayEvent(db, gateway, { gatewayRef: res.gatewayRef, gatewayEventId: res.gatewayRef + ':confirmed', type: 'collect_confirmed', amountMinor: txn.amountMinor, currency: txn.currency, verifiedSignature: true, raw: res }, id);
  const { row, txn: fresh } = await loadTxn(db, id);
  return txnView(db, row, fresh, user);
}

async function recordEvent(db, txnId, gateway, type, eventId, amount, payload) {
  try { await db.run('INSERT INTO payment_events (transaction_id, gateway, event_type, gateway_event_id, amount_minor, payload, received_at) VALUES (?,?,?,?,?,?,?)', txnId, gateway, type, eventId, amount ?? 0, JSON.stringify(payload), Date.now()); return true; }
  catch (e) { if (db.isUnique(e)) return false; throw e; }
}

/** Apply a gateway event (webhook, reconciliation or a sandbox confirmation). Idempotent per gateway event id. */
export async function applyGatewayEvent(db, gateway, ev, txnIdHint) {
  const row = txnIdHint ? await db.get('SELECT * FROM transactions WHERE id = ?', txnIdHint) : await db.get('SELECT * FROM transactions WHERE gateway_ref = ? OR idempotency_key = ?', ev.gatewayRef, ev.gatewayRef);
  if (!row) throw notFound('no transaction for gateway reference ' + ev.gatewayRef);
  if (!(await recordEvent(db, row.id, gateway.id, ev.type, ev.gatewayEventId, ev.amountMinor, ev.raw))) return { duplicate: true };
  let txn = JSON.parse(row.data);
  if (ev.type === 'collect_confirmed' && txn.state === E.STATES.PAYMENT_PENDING) {
    let verified = ev.verifiedSignature, amount = ev.amountMinor;
    if (ev.needsReconcile || !verified) { const q = await gateway.reconcile(ev.gatewayRef); await recordEvent(db, row.id, gateway.id, 'reconciled', q.gatewayEventId, q.amountMinor ?? 0, q.raw); verified = q.verifiedSignature && q.type === 'collect_confirmed'; amount = q.amountMinor ?? amount; }
    txn = E.transition(txn, 'confirm_collection', { actor: E.ACTORS.SYSTEM, now: Date.now(), verifiedSignature: verified, amountMinor: amount, currency: ev.currency || txn.currency, gatewayRef: ev.gatewayRef });
    await saveTxn(db, row.id, txn, 'gateway ' + gateway.id);
    await db.audit(null, 'escrow_held', 'transaction', row.id, { gateway: gateway.id, amount: txn.amountMinor });
    await notifyParties(db, txn, `Noble: ${fmt(txn)} is now held in escrow for ${txn.reference}. Arrange the viewing in the app.`);
  } else if (ev.type === 'collect_failed' && [E.STATES.INITIATED, E.STATES.PAYMENT_PENDING].includes(txn.state)) {
    txn = E.transition(txn, 'expire_collection', { actor: E.ACTORS.SYSTEM, now: Date.now() }); await saveTxn(db, row.id, txn, 'collection failed');
  }
  return { state: txn.state };
}

/** Apply a party/admin/system transition, then do the money movement a terminal state requires. */
export async function applyTransition(db, id, name, ctx) {
  const { row, txn: before } = await loadTxn(db, id);
  let txn;
  try { txn = E.transition(before, name, ctx); } catch (e) { if (e instanceof E.TransitionError) throw conflict(e.message); throw e; }
  await saveTxn(db, row.id, txn, ctx.note);
  const gateway = gatewayById(txn.gateway);
  if (txn.state === E.STATES.RELEASED && before.state !== E.STATES.RELEASED) {
    const seller = await db.get('SELECT * FROM users WHERE id = ?', txn.sellerId);
    const out = await gateway.payout({ idempotencyKey: `${txn.reference}:payout`, reference: txn.reference, amountMinor: txn.payoutMinor, grossMinor: txn.amountMinor, currency: txn.currency, payeeAccount: seller.payout_account || seller.phone_e164, payeeName: seller.full_name, originalGatewayRef: txn.gatewayRef, method: txn.method, callbackUrl: `${config.baseUrl}/webhooks/payments/${gateway.id}?txn=${row.id}&s=${cbSecret(row.id)}` });
    await recordEvent(db, row.id, gateway.id, 'payout_sent', out.gatewayRef, txn.payoutMinor, out);
    await db.run("UPDATE listings SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'approved'", Date.now(), txn.listingId);
    await db.audit(ctx.actorId || null, 'escrow_released', 'transaction', row.id, { payout: txn.payoutMinor, commission: txn.commissionMinor, by: ctx.actor });
    await notifyParties(db, txn, `Noble: escrow ${txn.reference} released. Deal record ${txn.agreementRef} is available in the app.`);
  }
  if (txn.state === E.STATES.REFUNDED && before.state !== E.STATES.REFUNDED) {
    const buyer = await db.get('SELECT * FROM users WHERE id = ?', txn.buyerId);
    const out = await gateway.refund({ idempotencyKey: `${txn.reference}:refund`, originalGatewayRef: txn.gatewayRef, amountMinor: txn.amountMinor, currency: txn.currency, payerAccount: buyer.phone_e164, reference: txn.reference });
    await recordEvent(db, row.id, gateway.id, 'refund_sent', out.gatewayRef, txn.amountMinor, out);
    await db.audit(ctx.actorId || null, 'escrow_refunded', 'transaction', row.id, { reason: txn.refundReason, by: ctx.actor });
    await notifyParties(db, txn, `Noble: escrow ${txn.reference} refunded to the buyer (${txn.refundReason}).`);
  }
  return txn;
}

const fmt = t => `${t.currency} ${(t.amountMinor / 100).toLocaleString('en-US')}`;
async function notifyParties(db, txn, text) {
  for (const id of [txn.buyerId, txn.sellerId]) { const u = await db.get('SELECT phone_e164 FROM users WHERE id = ?', id); if (u?.phone_e164) smsFor(u.phone_e164).send(u.phone_e164, text).catch(() => {}); }
}

export async function dealRecord(db, row, txn) {
  const l = await db.get('SELECT * FROM listings WHERE id = ?', txn.listingId), b = await db.get('SELECT * FROM users WHERE id = ?', txn.buyerId), s = await db.get('SELECT * FROM users WHERE id = ?', txn.sellerId), c = await db.country(l.country_code);
  const m = n => `${txn.currency} ${(n / 100).toLocaleString('en-US')}`, d = t => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
  return { agreement_ref: txn.agreementRef, escrow_reference: txn.reference, type: l.type === 'rent' ? 'Tenancy' : l.type === 'land' ? 'Land sale (deposit)' : 'House sale (deposit)', property: `${l.title}, ${l.place_name}`, listing_id: l.id, title_status: l.title_status, jurisdiction: c.name, land_registry: c.land_registry,
    buyer: { name: b.full_name, id_last4: b.id_last4 }, seller: { name: s.full_name, id_last4: s.id_last4, client_owner: l.client_owner_name }, agreed_price: m(txn.agreedPriceMinor), held: m(txn.amountMinor), paid_at: d(txn.paidAt), viewing_confirmed_at: d(txn.viewingConfirmedAt), released_at: d(txn.releasedAt), commission: m(txn.commissionMinor), released_to_seller: m(txn.payoutMinor),
    note: l.type !== 'rent' ? `Balance and legal transfer of title are completed offline at ${c.land_registry}.` : 'Deposit is held by the landlord under the tenancy terms agreed in chat.' };
}

export function registerTransactionRoutes(r, db) {
  r.post('/transactions', async ctx => {
    const user = requireVerified(ctx);
    const listing = await db.get('SELECT * FROM listings WHERE id = ?', ctx.body.listing_id); if (!listing) throw notFound('listing not found');
    const idem = ctx.body.idempotency_key || ctx.req.headers['idempotency-key']; if (!idem) throw bad('idempotency_key is required');
    if (!ctx.body.gateway || !ctx.body.payer_account) throw bad('gateway (payment method) and payer_account are required');
    return [201, await startEscrow(db, { user, listing, method: ctx.body.gateway, payerAccount: String(ctx.body.payer_account), idempotencyKey: String(idem), returnUrl: ctx.body.return_url })];
  });
  r.get('/transactions', async ctx => { const u = requireUser(ctx); const rows = u.role === 'admin' ? await db.all('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 200') : await db.all('SELECT * FROM transactions WHERE buyer_id = ? OR seller_id = ? ORDER BY created_at DESC', u.id, u.id); return Promise.all(rows.map(row => txnView(db, row, JSON.parse(row.data), u))); });
  r.get('/transactions/:id', async ctx => { const u = requireUser(ctx); const { row, txn } = await loadTxn(db, ctx.params.id); if (!actorFor(u, txn)) throw forbidden(); return txnView(db, row, txn, u); });
  r.post('/transactions/:id/transitions', async ctx => {
    const u = requireUser(ctx); const { row, txn } = await loadTxn(db, ctx.params.id); const actor = actorFor(u, txn); if (!actor) throw forbidden();
    const name = String(ctx.body.transition || '');
    if (!['confirm_viewing', 'confirm_handover', 'seller_cancel', 'open_dispute', 'seller_agrees_refund'].includes(name)) throw bad('transition not available to parties');
    await applyTransition(db, row.id, name, { actor, actorId: u.id, now: Date.now(), reason: ctx.body.reason, note: ctx.body.note });
    const fresh = await loadTxn(db, row.id); return txnView(db, fresh.row, fresh.txn, u);
  });
  r.get('/transactions/:id/record', async ctx => { const u = requireUser(ctx); const { row, txn } = await loadTxn(db, ctx.params.id); if (!actorFor(u, txn)) throw forbidden(); if (txn.state !== E.STATES.RELEASED) throw conflict('deal record is issued when escrow is released'); return dealRecord(db, row, txn); });
  r.post('/transactions/:id/rating', async ctx => {
    const u = requireUser(ctx); const { row, txn } = await loadTxn(db, ctx.params.id); const actor = actorFor(u, txn);
    if (!['buyer', 'seller'].includes(actor)) throw forbidden('only the parties can rate');
    if (txn.state !== E.STATES.RELEASED) throw conflict('rate after the deal is released');
    const stars = +ctx.body.stars; if (!(stars >= 1 && stars <= 5)) throw bad('stars must be 1 to 5');
    try { await db.run('INSERT INTO ratings (transaction_id, from_user_id, to_user_id, stars, comment, created_at) VALUES (?,?,?,?,?,?)', row.id, u.id, actor === 'buyer' ? txn.sellerId : txn.buyerId, stars, String(ctx.body.comment || '').slice(0, 500) || null, Date.now()); }
    catch (e) { if (db.isUnique(e)) throw conflict('you already rated this deal'); throw e; }
    return [201, { saved: true }];
  });
  r.post('/webhooks/payments/:gateway', async ctx => {
    const gateway = gatewayById(ctx.params.gateway);
    const txnId = ctx.query.txn;
    if (txnId && ctx.query.s !== cbSecret(txnId)) throw forbidden('bad callback secret');
    let ev; try { ev = await gateway.parseWebhook({ headers: ctx.req.headers, body: ctx.raw }); } catch (e) { throw forbidden(e.message); }
    try { const out = await applyGatewayEvent(db, gateway, ev, txnId); return [200, out]; }
    catch (e) { if (e instanceof E.TransitionError || e.status === 404) return [200, { ignored: e.message }]; throw e; } // always 200 after persisting, so the gateway stops retrying
  });
}
