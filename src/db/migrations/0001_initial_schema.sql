-- Cross River State Blue ID & Fisheries Information Management System
-- Initial PostgreSQL schema.
--
-- MIGRATED FROM MONGODB. Four things change shape, and each is an improvement
-- rather than a translation:
--
--   1. Partial unique indexes. Mongo could not express "unique when present"
--      without the `$type: 'string'` trick, because a `sparse` index still
--      collided on explicit nulls. Postgres says `WHERE x IS NOT NULL` and
--      means it. These indexes are the register's integrity guarantees: one
--      Blue ID per fisherman, one allocation per programme per person, one
--      record per client id on replay.
--
--   2. Geography. Community and registration points were GeoJSON in a
--      document; here they are PostGIS `geography(Point,4326)`, so "within
--      5km of this landing site" is an indexed query rather than an
--      application-side filter.
--
--   3. Child collections become tables. Duplicate flags, landing sites and
--      cooperative officers were embedded arrays. Each has its own lifecycle
--      — a flag is raised, reviewed and resolved by a named person — so each
--      becomes a row that can be constrained and audited.
--
--   4. Value objects stay together. A stored image (url, public id,
--      dimensions, bytes) is read as a unit and never filtered field by
--      field, so it stays JSONB rather than spreading eight columns across
--      four tables.
--
-- CHECK CONSTRAINTS are applied to the enumerations that drive behaviour —
-- status, role, LGA — and not to the descriptive ones (hull material, fuel
-- type), which Zod validates and which change with the fishery rather than
-- with the code. The database enforces what must never be wrong; it does not
-- duplicate every list.

-- pgcrypto supplies gen_random_uuid() on PostgreSQL 12; it is built in from
-- 13 onward. postgis supplies the geography type.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;
-- Trigram matching backs the fuzzy name search used by duplicate detection.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The 18 Local Government Areas. Written once and referenced by every table
-- that is scoped, so a typo cannot create a nineteenth.
CREATE DOMAIN lga_code AS text
  CHECK (VALUE IN ('ABI','AKA','AKP','BAK','BEK','BIA','BOK','CAM','CAS',
                   'ETU','IKM','OBA','OBU','OBD','ODU','OGJ','YAK','YAL'));

-- Every table carries these; a trigger keeps updated_at honest.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- Operators
-- ===========================================================================

CREATE TABLE users (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Set only when an external identity provider is in use. Local auth, the
  -- deployed mode, leaves it null and authenticates against password_hash.
  auth_uid               text,

  password_hash          text,
  password_changed_at    timestamptz,
  must_change_password   boolean NOT NULL DEFAULT false,
  reset_token_hash       text,
  reset_token_expires_at timestamptz,
  failed_login_attempts  integer NOT NULL DEFAULT 0,
  locked_until           timestamptz,
  last_login_at          timestamptz,
  last_login_ip          text,

  email                  text,
  phone                  text,
  first_name             text NOT NULL,
  last_name              text NOT NULL,

  role                   text NOT NULL DEFAULT 'ENUMERATOR'
                           CHECK (role IN ('SUPER_ADMIN','STATE_ADMIN','MINISTRY_OFFICER',
                                           'LGA_ADMIN','ENUMERATOR','COOPERATIVE_OFFICER')),
  status                 text NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','DISABLED')),

  -- Geographic scope. Arrays rather than a join table: they are read on every
  -- single request to build the scope filter, never queried in reverse.
  scope_lgas             text[] NOT NULL DEFAULT '{}',
  scope_communities      uuid[] NOT NULL DEFAULT '{}',

  cooperative_id         uuid,
  staff_id               text,
  designation            text,

  invited_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  invited_at             timestamptz,
  activated_at           timestamptz,
  last_seen_at           timestamptz,
  last_device_id         text,

  is_deleted             boolean NOT NULL DEFAULT false,
  deleted_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- One account per address, and one per provider subject. Partial, because a
-- pre-created invitation has neither until it is claimed.
CREATE UNIQUE INDEX user_email    ON users (lower(email)) WHERE email IS NOT NULL AND NOT is_deleted;
CREATE UNIQUE INDEX user_auth_uid ON users (auth_uid)     WHERE auth_uid IS NOT NULL;
CREATE INDEX users_role_status    ON users (role, status) WHERE NOT is_deleted;
CREATE INDEX users_scope_lgas     ON users USING gin (scope_lgas);

CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ===========================================================================
-- Refresh sessions
-- ===========================================================================

CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The token itself is never stored, only its SHA-256.
  token_hash     text NOT NULL UNIQUE,

  -- Rotation lineage. Presenting an already-rotated token means it was
  -- captured, so the whole family is revoked at once.
  family         text NOT NULL,
  rotated_at     timestamptz,
  rotated_to     text,

  revoked_at     timestamptz,
  revoked_reason text,
  expires_at     timestamptz NOT NULL,

  ip_address     text,
  user_agent     text,
  device_code    text,
  last_used_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_live ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family    ON sessions (family);
CREATE INDEX sessions_expiry    ON sessions (expires_at);

CREATE TRIGGER sessions_touch BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ===========================================================================
-- Communities
-- ===========================================================================

CREATE TABLE communities (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  normalized_name        text,
  code                   text,
  lga                    lga_code NOT NULL,
  ward                   text,
  type                   text NOT NULL DEFAULT 'FISHING_VILLAGE',

  location               geography(Point, 4326),

  facilities             jsonb NOT NULL DEFAULT
                           '{"landingSite":false,"coldStorage":false,"iceplant":false,
                             "processingFacility":false,"boatRepair":false,"jetty":false,"market":false}',
  accessibility          jsonb NOT NULL DEFAULT
                           '{"roadAccess":false,"boatOnlyAccess":false,"mobileNetwork":"NONE","electricity":false}',

  estimated_population   integer,
  estimated_fishermen    integer,

  -- Denormalised counts, recalculated by a queued job rather than on write;
  -- recomputing them per registration would serialise the sync pipeline.
  stats                  jsonb NOT NULL DEFAULT '{"registeredFishermen":0,"registeredBoats":0,"registeredEngines":0}',

  -- Fish production (concept note §8) belongs here when catch reporting
  -- arrives as a module; the column exists so the GIS payload has somewhere
  -- to read it from rather than being reshaped later.
  annual_production_kg   numeric(14,2),

  contact_person         jsonb,
  development_needs      text[] NOT NULL DEFAULT '{}',
  notes                  text,

  is_active              boolean NOT NULL DEFAULT true,
  is_deleted             boolean NOT NULL DEFAULT false,
  deleted_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX community_code      ON communities (code) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX community_name_lga  ON communities (lga, normalized_name) WHERE NOT is_deleted;
CREATE INDEX communities_lga            ON communities (lga) WHERE NOT is_deleted;
CREATE INDEX communities_location       ON communities USING gist (location);
CREATE INDEX communities_name_trgm      ON communities USING gin (name gin_trgm_ops);

CREATE TRIGGER communities_touch BEFORE UPDATE ON communities
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- An embedded array in Mongo. A landing site has its own coordinates and is
-- shown individually on the map, so it earns a row.
CREATE TABLE community_landing_sites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name         text NOT NULL,
  location     geography(Point, 4326),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX landing_sites_community ON community_landing_sites (community_id);
CREATE INDEX landing_sites_location  ON community_landing_sites USING gist (location);

-- ===========================================================================
-- Cooperatives
-- ===========================================================================

CREATE TABLE cooperatives (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  normalized_name      text,
  registration_number  text,
  lga                  lga_code NOT NULL,
  community_id         uuid REFERENCES communities(id) ON DELETE SET NULL,
  community_name       text,
  address              text,
  registered_at        timestamptz,

  contact_phone        text,
  contact_email        text,

  -- Only the last four digits are ever stored; the full account number is
  -- not needed to identify a society and would be a liability if held.
  bank_details         jsonb,

  member_count         integer NOT NULL DEFAULT 0,
  is_active            boolean NOT NULL DEFAULT true,
  is_deleted           boolean NOT NULL DEFAULT false,
  deleted_at           timestamptz,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX cooperative_registration_number
  ON cooperatives (registration_number) WHERE registration_number IS NOT NULL;
CREATE INDEX cooperatives_lga ON cooperatives (lga) WHERE NOT is_deleted;

CREATE TRIGGER cooperatives_touch BEFORE UPDATE ON cooperatives
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE cooperative_officers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cooperative_id uuid NOT NULL REFERENCES cooperatives(id) ON DELETE CASCADE,
  name           text NOT NULL,
  role           text,
  phone          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cooperative_officers_coop ON cooperative_officers (cooperative_id);

ALTER TABLE users
  ADD CONSTRAINT users_cooperative_fk
  FOREIGN KEY (cooperative_id) REFERENCES cooperatives(id) ON DELETE SET NULL;

-- ===========================================================================
-- Field devices
-- ===========================================================================

CREATE TABLE devices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code       text NOT NULL UNIQUE,
  label             text,
  hardware_id       text,
  platform          text NOT NULL DEFAULT 'ANDROID',
  model             text,
  os_version        text,
  app_version       text,

  assigned_to       uuid REFERENCES users(id) ON DELETE SET NULL,
  lga               lga_code,
  communities       uuid[] NOT NULL DEFAULT '{}',

  status            text NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED')),
  secret_hash       text,

  last_seen_at      timestamptz,
  last_sync_at      timestamptz,

  -- Per-entity sync cursors. One cursor per entity kind, because a single
  -- shared cursor silently skipped records whose entity sorted earlier.
  last_sync_cursors jsonb NOT NULL DEFAULT '{}',

  stats             jsonb NOT NULL DEFAULT '{"recordsPushed":0,"recordsPulled":0,"batchesProcessed":0}',

  registered_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at        timestamptz,
  revoked_reason    text,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX devices_assigned ON devices (assigned_to);
CREATE INDEX devices_lga      ON devices (lga);

CREATE TRIGGER devices_touch BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ===========================================================================
-- Fishermen — the register itself
-- ===========================================================================

CREATE TABLE fishermen (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Issued on verification, never at registration. Null until an officer
  -- approves the record, which is what the partial unique index allows.
  blue_id                    text,
  temp_reference             text,

  first_name                 text NOT NULL,
  middle_name                text,
  last_name                  text NOT NULL,
  full_name                  text,
  alias                      text,

  gender                     text NOT NULL CHECK (gender IN ('MALE','FEMALE','OTHER')),
  date_of_birth              date,
  estimated_year_of_birth    integer,

  photo                      jsonb,
  phone                      text,
  alt_phone                  text,

  -- AES-256-GCM ciphertext. The plaintext NIN is never stored or queried;
  -- matching goes through nin_index below.
  nin_encrypted              text,

  next_of_kin_name           text,
  next_of_kin_phone          text,
  next_of_kin_relationship   text,

  lga                        lga_code NOT NULL,
  community_id               uuid REFERENCES communities(id) ON DELETE SET NULL,
  community_name             text,
  landing_site               text,
  address                    text,
  ward                       text,
  location                   geography(Point, 4326),

  fisherman_types            text[] NOT NULL DEFAULT '{}',
  fishing_types              text[] NOT NULL DEFAULT '{}',
  years_fishing              integer,
  is_full_time               boolean NOT NULL DEFAULT true,
  secondary_occupation       text,
  estimated_monthly_catch_kg numeric(10,2),

  cooperative_id             uuid REFERENCES cooperatives(id) ON DELETE SET NULL,
  cooperative_name           text,
  cooperative_membership_no  text,
  cooperative_joined_at      timestamptz,

  status                     text NOT NULL DEFAULT 'PENDING_VERIFICATION'
                               CHECK (status IN ('PENDING_VERIFICATION','ACTIVE','SUSPENDED',
                                                 'DECEASED','INACTIVE','DUPLICATE_UNDER_REVIEW')),
  status_reason              text,
  status_changed_at          timestamptz,
  status_changed_by          uuid REFERENCES users(id) ON DELETE SET NULL,

  verified_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at                timestamptz,
  verification_notes         text,

  merged_into                uuid REFERENCES fishermen(id) ON DELETE SET NULL,

  -- Idempotency key from the field device. Makes a replayed sync a no-op
  -- rather than a second person.
  client_record_id           text,
  registration_channel       text NOT NULL DEFAULT 'FIELD_APP',
  registered_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id                  uuid REFERENCES devices(id) ON DELETE SET NULL,
  captured_at                timestamptz,
  synced_at                  timestamptz,
  client_revision            integer NOT NULL DEFAULT 0,

  -- Derived matching keys, maintained by the application on write. Held as
  -- plain columns rather than a nested object so each can be indexed.
  normalized_phone           text,
  normalized_alt_phone       text,
  nin_index                  text,   -- keyed HMAC blind index
  normalized_name            text,
  phonetic_name              text,
  birth_year                 integer,
  photo_hash                 text,   -- perceptual hash; concept note §10 names
                                     -- photograph as a duplicate signal

  -- Opaque QR token. Never the Blue ID: a card photographed by a stranger
  -- would otherwise hand over a real identifier.
  verification_token         text,
  qr_version                 integer NOT NULL DEFAULT 1,
  id_card_issued_at          timestamptz,
  id_card_issued_by          uuid REFERENCES users(id) ON DELETE SET NULL,

  notes                      text,
  tags                       text[] NOT NULL DEFAULT '{}',

  is_deleted                 boolean NOT NULL DEFAULT false,
  deleted_at                 timestamptz,
  deleted_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),

  -- Full-text search over the name, maintained by Postgres rather than by a
  -- hook that a future write path might forget to call.
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(first_name,'') || ' ' || coalesce(middle_name,'') || ' ' ||
      coalesce(last_name,'')  || ' ' || coalesce(alias,'')       || ' ' ||
      coalesce(blue_id,''))
  ) STORED
);

-- The integrity guarantees. Each of these, if missing, produces bad data
-- silently rather than an error.
CREATE UNIQUE INDEX fisherman_blue_id
  ON fishermen (blue_id) WHERE blue_id IS NOT NULL;
CREATE UNIQUE INDEX fisherman_client_record_id
  ON fishermen (client_record_id) WHERE client_record_id IS NOT NULL;
CREATE UNIQUE INDEX fisherman_verification_token
  ON fishermen (verification_token) WHERE verification_token IS NOT NULL;

CREATE INDEX fishermen_lga_status   ON fishermen (lga, status) WHERE NOT is_deleted;
CREATE INDEX fishermen_community    ON fishermen (community_id) WHERE NOT is_deleted;
CREATE INDEX fishermen_cooperative  ON fishermen (cooperative_id) WHERE cooperative_id IS NOT NULL;
CREATE INDEX fishermen_registered_by ON fishermen (registered_by);
CREATE INDEX fishermen_created_at   ON fishermen (created_at DESC);
CREATE INDEX fishermen_updated_at   ON fishermen (updated_at, id);  -- sync keyset cursor
CREATE INDEX fishermen_location     ON fishermen USING gist (location);
CREATE INDEX fishermen_search       ON fishermen USING gin (search_vector);
CREATE INDEX fishermen_types        ON fishermen USING gin (fisherman_types);
CREATE INDEX fishermen_fishing      ON fishermen USING gin (fishing_types);

-- Duplicate-detection lookups.
CREATE INDEX fishermen_norm_phone   ON fishermen (normalized_phone) WHERE normalized_phone IS NOT NULL;
CREATE INDEX fishermen_nin_index    ON fishermen (nin_index) WHERE nin_index IS NOT NULL;
CREATE INDEX fishermen_phonetic     ON fishermen (lga, phonetic_name) WHERE phonetic_name IS NOT NULL;
CREATE INDEX fishermen_photo_hash   ON fishermen (photo_hash) WHERE photo_hash IS NOT NULL;

CREATE TRIGGER fishermen_touch BEFORE UPDATE ON fishermen
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Flagged, never deleted (concept note §10). A flag is raised by matching, and
-- resolved by a named administrator whose decision is recorded.
CREATE TABLE fisherman_duplicate_flags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fisherman_id    uuid NOT NULL REFERENCES fishermen(id) ON DELETE CASCADE,
  candidate_id    uuid NOT NULL REFERENCES fishermen(id) ON DELETE CASCADE,
  score           numeric(4,3) NOT NULL,
  reasons         text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','DISMISSED','MERGED','CONFIRMED_DISTINCT')),
  resolution_note text,
  resolved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT duplicate_flag_not_self CHECK (fisherman_id <> candidate_id)
);

-- One open flag per pair, in one direction only.
CREATE UNIQUE INDEX duplicate_flag_pair
  ON fisherman_duplicate_flags (least(fisherman_id, candidate_id), greatest(fisherman_id, candidate_id))
  WHERE status = 'PENDING';
CREATE INDEX duplicate_flags_pending ON fisherman_duplicate_flags (status, created_at DESC);

-- ===========================================================================
-- Assets
-- ===========================================================================

CREATE TABLE boats (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES fishermen(id) ON DELETE RESTRICT,
  blue_id             text,
  lga                 lga_code NOT NULL,
  community_id        uuid REFERENCES communities(id) ON DELETE SET NULL,

  registration_number text,
  name                text,
  boat_type           text NOT NULL,
  canoe_type          text,
  material            text,
  length_meters       numeric(6,2),
  width_meters        numeric(6,2),
  crew_capacity       integer,
  cargo_capacity_kg   numeric(10,2),
  propulsion          text NOT NULL DEFAULT 'PADDLE',
  condition           text NOT NULL DEFAULT 'FAIR',
  year_acquired       integer,
  acquisition_source  text NOT NULL DEFAULT 'SELF_PURCHASED',
  allocation_id       uuid,
  photo               jsonb,
  estimated_value     numeric(14,2),

  is_active           boolean NOT NULL DEFAULT true,
  client_record_id    text,
  registered_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id           uuid REFERENCES devices(id) ON DELETE SET NULL,
  captured_at         timestamptz,
  synced_at           timestamptz,
  client_revision     integer NOT NULL DEFAULT 0,
  notes               text,

  is_deleted          boolean NOT NULL DEFAULT false,
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX boat_registration_number
  ON boats (registration_number) WHERE registration_number IS NOT NULL;
CREATE UNIQUE INDEX boat_client_record_id
  ON boats (client_record_id) WHERE client_record_id IS NOT NULL;
CREATE INDEX boats_owner    ON boats (owner_id) WHERE NOT is_deleted;
CREATE INDEX boats_lga      ON boats (lga) WHERE NOT is_deleted;
CREATE INDEX boats_updated  ON boats (updated_at, id);

CREATE TRIGGER boats_touch BEFORE UPDATE ON boats
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE engines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid NOT NULL REFERENCES fishermen(id) ON DELETE RESTRICT,
  blue_id            text,
  lga                lga_code NOT NULL,
  boat_id            uuid REFERENCES boats(id) ON DELETE SET NULL,

  manufacturer       text NOT NULL,
  model              text,
  horsepower         numeric(6,1),
  serial_number      text,
  engine_type        text NOT NULL DEFAULT 'OUTBOARD',
  fuel_type          text NOT NULL DEFAULT 'PETROL',
  condition          text NOT NULL DEFAULT 'FAIR',
  year_acquired      integer,
  acquisition_source text NOT NULL DEFAULT 'SELF_PURCHASED',
  allocation_id      uuid,
  last_serviced_at   timestamptz,
  photo              jsonb,
  estimated_value    numeric(14,2),

  is_active          boolean NOT NULL DEFAULT true,
  client_record_id   text,
  registered_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id          uuid REFERENCES devices(id) ON DELETE SET NULL,
  captured_at        timestamptz,
  synced_at          timestamptz,
  client_revision    integer NOT NULL DEFAULT 0,
  notes              text,

  is_deleted         boolean NOT NULL DEFAULT false,
  deleted_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX engine_serial_number
  ON engines (serial_number) WHERE serial_number IS NOT NULL;
CREATE UNIQUE INDEX engine_client_record_id
  ON engines (client_record_id) WHERE client_record_id IS NOT NULL;
CREATE INDEX engines_owner   ON engines (owner_id) WHERE NOT is_deleted;
CREATE INDEX engines_lga     ON engines (lga) WHERE NOT is_deleted;
CREATE INDEX engines_updated ON engines (updated_at, id);

CREATE TRIGGER engines_touch BEFORE UPDATE ON engines
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE equipment (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid NOT NULL REFERENCES fishermen(id) ON DELETE RESTRICT,
  blue_id            text,
  lga                lga_code NOT NULL,

  type               text NOT NULL,
  description        text,
  quantity           integer NOT NULL DEFAULT 1,
  unit               text NOT NULL DEFAULT 'UNIT',
  specification      jsonb,
  condition          text NOT NULL DEFAULT 'FAIR',
  year_acquired      integer,
  acquisition_source text NOT NULL DEFAULT 'SELF_PURCHASED',
  allocation_id      uuid,
  photo              jsonb,
  estimated_value    numeric(14,2),

  is_active          boolean NOT NULL DEFAULT true,
  client_record_id   text,
  registered_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id          uuid REFERENCES devices(id) ON DELETE SET NULL,
  captured_at        timestamptz,
  synced_at          timestamptz,
  client_revision    integer NOT NULL DEFAULT 0,
  notes              text,

  is_deleted         boolean NOT NULL DEFAULT false,
  deleted_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX equipment_client_record_id
  ON equipment (client_record_id) WHERE client_record_id IS NOT NULL;
CREATE INDEX equipment_owner   ON equipment (owner_id) WHERE NOT is_deleted;
CREATE INDEX equipment_lga     ON equipment (lga) WHERE NOT is_deleted;
CREATE INDEX equipment_updated ON equipment (updated_at, id);

CREATE TRIGGER equipment_touch BEFORE UPDATE ON equipment
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ===========================================================================
-- Programmes and allocations
-- ===========================================================================

CREATE TABLE programmes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  code                 text NOT NULL UNIQUE,
  type                 text NOT NULL,
  description          text,
  year                 integer NOT NULL,
  implementing_agency  text,
  funding_source       text,
  status               text NOT NULL DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT','OPEN','CLOSED','ARCHIVED')),
  start_date           date,
  end_date             date,

  item_description     text,
  unit_value           numeric(14,2),
  currency             text NOT NULL DEFAULT 'NGN',
  target_beneficiaries integer,
  allocated_count      integer NOT NULL DEFAULT 0,
  delivered_count      integer NOT NULL DEFAULT 0,
  total_budget         numeric(16,2),

  -- Eligibility rules, evaluated as a unit against a candidate.
  eligibility          jsonb NOT NULL DEFAULT '{}',

  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at          timestamptz,

  is_deleted           boolean NOT NULL DEFAULT false,
  deleted_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT programme_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE INDEX programmes_status_year ON programmes (status, year DESC) WHERE NOT is_deleted;

CREATE TRIGGER programmes_touch BEFORE UPDATE ON programmes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE allocations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id         uuid NOT NULL REFERENCES programmes(id) ON DELETE RESTRICT,
  programme_code       text,
  programme_type       text,

  fisherman_id         uuid NOT NULL REFERENCES fishermen(id) ON DELETE RESTRICT,
  blue_id              text NOT NULL,
  fisherman_name       text,
  lga                  lga_code NOT NULL,
  community_id         uuid REFERENCES communities(id) ON DELETE SET NULL,

  item_description     text,
  quantity             integer NOT NULL DEFAULT 1,
  value                numeric(14,2),
  currency             text NOT NULL DEFAULT 'NGN',

  asset_type           text,
  asset_ref            uuid,
  asset_model          text,

  status               text NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING','APPROVED','DELIVERED','REJECTED','REVOKED')),

  allocated_by         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  allocated_at         timestamptz NOT NULL DEFAULT now(),
  approved_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at          timestamptz,
  delivered_at         timestamptz,
  delivered_by         uuid REFERENCES users(id) ON DELETE SET NULL,

  acknowledgement      jsonb,
  rejection_reason     text,
  revoked_reason       text,
  notes                text,

  client_record_id     text,
  device_id            uuid REFERENCES devices(id) ON DELETE SET NULL,

  -- Mirrors status: true while the allocation still counts against the
  -- programme. Drives the one-per-programme index below.
  is_active_allocation boolean NOT NULL DEFAULT true,

  captured_at          timestamptz,
  synced_at            timestamptz,
  is_deleted           boolean NOT NULL DEFAULT false,
  deleted_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- The duplicate-benefit guarantee: one live allocation per person per
-- programme. A rejected or revoked allocation clears is_active_allocation,
-- which is what lets a corrected re-issue through.
CREATE UNIQUE INDEX one_active_allocation_per_programme
  ON allocations (programme_id, fisherman_id)
  WHERE is_active_allocation AND NOT is_deleted;

CREATE UNIQUE INDEX allocation_client_record_id
  ON allocations (client_record_id) WHERE client_record_id IS NOT NULL;

CREATE INDEX allocations_fisherman ON allocations (fisherman_id) WHERE NOT is_deleted;
CREATE INDEX allocations_programme ON allocations (programme_id, status);
CREATE INDEX allocations_lga       ON allocations (lga, allocated_at DESC);
CREATE INDEX allocations_updated   ON allocations (updated_at, id);

CREATE TRIGGER allocations_touch BEFORE UPDATE ON allocations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE boats     ADD CONSTRAINT boats_allocation_fk
  FOREIGN KEY (allocation_id) REFERENCES allocations(id) ON DELETE SET NULL;
ALTER TABLE engines   ADD CONSTRAINT engines_allocation_fk
  FOREIGN KEY (allocation_id) REFERENCES allocations(id) ON DELETE SET NULL;
ALTER TABLE equipment ADD CONSTRAINT equipment_allocation_fk
  FOREIGN KEY (allocation_id) REFERENCES allocations(id) ON DELETE SET NULL;

-- ===========================================================================
-- Sync
-- ===========================================================================

CREATE TABLE sync_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Replay key. A device that retries a batch gets the stored outcome rather
  -- than processing it twice.
  client_batch_id   text NOT NULL UNIQUE,
  device_id         uuid REFERENCES devices(id) ON DELETE SET NULL,
  device_code       text,
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,

  direction         text NOT NULL DEFAULT 'PUSH' CHECK (direction IN ('PUSH','PULL')),
  status            text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','PROCESSING','COMPLETED','PARTIAL','FAILED')),

  counts            jsonb NOT NULL DEFAULT '{}',
  results           jsonb NOT NULL DEFAULT '[]',

  -- Payloads that failed validation, kept so a record is never lost silently
  -- (concept note §4d). Read only by an administrator investigating.
  rejected_payloads jsonb NOT NULL DEFAULT '[]',

  app_version       text,
  network_type      text,
  captured_from     timestamptz,
  captured_to       timestamptz,
  started_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  duration_ms       integer,
  error             text,
  request_id        text,
  ip_address        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sync_batches_device ON sync_batches (device_id, created_at DESC);
-- Finds batches abandoned by a crashed process so they can be reclaimed.
CREATE INDEX sync_batches_stuck  ON sync_batches (status, started_at) WHERE status = 'PROCESSING';

CREATE TRIGGER sync_batches_touch BEFORE UPDATE ON sync_batches
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ===========================================================================
-- Audit trail (concept note §9)
-- ===========================================================================

CREATE TABLE audit_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action         text NOT NULL,

  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_name     text,
  actor_email    text,
  actor_role     text,
  actor_service  text,

  entity_type    text NOT NULL,
  entity_id      uuid,
  entity_blue_id text,
  entity_label   text,

  -- Field-level before/after. JSONB because it is written once and read whole.
  changes        jsonb NOT NULL DEFAULT '[]',
  metadata       jsonb,

  lga            text,
  request_id     text,
  ip_address     text,
  user_agent     text,
  device_id      uuid REFERENCES devices(id) ON DELETE SET NULL,
  device_code    text,

  succeeded      boolean NOT NULL DEFAULT true,
  failure_reason text,

  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_entity  ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_actor   ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_action  ON audit_logs (action, created_at DESC);
CREATE INDEX audit_created ON audit_logs (created_at DESC);

-- ===========================================================================
-- Transactional outbox
-- ===========================================================================

CREATE TABLE outbox_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED','DEAD')),

  -- Collapses repeat requests for the same work into one job.
  dedupe_key    text,

  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  run_at        timestamptz NOT NULL DEFAULT now(),
  locked_by     text,
  locked_until  timestamptz,
  last_error    text,
  completed_at  timestamptz,
  side_effects  jsonb NOT NULL DEFAULT '[]',

  request_id    text,
  actor_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  lga           text,
  priority      integer NOT NULL DEFAULT 0,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX outbox_dedupe_key
  ON outbox_jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('PENDING','PROCESSING');
-- The claim query: highest priority, due, not locked.
CREATE INDEX outbox_claimable
  ON outbox_jobs (status, priority DESC, run_at) WHERE status = 'PENDING';

CREATE TRIGGER outbox_touch BEFORE UPDATE ON outbox_jobs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ===========================================================================
-- Blue ID sequence
-- ===========================================================================

-- One row per LGA. The Blue ID's numeric tail comes from an atomic
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING, which cannot hand the same
-- number to two concurrent registrations.
CREATE TABLE counters (
  key        text PRIMARY KEY,
  seq        bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER counters_touch BEFORE UPDATE ON counters
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
