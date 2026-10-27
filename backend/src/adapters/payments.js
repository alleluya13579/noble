// Payment gateway adapters. Each implements the PaymentGateway contract from ../adapters.js:
//   collect(req) -> {gatewayRef, status, message?, redirectUrl?}
//   parseWebhook({headers, body}) -> GatewayEvent   (throws if the signature is bad)
//   payout(req) -> {gatewayRef}      refund(req) -> {gatewayRef}      reconcile(gatewayRef) -> GatewayEvent
// Every adapter has a `live` flag. When its keys are missing it is replaced by the sandbox adapter,
// which simulates the provider: collect() confirms immediately and the server applies the
// confirmation as if a signed webhook had arrived.
import crypto from 'node:crypto';
import { config } from '../config.js';

const json = async (url, { method = 'POST', headers = {}, body, auth } = {}) => {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`${url} -> ${r.status}: ${text.slice(0, 300)}`);
  return data;
};
const sigEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/* ---------- Sandbox: no keys, no money ---------- */
export function sandboxGateway(id = 'sandbox') {
  const refs = new Map();
  return {
    id, live: false,
    async collect(req) {
      if (!refs.has(req.idempotencyKey)) refs.set(req.idempotencyKey, `SBX-${crypto.randomBytes(4).toString('hex').toUpperCase()}`);
      return { gatewayRef: refs.get(req.idempotencyKey), status: 'confirmed', message: 'sandbox: payment simulated' };
    },
    async parseWebhook({ body }) { const e = JSON.parse(body.toString()); return { gatewayRef: e.gatewayRef, gatewayEventId: e.gatewayEventId || crypto.randomUUID(), type: e.type, amountMinor: e.amountMinor, currency: e.currency, verifiedSignature: true, raw: e }; },
    async payout(req) { return { gatewayRef: `SBX-OUT-${req.idempotencyKey.slice(0, 8)}` }; },
    async refund(req) { return { gatewayRef: `SBX-REF-${req.idempotencyKey.slice(0, 8)}` }; },
    async reconcile(ref) { return { gatewayRef: ref, gatewayEventId: `${ref}-reconcile`, type: 'collect_confirmed', amountMinor: 0, currency: '', verifiedSignature: true, raw: {} }; }
  };
}

/* ---------- Safaricom M-Pesa (Daraja) ---------- */
export function mpesaGateway(c = config.payments.mpesa) {
  const base = c.env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  let token = null, tokenExp = 0;
  async function auth() {
    if (token && Date.now() < tokenExp) return `Bearer ${token}`;
    const r = await json(`${base}/oauth/v1/generate?grant_type=client_credentials`, { method: 'GET', auth: 'Basic ' + Buffer.from(`${c.key}:${c.secret}`).toString('base64') });
    token = r.access_token; tokenExp = Date.now() + (+r.expires_in - 60) * 1000; return `Bearer ${token}`;
  }
  const stamp = () => new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return {
    id: 'mpesa', live: true,
    async collect(req) {
      const ts = stamp();
      const r = await json(`${base}/mpesa/stkpush/v1/processrequest`, { auth: await auth(), body: {
        BusinessShortCode: c.shortcode, Password: Buffer.from(c.shortcode + c.passkey + ts).toString('base64'), Timestamp: ts,
        TransactionType: 'CustomerPayBillOnline', Amount: Math.round(req.amountMinor / 100), PartyA: req.payerAccount.replace('+', ''), PartyB: c.shortcode,
        PhoneNumber: req.payerAccount.replace('+', ''), CallBackURL: req.callbackUrl, AccountReference: req.reference, TransactionDesc: `Noble escrow ${req.reference}` } });
      return { gatewayRef: r.CheckoutRequestID, status: 'pending', message: r.CustomerMessage };
    },
    async parseWebhook({ body }) {
      // Daraja does not sign callbacks: the callback URL must be unguessable (we include a per-transaction secret) and
      // every callback is reconciled with a query before funds are considered held.
      const e = JSON.parse(body.toString()); const cb = e.Body?.stkCallback || {};
      const items = Object.fromEntries((cb.CallbackMetadata?.Item || []).map(i => [i.Name, i.Value]));
      return { gatewayRef: cb.CheckoutRequestID, gatewayEventId: cb.CheckoutRequestID + ':' + cb.ResultCode, type: cb.ResultCode === 0 ? 'collect_confirmed' : 'collect_failed',
        amountMinor: Math.round((items.Amount || 0) * 100), currency: 'KES', verifiedSignature: false, needsReconcile: true, raw: e };
    },
    async reconcile(ref) {
      const ts = stamp();
      const r = await json(`${base}/mpesa/stkpushquery/v1/query`, { auth: await auth(), body: { BusinessShortCode: c.shortcode, Password: Buffer.from(c.shortcode + c.passkey + ts).toString('base64'), Timestamp: ts, CheckoutRequestID: ref } });
      return { gatewayRef: ref, gatewayEventId: ref + ':query:' + r.ResultCode, type: String(r.ResultCode) === '0' ? 'collect_confirmed' : 'collect_failed', amountMinor: null, currency: 'KES', verifiedSignature: true, raw: r };
    },
    async payout(req) {
      const r = await json(`${base}/mpesa/b2c/v3/paymentrequest`, { auth: await auth(), body: { OriginatorConversationID: req.idempotencyKey, InitiatorName: c.initiator, SecurityCredential: c.securityCredential, CommandID: 'BusinessPayment',
        Amount: Math.round(req.amountMinor / 100), PartyA: c.shortcode, PartyB: req.payeeAccount.replace('+', ''), Remarks: `Noble ${req.reference}`, QueueTimeOutURL: req.callbackUrl, ResultURL: req.callbackUrl, Occasion: req.reference } });
      return { gatewayRef: r.ConversationID };
    },
    async refund(req) { return this.payout({ ...req, payeeAccount: req.payerAccount }); } // M-Pesa refunds are B2C payments back to the payer
  };
}

/* ---------- Paystack ---------- */
export function paystackGateway(c = config.payments.paystack) {
  const base = 'https://api.paystack.co', auth = `Bearer ${c.secret}`;
  return {
    id: 'paystack', live: true,
    async collect(req) {
      const r = await json(`${base}/transaction/initialize`, { auth, body: { email: req.payerEmail || `${req.reference.toLowerCase()}@noble.invalid`, amount: req.amountMinor, currency: req.currency, reference: req.idempotencyKey, callback_url: req.returnUrl, metadata: { noble_reference: req.reference } } });
      return { gatewayRef: r.data.reference, status: 'pending', redirectUrl: r.data.authorization_url };
    },
    async parseWebhook({ headers, body }) {
      const expected = crypto.createHmac('sha512', c.secret).update(body).digest('hex');
      if (!sigEq(expected, headers['x-paystack-signature'] || '')) throw new Error('paystack: bad signature');
      const e = JSON.parse(body.toString()); const d = e.data || {};
      const type = { 'charge.success': 'collect_confirmed', 'transfer.success': 'payout_confirmed', 'transfer.failed': 'payout_failed', 'refund.processed': 'refund_confirmed' }[e.event] || e.event;
      return { gatewayRef: d.reference || d.transfer_code, gatewayEventId: `${e.event}:${d.id}`, type, amountMinor: d.amount, currency: d.currency, verifiedSignature: true, raw: e };
    },
    async reconcile(ref) {
      const r = await json(`${base}/transaction/verify/${encodeURIComponent(ref)}`, { method: 'GET', auth });
      return { gatewayRef: ref, gatewayEventId: `verify:${r.data.id}:${r.data.status}`, type: r.data.status === 'success' ? 'collect_confirmed' : 'collect_failed', amountMinor: r.data.amount, currency: r.data.currency, verifiedSignature: true, raw: r };
    },
    async payout(req) {
      const rec = await json(`${base}/transferrecipient`, { auth, body: { type: req.payeeBank ? 'nuban' : 'mobile_money', name: req.payeeName || 'Noble seller', account_number: req.payeeAccount, bank_code: req.payeeBank || 'MPESA', currency: req.currency } });
      const r = await json(`${base}/transfer`, { auth, body: { source: 'balance', amount: req.amountMinor, recipient: rec.data.recipient_code, reason: `Noble ${req.reference}`, reference: req.idempotencyKey } });
      return { gatewayRef: r.data.transfer_code };
    },
    async refund(req) { const r = await json(`${base}/refund`, { auth, body: { transaction: req.originalGatewayRef, amount: req.amountMinor } }); return { gatewayRef: String(r.data.id) }; }
  };
}

/* ---------- Flutterwave (MTN MoMo, Airtel, Tigo, cards) ---------- */
export function flutterwaveGateway(c = config.payments.flutterwave) {
  const base = 'https://api.flutterwave.com/v3', auth = `Bearer ${c.secret}`;
  const network = m => ({ mtn_momo: 'MTN', airtel_money: 'AIRTEL', tigo_pesa: 'TIGO', mpesa_tz: 'MPESA' }[m]);
  return {
    id: 'flutterwave', live: true,
    async collect(req) {
      const country = { UGX: 'UG', GHS: 'GH', RWF: 'RW', TZS: 'TZ', KES: 'KE' }[req.currency];
      const path = { UG: 'mobile_money_uganda', GH: 'mobile_money_ghana', RW: 'mobile_money_rwanda', TZ: 'mobile_money_tanzania', KE: 'mpesa' }[country] || 'mobile_money_uganda';
      const r = await json(`${base}/charges?type=${path}`, { auth, body: { tx_ref: req.idempotencyKey, amount: req.amountMinor / 100, currency: req.currency, email: req.payerEmail || `${req.reference.toLowerCase()}@noble.invalid`, phone_number: req.payerAccount.replace('+', ''), network: network(req.method), redirect_url: req.returnUrl, meta: { noble_reference: req.reference } } });
      return { gatewayRef: r.data?.flw_ref || req.idempotencyKey, status: 'pending', redirectUrl: r.meta?.authorization?.redirect, message: r.message };
    },
    async parseWebhook({ headers, body }) {
      if (!sigEq(c.webhookHash || '', headers['verif-hash'] || '')) throw new Error('flutterwave: bad verif-hash');
      const e = JSON.parse(body.toString()); const d = e.data || {};
      const type = e.event === 'charge.completed' ? (d.status === 'successful' ? 'collect_confirmed' : 'collect_failed') : e.event === 'transfer.completed' ? (d.status === 'SUCCESSFUL' ? 'payout_confirmed' : 'payout_failed') : e.event;
      return { gatewayRef: d.flw_ref || d.tx_ref || d.reference, gatewayEventId: `${e.event}:${d.id}`, type, amountMinor: Math.round((d.amount || 0) * 100), currency: d.currency, verifiedSignature: true, raw: e };
    },
    async reconcile(ref) {
      const r = await json(`${base}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(ref)}`, { method: 'GET', auth });
      return { gatewayRef: ref, gatewayEventId: `verify:${r.data?.id}:${r.data?.status}`, type: r.data?.status === 'successful' ? 'collect_confirmed' : 'collect_failed', amountMinor: Math.round((r.data?.amount || 0) * 100), currency: r.data?.currency, verifiedSignature: true, raw: r };
    },
    async payout(req) {
      const r = await json(`${base}/transfers`, { auth, body: { account_bank: req.payeeBank || network(req.method) || 'MPS', account_number: req.payeeAccount.replace('+', ''), amount: req.amountMinor / 100, currency: req.currency, reference: req.idempotencyKey, narration: `Noble ${req.reference}`, callback_url: req.callbackUrl } });
      return { gatewayRef: String(r.data.id) };
    },
    async refund(req) { const r = await json(`${base}/transactions/${encodeURIComponent(req.originalGatewayRef)}/refund`, { auth, body: { amount: req.amountMinor / 100 } }); return { gatewayRef: String(r.data?.id) }; }
  };
}

/* ---------- Stripe (manual capture holds, refunds, Connect transfers) ---------- */
export function stripeGateway(c = config.payments.stripe) {
  const base = 'https://api.stripe.com/v1', auth = `Bearer ${c.secret}`;
  const form = async (path, params, method = 'POST', idem) => {
    const r = await fetch(base + path, { method, headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded', ...(idem ? { 'Idempotency-Key': idem } : {}) }, body: method === 'GET' ? undefined : new URLSearchParams(params) });
    const d = await r.json(); if (!r.ok) throw new Error(`stripe ${path}: ${d.error?.message}`); return d;
  };
  return {
    id: 'stripe', live: true,
    async collect(req) {
      // Authorise now, capture when both sides confirm handover (capture happens in payout()).
      const pi = await form('/payment_intents', { amount: req.amountMinor, currency: req.currency.toLowerCase(), capture_method: 'manual', payment_method: req.payerAccount, confirm: 'true', 'metadata[noble_reference]': req.reference, return_url: req.returnUrl || req.callbackUrl }, 'POST', req.idempotencyKey);
      return { gatewayRef: pi.id, status: pi.status === 'requires_capture' ? 'confirmed' : 'pending', redirectUrl: pi.next_action?.redirect_to_url?.url };
    },
    async parseWebhook({ headers, body }) {
      const sig = Object.fromEntries((headers['stripe-signature'] || '').split(',').map(p => p.split('=')));
      const expected = crypto.createHmac('sha256', c.webhookSecret).update(`${sig.t}.${body}`).digest('hex');
      if (!sig.t || !sigEq(expected, sig.v1 || '') || Math.abs(Date.now() / 1000 - +sig.t) > 300) throw new Error('stripe: bad signature');
      const e = JSON.parse(body.toString()); const o = e.data.object;
      const type = { 'payment_intent.amount_capturable_updated': 'collect_confirmed', 'payment_intent.payment_failed': 'collect_failed', 'payment_intent.canceled': 'refund_confirmed', 'charge.refunded': 'refund_confirmed', 'transfer.created': 'payout_confirmed' }[e.type] || e.type;
      return { gatewayRef: o.payment_intent || o.id, gatewayEventId: e.id, type, amountMinor: o.amount_capturable ?? o.amount, currency: (o.currency || '').toUpperCase(), verifiedSignature: true, raw: e };
    },
    async reconcile(ref) { const pi = await form(`/payment_intents/${ref}`, {}, 'GET'); return { gatewayRef: ref, gatewayEventId: `${ref}:${pi.status}`, type: ['requires_capture', 'succeeded'].includes(pi.status) ? 'collect_confirmed' : 'collect_failed', amountMinor: pi.amount, currency: pi.currency.toUpperCase(), verifiedSignature: true, raw: pi }; },
    async payout(req) {
      await form(`/payment_intents/${req.originalGatewayRef}/capture`, { amount_to_capture: req.grossMinor || req.amountMinor }, 'POST', req.idempotencyKey + ':capture');
      const tr = await form('/transfers', { amount: req.amountMinor, currency: req.currency.toLowerCase(), destination: req.payeeAccount, transfer_group: req.reference }, 'POST', req.idempotencyKey + ':transfer');
      return { gatewayRef: tr.id };
    },
    async refund(req) { const r = await form(`/payment_intents/${req.originalGatewayRef}/cancel`, { cancellation_reason: 'requested_by_customer' }, 'POST', req.idempotencyKey); return { gatewayRef: r.id }; }
  };
}

/** Resolve the gateway for a payment method. Falls back to sandbox when the provider has no keys. */
export function gatewayForMethod(method) {
  const provider = config.paymentProviderFor(method);
  const live = { mpesa: config.payments.mpesa.configured, paystack: config.payments.paystack.configured, flutterwave: config.payments.flutterwave.configured, stripe: config.payments.stripe.configured }[provider];
  if (!live) return sandboxGateway(provider === 'sandbox' ? 'sandbox' : `sandbox:${provider}`);
  return { mpesa: mpesaGateway, paystack: paystackGateway, flutterwave: flutterwaveGateway, stripe: stripeGateway }[provider]();
}
export function gatewayById(id) {
  if (id.startsWith('sandbox')) return sandboxGateway(id);
  const g = { mpesa: mpesaGateway, paystack: paystackGateway, flutterwave: flutterwaveGateway, stripe: stripeGateway }[id];
  if (!g) throw new Error(`unknown gateway ${id}`);
  return g();
}
