-- Plank – grunnskjema
-- Alle tidsstempler er millisekunder siden epoch (INTEGER). Datoer uten klokkeslett er 'YYYY-MM-DD' (TEXT).

-- ─── Brukere, organisasjoner og innlogging ──────────────────────────────────

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE orgs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE memberships (
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE login_tokens (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  redirect    TEXT,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_login_tokens_email ON login_tokens(email, created_at);

CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ─── Portefølje: eiendom → bygg → etasje → rom ──────────────────────────────

CREATE TABLE properties (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  address       TEXT,
  postal_code   TEXT,
  city          TEXT,
  municipality  TEXT,
  gnr           TEXT,
  bnr           TEXT,
  description   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_properties_org ON properties(org_id);

CREATE TABLE buildings (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  property_id     TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  building_number TEXT,          -- bygningsnummer i matrikkelen
  building_type   TEXT,          -- formål, f.eks. kontor, bolig, skole
  year_built      INTEGER,
  gross_area      REAL,          -- BTA m²
  description     TEXT,
  ifc_guid        TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_buildings_org ON buildings(org_id);
CREATE INDEX idx_buildings_property ON buildings(property_id);

CREATE TABLE floors (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  building_id   TEXT NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  level         INTEGER NOT NULL DEFAULT 0,   -- sortering: -1 kjeller, 0 = 1. etg osv.
  elevation     REAL,
  gross_area    REAL,
  ifc_guid      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_floors_building ON floors(building_id, level);
CREATE INDEX idx_floors_org ON floors(org_id);

CREATE TABLE rooms (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  building_id   TEXT NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  floor_id      TEXT NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  number        TEXT,          -- romnummer
  usage         TEXT,          -- funksjon, f.eks. kontor, teknisk rom
  area          REAL,          -- NTA/BRA m²
  ifc_guid      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_rooms_floor ON rooms(floor_id);
CREATE INDEX idx_rooms_org ON rooms(org_id);

-- ─── FDV-register: komponenter ──────────────────────────────────────────────

CREATE TABLE components (
  id                      TEXT PRIMARY KEY,
  org_id                  TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  building_id             TEXT REFERENCES buildings(id) ON DELETE CASCADE,
  floor_id                TEXT REFERENCES floors(id) ON DELETE SET NULL,
  room_id                 TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  name                    TEXT NOT NULL,
  ns3451                  TEXT,     -- bygningsdelskode, f.eks. 360 (ventilasjon)
  tfm                     TEXT,     -- TFM-merking, f.eks. =360.001-RT401
  category                TEXT,
  manufacturer            TEXT,
  model                   TEXT,
  serial_number           TEXT,
  supplier                TEXT,
  installed_at            TEXT,
  warranty_until          TEXT,
  service_interval_months INTEGER,
  last_service_at         TEXT,
  next_service_at         TEXT,     -- beregnet ved lagring
  condition               TEXT,     -- TG0–TG3 (NS 3424)
  ifc_guid                TEXT,
  notes                   TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);
CREATE INDEX idx_components_org ON components(org_id);
CREATE INDEX idx_components_building ON components(building_id);
CREATE INDEX idx_components_next_service ON components(org_id, next_service_at);

-- ─── Dokumenter og fulltekstsøk ─────────────────────────────────────────────

CREATE TABLE documents (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  property_id   TEXT REFERENCES properties(id) ON DELETE SET NULL,
  building_id   TEXT REFERENCES buildings(id) ON DELETE SET NULL,
  floor_id      TEXT REFERENCES floors(id) ON DELETE SET NULL,
  room_id       TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  component_id  TEXT REFERENCES components(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  filename      TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'annet',
  ns3451        TEXT,
  status        TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'error', 'stored')),
  error         TEXT,
  summary       TEXT,
  text_chars    INTEGER,
  uploaded_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_documents_org ON documents(org_id, created_at);
CREATE INDEX idx_documents_building ON documents(building_id);
CREATE INDEX idx_documents_property ON documents(property_id);

-- Uttrukket tekst (markdown) per dokument
CREATE TABLE document_text (
  document_id   TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  content       TEXT NOT NULL
);

-- Fulltekstindeks over tekstbiter (chunks)
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  content,
  title,
  document_id UNINDEXED,
  org_id UNINDEXED,
  chunk_index UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ─── Oppgaver: vedlikehold, avvik, kontroller ──────────────────────────────

CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  property_id       TEXT REFERENCES properties(id) ON DELETE CASCADE,
  building_id       TEXT REFERENCES buildings(id) ON DELETE CASCADE,
  floor_id          TEXT REFERENCES floors(id) ON DELETE SET NULL,
  room_id           TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  component_id      TEXT REFERENCES components(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  type              TEXT NOT NULL DEFAULT 'vedlikehold' CHECK (type IN ('vedlikehold', 'avvik', 'kontroll', 'dokumentasjon', 'annet')),
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  priority          TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  due_date          TEXT,
  assignee          TEXT,
  created_by_user   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_agent  TEXT,
  completed_at      INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_tasks_org ON tasks(org_id, status, due_date);
CREATE INDEX idx_tasks_building ON tasks(building_id);

-- ─── Agenter, samtaler og kjøringer ─────────────────────────────────────────

CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  icon            TEXT NOT NULL DEFAULT 'bot',
  color           TEXT NOT NULL DEFAULT 'wood',
  description     TEXT,
  instructions    TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL,
  effort          TEXT NOT NULL DEFAULT 'medium',
  tools           TEXT NOT NULL DEFAULT '[]',     -- JSON: verktøygrupper
  scope_type      TEXT NOT NULL DEFAULT 'org' CHECK (scope_type IN ('org', 'property', 'building')),
  scope_id        TEXT,
  schedule        TEXT,                           -- f.eks. daily@07:00, weekly:1@07:00, monthly:1@07:00
  schedule_prompt TEXT,
  notify_emails   TEXT NOT NULL DEFAULT '[]',     -- JSON
  next_run_at     INTEGER,
  last_run_at     INTEGER,
  template        TEXT,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_agents_org ON agents(org_id, archived);
CREATE INDEX idx_agents_schedule ON agents(next_run_at) WHERE schedule IS NOT NULL AND archived = 0;

CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  title       TEXT,
  model       TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'chat' CHECK (source IN ('chat', 'schedule')),
  running_since INTEGER,       -- satt mens agenten svarer (hindrer samtidige turer)
  system_prompt TEXT,          -- fryses ved første melding: systemprompt og verktøy må være uendret gjennom samtalen
  tool_groups   TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_conversations_user ON conversations(org_id, user_id, updated_at);
CREATE INDEX idx_conversations_agent ON conversations(agent_id, updated_at);

-- Meldinger lagres i Claude API-format (content blocks som JSON), slik at samtalen kan spilles av uendret.
CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  org_id           TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content          TEXT NOT NULL,
  context          TEXT,           -- JSON: hva brukeren så på da meldingen ble sendt
  usage            TEXT,           -- JSON: tokenbruk
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE agent_runs (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  trigger          TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'error')),
  summary          TEXT,
  error            TEXT,
  usage            TEXT,
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER
);
CREATE INDEX idx_agent_runs_agent ON agent_runs(agent_id, started_at);

-- ─── Artifacts: sider brukerne «viber» opp sammen med agentene ─────────────

CREATE TABLE artifacts (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT,
  property_id       TEXT REFERENCES properties(id) ON DELETE SET NULL,
  building_id       TEXT REFERENCES buildings(id) ON DELETE SET NULL,
  current_version   INTEGER NOT NULL DEFAULT 1,
  pinned            INTEGER NOT NULL DEFAULT 0,
  created_by_user   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_agent  TEXT,
  conversation_id   TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_org ON artifacts(org_id, updated_at);

CREATE TABLE artifact_versions (
  artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  html          TEXT NOT NULL,
  note          TEXT,
  created_by    TEXT,           -- 'user:<id>' eller 'agent:<id>'
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

-- ─── IFC / BIM ──────────────────────────────────────────────────────────────

-- Elementindeks hentet ut fra IFC-modeller (i nettleseren via web-ifc), slik at agenter kan spørre mot modellen.
CREATE TABLE ifc_elements (
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  org_id        TEXT NOT NULL,
  building_id   TEXT,
  express_id    INTEGER NOT NULL,
  guid          TEXT,
  ifc_type      TEXT NOT NULL,
  name          TEXT,
  storey        TEXT,
  props         TEXT,          -- JSON med utvalgte egenskaper
  PRIMARY KEY (document_id, express_id)
);
CREATE INDEX idx_ifc_elements_building ON ifc_elements(building_id, ifc_type);
CREATE INDEX idx_ifc_elements_guid ON ifc_elements(org_id, guid);

CREATE TABLE ifc_models (
  document_id   TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  org_id        TEXT NOT NULL,
  building_id   TEXT,
  schema        TEXT,
  stats         TEXT,          -- JSON: antall per type / etasje
  indexed_at    INTEGER NOT NULL
);

-- ─── Aktivitetslogg ─────────────────────────────────────────────────────────

CREATE TABLE activity (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id      TEXT,
  actor_name    TEXT,
  action        TEXT NOT NULL,
  entity_type   TEXT,
  entity_id     TEXT,
  summary       TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_activity_org ON activity(org_id, created_at);
