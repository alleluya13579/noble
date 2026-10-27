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

## Backend core

`backend/` holds the production-grade pieces the prototype is a front for:

- `schema.sql`: PostgreSQL + PostGIS schema with a `countries` table that carries all per-country settings, money in minor units, an append-only payment ledger, transaction history and an audit log.
- `src/escrow.js`: the transaction process, a pure state machine with an explicit transition map. Money enters `held` only through a verified gateway webhook. Run `cd backend && npm test`.
- `src/adapters.js`: contracts for payment gateways (M-Pesa, MTN MoMo, Paystack, Flutterwave, Stripe), KYC providers, SMS and maps, plus a registry and a mock gateway.
- `openapi.yaml`: the API contract.

## Docs

- [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md): product blueprint and data model.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): services, transaction process, money, identity, compliance, delivery plan.
- [`docs/LANDSCAPE.md`](docs/LANDSCAPE.md): the open-source systems reviewed and which of their designs Noble adopts.
