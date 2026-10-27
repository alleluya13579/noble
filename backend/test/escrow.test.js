import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransaction, transition, available, dueSystemTransition, amountToHold, commissionFor, STATES, TransitionError } from '../src/escrow.js';

const KE = { depositPctSale: 10, rentDepositMonths: 1, viewingDays: 14, handoverDays: 30, commissionPct: 5 };
const DAY = 86400000;
const t0 = Date.parse('2026-11-01T09:00:00Z');

function rental() {
  return createTransaction({ reference: 'ESC-1', listing: { id: 'l1', type: 'rent' }, buyerId: 'u1', sellerId: 'u2', agreedPriceMinor: 85000_00, currency: 'KES', policy: KE });
}
function held(txn = rental(), now = t0) {
  let x = transition(txn, 'request_collection', { actor: 'buyer', actorId: 'u1', now, gateway: 'mpesa', idempotencyKey: 'k1' });
  return transition(x, 'confirm_collection', { actor: 'system', now: now + 60000, verifiedSignature: true, amountMinor: x.amountMinor, currency: 'KES', gatewayRef: 'MPESA123' });
}

test('amount to hold: rent is first month + deposit months; sale is the deposit percentage', () => {
  assert.equal(amountToHold({ type: 'rent', agreedPriceMinor: 85000_00 }, KE), 170000_00);
  assert.equal(amountToHold({ type: 'sale', agreedPriceMinor: 48_500_000_00 }, KE), 4_850_000_00);
  assert.equal(amountToHold({ type: 'land', agreedPriceMinor: 6_200_000_00 }, KE), 620_000_00);
});

test('commission is rounded to whole minor units', () => {
  assert.equal(commissionFor(170000_00, 5), 8500_00);
  assert.equal(commissionFor(333, 5), 16);
});

test('happy path: collect, both confirm viewing, both confirm handover, release with commission', () => {
  let x = held();
  assert.equal(x.state, STATES.HELD);
  assert.equal(x.viewingDeadline, t0 + 60000 + 14 * DAY);
  x = transition(x, 'confirm_viewing', { actor: 'buyer', actorId: 'u1', now: t0 + DAY });
  assert.equal(x.state, STATES.HELD, 'one confirmation is not enough');
  x = transition(x, 'confirm_viewing', { actor: 'seller', actorId: 'u2', now: t0 + DAY + 1 });
  assert.equal(x.state, STATES.VIEWING_CONFIRMED, 'second confirmation chains into viewing_confirmed');
  assert.equal(x.handoverDeadline, t0 + DAY + 1 + 30 * DAY);
  x = transition(x, 'confirm_handover', { actor: 'seller', actorId: 'u2', now: t0 + 2 * DAY });
  x = transition(x, 'confirm_handover', { actor: 'buyer', actorId: 'u1', now: t0 + 2 * DAY + 5 });
  assert.equal(x.state, STATES.RELEASED);
  assert.equal(x.commissionMinor, 8500_00);
  assert.equal(x.payoutMinor, 161500_00);
  assert.equal(x.agreementRef, 'AGR-ESC-1');
  assert.deepEqual(x.history.map(h => h.transition), ['request_collection', 'confirm_collection', 'confirm_viewing', 'confirm_viewing', 'both_confirmed_viewing', 'confirm_handover', 'confirm_handover', 'release']);
});

test('money only enters HELD through a verified webhook with the exact amount', () => {
  const x = transition(rental(), 'request_collection', { actor: 'buyer', actorId: 'u1', now: t0, gateway: 'mpesa', idempotencyKey: 'k1' });
  assert.throws(() => transition(x, 'confirm_collection', { actor: 'system', now: t0, verifiedSignature: false, amountMinor: x.amountMinor, currency: 'KES' }), /signature/);
  assert.throws(() => transition(x, 'confirm_collection', { actor: 'system', now: t0, verifiedSignature: true, amountMinor: x.amountMinor - 1, currency: 'KES' }), /does not match/);
  assert.throws(() => transition(x, 'confirm_collection', { actor: 'buyer', actorId: 'u1', now: t0, verifiedSignature: true, amountMinor: x.amountMinor, currency: 'KES' }), /may not/);
});

test('a party cannot confirm twice, and cannot confirm handover before the viewing', () => {
  let x = held();
  x = transition(x, 'confirm_viewing', { actor: 'buyer', actorId: 'u1', now: t0 });
  assert.throws(() => transition(x, 'confirm_viewing', { actor: 'buyer', actorId: 'u1', now: t0 }), /already confirmed/);
  assert.throws(() => transition(x, 'confirm_handover', { actor: 'buyer', actorId: 'u1', now: t0 }), /not allowed from held/);
});

test('only the real buyer and seller can act on a transaction', () => {
  const x = held();
  assert.throws(() => transition(x, 'confirm_viewing', { actor: 'buyer', actorId: 'someone-else', now: t0 }), /not the buyer/);
  assert.throws(() => transition(x, 'seller_cancel', { actor: 'seller', actorId: 'u1', now: t0 }), /not the seller/);
});

test('seller can refund without a dispute; buyer must open one', () => {
  const a = transition(held(), 'seller_cancel', { actor: 'seller', actorId: 'u2', now: t0 });
  assert.equal(a.state, STATES.REFUNDED);
  assert.throws(() => transition(held(), 'admin_refund', { actor: 'buyer', actorId: 'u1', now: t0 }), TransitionError);
  assert.throws(() => transition(held(), 'open_dispute', { actor: 'buyer', actorId: 'u1', now: t0, reason: 'short' }), /at least 10/);
  const d = transition(held(), 'open_dispute', { actor: 'buyer', actorId: 'u1', now: t0, reason: 'Landlord never showed up for the viewing' });
  assert.equal(d.state, STATES.DISPUTED);
  assert.deepEqual(available(d, 'seller'), ['seller_agrees_refund']);
  assert.deepEqual(available(d, 'admin'), ['release', 'admin_refund']);
  assert.deepEqual(available(d, 'buyer'), []);
  const r = transition(d, 'release', { actor: 'admin', actorId: 'u4', now: t0 });
  assert.equal(r.state, STATES.RELEASED);
  assert.equal(r.resolvedBy, 'u4');
});

test('admin cannot release a transaction that is not disputed', () => {
  assert.throws(() => transition(held(), 'release', { actor: 'admin', actorId: 'u4', now: t0 }), /not allowed from held/);
});

test('terminal states accept no further transitions', () => {
  const x = transition(held(), 'seller_cancel', { actor: 'seller', actorId: 'u2', now: t0 });
  assert.throws(() => transition(x, 'open_dispute', { actor: 'buyer', actorId: 'u1', now: t0, reason: 'changed my mind again' }), /no further changes/);
});

test('scheduler: auto-refund after the viewing deadline, and after the handover deadline', () => {
  const x = held();
  assert.equal(dueSystemTransition(x, x.viewingDeadline - 1), null);
  assert.equal(dueSystemTransition(x, x.viewingDeadline), 'auto_refund');
  assert.throws(() => transition(x, 'auto_refund', { actor: 'system', now: x.viewingDeadline - 1 }), /has not passed/);
  const r = transition(x, 'auto_refund', { actor: 'system', now: x.viewingDeadline });
  assert.equal(r.state, STATES.REFUNDED);
  assert.match(r.refundReason, /no viewing/);

  let y = transition(x, 'confirm_viewing', { actor: 'buyer', actorId: 'u1', now: t0 });
  y = transition(y, 'confirm_viewing', { actor: 'seller', actorId: 'u2', now: t0 });
  assert.equal(dueSystemTransition(y, y.handoverDeadline), 'auto_refund');
  assert.match(transition(y, 'auto_refund', { actor: 'system', now: y.handoverDeadline }).refundReason, /no handover/);
});

test('scheduler: a collection that never confirms expires after two hours', () => {
  const x = transition(rental(), 'request_collection', { actor: 'buyer', actorId: 'u1', now: t0, gateway: 'mpesa', idempotencyKey: 'k1' });
  assert.equal(dueSystemTransition(x, t0 + 3600000), null);
  assert.equal(dueSystemTransition(x, t0 + 2 * 3600000 + 1), 'expire_collection');
  assert.equal(transition(x, 'expire_collection', { actor: 'system', now: t0 + 3 * 3600000 }).state, STATES.EXPIRED);
});

test('transition never mutates its input', () => {
  const before = held();
  const snapshot = JSON.stringify(before);
  transition(before, 'confirm_viewing', { actor: 'buyer', actorId: 'u1', now: t0 });
  assert.equal(JSON.stringify(before), snapshot);
});
