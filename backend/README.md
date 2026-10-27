# Noble backend

The complete marketplace API: accounts with phone OTP and KYC, moderated listings with ownership documents, in-app chat with offers and viewings, escrow with a tested state machine, payouts, refunds, disputes, ratings, deal records, reports, suspensions and an audit log.

**Zero dependencies by default.** Node 22+ only: built-in HTTP server and built-in SQLite. `npm install` is not needed.

**PostgreSQL when you want it.** Set `DATABASE_URL=postgres://user:pass@host:5432/noble` and run `npm install` (pulls the `pg` driver); `schema.sql` is applied on start and the same code runs unchanged. The test suite runs on both backends (`npm test`, `npm run test:pg`).

**Every external provider is a slot.** Payments, KYC, SMS, maps and storage are adapters. With no keys they run in *sandbox* mode (simulated, logged, nothing charged or sent) so the whole system works end to end on day one. Enter a provider's keys in `.env` and that provider goes live; nothing else changes.

## Run

```sh
cd backend
cp .env.example .env        # fill in what you have; leave the rest empty
node src/server.js
```

Open **http://localhost:8080/app** for the web client (`web/index.html`, served by the API). It covers every screen: sign-in by SMS code, ID verification, browse and search with the map, listing pages with offers and viewings, seller listings with photo and document upload, escrow with confirmations, disputes, ratings and deal records, and the admin console (queue with checklist, reports, disputes, accounts, audit log, integrations). The client is a single static file; host it anywhere and point it at the API with `?api=https://api.example.com`.

The startup log lists every integration and the keys that unlock it:

```
Noble API listening on http://localhost:8080 (development)
  payment  mpesa           sandbox   unlock with MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY
  payment  paystack        sandbox   unlock with PAYSTACK_SECRET_KEY
  payment  stripe          sandbox   unlock with STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
  kyc      smile_id        sandbox   unlock with SMILE_ID_PARTNER_ID, SMILE_ID_API_KEY
  sms      africastalking  sandbox   unlock with AFRICASTALKING_USERNAME, AFRICASTALKING_API_KEY
  ...
```

`GET /admin/integrations` returns the same as JSON. In `NOBLE_ENV=development` the OTP code is returned by `POST /auth/otp` so you can sign in without SMS.

## Test

```sh
npm test
```

28 tests: the escrow state machine in isolation, and the API end to end (sign-up → KYC → listing → moderation checklist → chat, offer, viewing → escrow held → both confirmations → release with commission, deal record, rating → dispute and admin refund → scheduler auto-refund → report, take-down, suspension).

## Walkthrough with curl

```sh
B=http://localhost:8080
# 1. Sign in (development returns dev_code)
curl -s -X POST $B/auth/otp -H 'Content-Type: application/json' -d '{"phone_e164":"+254712345678"}'
curl -s -X POST $B/auth/otp/verify -H 'Content-Type: application/json' \
  -d '{"phone_e164":"+254712345678","code":"<dev_code>","country":"KE","full_name":"Joseph Mwangi","role":"seller"}'
# 2. Verify identity (sandbox verifies immediately)
curl -s -X POST $B/auth/kyc -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"document_type":"national_id","document_number":"31234567"}'
# 3. Submit a listing, add a photo and the lease letter
curl -s -X POST $B/listings -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"rent","title":"2-bed apartment with balcony","price_minor":8500000,"lat":-1.2921,"lng":36.7822,"place_name":"Kilimani","size":96,"size_unit":"sqm","bedrooms":2,"title_status":"Lease authority letter from owner"}'
curl -s -X POST "$B/listings/$LISTING/photos" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: image/jpeg' --data-binary @photo.jpg
curl -s -X POST "$B/listings/$LISTING/documents?kind=lease_authority" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/pdf' --data-binary @lease.pdf
# 4. Admin approves after ticking the checklist (ADMIN_PHONES in .env decides who is admin)
curl -s -X POST $B/admin/listings/$LISTING/review -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"decision":"approve","checks":{"lease_names_lister":true}}'
# 5. Buyer pays into escrow (sandbox confirms instantly; live M-Pesa sends an STK push and confirms via webhook)
curl -s -X POST $B/transactions -H "Authorization: Bearer $BUYER" -H 'Content-Type: application/json' \
  -d '{"listing_id":"'$LISTING'","gateway":"mpesa","payer_account":"+254711111111","idempotency_key":"pay-1"}'
# 6. Both confirm viewing, then handover; funds are released minus commission
curl -s -X POST $B/transactions/$TXN/transitions -H "Authorization: Bearer $BUYER" -H 'Content-Type: application/json' -d '{"transition":"confirm_viewing"}'
```

The full contract is in [`openapi.yaml`](openapi.yaml).

## Layout

```
backend/
├── .env.example          every key, with the provider it unlocks
├── schema.sql            PostgreSQL + PostGIS (production scale)
├── schema.sqlite.sql     SQLite edition used by this server
├── openapi.yaml          API contract
├── src/
│   ├── server.js         entry point
│   ├── app.js            wires db, routes, auth, scheduler
│   ├── http.js           tiny router, JSON, typed errors
│   ├── config.js         .env loading, integration status
│   ├── db.js             node:sqlite helpers, rate limits, audit
│   ├── escrow.js         the transaction process (pure state machine)
│   ├── auth.js           OTP sessions, KYC, user serialisation
│   ├── listings.js       search, create, lifecycle, photos, documents, saves, reports
│   ├── threads.js        chat with masking, offers, viewings
│   ├── transactions.js   escrow service: gateways, webhooks, payouts, refunds, deal records
│   ├── admin.js          queue + checklist, reports, disputes, users, audit, integrations
│   ├── scheduler.js      deadline enforcement
│   └── adapters/
│       ├── payments.js   mpesa (Daraja), paystack, flutterwave, stripe, sandbox
│       ├── kyc.js        smile_id, onfido, sandbox
│       ├── sms.js        africastalking, twilio, sandbox
│       ├── maps.js       mapbox, sandbox
│       └── storage.js    local disk, S3-compatible; AES-256-GCM for documents
└── test/                 escrow.test.js, api.test.js
```

## Going live, per provider

| Provider | What happens once keys are set |
| --- | --- |
| M-Pesa (Daraja) | `collect` sends an STK push; the callback hits `/webhooks/payments/mpesa?txn=…&s=…`; because Daraja does not sign callbacks the server re-queries the transaction (`reconcile`) before marking funds held. Payouts and refunds use B2C. |
| Paystack | `collect` returns an `authorization_url` for the buyer; `charge.success` webhook is HMAC-verified; payouts use transfer recipients. |
| Flutterwave | Mobile money charges for UG, GH, RW, TZ, KE; webhook verified with `verif-hash`. |
| Stripe | PaymentIntent with manual capture: the hold is an authorisation, capture + Connect transfer happen on release, cancel on refund. Webhook signature verified. |
| Smile Identity / Onfido | Hosted verification link returned as `redirect_url`; result arrives by signed webhook. Duplicate documents are caught by an HMAC of the document number. |
| Africa's Talking / Twilio | OTP and escrow notifications. African numbers prefer Africa's Talking. |
| Mapbox | Geocodes a typed address when a listing has no pin, reverse-geocodes pins into place names. |
| S3 | Photos and encrypted documents move off local disk. |

## Operations

- `GET /health` liveness, `GET /ready` database check, `GET /metrics` Prometheus metrics (optionally behind `METRICS_TOKEN`).
- Security: HSTS/`nosniff`/frame-deny headers, CSP on the web app, configurable `CORS_ORIGINS`, per-IP rate limit (`IP_RATE_LIMIT_PER_MIN`) plus per-account business limits, upload size cap and image magic-byte checks, request ids (`X-Request-Id`), JSON logs (`LOG_FORMAT=json`).
- In production the server refuses to start with development defaults (`productionProblems()` in `src/config.js`).
- Scheduler: deadlines, stale offers, expired sessions and OTP codes; on PostgreSQL only one instance runs it (advisory lock).
- Migrations: `migrations/NNN_name.sql`, applied once on start and recorded in `schema_migrations`.
- Notifications: every SMS-worthy event also lands in the user's inbox (`GET /notifications`).

Full deployment guide: [`../docs/DEPLOY.md`](../docs/DEPLOY.md).

## Production notes

- Put the API behind TLS; set `PUBLIC_BASE_URL` to the public address so providers can reach the webhooks.
- Set `SESSION_SECRET`, `ID_HASH_SECRET`, `DOCS_ENCRYPTION_KEY` to long random values and keep them stable.
- Run one scheduler: either keep it in a single API instance or call `runOnce()` from a cron job.
- Use PostgreSQL in production (`DATABASE_URL`). `src/db.js` holds both backends behind one async interface; application SQL is written once and the Postgres backend rewrites `?` placeholders and `INSERT OR IGNORE`. For PostGIS radius queries at scale, see the comment at the top of `schema.sql`.
- Holding client money is regulated; launch each country with the licence or a licensed escrow partner.
