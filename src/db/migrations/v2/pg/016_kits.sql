CREATE TABLE item_kits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kit_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE item_kit_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kit_id BIGINT NOT NULL REFERENCES item_kits(id) ON DELETE CASCADE,
  item_master_id BIGINT NOT NULL REFERENCES item_masters(id),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kit_id, item_master_id)
);

CREATE INDEX idx_item_kit_lines_kit ON item_kit_lines(kit_id);
