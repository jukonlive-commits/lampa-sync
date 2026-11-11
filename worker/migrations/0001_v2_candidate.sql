-- Isolated tables: existing prototype data is not imported or modified.
CREATE TABLE IF NOT EXISTS ls_users (id INTEGER PRIMARY KEY, telegram_id TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS ls_pairings (code_hash TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, expires INTEGER NOT NULL, user_id INTEGER REFERENCES ls_users(id), completed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ls_devices (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES ls_users(id), name TEXT NOT NULL, created INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ls_backups (user_id INTEGER PRIMARY KEY REFERENCES ls_users(id), version INTEGER NOT NULL, envelope TEXT NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ls_limits (key TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(key, window));
CREATE INDEX IF NOT EXISTS ls_pairings_expires ON ls_pairings(expires);
