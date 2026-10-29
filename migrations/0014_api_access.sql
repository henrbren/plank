-- API-tilgang uten nettleser: personlige API-nøkler og OAuth (for MCP-klienter som Claude).
-- En nøkkel tilhører én bruker i én organisasjon og gir aldri mer enn medlemskapet gir.
-- Bare hasher lagres. OAuth-tilganger roteres ved fornyelse, men beholder samme rad (id).

CREATE TABLE api_keys (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'key' CHECK (kind IN ('key', 'oauth')),
  token_hash         TEXT NOT NULL UNIQUE,
  prefix             TEXT NOT NULL,           -- de første tegnene, for visning
  can_write          INTEGER NOT NULL DEFAULT 0,
  client_id          TEXT,                    -- OAuth-klienten som fikk tilgangen
  refresh_hash       TEXT UNIQUE,
  expires_at         INTEGER,                 -- null = utløper ikke
  refresh_expires_at INTEGER,
  last_used_at       INTEGER,
  revoked_at         INTEGER,
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_api_keys_org ON api_keys(org_id, user_id);

-- Dynamisk klientregistrering (RFC 7591). Offentlige klienter med PKCE, uten hemmelighet.
CREATE TABLE oauth_clients (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  redirect_uris  TEXT NOT NULL,               -- JSON
  created_at     INTEGER NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  can_write       INTEGER NOT NULL DEFAULT 0,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER,
  created_at      INTEGER NOT NULL
);
