-- Forespørsler om tilgang uten Vipps: navn, e-post og samtykke. Bedrifter godkjennes i
-- boligmappa-ms-admin (Tilgangsforespørsler), kommuner går i lead-køen som før.

CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'org',            -- org | kommune
  org_nr TEXT NOT NULL,
  org_name TEXT,
  org_form TEXT,
  brand TEXT NOT NULL,
  origin TEXT NOT NULL,                        -- domenet forespørselen kom fra, brukes i e-postlenken
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  consent_text TEXT NOT NULL,
  consent_at INTEGER NOT NULL,
  ip TEXT,
  context TEXT,                                -- JSON: roller i Brønnøysund, navnetreff, bygg Boligmappa har gitt tilgang til
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected
  ms_synced_at INTEGER,                        -- når boligmappa-ms tok imot forespørselen
  ms_error TEXT,
  ms_attempts INTEGER NOT NULL DEFAULT 0,
  decision_note TEXT,
  decided_by TEXT,
  decided_at INTEGER,
  org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_access_requests_status ON access_requests(status, created_at);
CREATE INDEX idx_access_requests_email ON access_requests(email, created_at);
CREATE INDEX idx_access_requests_user ON access_requests(user_id, created_at);
