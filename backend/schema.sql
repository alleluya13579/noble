-- Noble schema for PostgreSQL 14+. Used by the server when DATABASE_URL is set.
-- Same tables and columns as schema.sqlite.sql so the application SQL is shared:
-- TEXT ids (UUID strings), BIGINT epoch-millisecond timestamps, JSON kept as TEXT.
-- Money is in minor units (BIGINT) with an ISO 4217 currency code.
--
-- Geography: lat/lng DOUBLE PRECISION columns. For PostGIS radius queries at scale, add
--   CREATE EXTENSION postgis;
--   ALTER TABLE listings ADD COLUMN geog geography(Point,4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat),4326)::geography) STORED;
--   CREATE INDEX listings_geog_idx ON listings USING GIST (geog);
-- and the search query can use ST_DWithin(geog, ST_MakePoint($lng,$lat)::geography, $metres).

CREATE TABLE IF NOT EXISTS countries (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, minor_unit_digits INTEGER NOT NULL DEFAULT 2,
  phone_prefix TEXT NOT NULL, id_document_types TEXT NOT NULL, land_registry TEXT NOT NULL, payment_methods TEXT NOT NULL,
  default_locale TEXT NOT NULL DEFAULT 'en', center_lat DOUBLE PRECISION NOT NULL, center_lng DOUBLE PRECISION NOT NULL,
  deposit_pct_sale DOUBLE PRECISION NOT NULL DEFAULT 10, rent_deposit_months INTEGER NOT NULL DEFAULT 1,
  viewing_days INTEGER NOT NULL DEFAULT 14, handover_days INTEGER NOT NULL DEFAULT 30, commission_pct DOUBLE PRECISION NOT NULL DEFAULT 5
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, country_code TEXT NOT NULL REFERENCES countries(code),
  role TEXT NOT NULL DEFAULT 'buyer' CHECK (role IN ('buyer','seller','agent','admin')),
  full_name TEXT NOT NULL, email TEXT UNIQUE, phone_e164 TEXT UNIQUE, phone_verified_at BIGINT,
  kyc_status TEXT NOT NULL DEFAULT 'none' CHECK (kyc_status IN ('none','pending','verified','rejected')),
  kyc_provider TEXT, kyc_ref TEXT, id_doc_hash TEXT UNIQUE, id_last4 TEXT, agent_licence TEXT,
  locale TEXT NOT NULL DEFAULT 'en', member_since BIGINT NOT NULL, suspended_at BIGINT, suspended_reason TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_codes (
  phone_e164 TEXT PRIMARY KEY, code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY, country_code TEXT NOT NULL REFERENCES countries(code), owner_id TEXT NOT NULL REFERENCES users(id),
  client_owner_name TEXT, type TEXT NOT NULL CHECK (type IN ('sale','rent','land')),
  title TEXT NOT NULL CHECK (length(title) <= 120), description TEXT,
  price_minor BIGINT NOT NULL CHECK (price_minor > 0), currency TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL, place_name TEXT NOT NULL, address_private TEXT,
  size DOUBLE PRECISION NOT NULL, size_unit TEXT NOT NULL CHECK (size_unit IN ('sqm','sqft','acres','hectares','plots')),
  bedrooms INTEGER NOT NULL DEFAULT 0, title_status TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('draft','pending','approved','paused','closed','rejected','removed')),
  reject_reason TEXT, reviewed_by TEXT REFERENCES users(id), reviewed_at BIGINT,
  view_count INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, closed_at BIGINT
);
CREATE INDEX IF NOT EXISTS listings_search_idx ON listings (country_code, status, type, price_minor);
CREATE INDEX IF NOT EXISTS listings_owner_idx ON listings (owner_id);

CREATE TABLE IF NOT EXISTS listing_photos (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL, content_type TEXT NOT NULL, content_hash TEXT NOT NULL, perceptual_hash TEXT,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS listing_photos_hash_idx ON listing_photos (content_hash);

CREATE TABLE IF NOT EXISTS ownership_documents (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('title_deed','registry_search','lease_authority','allotment_letter')),
  object_key TEXT NOT NULL, checks TEXT NOT NULL DEFAULT '{}', checked_by TEXT REFERENCES users(id), checked_at BIGINT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_listings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL, PRIMARY KEY (user_id, listing_id)
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id), buyer_id TEXT NOT NULL REFERENCES users(id),
  owner_id TEXT NOT NULL REFERENCES users(id), created_at BIGINT NOT NULL, UNIQUE (listing_id, buyer_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, sender_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('text','offer','viewing','system')), body TEXT, offer_minor BIGINT, viewing_at BIGINT,
  decision TEXT CHECK (decision IN ('pending','accepted','declined','expired')), created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id, created_at);

CREATE TABLE IF NOT EXISTS messages_raw (message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, body TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, listing_id TEXT NOT NULL REFERENCES listings(id),
  buyer_id TEXT NOT NULL REFERENCES users(id), seller_id TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL, currency TEXT NOT NULL, amount_minor BIGINT NOT NULL, gateway TEXT, gateway_ref TEXT,
  idempotency_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL,   -- full transaction-process object (see src/escrow.js)
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS transactions_state_idx ON transactions (state);
CREATE INDEX IF NOT EXISTS transactions_parties_idx ON transactions (buyer_id, seller_id);

CREATE TABLE IF NOT EXISTS payment_events (
  id BIGSERIAL PRIMARY KEY, transaction_id TEXT NOT NULL REFERENCES transactions(id), gateway TEXT NOT NULL,
  event_type TEXT NOT NULL, gateway_event_id TEXT, amount_minor BIGINT NOT NULL, payload TEXT NOT NULL, received_at BIGINT NOT NULL,
  UNIQUE (gateway, gateway_event_id)
);

CREATE TABLE IF NOT EXISTS transaction_transitions (
  id BIGSERIAL PRIMARY KEY, transaction_id TEXT NOT NULL REFERENCES transactions(id), from_state TEXT, to_state TEXT NOT NULL,
  transition TEXT NOT NULL, actor_id TEXT, note TEXT, created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS ratings (
  transaction_id TEXT NOT NULL REFERENCES transactions(id), from_user_id TEXT NOT NULL REFERENCES users(id),
  to_user_id TEXT NOT NULL REFERENCES users(id), stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5), comment TEXT,
  created_at BIGINT NOT NULL, PRIMARY KEY (transaction_id, from_user_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, listing_id TEXT REFERENCES listings(id), reported_user_id TEXT REFERENCES users(id),
  reporter_id TEXT NOT NULL REFERENCES users(id), reason TEXT NOT NULL, details TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')), resolved_by TEXT, resolved_at BIGINT, created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}', ip_hash TEXT, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_target_idx ON audit_log (target_type, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  user_key TEXT NOT NULL, bucket TEXT NOT NULL, window_start BIGINT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_key, bucket, window_start)
);

INSERT INTO countries VALUES
('KE','Kenya','KES',2,'+254','["national_id","passport"]','Ministry of Lands (Ardhisasa)','["mpesa","airtel_money","card"]','en',-1.29,36.82,10,1,14,30,5),
('UG','Uganda','UGX',0,'+256','["national_id","passport"]','Ministry of Lands, Housing and Urban Development','["mtn_momo","airtel_money","card"]','en',0.35,32.58,10,1,14,30,5),
('TZ','Tanzania','TZS',0,'+255','["nida_id","passport"]','Ministry of Lands (ILMIS)','["mpesa_tz","tigo_pesa","airtel_money","card"]','sw',-6.80,39.28,10,1,14,30,5),
('RW','Rwanda','RWF',0,'+250','["national_id","passport"]','Rwanda Land Management and Use Authority','["mtn_momo","airtel_money","card"]','en',-1.95,30.06,10,1,14,30,5),
('NG','Nigeria','NGN',2,'+234','["nin","passport","drivers_licence"]','State Lands Registry (Governor''s consent)','["bank_transfer","card","ussd"]','en',6.52,3.38,10,1,14,30,5),
('GH','Ghana','GHS',2,'+233','["ghana_card","passport"]','Lands Commission','["mtn_momo","card"]','en',5.60,-0.19,10,1,14,30,5),
('ZA','South Africa','ZAR',2,'+27','["sa_id","passport"]','Deeds Office','["card","eft"]','en',-26.20,28.05,10,1,14,30,4),
('GB','United Kingdom','GBP',2,'+44','["passport","drivers_licence","brp"]','HM Land Registry','["card","open_banking"]','en',51.51,-0.12,10,1,14,30,3),
('US','United States','USD',2,'+1','["passport","drivers_licence","state_id"]','County Recorder','["card","ach"]','en',40.73,-73.99,10,1,14,30,3)
ON CONFLICT (code) DO NOTHING;
