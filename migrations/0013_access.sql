-- Brukertilganger: lese eller redigere, hele porteføljen eller utvalgte eiendommer/bygg, og utløpsdato.
-- Gjelder medlemmer – eiere og administratorer har alltid full tilgang.
ALTER TABLE memberships ADD COLUMN can_edit INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memberships ADD COLUMN scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'limited'));
ALTER TABLE memberships ADD COLUMN expires_at INTEGER;
ALTER TABLE memberships ADD COLUMN invited_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE memberships ADD COLUMN updated_at INTEGER;

-- Eiendom gir tilgang til alle bygg på eiendommen, også bygg som legges til senere
CREATE TABLE membership_scope (
  org_id       TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('property', 'building')),
  entity_id    TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id, entity_type, entity_id),
  FOREIGN KEY (org_id, user_id) REFERENCES memberships(org_id, user_id) ON DELETE CASCADE
);
