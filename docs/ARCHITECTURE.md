# Noble architecture

A property marketplace that works the same way in Nairobi, Lagos, Accra, Kigali, Johannesburg, London or New York: the product rules are shared, and everything that differs by country (currency, payment rails, ID documents, land registry, deposit and deadline policy, language) is data on a `countries` row plus a set of adapters.

## Services

```
 clients ─── mobile app (React Native) ── web app (Next.js) ── admin console
                 │                               │                  │
                 └──────────────── API (Fastify/NestJS, TypeScript) ─┘
                                        │
      ┌───────────────┬─────────────────┼──────────────────┬───────────────┐
  identity svc    listings svc     transactions svc     messaging svc    moderation svc
  (OTP, KYC,      (search, geo,    (transaction          (threads,        (queue, reports,
   sessions)       photos, docs)    process, ledger,      masking,         disputes, audit)
                                    payouts, scheduler)   viewings)
      │               │                 │                    │
   KYC adapters   object storage    payment adapters      SMS/push
   (Smile ID,     (S3-compatible,   (M-Pesa Daraja,       (Africa's Talking,
    Onfido,        signed URLs)      MTN MoMo, Paystack,   Twilio, FCM)
    Idswyft)                         Flutterwave, Stripe)
                       PostgreSQL + PostGIS · Redis (rate limits, queues) · OpenSearch (optional)
```

Start as one deployable (modular monolith) with these as modules; split when traffic or team size demands it.

## The transaction process

`backend/src/escrow.js` is the only code allowed to change a transaction's state. It is a pure function over an explicit transition map (see `TRANSITIONS`), the pattern used by Sharetribe's transaction processes and Deal Secure's escrow. Rules it enforces:

- Money enters `held` only from a **verified gateway webhook** whose amount and currency match exactly. The API never marks a payment as received on its own.
- Each side confirms viewing and handover independently; the second confirmation chains the state forward automatically.
- Sellers can refund at any time without a dispute. Buyers open a dispute; the seller or an admin closes it.
- Admins can only act on disputed transactions.
- Terminal states (`released`, `refunded`, `expired`) are final.
- A scheduler calls `dueSystemTransition()` and applies `auto_refund` or `expire_collection` when deadlines pass.

Every transition is appended to `transaction_transitions`; every gateway event to `payment_events`. The ledger can rebuild balances from scratch and is the evidence in a dispute.

```
initiated ─request_collection→ payment_pending ─confirm_collection (webhook)→ held
   └──────────── expire_collection ────────────┘                               │
                                                   confirm_viewing ×2 (buyer+seller)
                                                                               ▼
                                 disputed ◄── open_dispute (buyer) ── viewing_confirmed
                                   │  │                                        │
          admin_refund / seller_agrees_refund   release (admin)   confirm_handover ×2 → release
                                   ▼  ▼                                        ▼
                                refunded ◄─── seller_cancel / auto_refund ── released
```

## Money

- Amounts are integers in minor units; currency is on every row. Display uses `Intl.NumberFormat` with the user's locale.
- Noble holds client funds in a segregated collection account per country (or a licensed escrow partner where the law requires it). Payouts are B2C / bank transfer / Stripe transfer minus commission.
- Every gateway call carries an idempotency key; retries return the same reference. A timeout triggers `reconcile()`, never a blind retry or a blind refund.
- Commission, deposit percentage, rent deposit months and deadlines are per-country policy, not constants.

## Identity

- Phone OTP for login. ID document + liveness through a KYC adapter chosen by country; the client uploads directly to the provider so Noble never stores raw document images.
- Noble keeps the outcome, the provider's check id, an HMAC of the document number (duplicate accounts) and the last 4 digits (deal records).
- Agents carry a licence number validated against the national register where one exists (Kenya EARB, Nigeria ESVARBON, South Africa PPRA, UK Propertymark).

## Listings and moderation

- Every listing is `pending` until an admin completes the document checklist stored on `ownership_documents.checks`. The Approve action is rejected server-side (422) while any required check is false.
- Photos get a perceptual hash at upload; near-duplicates across listings are flagged in the queue.
- Exact address is private until the buyer's escrow is held; the public listing shows the map pin and place name.
- Lifecycle `pending → approved → paused / closed → pending (relist)`; closed listings leave search immediately when a transaction is released.

## Messaging

- Text is masked for phone numbers, emails and payment handles before storage; the original is kept in `messages_raw` readable only by the disputes role.
- Offers and viewing proposals are structured messages with a decision, so they can drive the transaction process and the deal record.

## Internationalisation

- UI strings via ICU message format; launch locales `en`, `sw`, `fr`, with `pt`, `ar`, `am` next.
- Units: sqm/sqft and acres/hectares per country default, with conversion on display.
- Dates and phone numbers formatted per locale; phone input validated as E.164.
- Legal copy (terms, escrow agreement, deal record) is templated per country.

## Compliance and security

- Data protection: Kenya DPA 2019, Nigeria NDPA 2023, Ghana DPA 2012, South Africa POPIA, UK GDPR, US state laws. Per-country data residency is a deployment option (region per country group).
- Payments: PCI scope kept out of Noble by tokenising cards at the gateway; AML/KYC on both parties; sanctions screening via the KYC provider.
- Holding client money is regulated (e.g. Kenya NPS Act, UK PSRs): launch per country only with the licence or a licensed escrow partner.
- Audit log on every admin action with hashed IP; admin sessions require 2FA; least-privilege roles (`moderator`, `disputes`, `finance`, `superadmin`).
- Rate limits in Redis: listings/day, messages/30 s, reports/day, OTP attempts.

## Repository layout (target)

```
noble/
├── prototype/        reference UI (this repo today)
├── backend/
│   ├── schema.sql    PostgreSQL + PostGIS
│   ├── openapi.yaml  API contract
│   └── src/          escrow.js (transaction process), adapters.js (provider contracts)
├── docs/             BLUEPRINT, ARCHITECTURE, LANDSCAPE
└── apps/             mobile, web, admin (to come)
```

## Delivery plan

1. **Core** (now): schema, transaction process with tests, adapter contracts, OpenAPI.
2. **Kenya pilot**: identity svc with Smile Identity + Africa's Talking, M-Pesa Daraja adapter against the sandbox, listings + moderation, web app from the prototype.
3. **Hardening**: reconciliation job, scheduler, audit, pen test, data-protection registration.
4. **Second country** (Uganda or Nigeria): prove that adding a country is a `countries` row, two adapters and a locale file.
5. **Mobile app**, then UK/US with Stripe manual capture and Connect.
