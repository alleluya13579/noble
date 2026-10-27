// SMS adapters. Sandbox prints to the log (and the API returns the OTP in development mode).
import { config } from '../config.js';

export function sandboxSms(logger = console) {
  return { id: 'sandbox', live: false, async send(to, body) { logger.log(`[sms sandbox] to ${to}: ${body}`); return { messageId: 'sbx-' + Date.now() }; } };
}

/* Africa's Talking. https://developers.africastalking.com/docs/sms/sending */
export function africasTalkingSms(c = config.sms.africastalking) {
  const base = c.username === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
  return {
    id: 'africastalking', live: true,
    async send(to, body) {
      const r = await fetch(`${base}/version1/messaging`, { method: 'POST', headers: { apiKey: c.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: c.username, to, message: body, ...(c.from ? { from: c.from } : {}) }) });
      const d = await r.json(); const rec = d.SMSMessageData?.Recipients?.[0];
      if (!rec || rec.statusCode >= 400) throw new Error(`africastalking: ${rec?.status || d.SMSMessageData?.Message}`);
      return { messageId: rec.messageId };
    }
  };
}

/* Twilio. https://www.twilio.com/docs/sms/api/message-resource */
export function twilioSms(c = config.sms.twilio) {
  return {
    id: 'twilio', live: true,
    async send(to, body) {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Messages.json`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: to, From: c.from, Body: body }) });
      const d = await r.json(); if (!r.ok) throw new Error(`twilio: ${d.message}`);
      return { messageId: d.sid };
    }
  };
}

/** African numbers go through Africa's Talking when configured, everything else through Twilio; sandbox otherwise. */
export function smsFor(phoneE164) {
  const african = /^\+(2[0-9]{2}|27)/.test(phoneE164);
  if (african && config.sms.africastalking.configured) return africasTalkingSms();
  if (config.sms.twilio.configured) return twilioSms();
  if (config.sms.africastalking.configured) return africasTalkingSms();
  return sandboxSms();
}
