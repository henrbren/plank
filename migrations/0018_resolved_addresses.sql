-- Husnummer fra matrikkelens bygningsnummer. Boligmappa sender ofte bare gatenavnet.
CREATE TABLE resolved_addresses (
  building_number TEXT PRIMARY KEY,
  address         TEXT,
  street          TEXT,
  house_number    TEXT,
  house_letter    TEXT,
  postal_code     TEXT,
  city            TEXT,
  looked_up_at    INTEGER NOT NULL
);
