-- Usuarios del panel. password_hash es Argon2id (PHC); se verifica en el servidor de Vercel.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('root', 'staff')),
  permissions   TEXT NOT NULL DEFAULT '[]',
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_login_at TEXT
);
-- Solo puede existir un root.
CREATE UNIQUE INDEX idx_users_single_root ON users (role) WHERE role = 'root';

-- Las sesiones pasan a pertenecer a un usuario; se invalidan las anteriores.
DELETE FROM sessions;
ALTER TABLE sessions ADD COLUMN user_id TEXT;
CREATE INDEX idx_sessions_user ON sessions (user_id);
