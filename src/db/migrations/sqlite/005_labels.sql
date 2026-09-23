-- V6.3: barcode labels (SQLite)
CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label_code TEXT NOT NULL UNIQUE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  item_code TEXT NOT NULL,
  year INTEGER NOT NULL,
  serial INTEGER NOT NULL,
  qty NUMERIC NOT NULL DEFAULT 1,
  label_mode TEXT NOT NULL CHECK (label_mode IN ('unit','batch')),
  transaction_id INTEGER REFERENCES transactions(id),
  location TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','issued','scrapped')),
  printed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_labels_item ON labels(item_id);
CREATE INDEX IF NOT EXISTS idx_labels_created ON labels(created_at);
