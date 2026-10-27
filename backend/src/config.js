// Configuration: reads .env (if present) and the process environment. Every provider reports
// whether it is configured; unconfigured providers run in sandbox mode.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function loadDotenv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
loadDotenv(path.resolve(process.cwd(), '.env'));

const env = (k, d = '') => (process.env[k] ?? d).trim();
const has = (...keys) => keys.every(k => env(k) !== '');

export const config = {
  port: +env('PORT', '8080'),
  env: env('NOBLE_ENV', 'development'),
  isDev: env('NOBLE_ENV', 'development') !== 'production',
  dbPath: env('DATABASE_PATH', './data/noble.sqlite'),
  uploadDir: env('UPLOAD_DIR', './data/uploads'),
  baseUrl: env('PUBLIC_BASE_URL', 'http://localhost:8080'),
  sessionSecret: env('SESSION_SECRET', 'dev-session-secret'),
  idHashSecret: env('ID_HASH_SECRET', 'dev-id-hash-secret'),
  docsKey: env('DOCS_ENCRYPTION_KEY') || crypto.randomBytes(32).toString('hex'),
  adminPhones: env('ADMIN_PHONES').split(',').map(s => s.trim()).filter(Boolean),

  payments: {
    mpesa: { configured: has('MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY'), env: env('MPESA_ENV', 'sandbox'), key: env('MPESA_CONSUMER_KEY'), secret: env('MPESA_CONSUMER_SECRET'), shortcode: env('MPESA_SHORTCODE'), passkey: env('MPESA_PASSKEY'), initiator: env('MPESA_B2C_INITIATOR'), securityCredential: env('MPESA_B2C_SECURITY_CREDENTIAL') },
    paystack: { configured: has('PAYSTACK_SECRET_KEY'), secret: env('PAYSTACK_SECRET_KEY') },
    flutterwave: { configured: has('FLUTTERWAVE_SECRET_KEY'), secret: env('FLUTTERWAVE_SECRET_KEY'), webhookHash: env('FLUTTERWAVE_WEBHOOK_HASH') },
    stripe: { configured: has('STRIPE_SECRET_KEY'), secret: env('STRIPE_SECRET_KEY'), webhookSecret: env('STRIPE_WEBHOOK_SECRET') }
  },
  // Default provider per payment method; PAYMENT_PROVIDER_<METHOD> overrides.
  paymentProviderFor(method) {
    const override = env('PAYMENT_PROVIDER_' + method.toUpperCase());
    if (override) return override;
    return { mpesa: 'mpesa', mpesa_tz: 'flutterwave', airtel_money: 'flutterwave', mtn_momo: 'flutterwave', tigo_pesa: 'flutterwave',
      bank_transfer: 'paystack', ussd: 'paystack', eft: 'paystack', card: 'stripe', open_banking: 'stripe', ach: 'stripe' }[method] || 'sandbox';
  },
  kyc: {
    smile_id: { configured: has('SMILE_ID_PARTNER_ID', 'SMILE_ID_API_KEY'), partnerId: env('SMILE_ID_PARTNER_ID'), apiKey: env('SMILE_ID_API_KEY'), env: env('SMILE_ID_ENV', 'sandbox') },
    onfido: { configured: has('ONFIDO_API_TOKEN'), token: env('ONFIDO_API_TOKEN'), webhookToken: env('ONFIDO_WEBHOOK_TOKEN') },
    sandboxAutoVerify: env('KYC_SANDBOX_AUTO_VERIFY', 'true') === 'true'
  },
  kycProviderFor(country) {
    const override = env('KYC_PROVIDER_' + country.toUpperCase());
    if (override) return override;
    return ['KE', 'UG', 'TZ', 'RW', 'NG', 'GH', 'ZA'].includes(country) ? 'smile_id' : 'onfido';
  },
  sms: {
    africastalking: { configured: has('AFRICASTALKING_USERNAME', 'AFRICASTALKING_API_KEY'), username: env('AFRICASTALKING_USERNAME'), apiKey: env('AFRICASTALKING_API_KEY'), from: env('AFRICASTALKING_SENDER_ID') },
    twilio: { configured: has('TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'), sid: env('TWILIO_ACCOUNT_SID'), token: env('TWILIO_AUTH_TOKEN'), from: env('TWILIO_FROM') }
  },
  maps: { mapbox: { configured: has('MAPBOX_TOKEN'), token: env('MAPBOX_TOKEN') } },
  storage: { s3: { configured: has('S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'), endpoint: env('S3_ENDPOINT'), bucket: env('S3_BUCKET'), key: env('S3_ACCESS_KEY_ID'), secret: env('S3_SECRET_ACCESS_KEY'), region: env('S3_REGION', 'auto') } }
};

/** Summary for GET /admin/integrations: what is live, what is sandboxed, which keys unlock it. */
export function integrationStatus() {
  const row = (kind, id, configured, keys) => ({ kind, id, mode: configured ? 'live' : 'sandbox', unlock_with: configured ? [] : keys });
  return [
    row('payment', 'mpesa', config.payments.mpesa.configured, ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY']),
    row('payment', 'paystack', config.payments.paystack.configured, ['PAYSTACK_SECRET_KEY']),
    row('payment', 'flutterwave', config.payments.flutterwave.configured, ['FLUTTERWAVE_SECRET_KEY', 'FLUTTERWAVE_WEBHOOK_HASH']),
    row('payment', 'stripe', config.payments.stripe.configured, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']),
    row('kyc', 'smile_id', config.kyc.smile_id.configured, ['SMILE_ID_PARTNER_ID', 'SMILE_ID_API_KEY']),
    row('kyc', 'onfido', config.kyc.onfido.configured, ['ONFIDO_API_TOKEN', 'ONFIDO_WEBHOOK_TOKEN']),
    row('sms', 'africastalking', config.sms.africastalking.configured, ['AFRICASTALKING_USERNAME', 'AFRICASTALKING_API_KEY']),
    row('sms', 'twilio', config.sms.twilio.configured, ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM']),
    row('maps', 'mapbox', config.maps.mapbox.configured, ['MAPBOX_TOKEN']),
    row('storage', 's3', config.storage.s3.configured, ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'])
  ];
}
