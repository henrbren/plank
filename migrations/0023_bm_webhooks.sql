-- Hvor langt Plank har lest webhook-dokumenter fra boligmappa-ms.
-- webhook_after er siste pending_documents.id som er lagt inn. webhook_at settes når siden er tom,
-- og nullstilles når dokumentlistene åpnes på nytt, så nye webhooks kommer med neste runde.

ALTER TABLE bm_sources ADD COLUMN webhook_after INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bm_sources ADD COLUMN webhook_at INTEGER;
