-- Forhåndskjøpte AI-kreditter. Gjenværende saldo trekkes før overforbruk faktureres.
-- Kredittene varer ett år fra purchased_at.

CREATE TABLE credit_grants (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  pack_id               TEXT NOT NULL,
  credit_ore            INTEGER NOT NULL,
  price_ore             INTEGER NOT NULL,
  remaining_ore         INTEGER NOT NULL,
  stripe_session_id     TEXT NOT NULL,
  stripe_payment_intent TEXT,
  purchased_at          INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_credit_session ON credit_grants(stripe_session_id);
CREATE INDEX idx_credit_grants_org ON credit_grants(org_id, expires_at);

CREATE TABLE credit_draws (
  id           TEXT PRIMARY KEY,
  grant_id     TEXT NOT NULL REFERENCES credit_grants(id) ON DELETE CASCADE,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  billed_ore   INTEGER NOT NULL,
  period_start INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_credit_draws_org ON credit_draws(org_id, period_start);
