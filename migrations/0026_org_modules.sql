-- Moduler som er slått på for organisasjonen. NULL betyr ingen.
-- Bare Leie leser feltet. Plank, Sameie og Næringsmappa viser som før.
ALTER TABLE orgs ADD COLUMN modules TEXT;
