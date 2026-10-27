// End-to-end test of the API with every provider in sandbox mode:
// sign up → verify → list → moderate → enquire, offer, viewing → escrow → confirm → release → rate → record.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NOBLE_ENV = 'development';
process.env.ADMIN_PHONES = '+254700000001';
process.env.UPLOAD_DIR = '/tmp/noble-test-uploads-' + process.pid;
const { createApp } = await import('../src/app.js');
const { runOnce } = await import('../src/scheduler.js');

let app, base;
const quiet = { log() {}, error: console.error };
before(async () => { app = createApp({ dbPath: ':memory:', scheduler: false, logger: quiet }); await new Promise(r => app.server.listen(0, r)); base = `http://127.0.0.1:${app.server.address().port}`; });
after(() => app.close());

async function api(method, path, { token, body, raw, contentType } = {}) {
  const res = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': contentType || 'application/json' }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await res.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
async function signIn(phone, extra) {
  const otp = await api('POST', '/auth/otp', { body: { phone_e164: phone } });
  assert.equal(otp.status, 200); assert.ok(otp.data.dev_code, 'dev mode returns the code');
  const v = await api('POST', '/auth/otp/verify', { body: { phone_e164: phone, code: otp.data.dev_code, ...extra } });
  assert.equal(v.status, 200, JSON.stringify(v.data)); return v.data;
}

const S = {};

test('countries are served with policy and payment methods', async () => {
  const r = await api('GET', '/countries'); assert.equal(r.status, 200);
  const ke = r.data.find(c => c.code === 'KE'); assert.deepEqual(ke.payment_methods, ['mpesa', 'airtel_money', 'card']); assert.equal(ke.policy.commission_pct, 5);
});

test('sign up: buyer, landlord, admin; wrong OTP is rejected', async () => {
  S.buyer = await signIn('+254711111111', { country: 'KE', full_name: 'Amina Odhiambo', role: 'buyer' });
  S.seller = await signIn('+254722222222', { country: 'KE', full_name: 'Joseph Mwangi', role: 'seller' });
  S.admin = await signIn('+254700000001', { country: 'KE', full_name: 'Grace Njeri' });
  assert.equal(S.admin.user.role, 'admin'); assert.equal(S.buyer.user.verified, false);
  const otp = await api('POST', '/auth/otp', { body: { phone_e164: '+254733333333' } });
  const bad = await api('POST', '/auth/otp/verify', { body: { phone_e164: '+254733333333', code: '000000', country: 'KE', full_name: 'X Y' } });
  assert.equal(bad.status, 400); assert.ok(otp.data.sent);
});

test('unverified accounts cannot list, message or pay', async () => {
  const r = await api('POST', '/listings', { token: S.seller.token, body: { type: 'rent' } });
  assert.equal(r.status, 403); assert.match(r.data.message, /verification/);
});

test('KYC in sandbox verifies immediately; the same document on a second account is rejected', async () => {
  for (const who of ['buyer', 'seller']) {
    const r = await api('POST', '/auth/kyc', { token: S[who].token, body: { document_type: 'national_id', document_number: who === 'buyer' ? '31234567' : '28765432' } });
    assert.equal(r.status, 202); assert.equal(r.data.status, 'verified'); assert.equal(r.data.mode, 'sandbox');
  }
  const dup = await signIn('+254744444444', { country: 'KE', full_name: 'Brian Otieno' });
  const r = await api('POST', '/auth/kyc', { token: dup.token, body: { document_type: 'national_id', document_number: '31234567' } });
  assert.equal(r.data.status, 'rejected', 'duplicate ID number is caught by the HMAC hash');
  const wrong = await api('POST', '/auth/kyc', { token: dup.token, body: { document_type: 'ghana_card' } });
  assert.equal(wrong.status, 400);
});

test('landlord submits a listing with a photo and a lease document; it waits in the queue', async () => {
  const r = await api('POST', '/listings', { token: S.seller.token, body: { type: 'rent', title: '2-bed apartment with balcony', price_minor: 85000_00, lat: -1.2921, lng: 36.7822, place_name: 'Kilimani', address_private: 'Rose Avenue 12, apt 4B', size: 96, size_unit: 'sqm', bedrooms: 2, title_status: 'Lease authority letter from owner' } });
  assert.equal(r.status, 201, JSON.stringify(r.data)); S.listing = r.data; assert.equal(r.data.status, 'pending'); assert.equal(r.data.currency, 'KES');
  const ph = await api('POST', `/listings/${S.listing.id}/photos`, { token: S.seller.token, raw: Buffer.from('fake-png-bytes-1'), contentType: 'image/png' });
  assert.equal(ph.status, 201); assert.deepEqual(ph.data.duplicate_of, []);
  const doc = await api('POST', `/listings/${S.listing.id}/documents?kind=lease_authority`, { token: S.seller.token, raw: Buffer.from('%PDF-1.4 lease'), contentType: 'application/pdf' });
  assert.equal(doc.status, 201);
  const pub = await api('GET', `/listings?country=KE`); assert.equal(pub.data.total, 0, 'pending listings are not public');
  const hidden = await api('GET', `/listings/${S.listing.id}`); assert.equal(hidden.status, 404);
});

test('a second listing reusing the same photo is flagged as a duplicate', async () => {
  const r = await api('POST', '/listings', { token: S.seller.token, body: { type: 'sale', title: 'Family house on half-acre', price_minor: 48_500_000_00, lat: -1.32, lng: 36.71, place_name: 'Karen', size: 0.5, size_unit: 'acres', bedrooms: 4, title_status: 'Freehold title deed' } });
  S.listing2 = r.data;
  const ph = await api('POST', `/listings/${S.listing2.id}/photos`, { token: S.seller.token, raw: Buffer.from('fake-png-bytes-1'), contentType: 'image/png' });
  assert.deepEqual(ph.data.duplicate_of, [S.listing.id]);
});

test('admin cannot approve without the checklist; approves with it; sale needs a document', async () => {
  const q = await api('GET', '/admin/listings', { token: S.admin.token }); assert.equal(q.data.length, 2); assert.deepEqual(q.data[0].required_checks, ['lease_names_lister']);
  const no = await api('POST', `/admin/listings/${S.listing.id}/review`, { token: S.admin.token, body: { decision: 'approve', checks: {} } });
  assert.equal(no.status, 422); assert.deepEqual(no.data.missing, ['lease_names_lister']);
  const yes = await api('POST', `/admin/listings/${S.listing.id}/review`, { token: S.admin.token, body: { decision: 'approve', checks: { lease_names_lister: true } } });
  assert.equal(yes.status, 200); assert.equal(yes.data.status, 'approved'); assert.equal(yes.data.ownership_verified, true);
  const sale = await api('POST', `/admin/listings/${S.listing2.id}/review`, { token: S.admin.token, body: { decision: 'approve', checks: { name_matches: true, parcel_matches: true, search_recent: true } } });
  assert.equal(sale.status, 422, 'sale without a title document cannot be approved');
  const rej = await api('POST', `/admin/listings/${S.listing2.id}/review`, { token: S.admin.token, body: { decision: 'reject', reject_reason: 'Missing proof of ownership' } });
  assert.equal(rej.data.status, 'rejected');
  const notAdmin = await api('GET', '/admin/listings', { token: S.seller.token }); assert.equal(notAdmin.status, 403);
});

test('search finds the live listing; private address hidden until escrow', async () => {
  const r = await api('GET', '/listings?country=KE&q=balcony&type=rent&min_price=5000000&sort=price_asc', { token: S.buyer.token });
  assert.equal(r.data.total, 1); assert.equal(r.data.items[0].address_private, undefined); assert.equal(r.data.items[0].owner.verified, true);
  const near = await api('GET', '/listings?country=KE&near=-1.29,36.78&radius_km=2'); assert.equal(near.data.total, 1);
  const far = await api('GET', '/listings?country=KE&near=-1.29,36.78&radius_km=0.1'); assert.equal(far.data.total, 0);
  await api('PUT', `/listings/${S.listing.id}/save`, { token: S.buyer.token });
  const saved = await api('GET', '/listings?country=KE&saved=true', { token: S.buyer.token }); assert.equal(saved.data.total, 1); assert.equal(saved.data.items[0].saved, true);
});

test('chat masks contact details; offer accepted sets the escrow price; viewing agreed', async () => {
  const th = await api('POST', '/threads', { token: S.buyer.token, body: { listing_id: S.listing.id } }); assert.equal(th.status, 200); S.thread = th.data;
  const m = await api('POST', `/threads/${S.thread.id}/messages`, { token: S.buyer.token, body: { kind: 'text', body: 'Call me on 0712 345 678 or amina@example.com' } });
  assert.equal(m.data.body, 'Call me on [number hidden] or [email hidden]');
  const offer = await api('POST', `/threads/${S.thread.id}/messages`, { token: S.buyer.token, body: { kind: 'offer', offer_minor: 80000_00 } });
  const own = await api('POST', `/messages/${offer.data.id}/decision`, { token: S.buyer.token, body: { decision: 'accepted' } }); assert.equal(own.status, 403, 'cannot accept your own offer');
  const acc = await api('POST', `/messages/${offer.data.id}/decision`, { token: S.seller.token, body: { decision: 'accepted' } }); assert.equal(acc.data.decision, 'accepted');
  const when = new Date(Date.now() + 2 * 86400e3).toISOString();
  const vw = await api('POST', `/threads/${S.thread.id}/messages`, { token: S.seller.token, body: { kind: 'viewing', viewing_at: when } });
  const vacc = await api('POST', `/messages/${vw.data.id}/decision`, { token: S.buyer.token, body: { decision: 'accepted' } }); assert.equal(vacc.data.decision, 'accepted');
  const full = await api('GET', `/threads/${S.thread.id}`, { token: S.buyer.token }); assert.ok(full.data.messages.some(x => x.kind === 'system' && /hidden/.test(x.body)));
});

test('escrow: sandbox collection is held at the accepted price; idempotent; address now visible', async () => {
  const r = await api('POST', '/transactions', { token: S.buyer.token, body: { listing_id: S.listing.id, gateway: 'mpesa', payer_account: '+254711111111', idempotency_key: 'pay-1' } });
  assert.equal(r.status, 201, JSON.stringify(r.data)); S.txn = r.data;
  assert.equal(r.data.state, 'held'); assert.equal(r.data.agreed_price_minor, 80000_00); assert.equal(r.data.amount_minor, 160000_00); assert.match(r.data.gateway, /^sandbox/);
  assert.deepEqual(r.data.available_transitions, ['confirm_viewing', 'open_dispute']);
  const again = await api('POST', '/transactions', { token: S.buyer.token, body: { listing_id: S.listing.id, gateway: 'mpesa', payer_account: '+254711111111', idempotency_key: 'pay-1' } });
  assert.equal(again.data.id, S.txn.id, 'same idempotency key returns the same transaction');
  const dupe = await api('POST', '/transactions', { token: S.buyer.token, body: { listing_id: S.listing.id, gateway: 'mpesa', payer_account: '+254711111111', idempotency_key: 'pay-2' } });
  assert.equal(dupe.status, 409, 'one open escrow per buyer per listing');
  const wrongMethod = await api('POST', '/transactions', { token: S.seller.token, body: { listing_id: S.listing.id, gateway: 'ach', payer_account: 'x', idempotency_key: 'pay-3' } });
  assert.equal(wrongMethod.status, 403, 'seller cannot pay for own listing');
  const l = await api('GET', `/listings/${S.listing.id}`, { token: S.buyer.token }); assert.equal(l.data.address_private, 'Rose Avenue 12, apt 4B');
});

test('both confirm viewing then handover; release pays out minus commission, closes the listing, issues the record', async () => {
  const t = (token, transition, extra) => api('POST', `/transactions/${S.txn.id}/transitions`, { token, body: { transition, ...extra } });
  let r = await t(S.buyer.token, 'confirm_handover'); assert.equal(r.status, 409, 'handover before viewing is refused');
  r = await t(S.buyer.token, 'confirm_viewing'); assert.equal(r.data.state, 'held');
  r = await t(S.buyer.token, 'confirm_viewing'); assert.equal(r.status, 409, 'cannot confirm twice');
  r = await t(S.seller.token, 'confirm_viewing'); assert.equal(r.data.state, 'viewing_confirmed'); assert.ok(r.data.handover_deadline);
  r = await t(S.seller.token, 'confirm_handover'); assert.equal(r.data.state, 'viewing_confirmed');
  r = await t(S.buyer.token, 'confirm_handover'); assert.equal(r.data.state, 'released');
  assert.equal(r.data.commission_minor, 8000_00); assert.equal(r.data.payout_minor, 152000_00); assert.ok(r.data.agreement_ref);
  const l = await api('GET', `/listings/${S.listing.id}`); assert.equal(l.data.status, 'closed');
  const rec = await api('GET', `/transactions/${S.txn.id}/record`, { token: S.seller.token }); assert.equal(rec.data.jurisdiction, 'Kenya'); assert.equal(rec.data.released_to_seller, 'KES 152,000');
  const events = app.db.all('SELECT event_type FROM payment_events WHERE transaction_id = ? ORDER BY id', S.txn.id).map(e => e.event_type);
  assert.deepEqual(events, ['collect_requested', 'collect_confirmed', 'payout_sent']);
});

test('ratings only after release, once per party; owner trust line updates', async () => {
  const r = await api('POST', `/transactions/${S.txn.id}/rating`, { token: S.buyer.token, body: { stars: 5, comment: 'Smooth handover' } }); assert.equal(r.status, 201);
  const twice = await api('POST', `/transactions/${S.txn.id}/rating`, { token: S.buyer.token, body: { stars: 4 } }); assert.equal(twice.status, 409);
  const me = await api('GET', '/me', { token: S.seller.token }); assert.equal(me.data.rating.avg, 5); assert.equal(me.data.deals_completed, 1);
});

test('dispute: buyer opens, admin refunds; audit log records it', async () => {
  // Relist and approve a second rental so there is something to pay for
  await api('POST', `/listings/${S.listing.id}/status`, { token: S.seller.token, body: { action: 'relist' } });
  await api('POST', `/admin/listings/${S.listing.id}/review`, { token: S.admin.token, body: { decision: 'approve', checks: { lease_names_lister: true } } });
  const pay = await api('POST', '/transactions', { token: S.buyer.token, body: { listing_id: S.listing.id, gateway: 'card', payer_account: 'pm_card_visa', idempotency_key: 'pay-4' } });
  assert.equal(pay.data.state, 'held');
  const d = await api('POST', `/transactions/${pay.data.id}/transitions`, { token: S.buyer.token, body: { transition: 'open_dispute', reason: 'Landlord never showed up for the viewing' } });
  assert.equal(d.data.state, 'disputed');
  const notParty = await api('POST', `/admin/transactions/${pay.data.id}/resolve`, { token: S.seller.token, body: { transition: 'admin_refund' } }); assert.equal(notParty.status, 403);
  const res = await api('POST', `/admin/transactions/${pay.data.id}/resolve`, { token: S.admin.token, body: { transition: 'admin_refund', note: 'seller unresponsive' } });
  assert.equal(res.data.state, 'refunded'); assert.equal(res.data.refund_reason, 'admin decision');
  const audit = await api('GET', `/admin/audit?target_id=${pay.data.id}`, { token: S.admin.token });
  assert.ok(audit.data.items.some(a => a.action === 'escrow_refunded'));
});

test('scheduler auto-refunds when the viewing deadline passes', async () => {
  const pay = await api('POST', '/transactions', { token: S.buyer.token, body: { listing_id: S.listing.id, gateway: 'airtel_money', payer_account: '+254711111111', idempotency_key: 'pay-5' } });
  assert.equal(pay.data.state, 'held');
  const nothing = await runOnce(app.db, Date.now(), quiet); assert.equal(nothing.applied, 0);
  const later = await runOnce(app.db, Date.now() + 15 * 86400e3, quiet); assert.equal(later.applied, 1);
  const t = await api('GET', `/transactions/${pay.data.id}`, { token: S.buyer.token }); assert.equal(t.data.state, 'refunded'); assert.match(t.data.refund_reason, /no viewing/);
});

test('reports and suspension', async () => {
  const rep = await api('POST', `/listings/${S.listing.id}/report`, { token: S.buyer.token, body: { reason: 'Asked to pay outside the app' } }); assert.equal(rep.status, 202);
  const list = await api('GET', '/admin/reports', { token: S.admin.token }); assert.equal(list.data.length, 1);
  await api('POST', `/admin/reports/${rep.data.id}/resolve`, { token: S.admin.token, body: { action: 'take_down' } });
  const l = await api('GET', `/listings/${S.listing.id}`, { token: S.admin.token }); assert.equal(l.data.status, 'removed');
  await api('POST', `/admin/users/${S.seller.user.id}/suspend`, { token: S.admin.token, body: { reason: 'off-platform payments' } });
  const blocked = await api('GET', '/me', { token: S.seller.token }); assert.equal(blocked.status, 401, 'sessions are revoked on suspension');
});

test('integrations report sandbox mode and the keys that unlock each provider', async () => {
  const r = await api('GET', '/admin/integrations', { token: S.admin.token });
  assert.ok(r.data.every(i => i.mode === 'sandbox')); assert.ok(r.data.find(i => i.id === 'mpesa').unlock_with.includes('MPESA_CONSUMER_KEY'));
});
