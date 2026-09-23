-- V6.3: barcode labels (per item, per year serial)
CREATE TABLE IF NOT EXISTS labels (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label_code     text NOT NULL UNIQUE,
  item_id        integer NOT NULL REFERENCES items(id),
  item_code      text NOT NULL,
  year           integer NOT NULL,
  serial         integer NOT NULL,
  qty            numeric(14,2) NOT NULL DEFAULT 1,
  label_mode     text NOT NULL CHECK (label_mode IN ('unit','batch')),
  transaction_id integer REFERENCES transactions(id),
  location       text,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','issued','scrapped')),
  printed_at     timestamptz,
  created_by     integer REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_labels_item ON labels(item_id);
CREATE INDEX IF NOT EXISTS idx_labels_created ON labels(created_at);
