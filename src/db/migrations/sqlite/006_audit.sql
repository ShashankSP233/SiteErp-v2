-- V6.4: physical stock audit (SQLite)
CREATE TABLE IF NOT EXISTS audit_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  notes TEXT,
  started_by INTEGER REFERENCES users(id),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_by INTEGER REFERENCES users(id),
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_scan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES audit_session(id) ON DELETE CASCADE,
  scanned_code TEXT NOT NULL,
  label_id INTEGER REFERENCES labels(id),
  item_id INTEGER REFERENCES items(id),
  item_code TEXT,
  result TEXT NOT NULL CHECK (result IN ('matched','unexpected','unknown','duplicate')),
  location TEXT,
  scanned_by INTEGER REFERENCES users(id),
  scanned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scan_session ON audit_scan(session_id);
