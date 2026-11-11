-- Brukeren velger under oppstart om nye dokumenter fra Boligmappa skal varsles på e-post.
ALTER TABLE memberships ADD COLUMN bm_notify INTEGER NOT NULL DEFAULT 0;

-- Vannmerke for dokumenter som allerede er med i et varsel, og når neste sjekk skal kjøre.
ALTER TABLE bm_sources ADD COLUMN notify_watermark INTEGER;
ALTER TABLE bm_sources ADD COLUMN watch_at INTEGER;

-- Valget følger med når tilgang blir bedt om før organisasjonen finnes.
ALTER TABLE access_requests ADD COLUMN bm_notify INTEGER NOT NULL DEFAULT 0;
