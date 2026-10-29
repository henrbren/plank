-- Skiller vanlige innloggingslenker fra demoinvitasjoner (48 timer).
ALTER TABLE login_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'login';
