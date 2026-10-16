-- Preserve earlier master-based kit contents for reference, then store exact units.
ALTER TABLE item_kit_lines RENAME TO item_kit_lines_master_legacy;
DROP INDEX IF EXISTS idx_item_kit_lines_kit;

CREATE TABLE item_kit_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kit_id BIGINT NOT NULL REFERENCES item_kits(id) ON DELETE CASCADE,
  item_instance_id BIGINT NOT NULL REFERENCES item_instances(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_instance_id)
);

CREATE INDEX idx_item_kit_lines_kit ON item_kit_lines(kit_id);
