-- Citas
CREATE TABLE appointments (
  id           TEXT PRIMARY KEY,
  service_id   TEXT NOT NULL,
  service_name TEXT NOT NULL,
  client_name  TEXT NOT NULL,
  phone        TEXT NOT NULL,
  email        TEXT,
  notes        TEXT,
  date         TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  time         TEXT NOT NULL CHECK (time GLOB '[0-2][0-9]:[0-5][0-9]'),
  status       TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'atendida')),
  source       TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'admin')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
-- Un solo cliente por franja: evita doble reserva incluso con peticiones simultáneas.
CREATE UNIQUE INDEX idx_appointments_slot ON appointments (date, time);
CREATE INDEX idx_appointments_phone ON appointments (phone);

-- Días habilitados/deshabilitados manualmente (is_open=1 abre un domingo o festivo).
CREATE TABLE day_overrides (
  date    TEXT PRIMARY KEY,
  is_open INTEGER NOT NULL CHECK (is_open IN (0, 1)),
  note    TEXT
);

-- Horas habilitadas/deshabilitadas para una fecha concreta.
CREATE TABLE slot_overrides (
  date    TEXT NOT NULL,
  time    TEXT NOT NULL,
  is_open INTEGER NOT NULL CHECK (is_open IN (0, 1)),
  PRIMARY KEY (date, time)
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Sesiones del panel (solo se guarda el hash SHA-256 del token).
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Rate limit por ventana fija.
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
