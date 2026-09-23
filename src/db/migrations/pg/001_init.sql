-- Site ERP initial schema (PostgreSQL / Supabase)

CREATE TABLE IF NOT EXISTS users (
  id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username              text NOT NULL UNIQUE,
  password_hash         text NOT NULL,
  full_name             text,
  role                  text NOT NULL DEFAULT 'operator' CHECK (role IN ('admin','manager','operator','viewer')),
  is_active             boolean NOT NULL DEFAULT true,
  must_change_password  boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vendors (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- "locations" are the sites/stores the software operates across.
CREATE TABLE IF NOT EXISTS locations (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_code     text NOT NULL UNIQUE,
  description   text NOT NULL,
  unit          text,
  type          text,
  category_id   integer REFERENCES categories(id),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','discontinued')),
  reorder_level numeric(14,2) NOT NULL DEFAULT 0,
  remarks       text,
  created_by    integer REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Stock ledger: balances and valuation are derived from these rows.
CREATE TABLE IF NOT EXISTS transactions (
  id                   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id              integer NOT NULL REFERENCES items(id),
  transaction_type     text NOT NULL CHECK (transaction_type IN ('RECEIVED','ISSUED','RETURNED','DISCARD','ADJUSTMENT_IN','ADJUSTMENT_OUT')),
  quantity             numeric(14,2) NOT NULL CHECK (quantity > 0),
  transaction_date     timestamptz NOT NULL DEFAULT now(),
  grn_no               text,
  issue_order_no       text,
  reference_no         text,
  brand                text,
  vendor_id            integer REFERENCES vendors(id),
  manufacturer         text,
  serial_no            text,
  source_location      text,
  destination_location text,
  issue_location       text,
  cost                 numeric(14,2) NOT NULL DEFAULT 0,
  reorder_quantity     numeric(14,2) NOT NULL DEFAULT 0,
  discard_reason       text,
  condition_text       text,
  notes                text,
  image_path           text,
  user_id              integer NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tx_item ON transactions(item_id);
CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(transaction_date);

-- Financial-year document numbering (GRN / ISSUE).
CREATE TABLE IF NOT EXISTS sequence_counters (
  name           text NOT NULL,
  financial_year text NOT NULL,
  last_number    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (name, financial_year)
);

-- Supplier bills / invoices, optionally linked to a GRN.
CREATE TABLE IF NOT EXISTS bills (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bill_no           text NOT NULL,
  vendor_id         integer REFERENCES vendors(id),
  bill_date         date NOT NULL DEFAULT current_date,
  grn_no            text,
  amount            numeric(14,2) NOT NULL DEFAULT 0,
  tax               numeric(14,2) NOT NULL DEFAULT 0,
  total             numeric(14,2) NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('draft','submitted','approved','rejected','part_paid','paid')),
  approved_by       integer REFERENCES users(id),
  approved_at       timestamptz,
  approval_remarks  text,
  notes             text,
  attachment        text,
  created_by        integer REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bills_vendor ON bills(vendor_id);
CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status);

-- Payments made against a bill.
CREATE TABLE IF NOT EXISTS payments (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bill_id       integer NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  mode          text NOT NULL CHECK (mode IN ('cash','bank','upi','cheque','other')),
  payment_date  date NOT NULL DEFAULT current_date,
  reference_no  text,
  notes         text,
  created_by    integer REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_bill ON payments(bill_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    integer REFERENCES users(id),
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  details    text,
  ip         text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
