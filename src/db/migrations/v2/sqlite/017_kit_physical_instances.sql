-- Preserve earlier master-based kit contents for reference, then store exact units.
DROP INDEX IF EXISTS idx_item_kit_lines_kit;
ALTER TABLE item_kit_lines RENAME TO item_kit_lines_master_legacy;

CREATE TABLE item_kit_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_id INTEGER NOT NULL REFERENCES item_kits(id) ON DELETE CASCADE,
  item_instance_id INTEGER NOT NULL REFERENCES item_instances(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (item_instance_id)
);

CREATE INDEX idx_item_kit_lines_kit ON item_kit_lines(kit_id);
