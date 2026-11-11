-- Én e-post når dokumentene fra Boligmappa er overført, eller når hentingen gir opp.
ALTER TABLE bm_sources ADD COLUMN transfer_mail_at INTEGER;
