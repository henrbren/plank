-- Én leverandørside per organisasjon, og ett varsel per område (eiendom).
ALTER TABLE artifacts ADD COLUMN template TEXT;
CREATE UNIQUE INDEX idx_artifacts_org_template ON artifacts(org_id, template) WHERE template IS NOT NULL;

CREATE TABLE supplier_notices (
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL DEFAULT '',
  mailed_at   INTEGER NOT NULL,
  PRIMARY KEY (org_id, property_id)
);
