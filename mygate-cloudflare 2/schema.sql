-- D1 schema + seed data for SocietyApp prototype.
-- Run this once in the Cloudflare D1 Console (Console tab → paste → Execute).

-- Idempotent: drops + recreates everything so you can re-run safely.
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS visit_logs;
DROP TABLE IF EXISTS walkins;
DROP TABLE IF EXISTS invites;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('resident','guard','admin')),
  tower       TEXT,
  flat        TEXT,
  phone       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE invites (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  resident_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visitor_name    TEXT NOT NULL,
  visitor_phone   TEXT,
  visit_type      TEXT NOT NULL CHECK (visit_type IN ('Guest','Delivery','Cab','Service')),
  expected_at     TEXT NOT NULL,
  valid_until     TEXT NOT NULL,
  qr_token        TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','used','expired','cancelled')),
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  used_at         TEXT
);

CREATE TABLE walkins (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guard_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resident_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visitor_name    TEXT NOT NULL,
  visitor_phone   TEXT,
  visit_type      TEXT NOT NULL CHECK (visit_type IN ('Guest','Delivery','Cab','Service')),
  vehicle_number  TEXT,
  photo_data_url  TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','expired')),
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at      TEXT
);

CREATE TABLE visit_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN ('invite','walkin')),
  ref_id          INTEGER NOT NULL,
  resident_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guard_id        INTEGER REFERENCES users(id),
  visitor_name    TEXT NOT NULL,
  vehicle_number  TEXT,
  visit_type      TEXT,
  check_in_at     TEXT NOT NULL DEFAULT (datetime('now')),
  check_out_at    TEXT
);

CREATE INDEX idx_invites_resident ON invites(resident_id);
CREATE INDEX idx_invites_token    ON invites(qr_token);
CREATE INDEX idx_walkins_resident ON walkins(resident_id, status);
CREATE INDEX idx_logs_resident    ON visit_logs(resident_id);

-- Seeded users
INSERT INTO users (name, role, tower, flat, phone) VALUES
  ('Bhavit Sheth',   'resident', 'A', 'A-101', '+91 90000 00001'),
  ('Priya Sharma',   'resident', 'A', 'A-102', '+91 90000 00002'),
  ('Rohan Verma',    'resident', 'A', 'A-202', '+91 90000 00003'),
  ('Anjali Mehta',   'resident', 'A', 'A-301', '+91 90000 00004'),
  ('Vikram Iyer',    'resident', 'B', 'B-101', '+91 90000 00005'),
  ('Neha Kapoor',    'resident', 'B', 'B-202', '+91 90000 00006'),
  ('Arjun Desai',    'resident', 'B', 'B-301', '+91 90000 00007'),
  ('Ramesh (Guard)', 'guard',     NULL, NULL,   '+91 90000 00010');
