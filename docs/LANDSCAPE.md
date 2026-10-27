# Open-source landscape and what Noble adopts

Reviewed on 27 Oct 2026. None of these projects can be dropped in as-is: the real-estate ones are learning projects or country-specific, the escrow ones are small, and the mature marketplace engines are either unmaintained or under restrictive licences. What is worth taking is their *designs*, listed per project below. Noble does not copy code from any of them.

| Project | What it is | Licence | Status | What Noble takes |
| --- | --- | --- | --- | --- |
| [Sharetribe Go](https://github.com/sharetribe/sharetribe) | Rails P2P marketplace engine (listings, Stripe, reviews, admin) | Sharetribe Community Public License (source-available, not OSI open source) | No longer maintained; replaced by the hosted "New Sharetribe" | The **transaction process** idea: every deal is a named process made of states, transitions and actions with preconditions, and reviews open only after a transaction completes ([docs](https://www.sharetribe.com/docs/concepts/transactions/transaction-process/)). Noble's `backend/src/escrow.js` is written this way. |
| [Cocorico](https://github.com/Cocolabs-SAS/cocorico) | Symfony/MongoDB rental and services marketplace with escrow, availability and ratings | MIT | Superseded by a commercial product ("Second"); little recent activity | Separation of *booking* from *payment*: money is authorised at booking and captured/released on completion. Noble keeps viewing appointments and escrow as separate objects linked by the transaction. |
| [Deal Secure](https://github.com/prudence2024/Escrow_platform) | React + Convex escrow platform with inspection period and admin dispute console | No licence file (all rights reserved by default) | Active demo project | The **explicit transition map** validated on every status change, server-side payment verification before `PAYMENT_SECURED`, and a cron that auto-settles when the inspection window passes. Noble mirrors all three: transition map, verified webhook before `held`, scheduled auto-refund deadlines. |
| [escrow-agent](https://github.com/org-45/escrow-agent) | Go + PostgreSQL general-purpose escrow agent with pluggable gateways | MIT | Early stage | Gateway abstraction (one interface, many providers) and storing the signed agreement document with the transaction for disputes. Noble's `payment_events` table and `PaymentGateway` interface follow this. |
| [immo-finder](https://github.com/manimovassagh/immo-finder) | Spring Boot + React + Keycloak real-estate platform, sales and rentals | Check repo | Portfolio-scale | Keycloak-style separation of identity from the app: Noble treats auth/KYC as an identity service with its own tables and never stores raw ID numbers in the listings database. |
| PropKub (Thailand) | Next.js + NestJS national property marketplace with agent CRM | Check repo (fetch returned 404 at review time) | Active, single-country | The agent-CRM angle: agents list on behalf of named owners, with leads tracked per listing. Noble's `client_owner` field and per-listing enquiry/offer counts come from this. |
| [Idswyft](https://dev.to/teamidswyft/i-built-an-open-source-identity-verification-platform-heres-what-i-learned-5fkn) | Self-hosted KYC (OCR, liveness, face match, AML) via Docker Compose | Not stated; verify before use | New, unaudited | A self-hostable fallback for markets where commercial KYC vendors have no coverage. Noble's KYC adapter interface allows it as one provider among several. |

## Payments: what the providers actually offer

- **Safaricom Daraja (M-Pesa)**: STK Push to collect, B2C to pay out, callbacks to confirm. No native escrow: Noble must hold funds in its own regulated collection account and reconcile every callback (a timeout does not mean the money did not move). Idempotency keys on every request and a `payment_events` ledger are mandatory.
- **Paystack / Flutterwave / IntaSend / Pesapal**: aggregate M-Pesa, Airtel Money, cards, bank transfers and Apple Pay behind one API, with payouts. Neither Paystack nor Flutterwave documents a hold-and-release escrow product, so the same hold-in-own-account model applies.
- **Stripe**: supports manual capture (authorise now, capture later) and Connect for payouts; this is the natural adapter for the UK, EU and US.
- **Regulatory note**: holding client money is a regulated activity almost everywhere (e.g. Kenya's National Payment System Act, the UK's Payment Services Regulations). Production Noble either partners with a licensed escrow/trust provider per country or obtains the licence. The adapter design keeps this swappable.

## Why not fork a marketplace engine

1. Licence: Sharetribe Go is not open source; Deal Secure has no licence; Cocorico is MIT but abandoned on an old Symfony/MongoDB stack.
2. Domain fit: none models title deeds, land registry searches, agent-for-owner listings or offline legal transfer.
3. Money: none has a mobile-money escrow model with reconciliation and regulatory hooks.

So Noble takes the patterns, writes its own core (schema, transaction process, gateway and KYC interfaces, OpenAPI) and keeps the prototype as the reference UI.
