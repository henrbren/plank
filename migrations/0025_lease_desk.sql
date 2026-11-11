-- Utleiepulten: leieobjekter, leieforhold og brev som ligger på saken.
CREATE TABLE lease_units (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  building_id       TEXT REFERENCES buildings(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  address           TEXT,
  kind              TEXT NOT NULL CHECK (kind IN ('bolig', 'naering')),
  area_sqm          REAL,
  rooms             INTEGER,
  status            TEXT NOT NULL CHECK (status IN ('vacant', 'make_ready', 'occupied', 'reserved')),
  market_rent_year  INTEGER NOT NULL DEFAULT 0,
  vacant_since      TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_lease_units_org ON lease_units(org_id);

CREATE TABLE leases (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  unit_id       TEXT REFERENCES lease_units(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('bolig', 'naering')),
  tenant_name   TEXT NOT NULL,
  stage         TEXT NOT NULL CHECK (stage IN ('vedtak', 'offer', 'contract', 'move_in', 'active', 'move_out', 'ended')),
  rent_year     INTEGER NOT NULL DEFAULT 0,
  start_on      TEXT,
  end_on        TEXT,
  break_on      TEXT,
  signed_on     TEXT,
  listed_on     TEXT,
  arrears_nok   INTEGER NOT NULL DEFAULT 0,
  arrears_days  INTEGER NOT NULL DEFAULT 0,
  index_on      TEXT,
  move_out_on   TEXT,
  keys_on       TEXT,
  vedtak_on     TEXT,
  need          TEXT,
  household     TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_leases_org ON leases(org_id);

CREATE TABLE lease_letters (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lease_id    TEXT REFERENCES leases(id) ON DELETE CASCADE,
  unit_id     TEXT REFERENCES lease_units(id) ON DELETE SET NULL,
  case_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_by  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_lease_letters_case ON lease_letters(org_id, case_id);
