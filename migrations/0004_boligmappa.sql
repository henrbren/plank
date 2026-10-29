-- Cache av Boligmappa-hierarkiet, og kobling til porteføljen.
-- API-et er tregt, så siden leser bare herfra.

ALTER TABLE properties ADD COLUMN boligmappa_key TEXT;
ALTER TABLE buildings ADD COLUMN boligmappa_number TEXT;
ALTER TABLE documents ADD COLUMN boligmappa_id TEXT;

CREATE INDEX idx_properties_boligmappa ON properties(org_id, boligmappa_key);
CREATE INDEX idx_buildings_boligmappa ON buildings(org_id, boligmappa_number);
CREATE INDEX idx_documents_boligmappa ON documents(org_id, boligmappa_id);

CREATE TABLE bm_sources (
  org_id          TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  org_nr          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'idle',
  phase           TEXT NOT NULL DEFAULT 'buildings',
  page            INTEGER NOT NULL DEFAULT 1,
  building_count  INTEGER NOT NULL DEFAULT 0,
  unit_count      INTEGER NOT NULL DEFAULT 0,
  document_count  INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE bm_buildings (
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  bmn             TEXT NOT NULL,
  building_number TEXT,
  name            TEXT NOT NULL,
  address         TEXT,
  postal_code     TEXT,
  city            TEXT,
  municipality    TEXT,
  knr             TEXT,
  gnr             TEXT,
  bnr             TEXT,
  building_type   TEXT,
  year_built      INTEGER,
  area_m2         REAL,
  estate_key      TEXT NOT NULL,
  docs_page       INTEGER NOT NULL DEFAULT 0,
  docs_fetched_at INTEGER,
  PRIMARY KEY (org_id, bmn)
);
CREATE INDEX idx_bm_buildings_estate ON bm_buildings(org_id, estate_key);

CREATE TABLE bm_units (
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  bmn             TEXT NOT NULL,
  building_bmn    TEXT,
  building_number TEXT,
  name            TEXT NOT NULL,
  address         TEXT,
  postal_code     TEXT,
  city            TEXT,
  unit_number     TEXT,
  estate_key      TEXT NOT NULL,
  docs_page       INTEGER NOT NULL DEFAULT 0,
  docs_fetched_at INTEGER,
  PRIMARY KEY (org_id, bmn)
);
CREATE INDEX idx_bm_units_building ON bm_units(org_id, building_bmn);

CREATE TABLE bm_documents (
  org_id               TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  remote_id            TEXT NOT NULL,
  owner_kind           TEXT NOT NULL,
  owner_bmn            TEXT NOT NULL,
  title                TEXT NOT NULL,
  filename             TEXT,
  category             TEXT,
  download_url         TEXT,
  error                TEXT,
  imported_document_id TEXT,
  PRIMARY KEY (org_id, remote_id)
);
CREATE INDEX idx_bm_documents_owner ON bm_documents(org_id, owner_kind, owner_bmn);
