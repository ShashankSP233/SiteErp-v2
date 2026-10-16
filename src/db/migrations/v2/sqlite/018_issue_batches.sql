CREATE TABLE inventory_issue_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('PROJECT','EMPLOYEE','DEPARTMENT','OTHER')),
  recipient_reference TEXT,
  reason TEXT,
  issued_by INTEGER NOT NULL REFERENCES users(id),
  site_id INTEGER REFERENCES sites(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PARTIALLY_RETURNED','RETURNED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE inventory_issues ADD COLUMN batch_id INTEGER REFERENCES inventory_issue_batches(id);
CREATE INDEX idx_inventory_issues_batch ON inventory_issues(batch_id);

CREATE TABLE inventory_issue_batch_kits (
  batch_id INTEGER NOT NULL REFERENCES inventory_issue_batches(id) ON DELETE CASCADE,
  kit_id INTEGER NOT NULL REFERENCES item_kits(id),
  PRIMARY KEY (batch_id, kit_id)
);

CREATE TABLE inventory_issue_batch_return_scans (
  batch_id INTEGER NOT NULL REFERENCES inventory_issue_batches(id) ON DELETE CASCADE,
  issue_id INTEGER NOT NULL REFERENCES inventory_issues(id) ON DELETE CASCADE,
  scanned_by INTEGER NOT NULL REFERENCES users(id),
  scanned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (batch_id, issue_id)
);
