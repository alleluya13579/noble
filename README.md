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
| Amina Odhiambo | Buyer / renter | Open a listing, send an offer, pay a deposit into escrow, confirm viewing and handover |
| Brian Otieno | Buyer (unverified) | Try to message or pay and get asked to verify ID and phone first |
| Joseph Mwangi | Seller / landlord | Accept offers, confirm handovers, submit a listing |
| Wanjiru Kamau | Agent | List for a client owner; reuse a photo to see duplicate detection |
| Grace Njeri | Admin | Approve or reject the pending queue, act on reports, settle escrow disputes, suspend accounts |

Demo data lives in the browser's local storage. **Reset demo** restores it.

See [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) for the product blueprint and the data model behind it.
