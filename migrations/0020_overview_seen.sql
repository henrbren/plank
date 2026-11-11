-- Når brukeren sist åpnet oversikten, så «Siden sist» kan vise det som har skjedd etter forrige besøk.
ALTER TABLE memberships ADD COLUMN overview_seen_at INTEGER;
ALTER TABLE memberships ADD COLUMN overview_visit_at INTEGER;
