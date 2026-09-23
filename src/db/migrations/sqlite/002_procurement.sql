-- V6: master-data enrichment + procurement (purchase orders) — SQLite

ALTER TABLE items ADD COLUMN hsn_code   TEXT;
ALTER TABLE items ADD COLUMN gst_rate   NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN min_level  NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN max_level  NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN item_group TEXT;

ALTER TABLE vendors ADD COLUMN contact_name TEXT;
ALTER TABLE vendors ADD COLUMN email        TEXT;
ALTER TABLE vendors ADD COLUMN mobile       TEXT;
ALTER TABLE vendors ADD COLUMN phone        TEXT;
ALTER TABLE vendors ADD COLUMN address      TEXT;
ALTER TABLE vendors ADD COLUMN gstin        TEXT;
ALTER TABLE vendors ADD COLUMN notes        TEXT;

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_no TEXT NOT NULL,
  vendor_id INTEGER REFERENCES vendors(id),
  po_date TEXT NOT NULL DEFAULT (date('now')),
  delivery_to TEXT,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','approved','rejected','partially_received','received','cancelled')),
  notes TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  approval_remarks TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_po_vendor ON purchase_orders(vendor_id);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);

CREATE TABLE IF NOT EXISTS po_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  rate NUMERIC NOT NULL DEFAULT 0,
  received_qty NUMERIC NOT NULL DEFAULT 0,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_po_lines_po ON po_lines(po_id);
