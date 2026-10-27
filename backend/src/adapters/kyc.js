// KYC adapters: start a document + liveness check, parse the provider's webhook, fetch a result.
// Noble never stores document images; the client uploads to the provider's hosted flow (redirectUrl).
import crypto from 'node:crypto';
import { config } from '../config.js';

const hashDoc = n => crypto.createHmac('sha256', config.idHashSecret).update(String(n).replace(/\s+/g, '').toUpperCase()).digest('hex');

export function sandboxKyc() {
  return {
    id: 'sandbox', live: false,
    async start(req) {
      const checkId = 'KYC-SBX-' + crypto.randomBytes(4).toString('hex');
      const auto = config.kyc.sandboxAutoVerify;
      return { checkId, redirectUrl: null, immediate: auto ? { checkId, status: 'verified', documentNumberHash: hashDoc(req.documentNumber || checkId), last4: String(req.documentNumber || '0000').slice(-4) } : null };
    },
    async parseWebhook({ body }) { const e = JSON.parse(body.toString()); return { checkId: e.checkId, status: e.status, documentNumberHash: hashDoc(e.documentNumber || e.checkId), last4: String(e.documentNumber || '0000').slice(-4) }; },
    async fetch(checkId) { return { checkId, status: 'pending' }; }
  };
}

/* Smile Identity: Enhanced KYC + Document Verification via hosted web links. https://docs.usesmileid.com */
export function smileIdKyc(c = config.kyc.smile_id) {
  const base = c.env === 'production' ? 'https://api.smileidentity.com/v1' : 'https://testapi.smileidentity.com/v1';
  const sig = ts => crypto.createHmac('sha256', c.apiKey).update(ts + c.partnerId + 'sid_request').digest('base64');
  return {
    id: 'smile_id', live: true,
    async start(req) {
      const timestamp = new Date().toISOString();
      const r = await fetch(`${base}/smile_links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ partner_id: c.partnerId, signature: sig(timestamp), timestamp, name: 'Noble verification', company_name: 'Noble', id_types: [{ country: req.country, id_type: req.documentType.toUpperCase(), verification_method: 'doc_verification' }], callback_url: req.callbackUrl, user_id: req.userId, data_privacy_policy_url: req.privacyUrl, logo_url: req.logoUrl, is_single_use: true, partner_params: { user_id: req.userId } }) });
      const d = await r.json(); if (!r.ok) throw new Error(`smile_id: ${JSON.stringify(d).slice(0, 200)}`);
      return { checkId: d.ref_id, redirectUrl: d.link, immediate: null };
    },
    async parseWebhook({ body }) {
      const e = JSON.parse(body.toString());
      const expected = crypto.createHmac('sha256', c.apiKey).update(e.timestamp + c.partnerId + 'sid_request').digest('base64');
      if (e.signature !== expected) throw new Error('smile_id: bad signature');
      const ok = ['0810', '1020', '1012'].includes(String(e.ResultCode)); // verified codes per Smile ID result-code table
      return { checkId: e.PartnerParams?.job_id || e.ref_id, userId: e.PartnerParams?.user_id, status: ok ? 'verified' : 'rejected', documentNumberHash: hashDoc(e.IDNumber || e.ref_id), last4: String(e.IDNumber || '0000').slice(-4), reasons: ok ? [] : [e.ResultText] };
    },
    async fetch(checkId) {
      const timestamp = new Date().toISOString();
      const r = await fetch(`${base}/job_status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ partner_id: c.partnerId, signature: sig(timestamp), timestamp, job_id: checkId, user_id: checkId }) });
      const d = await r.json(); return { checkId, status: d.job_complete ? (d.job_success ? 'verified' : 'rejected') : 'pending' };
    }
  };
}

/* Onfido: applicant + SDK token + check with document and facial similarity. https://documentation.onfido.com */
export function onfidoKyc(c = config.kyc.onfido) {
  const base = 'https://api.eu.onfido.com/v3.6', h = { Authorization: `Token token=${c.token}`, 'Content-Type': 'application/json' };
  return {
    id: 'onfido', live: true,
    async start(req) {
      const [first, ...rest] = req.fullName.split(' ');
      const a = await (await fetch(`${base}/applicants`, { method: 'POST', headers: h, body: JSON.stringify({ first_name: first, last_name: rest.join(' ') || first, location: { country_of_residence: req.country } }) })).json();
      const w = await (await fetch(`${base}/workflow_runs`, { method: 'POST', headers: h, body: JSON.stringify({ applicant_id: a.id, workflow_id: req.workflowId || process.env.ONFIDO_WORKFLOW_ID, link: { completed_redirect_url: req.returnUrl } }) })).json();
      return { checkId: w.id, redirectUrl: w.link?.url, immediate: null };
    },
    async parseWebhook({ headers, body }) {
      const expected = crypto.createHmac('sha256', c.webhookToken).update(body).digest('hex');
      if (expected !== (headers['x-sha2-signature'] || '')) throw new Error('onfido: bad signature');
      const e = JSON.parse(body.toString()); const o = e.payload?.object || {};
      const status = o.status === 'approved' ? 'verified' : o.status === 'declined' ? 'rejected' : 'pending';
      return { checkId: o.id, status, documentNumberHash: hashDoc(o.id), last4: '••••', reasons: status === 'rejected' ? [o.output?.reason || 'declined'] : [] };
    },
    async fetch(checkId) { const w = await (await fetch(`${base}/workflow_runs/${checkId}`, { headers: h })).json(); return { checkId, status: w.status === 'approved' ? 'verified' : w.status === 'declined' ? 'rejected' : 'pending' }; }
  };
}

export function kycForCountry(country) {
  const p = config.kycProviderFor(country);
  if (p === 'smile_id' && config.kyc.smile_id.configured) return smileIdKyc();
  if (p === 'onfido' && config.kyc.onfido.configured) return onfidoKyc();
  return sandboxKyc();
}
export function kycById(id) { return id === 'smile_id' ? smileIdKyc() : id === 'onfido' ? onfidoKyc() : sandboxKyc(); }
export { hashDoc };
