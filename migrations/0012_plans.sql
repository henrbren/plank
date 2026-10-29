-- To planer: standard (990 kr, 300 kr AI-bruk) og pro (3000 kr, 1200 kr AI-bruk).
ALTER TABLE orgs ADD COLUMN plan TEXT NOT NULL DEFAULT 'standard';

-- Høyeste plan i måneden som starter plan_peak_month, så inkludert bruk ikke synker
-- midt i måneden når noen bytter ned.
ALTER TABLE orgs ADD COLUMN plan_peak TEXT;
ALTER TABLE orgs ADD COLUMN plan_peak_month INTEGER;

-- Øvre grense for ekstra bruk på fakturaen per måned, i øre inkl. mva. NULL = ubegrenset.
ALTER TABLE orgs ADD COLUMN spend_limit_ore INTEGER;

-- Måneden (start i ms, Europe/Oslo) det sist ble varslet om 80 % og 100 % av grensen.
ALTER TABLE orgs ADD COLUMN limit_warned_month INTEGER;
ALTER TABLE orgs ADD COLUMN limit_reached_month INTEGER;
