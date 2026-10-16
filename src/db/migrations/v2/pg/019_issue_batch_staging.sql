ALTER TABLE inventory_issue_batches ADD COLUMN finalized_at TIMESTAMPTZ;

CREATE TABLE inventory_issue_batch_staged_instances (
  batch_id BIGINT NOT NULL REFERENCES inventory_issue_batches(id) ON DELETE CASCADE,
  instance_id BIGINT NOT NULL REFERENCES item_instances(id),
  scanned_by BIGINT NOT NULL REFERENCES users(id),
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, instance_id)
);
