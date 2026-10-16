CREATE TABLE item_kits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE item_kit_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_id INTEGER NOT NULL REFERENCES item_kits(id) ON DELETE CASCADE,
  item_master_id INTEGER NOT NULL REFERENCES item_masters(id),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (kit_id, item_master_id)
);

CREATE INDEX idx_item_kit_lines_kit ON item_kit_lines(kit_id);
