-- Hjelpesenter per organisasjon. Skjermbildene ligger i R2 som help/{org_id}/{slug}.jpg.
CREATE TABLE help_articles (
  org_id           TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slug             TEXT NOT NULL,
  title            TEXT NOT NULL,
  summary          TEXT NOT NULL,
  body             TEXT NOT NULL,
  category         TEXT NOT NULL,
  route            TEXT NOT NULL DEFAULT '',
  sort             INTEGER NOT NULL DEFAULT 0,
  shot_key         TEXT,
  seen_text        TEXT,
  seen_hash        TEXT,
  needs_rewrite    INTEGER NOT NULL DEFAULT 1,
  catalog_version  INTEGER NOT NULL DEFAULT 1,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (org_id, slug)
);

CREATE INDEX idx_help_updated ON help_articles(updated_at);
