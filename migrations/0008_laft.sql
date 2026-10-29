-- LAFT: innlogging via LAFT ID, tilkobling per organisasjon og kobling av objekter hentet fra LAFT.
-- Sider kan i tillegg festes i sidemenyen.

-- Én rad per LAFT-bruker (instans + bruker-ID). Raden er også innloggingskoblingen til Plank-brukeren.
-- user_id er NULL mens koblingen venter på at eieren av e-postadressen bekrefter den.
CREATE TABLE laft_accounts (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT REFERENCES users(id) ON DELETE CASCADE,
  server_url         TEXT NOT NULL,
  server_name        TEXT NOT NULL,
  laft_user_id       TEXT NOT NULL,
  email              TEXT NOT NULL,
  name               TEXT,
  role               TEXT,
  area_id            TEXT,
  area_name          TEXT,
  jwt_enc            TEXT,
  jwt_expires_at     INTEGER,
  refresh_enc        TEXT,
  refresh_expires_at INTEGER,
  refresh_lock_until INTEGER,
  status             TEXT NOT NULL DEFAULT 'ok',
  error              TEXT,
  refreshed_at       INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_laft_accounts_identity ON laft_accounts(server_url, laft_user_id);
CREATE INDEX idx_laft_accounts_user ON laft_accounts(user_id);

ALTER TABLE orgs ADD COLUMN laft_account_id TEXT;
ALTER TABLE login_tokens ADD COLUMN payload TEXT;

-- «host:id», f.eks. kommune.laft.io:123. Eiendommer får en nøkkel fordi LAFT ikke har eiendom over bygget.
ALTER TABLE properties ADD COLUMN laft_key TEXT;
ALTER TABLE buildings ADD COLUMN laft_ref TEXT;
ALTER TABLE floors ADD COLUMN laft_ref TEXT;
ALTER TABLE rooms ADD COLUMN laft_ref TEXT;
ALTER TABLE documents ADD COLUMN laft_ref TEXT;

CREATE INDEX idx_properties_laft ON properties(org_id, laft_key);
CREATE INDEX idx_buildings_laft ON buildings(org_id, laft_ref);
CREATE INDEX idx_floors_laft ON floors(org_id, laft_ref);
CREATE INDEX idx_rooms_laft ON rooms(org_id, laft_ref);
CREATE INDEX idx_documents_laft ON documents(org_id, laft_ref);

-- Innloggingsforsøk (LAFT-passord går via Plank, så vi begrenser antall forsøk).
CREATE TABLE auth_attempts (
  key         TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_auth_attempts ON auth_attempts(key, created_at);

-- Sider i sidemenyen: NULL = ikke i menyen. Lavest tall vises først.
ALTER TABLE artifacts ADD COLUMN sidebar_order INTEGER;
ALTER TABLE artifacts ADD COLUMN sidebar_icon TEXT;
