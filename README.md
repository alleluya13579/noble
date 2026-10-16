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

Demo data lives in the browser's local storage. **Reset demo** restores it.

See [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) for the product blueprint and the data model behind it.
