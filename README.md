# Noble

A property marketplace that connects buyers, renters, sellers and landlords, with ID verification, admin moderation and escrow payments built in.

## Clickable prototype

`prototype/index.html` is a self-contained, no-build prototype. Open it in a browser, or serve the folder:

```sh
npx serve prototype   # or: python3 -m http.server -d prototype
```

Use the **Viewing as** menu to switch between the demo accounts:

| Account | Role | Try this |
| --- | --- | --- |
| Amina Odhiambo | Buyer / renter | Search and save listings, send an offer, agree a viewing in chat, pay a deposit into escrow, confirm viewing and handover, rate the landlord, open the deal record |
| Brian Otieno | Buyer (unverified) | Try to message, save or pay and get asked to verify ID and phone first |
| Joseph Mwangi | Seller / landlord | Accept offers and viewings, confirm handovers, see listing stats, mark a listing as let or sold, pause or relist |
| Wanjiru Kamau | Agent | List for a client owner; reuse a photo to see duplicate detection |
| Grace Njeri | Admin | Work the document checklist before approving, reject with a reason, act on reports, settle escrow disputes, suspend accounts, read the audit log |

Other things to try: `#l2` on the end of the URL opens that listing directly; the escrow card shows the auto-refund date; a released deal issues a copyable deal record.

**Countries and languages.** The two selectors at the top switch the market (Kenya, Uganda, Nigeria, Ghana, South Africa, United Kingdom, United States) and the UI language (English, Kiswahili, Français). A country brings its own currency and price formatting, payment rails, accepted ID documents, land registry, agent register, deposit and deadline policy, and local areas on the map.

Demo data lives in the browser's local storage. **Reset demo** restores it.

## The real thing: web app + backend

`backend/` is the complete API and `web/` is the client that talks to it. One process serves both, with nothing but Node 22:

```sh
cd backend && cp .env.example .env && node src/server.js
# then open http://localhost:8080/app
```

Sign in with any phone number (development mode shows the SMS code on screen), verify with any document number (sandbox KYC), submit a listing as a seller, approve it as the admin (the phone in `ADMIN_PHONES`), then pay into escrow as a buyer. The web app can also be opened from anywhere with `?api=https://your-api-host`.

Every external provider (M-Pesa, Paystack, Flutterwave, Stripe, Smile Identity, Onfido, Africa's Talking, Twilio, Mapbox, S3) is a slot: it runs in sandbox mode until its API keys are entered in `.env`, then goes live with no code change. The startup log and `GET /admin/integrations` show what is live and which keys unlock the rest.

The database is SQLite out of the box and **PostgreSQL** when `DATABASE_URL` is set (`backend/schema.sql`); the 29-test suite runs on both. See [`backend/README.md`](backend/README.md).

## Docs

- [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md): product blueprint and data model.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): services, transaction process, money, identity, compliance, delivery plan.
- [`docs/LANDSCAPE.md`](docs/LANDSCAPE.md): the open-source systems reviewed and which of their designs Noble adopts.
