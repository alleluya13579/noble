// Provider adapters. One interface per concern; countries pick adapters by id
// (see countries.payment_methods and id_document_types in schema.sql).
// Real implementations live in backend/src/adapters/<id>.js and are loaded by id.
// The contracts below are what the transaction process and the API depend on.

/**
 * @typedef {object} PaymentGateway
 * @property {string} id                       e.g. 'mpesa', 'mtn_momo', 'paystack_bank', 'card', 'stripe'
 * @property {string[]} countries              ISO codes it serves
 * @property {(req: CollectRequest) => Promise<CollectResult>} collect
 *   Ask the payer for the money (STK push, card authorisation, bank transfer instructions).
 *   Must be idempotent on req.idempotencyKey: a retry returns the same gatewayRef.
 * @property {(raw: {headers: object, body: string}) => Promise<GatewayEvent>} parseWebhook
 *   Verify the signature and normalise the event. Must throw when the signature is invalid;
 *   the transaction process only trusts events with verifiedSignature === true.
 * @property {(req: PayoutRequest) => Promise<{gatewayRef: string}>} payout
 *   Send money to the seller (B2C, bank transfer, Stripe transfer). Idempotent as above.
 * @property {(req: RefundRequest) => Promise<{gatewayRef: string}>} refund
 *   Return money to the buyer. Idempotent as above.
 * @property {(gatewayRef: string) => Promise<GatewayEvent>} reconcile
 *   Query the provider for the true status of a collection. Called when a webhook is late or a
 *   request timed out: with mobile money a timeout does not mean the money did not move.
 */

/**
 * @typedef {object} CollectRequest
 * @property {string} idempotencyKey
 * @property {string} reference            Noble transaction reference, shown on the payer's statement
 * @property {number} amountMinor
 * @property {string} currency
 * @property {string} payerAccount         phone number (E.164) or card/bank token
 * @property {string} callbackUrl
 */
/** @typedef {{gatewayRef: string, status: 'pending'|'confirmed'|'failed', message?: string}} CollectResult */
/** @typedef {{gatewayRef: string, gatewayEventId: string, type: 'collect_confirmed'|'collect_failed'|'payout_confirmed'|'refund_confirmed', amountMinor: number, currency: string, verifiedSignature: boolean, raw: object}} GatewayEvent */
/** @typedef {{idempotencyKey: string, reference: string, amountMinor: number, currency: string, payeeAccount: string}} PayoutRequest */
/** @typedef {{idempotencyKey: string, originalGatewayRef: string, amountMinor: number, currency: string}} RefundRequest */

/**
 * @typedef {object} KycProvider
 * @property {string} id                       e.g. 'smile_identity', 'onfido', 'idswyft_selfhosted'
 * @property {string[]} countries
 * @property {string[]} documentTypes          which of countries.id_document_types it can read
 * @property {(req: KycRequest) => Promise<{checkId: string, redirectUrl?: string}>} start
 *   Begin a document + liveness check. Document images go straight to the provider from the
 *   client where possible; Noble never stores raw document images.
 * @property {(raw: {headers: object, body: string}) => Promise<KycResult>} parseWebhook
 * @property {(checkId: string) => Promise<KycResult>} fetch
 */
/** @typedef {{userId: string, country: string, documentType: string, fullName: string, phoneE164: string, locale: string}} KycRequest */
/** @typedef {{checkId: string, status: 'pending'|'verified'|'rejected', documentNumberHash: string, last4: string, reasons?: string[]}} KycResult */

/**
 * @typedef {object} SmsProvider
 * @property {string} id                       e.g. 'africastalking', 'twilio'
 * @property {(to: string, body: string) => Promise<{messageId: string}>} send
 */

/**
 * @typedef {object} MapProvider
 * @property {string} id                       e.g. 'mapbox', 'google', 'osm'
 * @property {(q: string, country: string) => Promise<Array<{label: string, lat: number, lng: number}>>} geocode
 * @property {(lat: number, lng: number) => Promise<{placeName: string}>} reverse
 */

/** Simple registry so the rest of the code never imports a provider directly. */
export class AdapterRegistry {
  #byId = new Map();
  register(kind, adapter) { this.#byId.set(`${kind}:${adapter.id}`, adapter); return this; }
  get(kind, id) {
    const a = this.#byId.get(`${kind}:${id}`);
    if (!a) throw new Error(`no ${kind} adapter registered with id ${id}`);
    return a;
  }
  /** Adapters of a kind that serve a country, in the order the country lists them. */
  forCountry(kind, country) {
    return country[kind === 'payment' ? 'paymentMethods' : 'idDocumentTypes']
      .map(id => this.#byId.get(`${kind}:${id}`)).filter(Boolean);
  }
}

/** In-memory gateway for tests and the prototype. Confirms instantly, never fails. */
export function mockGateway(id = 'mock', countries = ['*']) {
  const seen = new Map();
  return {
    id, countries,
    async collect(req) { if (!seen.has(req.idempotencyKey)) seen.set(req.idempotencyKey, `${id}-${seen.size + 1}`); return { gatewayRef: seen.get(req.idempotencyKey), status: 'confirmed' }; },
    async parseWebhook({ body }) { const e = JSON.parse(body); return { ...e, verifiedSignature: true, raw: e }; },
    async payout(req) { return { gatewayRef: `${id}-out-${req.idempotencyKey}` }; },
    async refund(req) { return { gatewayRef: `${id}-ref-${req.idempotencyKey}` }; },
    async reconcile(ref) { return { gatewayRef: ref, gatewayEventId: `${ref}-r`, type: 'collect_confirmed', amountMinor: 0, currency: '', verifiedSignature: true, raw: {} }; }
  };
}
