# Noble blueprint

## What each listing holds
Type (sale, rent, land), price and currency, exact location pinned on a map, photos, size, title/ownership status, and the verified owner or agent behind it.

## Controls that keep it safe
- Every account verified with ID and phone before listing, saving, messaging or paying.
- Listings go into a pending queue. The admin must complete a document checklist (name on title matches, parcel number and acreage match, registry search under 30 days with no caveat; for rentals, the lease authority names the lister) before the Approve button unlocks.
- Proof of ownership (title deed or lease authority) required for sale and land listings.
- All chat, offers and viewing appointments stay in-app, so disputes have a record. Phone numbers and emails typed into chat are masked.
- Rate limits (3 listings per account per 24 h, message bursts), duplicate-photo detection and user reporting to catch scams.
- Listing lifecycle: pending → live → paused / sold / let. Relisting goes back through review, so stale or recycled listings cannot sneak back.
- Ratings can only be left after a completed escrow deal, so they cannot be bought or faked.
- Audit log of every moderation decision and every escrow release or refund.
- Roles: buyer, seller/landlord, agent, admin, each with different permissions.

## Online transaction flow
1. Buyer pays a deposit (10% for sale/land) or rent (first month + one month deposit) into escrow via mobile money or card.
2. Seller is notified. A viewing is proposed and accepted in chat; afterwards both sides confirm it happened, then both confirm the handover.
3. Platform releases funds to the seller minus a 5% commission and issues a deal record to both parties, or refunds if the deal falls through. A refund the seller does not agree to goes to an admin.
4. Deadlines: no viewing confirmed within 14 days of payment, or no handover within 30 days of the viewing, refunds the buyer automatically (a scheduled job in production).
5. Full land or house sales still need the legal transfer offline, so escrow covers the deposit and the platform records the agreement.

## Search and discovery
Text search over title, area and title status; filters for type, area, price range and bedrooms; sort by newest, price or most viewed; saved listings per account. Listings carry view, save, enquiry and offer counts for their owner.

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

- **users**: id, name, role, phone, phone_verified_at, national_id_hash, kyc_status, agent_licence, member_since, suspended_at
- **listings**: id, owner_id, client_owner_name, type, title, price, currency, location (PostGIS point), place_name, size, size_unit, bedrooms, title_status, status (pending/approved/paused/closed/rejected/removed), reject_reason, approved_by, view_count, created_at, closed_at
- **listing_photos**: id, listing_id, url, perceptual_hash (indexed for duplicate search)
- **ownership_documents**: id, listing_id, kind, file_url, checks (jsonb: name_matches, parcel_matches, search_recent), checked_by, checked_at
- **saved_listings**: user_id, listing_id
- **threads / messages**: listing_id, buyer_id, owner_id; messages carry text, an offer (amount, status) or a viewing proposal (when, status)
- **escrow_transactions**: id, listing_id, buyer_id, seller_id, kind, agreed_price, amount, currency, method, provider_ref, status (held/disputed/released/refunded), paid_at, viewing_confirmed_at, released_at, viewing/handover confirmations per side, commission, agreement_ref
- **ratings**: transaction_id, from_user_id, to_user_id, stars, created_at (one per party per transaction, only when released)
- **reports**: id, listing_id, reporter_id, reason, status, resolved_by
- **audit_log**: actor, action, target, created_at — every state change on listings, escrow and accounts

## Suggested build
- Mobile app (React Native or Flutter) plus a web dashboard for owners, agents and admins.
- API backend with PostgreSQL + PostGIS for users, listings and transactions.
- Map API for geocoding and pins.
- Payment provider that supports escrow or held funds: M-Pesa / mobile money and card.
- KYC provider for ID document and selfie checks; SMS OTP for phones.
- Admin tools for the moderation queue, reports, disputes and suspensions.
