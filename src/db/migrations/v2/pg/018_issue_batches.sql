CREATE TABLE inventory_issue_batches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('PROJECT','EMPLOYEE','DEPARTMENT','OTHER')),
  recipient_reference TEXT,
  reason TEXT,
  issued_by BIGINT NOT NULL REFERENCES users(id),
  site_id BIGINT REFERENCES sites(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PARTIALLY_RETURNED','RETURNED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE inventory_issues ADD COLUMN batch_id BIGINT REFERENCES inventory_issue_batches(id);
CREATE INDEX idx_inventory_issues_batch ON inventory_issues(batch_id);

CREATE TABLE inventory_issue_batch_kits (
  batch_id BIGINT NOT NULL REFERENCES inventory_issue_batches(id) ON DELETE CASCADE,
  kit_id BIGINT NOT NULL REFERENCES item_kits(id),
  PRIMARY KEY (batch_id, kit_id)
);

CREATE TABLE inventory_issue_batch_return_scans (
  batch_id BIGINT NOT NULL REFERENCES inventory_issue_batches(id) ON DELETE CASCADE,
  issue_id BIGINT NOT NULL REFERENCES inventory_issues(id) ON DELETE CASCADE,
  scanned_by BIGINT NOT NULL REFERENCES users(id),
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, issue_id)
);
