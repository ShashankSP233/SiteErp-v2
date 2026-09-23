-- V6.1: Transfer movement type + PO attachment (SQLite: rebuild transactions to widen CHECK)
ALTER TABLE transactions RENAME TO transactions_old;
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('RECEIVED','ISSUED','RETURNED','DISCARD','ADJUSTMENT_IN','ADJUSTMENT_OUT','TRANSFER')),
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  transaction_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  grn_no TEXT, issue_order_no TEXT, reference_no TEXT, brand TEXT,
  vendor_id INTEGER REFERENCES vendors(id),
  manufacturer TEXT, serial_no TEXT, source_location TEXT, destination_location TEXT, issue_location TEXT,
  cost NUMERIC NOT NULL DEFAULT 0,
  reorder_quantity NUMERIC NOT NULL DEFAULT 0,
  discard_reason TEXT, condition_text TEXT, notes TEXT, image_path TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO transactions (id,item_id,transaction_type,quantity,transaction_date,grn_no,issue_order_no,reference_no,brand,vendor_id,manufacturer,serial_no,source_location,destination_location,issue_location,cost,reorder_quantity,discard_reason,condition_text,notes,image_path,user_id,created_at)
SELECT id,item_id,transaction_type,quantity,transaction_date,grn_no,issue_order_no,reference_no,brand,vendor_id,manufacturer,serial_no,source_location,destination_location,issue_location,cost,reorder_quantity,discard_reason,condition_text,notes,image_path,user_id,created_at FROM transactions_old;
DROP TABLE transactions_old;
CREATE INDEX IF NOT EXISTS idx_tx_item ON transactions(item_id);
CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(transaction_date);
ALTER TABLE purchase_orders ADD COLUMN attachment TEXT;
