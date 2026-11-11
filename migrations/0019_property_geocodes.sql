-- Koordinater for kartet. Slås opp fra adressen hos Kartverket og lagres til adressen endres.
CREATE TABLE property_geocodes (
  property_id  TEXT PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  org_id       TEXT NOT NULL,
  query        TEXT NOT NULL,
  lat          REAL,
  lon          REAL,
  looked_up_at INTEGER NOT NULL
);
CREATE INDEX idx_property_geocodes_org ON property_geocodes(org_id);
