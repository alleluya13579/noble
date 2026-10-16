# Noble blueprint

## What each listing holds
Type (sale, rent, land), price and currency, exact location pinned on a map, photos, size, title/ownership status, and the verified owner or agent behind it.

## Controls that keep it safe
- Every account verified with ID and phone before listing or paying.
- Listings go into a pending queue; admins approve before they go live.
- Proof of ownership (title deed or lease authority) required for sale and land listings.
- All chat and offers stay in-app, so disputes have a record. Phone numbers and emails typed into chat are masked.
- Rate limits (3 listings per account per 24 h, message bursts), duplicate-photo detection and user reporting to catch scams.
- Roles: buyer, seller/landlord, agent, admin, each with different permissions.

## Online transaction flow
1. Buyer pays a deposit (10% for sale/land) or rent (first month + one month deposit) into escrow via mobile money or card.
2. Seller is notified; both sides confirm viewing, then handover.
3. Platform releases funds to the seller minus a 5% commission, or refunds if the deal falls through. A refund the seller does not agree to goes to an admin.
4. Full land or house sales still need the legal transfer offline, so escrow covers the deposit and the platform records the agreement.

## Role permissions

| Action | Buyer | Seller / landlord | Agent | Admin |
| --- | :-: | :-: | :-: | :-: |
| Browse approved listings | ✓ | ✓ | ✓ | ✓ |
| Message owners, make offers | ✓ | ✓ | ✓ | |
| Pay into escrow | ✓ | ✓ | ✓ | |
| Create listings (own property) | | ✓ | | |
| Create listings for a client owner | | | ✓ | |
| Accept offers, confirm handover | | ✓ | ✓ | |
| Report a listing or user | ✓ | ✓ | ✓ | |
| Approve / reject listings | | | | ✓ |
| Resolve reports and escrow disputes | | | | ✓ |
| Suspend accounts | | | | ✓ |

## Data model (first cut)

- **users**: id, name, role, phone, phone_verified_at, national_id_hash, kyc_status, agent_licence, suspended_at
- **listings**: id, owner_id, client_owner_name, type, title, price, currency, location (PostGIS point), place_name, size, size_unit, bedrooms, title_status, status (pending/approved/rejected/removed), reject_reason, approved_by, created_at
- **listing_photos**: id, listing_id, url, perceptual_hash (indexed for duplicate search)
- **ownership_documents**: id, listing_id, kind, file_url, checked_by, checked_at
- **threads / messages**: listing_id, buyer_id, owner_id; messages carry text or an offer (amount, status)
- **escrow_transactions**: id, listing_id, buyer_id, seller_id, kind, amount, currency, method, provider_ref, status (held/disputed/released/refunded), viewing/handover confirmations per side, commission, agreement_ref
- **reports**: id, listing_id, reporter_id, reason, status, resolved_by
- **audit_log**: every state change on listings, escrow and accounts

## Suggested build
- Mobile app (React Native or Flutter) plus a web dashboard for owners, agents and admins.
- API backend with PostgreSQL + PostGIS for users, listings and transactions.
- Map API for geocoding and pins.
- Payment provider that supports escrow or held funds: M-Pesa / mobile money and card.
- KYC provider for ID document and selfie checks; SMS OTP for phones.
- Admin tools for the moderation queue, reports, disputes and suspensions.
