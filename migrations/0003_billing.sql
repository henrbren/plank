-- Abonnement per organisasjon. 990 kr/mnd dekker building_limit bygg (standard 10).
ALTER TABLE orgs ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE orgs ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE orgs ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE orgs ADD COLUMN building_limit INTEGER NOT NULL DEFAULT 10;
ALTER TABLE orgs ADD COLUMN billing_note TEXT;

CREATE INDEX idx_orgs_stripe_customer ON orgs(stripe_customer_id);
