-- Næringsmappa-trakten: Vipps-bekreftet navn brukes mot rollene i Brønnøysund,
-- og nye organisasjoner fra trakten henter Boligmappa automatisk.

ALTER TABLE users ADD COLUMN vipps_name TEXT;
ALTER TABLE users ADD COLUMN vipps_verified_at INTEGER;
ALTER TABLE bm_sources ADD COLUMN auto_import INTEGER NOT NULL DEFAULT 0;

-- Boligmappa timer ofte ut. Synken teller feil på rad og venter stadig lenger før neste forsøk.
ALTER TABLE bm_sources ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bm_sources ADD COLUMN retry_at INTEGER;
-- Dokumentlister som feiler, legges bakerst i køen. Etter noen forsøk gir vi opp den ene i stedet for å stoppe hele synken.
ALTER TABLE bm_buildings ADD COLUMN docs_error TEXT;
ALTER TABLE bm_buildings ADD COLUMN docs_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bm_units ADD COLUMN docs_error TEXT;
ALTER TABLE bm_units ADD COLUMN docs_attempts INTEGER NOT NULL DEFAULT 0;
-- Nedlastinger prøves på nytt noen ganger før dokumentet merkes med feil
ALTER TABLE bm_documents ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
