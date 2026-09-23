-- V6: master-data enrichment + procurement (purchase orders)

ALTER TABLE items ADD COLUMN hsn_code   text;
ALTER TABLE items ADD COLUMN gst_rate   numeric(6,2) NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN min_level  numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN max_level  numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN item_group text;

ALTER TABLE vendors ADD COLUMN contact_name text;
ALTER TABLE vendors ADD COLUMN email        text;
ALTER TABLE vendors ADD COLUMN mobile       text;
ALTER TABLE vendors ADD COLUMN phone        text;
ALTER TABLE vendors ADD COLUMN address      text;
ALTER TABLE vendors ADD COLUMN gstin        text;
ALTER TABLE vendors ADD COLUMN notes        text;

CREATE TABLE IF NOT EXISTS purchase_orders (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_no            text NOT NULL,
  vendor_id        integer REFERENCES vendors(id),
  po_date          date NOT NULL DEFAULT current_date,
  delivery_to      text,
  status           text NOT NULL DEFAULT 'submitted'
                   CHECK (status IN ('submitted','approved','rejected','partially_received','received','cancelled')),
  notes            text,
  approved_by      integer REFERENCES users(id),
  approved_at      timestamptz,
  approval_remarks text,
  created_by       integer REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_po_vendor ON purchase_orders(vendor_id);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);

CREATE TABLE IF NOT EXISTS po_lines (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_id        integer NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id      integer NOT NULL REFERENCES items(id),
  quantity     numeric(14,2) NOT NULL CHECK (quantity > 0),
  rate         numeric(14,2) NOT NULL DEFAULT 0,
  received_qty numeric(14,2) NOT NULL DEFAULT 0,
  notes        text
);
CREATE INDEX IF NOT EXISTS idx_po_lines_po ON po_lines(po_id);
