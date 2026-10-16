ALTER TABLE inventory_issue_batches ADD COLUMN finalized_at TEXT;

CREATE TABLE inventory_issue_batch_staged_instances (
  batch_id INTEGER NOT NULL REFERENCES inventory_issue_batches(id) ON DELETE CASCADE,
  instance_id INTEGER NOT NULL REFERENCES item_instances(id),
  scanned_by INTEGER NOT NULL REFERENCES users(id),
  scanned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (batch_id, instance_id)
);
