-- Bilde av eiendom og bygg. Nøkkelen peker på objektet i R2.
ALTER TABLE properties ADD COLUMN image_key TEXT;
ALTER TABLE buildings ADD COLUMN image_key TEXT;
