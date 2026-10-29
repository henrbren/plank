-- White-label: org.nr og merkevare på organisasjonen, og kø for kommuner
-- som skal godkjennes og overføres til kommune.laft.io.

ALTER TABLE orgs ADD COLUMN org_nr TEXT;
ALTER TABLE orgs ADD COLUMN brand TEXT;
CREATE INDEX idx_orgs_org_nr ON orgs(org_nr);

CREATE TABLE brand_signups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_nr TEXT NOT NULL,
  org_name TEXT,
  org_form TEXT,
  org_form_kode TEXT,
  brand TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  email TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_brand_signups_status ON brand_signups(status, created_at);
