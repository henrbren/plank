-- Kostnad per AI-kall, og beløpet som skal viderefaktureres med påslag.
-- billable = 1 bare når organisasjonen har aktivt abonnement. Prøvebruk spores, men faktureres ikke i etterkant.

CREATE TABLE usage_ledger (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  source              TEXT NOT NULL,
  model               TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_ore            INTEGER NOT NULL,
  billed_ore          INTEGER NOT NULL,
  billable            INTEGER NOT NULL DEFAULT 0,
  batch_id            TEXT,
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_usage_org ON usage_ledger(org_id, created_at);
CREATE INDEX idx_usage_open ON usage_ledger(billable, batch_id);

CREATE TABLE usage_batches (
  id                      TEXT PRIMARY KEY,
  org_id                  TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  cost_ore                INTEGER NOT NULL,
  billed_ore              INTEGER NOT NULL,
  stripe_invoice_item_id  TEXT,
  status                  TEXT NOT NULL,
  error                   TEXT,
  created_at              INTEGER NOT NULL
);
CREATE INDEX idx_usage_batches_status ON usage_batches(status);
