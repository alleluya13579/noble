// Noble transaction process: an explicit, data-driven state machine for escrow.
//
// Design borrowed from Sharetribe's "transaction process" (states, transitions,
// actions with preconditions) and Deal Secure's rule that every status change
// goes through one validated transition function. Nothing else may set `state`.
//
// Money is in minor units. Times are epoch milliseconds. The module is pure:
// it never touches a database or a gateway, so it can be unit-tested and reused
// by the API, the scheduler and the webhook handler alike.

export const STATES = Object.freeze({
  INITIATED: 'initiated',               // buyer asked to pay; nothing collected yet
  PAYMENT_PENDING: 'payment_pending',   // collection requested at the gateway (STK push sent, card authorising)
  HELD: 'held',                         // gateway confirmed the money; Noble holds it
  VIEWING_CONFIRMED: 'viewing_confirmed', // both sides confirmed the viewing happened
  DISPUTED: 'disputed',                 // a party asked for a refund the other has not agreed to
  RELEASED: 'released',                 // paid out to the seller minus commission; terminal
  REFUNDED: 'refunded',                 // returned to the buyer; terminal
  EXPIRED: 'expired'                    // collection never completed; terminal
});

export const ACTORS = Object.freeze({ BUYER: 'buyer', SELLER: 'seller', ADMIN: 'admin', SYSTEM: 'system' });

const TERMINAL = new Set([STATES.RELEASED, STATES.REFUNDED, STATES.EXPIRED]);

/**
 * The transition map. Each entry: name -> { from, to, by, guard?, apply? }
 *  - from: states the transition is allowed from
 *  - by:   actors allowed to trigger it
 *  - guard(txn, ctx): throws with a reason when preconditions fail
 *  - apply(txn, ctx): returns the fields to merge into the transaction
 */
export const TRANSITIONS = Object.freeze({
  request_collection: {
    from: [STATES.INITIATED], to: STATES.PAYMENT_PENDING, by: [ACTORS.BUYER],
    guard: (t, c) => { need(c.gateway, 'gateway is required'); need(c.idempotencyKey, 'idempotency key is required'); },
    apply: (t, c) => ({ gateway: c.gateway, idempotencyKey: c.idempotencyKey })
  },
  // Only a verified gateway webhook moves money into HELD. Amount must match exactly.
  confirm_collection: {
    from: [STATES.PAYMENT_PENDING], to: STATES.HELD, by: [ACTORS.SYSTEM],
    guard: (t, c) => {
      need(c.verifiedSignature === true, 'webhook signature not verified');
      need(c.amountMinor === t.amountMinor, `collected ${c.amountMinor} does not match expected ${t.amountMinor}`);
      need(c.currency === t.currency, 'currency mismatch');
    },
    apply: (t, c) => ({ gatewayRef: c.gatewayRef, paidAt: c.now, viewingDeadline: c.now + t.policy.viewingDays * DAY })
  },
  expire_collection: {
    from: [STATES.INITIATED, STATES.PAYMENT_PENDING], to: STATES.EXPIRED, by: [ACTORS.SYSTEM, ACTORS.BUYER]
  },
  confirm_viewing: {
    from: [STATES.HELD], to: STATES.HELD, by: [ACTORS.BUYER, ACTORS.SELLER],
    guard: (t, c) => need(!t[`viewing_${c.actor}_at`], `${c.actor} already confirmed the viewing`),
    apply: (t, c) => ({ [`viewing_${c.actor}_at`]: c.now }),
    // when both have confirmed, chain into VIEWING_CONFIRMED
    then: (t, c) => (t.viewing_buyer_at && t.viewing_seller_at) ? 'both_confirmed_viewing' : null
  },
  both_confirmed_viewing: {
    from: [STATES.HELD], to: STATES.VIEWING_CONFIRMED, by: [ACTORS.SYSTEM],
    guard: t => need(t.viewing_buyer_at && t.viewing_seller_at, 'both parties must confirm the viewing'),
    apply: (t, c) => ({ viewingConfirmedAt: c.now, handoverDeadline: c.now + t.policy.handoverDays * DAY, viewingDeadline: null })
  },
  confirm_handover: {
    from: [STATES.VIEWING_CONFIRMED], to: STATES.VIEWING_CONFIRMED, by: [ACTORS.BUYER, ACTORS.SELLER],
    guard: (t, c) => need(!t[`handover_${c.actor}_at`], `${c.actor} already confirmed the handover`),
    apply: (t, c) => ({ [`handover_${c.actor}_at`]: c.now }),
    then: (t) => (t.handover_buyer_at && t.handover_seller_at) ? 'release' : null
  },
  release: {
    from: [STATES.VIEWING_CONFIRMED, STATES.DISPUTED], to: STATES.RELEASED, by: [ACTORS.SYSTEM, ACTORS.ADMIN],
    guard: (t, c) => {
      if (c.actor === ACTORS.SYSTEM) need(t.handover_buyer_at && t.handover_seller_at, 'system release needs both handover confirmations');
      if (c.actor === ACTORS.ADMIN) need(t.state === STATES.DISPUTED, 'admin can only release a disputed transaction');
    },
    apply: (t, c) => {
      const commission = commissionFor(t.amountMinor, t.policy.commissionPct);
      return { commissionMinor: commission, payoutMinor: t.amountMinor - commission, releasedAt: c.now, agreementRef: c.agreementRef || `AGR-${t.reference}`, resolvedBy: c.actor === ACTORS.ADMIN ? c.actorId : null };
    }
  },
  // Seller can refund unilaterally at any time while money is held: no dispute needed.
  seller_cancel: {
    from: [STATES.HELD, STATES.VIEWING_CONFIRMED], to: STATES.REFUNDED, by: [ACTORS.SELLER],
    apply: (t, c) => ({ refundedAt: c.now, refundReason: 'cancelled by seller' })
  },
  // Buyer asking for a refund opens a dispute; the seller or an admin closes it.
  open_dispute: {
    from: [STATES.HELD, STATES.VIEWING_CONFIRMED], to: STATES.DISPUTED, by: [ACTORS.BUYER],
    guard: (t, c) => need(c.reason && c.reason.length >= 10, 'a dispute needs a reason of at least 10 characters'),
    apply: (t, c) => ({ disputeOpenedBy: c.actorId, disputeReason: c.reason, disputeOpenedAt: c.now })
  },
  seller_agrees_refund: {
    from: [STATES.DISPUTED], to: STATES.REFUNDED, by: [ACTORS.SELLER],
    apply: (t, c) => ({ refundedAt: c.now, refundReason: 'agreed by seller' })
  },
  admin_refund: {
    from: [STATES.DISPUTED], to: STATES.REFUNDED, by: [ACTORS.ADMIN],
    apply: (t, c) => ({ refundedAt: c.now, refundReason: 'admin decision', resolvedBy: c.actorId })
  },
  // Scheduler: deadlines passed without the needed confirmations.
  auto_refund: {
    from: [STATES.HELD, STATES.VIEWING_CONFIRMED], to: STATES.REFUNDED, by: [ACTORS.SYSTEM],
    guard: (t, c) => {
      const deadline = t.state === STATES.HELD ? t.viewingDeadline : t.handoverDeadline;
      need(deadline && c.now >= deadline, 'deadline has not passed');
    },
    apply: (t, c) => ({ refundedAt: c.now, refundReason: t.state === STATES.HELD ? 'no viewing confirmed in time' : 'no handover confirmed in time' })
  }
});

const DAY = 24 * 3600 * 1000;

export class TransitionError extends Error {
  constructor(message, code) { super(message); this.name = 'TransitionError'; this.code = code; }
}
function need(cond, msg) { if (!cond) throw new TransitionError(msg, 'precondition'); }

export function commissionFor(amountMinor, pct) { return Math.round(amountMinor * pct) / 100 | 0; }

/** Deposit held for a listing, per country policy. */
export function amountToHold({ type, agreedPriceMinor }, policy) {
  if (type === 'rent') return agreedPriceMinor * (1 + policy.rentDepositMonths);
  return Math.round(agreedPriceMinor * policy.depositPctSale / 100);
}

/** Create a new transaction object in INITIATED. */
export function createTransaction({ reference, listing, buyerId, sellerId, agreedPriceMinor, currency, policy }) {
  if (buyerId === sellerId) throw new TransitionError('buyer and seller must differ', 'invalid');
  return {
    reference, listingId: listing.id, listingType: listing.type, buyerId, sellerId, currency, policy,
    agreedPriceMinor, amountMinor: amountToHold({ type: listing.type, agreedPriceMinor }, policy),
    state: STATES.INITIATED, history: []
  };
}

/** Which transitions the given actor could take right now (for building UIs). */
export function available(txn, actor) {
  return Object.entries(TRANSITIONS).filter(([, tr]) => tr.from.includes(txn.state) && tr.by.includes(actor)).map(([name]) => name);
}

/**
 * Apply a named transition. Returns a NEW transaction object; the caller persists it
 * and the history entries (one row each in transaction_transitions).
 * ctx: { actor, actorId?, now, ...transition-specific fields }
 */
export function transition(txn, name, ctx) {
  const tr = TRANSITIONS[name];
  if (!tr) throw new TransitionError(`unknown transition ${name}`, 'unknown');
  if (TERMINAL.has(txn.state)) throw new TransitionError(`transaction is ${txn.state}; no further changes`, 'terminal');
  if (!tr.from.includes(txn.state)) throw new TransitionError(`${name} is not allowed from ${txn.state}`, 'state');
  if (!tr.by.includes(ctx.actor)) throw new TransitionError(`${ctx.actor} may not ${name}`, 'actor');
  if (ctx.actor === ACTORS.BUYER && ctx.actorId && ctx.actorId !== txn.buyerId) throw new TransitionError('not the buyer of this transaction', 'actor');
  if (ctx.actor === ACTORS.SELLER && ctx.actorId && ctx.actorId !== txn.sellerId) throw new TransitionError('not the seller of this transaction', 'actor');
  if (tr.guard) tr.guard(txn, ctx);
  const patch = tr.apply ? tr.apply(txn, ctx) : {};
  let next = { ...txn, ...patch, state: tr.to, history: [...txn.history, { at: ctx.now, from: txn.state, to: tr.to, transition: name, actor: ctx.actor, actorId: ctx.actorId || null }] };
  const chained = tr.then && tr.then(next, ctx);
  if (chained) next = transition(next, chained, { ...ctx, actor: ACTORS.SYSTEM, actorId: null });
  return next;
}

/** Scheduler helper: returns the transition the system should apply now, if any. */
export function dueSystemTransition(txn, now) {
  if (txn.state === STATES.HELD && txn.viewingDeadline && now >= txn.viewingDeadline) return 'auto_refund';
  if (txn.state === STATES.VIEWING_CONFIRMED && txn.handoverDeadline && now >= txn.handoverDeadline) return 'auto_refund';
  if (txn.state === STATES.PAYMENT_PENDING && txn.history.length && now - txn.history.at(-1).at > 2 * 3600 * 1000) return 'expire_collection';
  return null;
}
