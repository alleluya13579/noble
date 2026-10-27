-- Noble core schema. PostgreSQL 15+ with PostGIS.
-- Money is stored in minor units (cents, pesewas) as BIGINT with an ISO 4217 currency code.
-- Raw identity documents never live here; the identity service stores them encrypted and
-- this schema keeps only the verification outcome and a hash for duplicate detection.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role        AS ENUM ('buyer', 'seller', 'agent', 'admin');
CREATE TYPE kyc_status       AS ENUM ('none', 'pending', 'verified', 'rejected');
CREATE TYPE listing_type     AS ENUM ('sale', 'rent', 'land');
CREATE TYPE listing_status   AS ENUM ('draft', 'pending', 'approved', 'paused', 'closed', 'rejected', 'removed');
CREATE TYPE size_unit        AS ENUM ('sqm', 'sqft', 'acres', 'hectares');
CREATE TYPE message_kind     AS ENUM ('text', 'offer', 'viewing', 'system');
CREATE TYPE decision_status  AS ENUM ('pending', 'accepted', 'declined', 'expired');
CREATE TYPE txn_state        AS ENUM ('initiated', 'payment_pending', 'held', 'viewing_confirmed', 'disputed', 'released', 'refunded', 'expired');
CREATE TYPE report_status    AS ENUM ('open', 'dismissed', 'actioned');

-- Countries Noble operates in. Everything locale-specific hangs off this row.
CREATE TABLE countries (
  code              CHAR(2) PRIMARY KEY,            -- ISO 3166-1 alpha-2
  name              TEXT NOT NULL,
  currency          CHAR(3) NOT NULL,               -- ISO 4217
  minor_unit_digits SMALLINT NOT NULL DEFAULT 2,
  phone_prefix      TEXT NOT NULL,
  id_document_types TEXT[] NOT NULL,                -- e.g. {national_id,passport}
  land_registry     TEXT NOT NULL,                  -- display name of the registry that completes transfers
  payment_methods   TEXT[] NOT NULL,                -- adapter ids, e.g. {mpesa,card}
  default_locale    TEXT NOT NULL DEFAULT 'en',
  map_center        GEOGRAPHY(POINT, 4326) NOT NULL,
  deposit_pct_sale  NUMERIC(5,2) NOT NULL DEFAULT 10,
  rent_deposit_months SMALLINT NOT NULL DEFAULT 1,
  viewing_days      SMALLINT NOT NULL DEFAULT 14,   -- auto-refund if no viewing confirmed
  handover_days     SMALLINT NOT NULL DEFAULT 30,   -- auto-refund if no handover confirmed
  commission_pct    NUMERIC(5,2) NOT NULL DEFAULT 5
);

CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code      CHAR(2) NOT NULL REFERENCES countries,
  role              user_role NOT NULL DEFAULT 'buyer',
  full_name         TEXT NOT NULL,
  email             CITEXT UNIQUE,
  phone_e164        TEXT UNIQUE,
  phone_verified_at TIMESTAMPTZ,
  kyc_status        kyc_status NOT NULL DEFAULT 'none',
  kyc_provider      TEXT,                           -- adapter id that verified them
  kyc_ref           TEXT,                           -- provider's check id, for audit
  id_doc_hash       BYTEA UNIQUE,                   -- HMAC of document number: duplicate detection without storing the number
  id_last4          CHAR(4),                        -- shown on deal records
  agent_licence     TEXT,
  locale            TEXT NOT NULL DEFAULT 'en',
  member_since      DATE NOT NULL DEFAULT CURRENT_DATE,
  suspended_at      TIMESTAMPTZ,
  suspended_reason  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE listings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code      CHAR(2) NOT NULL REFERENCES countries,
  owner_id          UUID NOT NULL REFERENCES users,
  client_owner_name TEXT,                           -- when an agent lists for a registered owner
  type              listing_type NOT NULL,
  title             TEXT NOT NULL CHECK (char_length(title) <= 120),
  description       TEXT,
  price_minor       BIGINT NOT NULL CHECK (price_minor > 0),
  currency          CHAR(3) NOT NULL,
  location          GEOGRAPHY(POINT, 4326) NOT NULL,
  place_name        TEXT NOT NULL,
  address_private   TEXT,                           -- exact address, shown only after escrow is held
  size              NUMERIC(12,2) NOT NULL,
  size_unit         size_unit NOT NULL,
  bedrooms          SMALLINT NOT NULL DEFAULT 0,
  title_status      TEXT NOT NULL,                  -- freehold, leasehold, lease authority, allotment...
  status            listing_status NOT NULL DEFAULT 'pending',
  reject_reason     TEXT,
  reviewed_by       UUID REFERENCES users,
  reviewed_at       TIMESTAMPTZ,
  view_count        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at         TIMESTAMPTZ
);
CREATE INDEX listings_geo_idx    ON listings USING GIST (location);
CREATE INDEX listings_search_idx ON listings (country_code, status, type, price_minor);
CREATE INDEX listings_text_idx   ON listings USING GIN (to_tsvector('simple', title || ' ' || place_name || ' ' || title_status));

CREATE TABLE listing_photos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id        UUID NOT NULL REFERENCES listings ON DELETE CASCADE,
  object_key        TEXT NOT NULL,                  -- storage path; served through signed URLs
  perceptual_hash   BIT(64) NOT NULL,               -- pHash; near-duplicates found by Hamming distance
  position          SMALLINT NOT NULL DEFAULT 0
);
CREATE INDEX listing_photos_hash_idx ON listing_photos (perceptual_hash);

CREATE TABLE ownership_documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id        UUID NOT NULL REFERENCES listings ON DELETE CASCADE,
  kind              TEXT NOT NULL,                  -- title_deed, registry_search, lease_authority, allotment_letter
  object_key        TEXT NOT NULL,                  -- encrypted at rest
  checks            JSONB NOT NULL DEFAULT '{}',    -- {name_matches, parcel_matches, search_recent, lease_names_lister}
  checked_by        UUID REFERENCES users,
  checked_at        TIMESTAMPTZ
);

CREATE TABLE saved_listings (
  user_id           UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  listing_id        UUID NOT NULL REFERENCES listings ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, listing_id)
);

CREATE TABLE threads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id        UUID NOT NULL REFERENCES listings,
  buyer_id          UUID NOT NULL REFERENCES users,
  owner_id          UUID NOT NULL REFERENCES users,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, buyer_id)
);

CREATE TABLE messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id         UUID NOT NULL REFERENCES threads ON DELETE CASCADE,
  sender_id         UUID REFERENCES users,          -- NULL for system messages
  kind              message_kind NOT NULL,
  body              TEXT,                           -- masked text; original kept in messages_raw for disputes
  offer_minor       BIGINT,
  viewing_at        TIMESTAMPTZ,
  decision          decision_status,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread_idx ON messages (thread_id, created_at);

-- Original text before contact masking, readable only by the disputes role.
CREATE TABLE messages_raw (
  message_id        UUID PRIMARY KEY REFERENCES messages ON DELETE CASCADE,
  body              TEXT NOT NULL
);

CREATE TABLE transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference         TEXT NOT NULL UNIQUE,           -- human reference, e.g. ESC-20481
  listing_id        UUID NOT NULL REFERENCES listings,
  buyer_id          UUID NOT NULL REFERENCES users,
  seller_id         UUID NOT NULL REFERENCES users,
  state             txn_state NOT NULL DEFAULT 'initiated',
  agreed_price_minor BIGINT NOT NULL,
  amount_minor      BIGINT NOT NULL,                -- deposit or rent + deposit actually held
  currency          CHAR(3) NOT NULL,
  commission_minor  BIGINT NOT NULL DEFAULT 0,
  gateway           TEXT,                           -- adapter id: mpesa, paystack, stripe...
  gateway_ref       TEXT,                           -- provider transaction id
  idempotency_key   TEXT NOT NULL UNIQUE,
  paid_at           TIMESTAMPTZ,
  viewing_buyer_at  TIMESTAMPTZ,
  viewing_seller_at TIMESTAMPTZ,
  handover_buyer_at TIMESTAMPTZ,
  handover_seller_at TIMESTAMPTZ,
  viewing_deadline  TIMESTAMPTZ,                    -- paid_at + country.viewing_days
  handover_deadline TIMESTAMPTZ,                    -- viewing confirmed + country.handover_days
  dispute_opened_by UUID REFERENCES users,
  dispute_reason    TEXT,
  resolved_by       UUID REFERENCES users,
  agreement_ref     TEXT,                           -- deal record id issued on release
  released_at       TIMESTAMPTZ,
  refunded_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (buyer_id <> seller_id)
);
CREATE INDEX transactions_deadline_idx ON transactions (state, viewing_deadline, handover_deadline);

-- Append-only ledger of every gateway event, so the balance can be rebuilt from scratch.
CREATE TABLE payment_events (
  id                BIGSERIAL PRIMARY KEY,
  transaction_id    UUID NOT NULL REFERENCES transactions,
  gateway           TEXT NOT NULL,
  event_type        TEXT NOT NULL,                  -- collect_requested, collect_confirmed, payout_sent, payout_confirmed, refund_sent...
  gateway_event_id  TEXT,                           -- provider's id, unique per gateway
  amount_minor      BIGINT NOT NULL,
  payload           JSONB NOT NULL,                 -- raw webhook body, verified signature
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gateway, gateway_event_id)
);

-- Every state change of a transaction, with who caused it. Written by the transaction process only.
CREATE TABLE transaction_transitions (
  id                BIGSERIAL PRIMARY KEY,
  transaction_id    UUID NOT NULL REFERENCES transactions,
  from_state        txn_state,
  to_state          txn_state NOT NULL,
  transition        TEXT NOT NULL,                  -- name from backend/src/escrow.js
  actor_id          UUID REFERENCES users,          -- NULL = system (scheduler, webhook)
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ratings (
  transaction_id    UUID NOT NULL REFERENCES transactions,
  from_user_id      UUID NOT NULL REFERENCES users,
  to_user_id        UUID NOT NULL REFERENCES users,
  stars             SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (transaction_id, from_user_id)
);

CREATE TABLE reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id        UUID REFERENCES listings,
  reported_user_id  UUID REFERENCES users,
  reporter_id       UUID NOT NULL REFERENCES users,
  reason            TEXT NOT NULL,
  details           TEXT,
  status            report_status NOT NULL DEFAULT 'open',
  resolved_by       UUID REFERENCES users,
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (listing_id IS NOT NULL OR reported_user_id IS NOT NULL)
);

CREATE TABLE audit_log (
  id                BIGSERIAL PRIMARY KEY,
  actor_id          UUID REFERENCES users,          -- NULL = system
  action            TEXT NOT NULL,
  target_type       TEXT NOT NULL,
  target_id         TEXT NOT NULL,
  detail            JSONB NOT NULL DEFAULT '{}',
  ip_hash           BYTEA,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id, created_at DESC);

-- Rate limiting counters (listing submissions per day, message bursts, report spam).
CREATE TABLE rate_limits (
  user_id           UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  bucket            TEXT NOT NULL,                  -- listings_24h, messages_30s, reports_24h
  window_start      TIMESTAMPTZ NOT NULL,
  count             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, bucket, window_start)
);

-- Seed: the launch countries. Payment and ID adapters are looked up by these ids.
INSERT INTO countries VALUES
('KE','Kenya','KES',2,'+254','{national_id,passport}','Ministry of Lands (Ardhisasa)','{mpesa,airtel_money,card}','en',ST_GeogFromText('POINT(36.82 -1.29)'),10,1,14,30,5),
('UG','Uganda','UGX',0,'+256','{national_id,passport}','Ministry of Lands, Housing and Urban Development','{mtn_momo,airtel_money,card}','en',ST_GeogFromText('POINT(32.58 0.35)'),10,1,14,30,5),
('TZ','Tanzania','TZS',0,'+255','{nida_id,passport}','Ministry of Lands (ILMIS)','{mpesa_tz,tigo_pesa,airtel_money,card}','sw',ST_GeogFromText('POINT(39.28 -6.80)'),10,1,14,30,5),
('RW','Rwanda','RWF',0,'+250','{national_id,passport}','Rwanda Land Management and Use Authority','{mtn_momo,airtel_money,card}','en',ST_GeogFromText('POINT(30.06 -1.95)'),10,1,14,30,5),
('NG','Nigeria','NGN',2,'+234','{nin,passport,drivers_licence}','State Lands Registry (Governor''s consent)','{paystack_bank,card,ussd}','en',ST_GeogFromText('POINT(3.38 6.52)'),10,1,14,30,5),
('GH','Ghana','GHS',2,'+233','{ghana_card,passport}','Lands Commission','{mtn_momo,card}','en',ST_GeogFromText('POINT(-0.19 5.60)'),10,1,14,30,5),
('ZA','South Africa','ZAR',2,'+27','{sa_id,passport}','Deeds Office','{card,eft}','en',ST_GeogFromText('POINT(28.05 -26.20)'),10,1,14,30,5),
('GB','United Kingdom','GBP',2,'+44','{passport,drivers_licence,brp}','HM Land Registry','{card,open_banking}','en',ST_GeogFromText('POINT(-0.12 51.51)'),10,1,14,30,3),
('US','United States','USD',2,'+1','{passport,drivers_licence,state_id}','County Recorder','{card,ach}','en',ST_GeogFromText('POINT(-73.99 40.73)'),10,1,14,30,3);
