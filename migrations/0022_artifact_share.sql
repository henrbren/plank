ALTER TABLE artifacts ADD COLUMN share_mode TEXT NOT NULL DEFAULT 'off';
ALTER TABLE artifacts ADD COLUMN share_token TEXT;
CREATE UNIQUE INDEX idx_artifacts_share_token ON artifacts(share_token);
