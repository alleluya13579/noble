// Identity: phone OTP sessions, KYC start/webhook, user serialisation, authorisation helpers.
import crypto from 'node:crypto';
import { config } from './config.js';
import { bad, unauth, forbidden, tooMany, notFound } from './http.js';
import { smsFor } from './adapters/sms.js';
import { kycForCountry, kycById } from './adapters/kyc.js';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const E164 = /^\+[1-9]\d{6,14}$/;

export async function publicUser(db, u) {
  if (!u) return null;
  const r = await db.get('SELECT COUNT(*) n, AVG(stars) avg FROM ratings WHERE to_user_id = ?', u.id);
  const deals = (await db.get("SELECT COUNT(*) n FROM transactions WHERE state = 'released' AND (buyer_id = ? OR seller_id = ?)", u.id, u.id)).n;
  return { id: u.id, full_name: u.full_name, role: u.role, country: u.country_code, verified: u.kyc_status === 'verified' && !!u.phone_verified_at, kyc_status: u.kyc_status,
    agent_licence: u.agent_licence, rating: { avg: r.avg ? +Number(r.avg).toFixed(2) : null, count: Number(r.n) }, deals_completed: Number(deals), member_since: new Date(Number(u.member_since)).toISOString().slice(0, 10), suspended: !!u.suspended_at };
}

export function makeAuth(db) {
  return async function authenticate(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return null;
    return db.get('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?', sha(m[1]), Date.now());
  };
}
export const requireUser = ctx => { if (!ctx.user) throw unauth(); if (ctx.user.suspended_at) throw forbidden('account suspended: ' + (ctx.user.suspended_reason || 'contact support')); return ctx.user; };
export const requireVerified = ctx => { const u = requireUser(ctx); if (u.role !== 'admin' && !(u.kyc_status === 'verified' && u.phone_verified_at)) throw forbidden('complete ID and phone verification first'); return u; };
export const requireRole = (...roles) => ctx => { const u = requireUser(ctx); if (!roles.includes(u.role)) throw forbidden(`requires role ${roles.join(' or ')}`); return u; };

export function registerAuthRoutes(r, db) {
  r.get('/countries', async () => (await db.all('SELECT * FROM countries ORDER BY name')).map(c => ({ code: c.code, name: c.name, currency: c.currency, phone_prefix: c.phone_prefix, id_document_types: JSON.parse(c.id_document_types), payment_methods: JSON.parse(c.payment_methods), land_registry: c.land_registry, default_locale: c.default_locale, center: { lat: c.center_lat, lng: c.center_lng },
    policy: { deposit_pct_sale: c.deposit_pct_sale, rent_deposit_months: c.rent_deposit_months, viewing_days: c.viewing_days, handover_days: c.handover_days, commission_pct: c.commission_pct } })));

  r.post('/auth/otp', async ctx => {
    const phone = String(ctx.body.phone_e164 || '').replace(/\s+/g, '');
    if (!E164.test(phone)) throw bad('phone_e164 must be in E.164 form, e.g. +254712345678');
    if (!(await db.allow(phone, 'otp_send', 5, 15 * 60e3)) || !(await db.allow(ctx.ip || 'ip', 'otp_send_ip', 30, 15 * 60e3))) throw tooMany('too many codes requested; wait 15 minutes');
    const code = String(crypto.randomInt(100000, 999999));
    await db.run('INSERT INTO otp_codes (phone_e164, code_hash, attempts, expires_at) VALUES (?,?,0,?) ON CONFLICT(phone_e164) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at', phone, sha(code + config.sessionSecret), Date.now() + 10 * 60e3);
    await smsFor(phone).send(phone, `Your Noble code is ${code}. It expires in 10 minutes.`);
    return [200, { sent: true, ...(config.isDev ? { dev_code: code } : {}) }];
  });

  r.post('/auth/otp/verify', async ctx => {
    const phone = String(ctx.body.phone_e164 || '').replace(/\s+/g, ''), code = String(ctx.body.code || '');
    const row = await db.get('SELECT * FROM otp_codes WHERE phone_e164 = ?', phone);
    if (!row || row.expires_at < Date.now()) throw bad('request a new code');
    if (row.attempts >= 5) throw tooMany('too many attempts; request a new code');
    if (row.code_hash !== sha(code + config.sessionSecret)) { await db.run('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone_e164 = ?', phone); throw bad('wrong code'); }
    await db.run('DELETE FROM otp_codes WHERE phone_e164 = ?', phone);
    let user = await db.get('SELECT * FROM users WHERE phone_e164 = ?', phone);
    if (!user) {
      const country = String(ctx.body.country || '').toUpperCase(), c = await db.country(country);
      if (!c) throw bad('country is required for a new account (ISO code, e.g. KE)');
      const role = config.adminPhones.includes(phone) ? 'admin' : ['buyer', 'seller', 'agent'].includes(ctx.body.role) ? ctx.body.role : 'buyer';
      const name = String(ctx.body.full_name || '').trim(); if (name.length < 2) throw bad('full_name is required for a new account');
      const id = db.uuid();
      await db.run('INSERT INTO users (id, country_code, role, full_name, phone_e164, phone_verified_at, agent_licence, locale, member_since, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, country, role, name, phone, Date.now(), ctx.body.agent_licence || null, c.default_locale, Date.now(), Date.now());
      user = await db.get('SELECT * FROM users WHERE id = ?', id);
    } else await db.run('UPDATE users SET phone_verified_at = ? WHERE id = ?', Date.now(), user.id);
    const token = crypto.randomBytes(32).toString('base64url');
    await db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', sha(token), user.id, Date.now(), Date.now() + 30 * 86400e3);
    return { token, user: await publicUser(db, await db.get('SELECT * FROM users WHERE id = ?', user.id)) };
  });

  r.get('/me', ctx => publicUser(db, requireUser(ctx)));
  r.post('/auth/logout', async ctx => { requireUser(ctx); const m = /^Bearer (.+)$/.exec(ctx.req.headers.authorization || ''); await db.run('DELETE FROM sessions WHERE token_hash = ?', sha(m[1])); return [204]; });
  r.post('/auth/logout-all', async ctx => { const u = requireUser(ctx); await db.run('DELETE FROM sessions WHERE user_id = ?', u.id); return [204]; });

  r.post('/auth/kyc', async ctx => {
    const u = requireUser(ctx), c = await db.country(u.country_code);
    const docType = String(ctx.body.document_type || '');
    if (!c.id_document_types.includes(docType)) throw bad(`document_type must be one of ${c.id_document_types.join(', ')}`);
    const kyc = kycForCountry(u.country_code);
    const res = await kyc.start({ userId: u.id, country: u.country_code, documentType: docType, documentNumber: ctx.body.document_number, fullName: u.full_name, phoneE164: u.phone_e164, locale: u.locale, callbackUrl: `${config.baseUrl}/webhooks/kyc/${kyc.id}`, returnUrl: ctx.body.return_url });
    await db.run("UPDATE users SET kyc_status = 'pending', kyc_provider = ?, kyc_ref = ? WHERE id = ?", kyc.id, res.checkId, u.id);
    if (res.immediate) await applyKycResult(db, u.id, res.immediate);
    return [202, { check_id: res.checkId, redirect_url: res.redirectUrl, provider: kyc.id, mode: kyc.live ? 'live' : 'sandbox', status: (await db.get('SELECT kyc_status FROM users WHERE id = ?', u.id)).kyc_status }];
  });

  r.post('/webhooks/kyc/:provider', async ctx => {
    const kyc = kycById(ctx.params.provider);
    const result = await kyc.parseWebhook({ headers: ctx.req.headers, body: ctx.raw });
    const u = result.userId ? await db.get('SELECT * FROM users WHERE id = ?', result.userId) : await db.get('SELECT * FROM users WHERE kyc_ref = ?', result.checkId);
    if (!u) throw notFound('no user for this check');
    await applyKycResult(db, u.id, result);
    return [200, { ok: true }];
  });
}

export async function applyKycResult(db, userId, result) {
  if (result.status === 'verified') {
    const dup = await db.get('SELECT id FROM users WHERE id_doc_hash = ? AND id <> ?', result.documentNumberHash, userId);
    if (dup) { await db.run("UPDATE users SET kyc_status = 'rejected' WHERE id = ?", userId); await db.audit(null, 'kyc_duplicate_document', 'user', userId, { matches: dup.id }); return; }
    await db.run("UPDATE users SET kyc_status = 'verified', id_doc_hash = ?, id_last4 = ? WHERE id = ?", result.documentNumberHash, result.last4, userId);
  } else if (result.status === 'rejected') await db.run("UPDATE users SET kyc_status = 'rejected' WHERE id = ?", userId);
  await db.audit(null, 'kyc_' + result.status, 'user', userId, { reasons: result.reasons || [] });
}
