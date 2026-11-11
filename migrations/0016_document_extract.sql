-- Strukturert uttrekk fra dokumentet (leverandør, komponent, service). Selve radene i FDV-registeret ligger i components.
ALTER TABLE documents ADD COLUMN extracted TEXT;
