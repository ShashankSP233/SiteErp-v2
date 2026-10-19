UPDATE inventory_issue_batches
SET finalized_at = COALESCE(finalized_at, created_at),
    updated_at = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM inventory_issues inv
  WHERE inv.batch_id = inventory_issue_batches.id
);

DELETE FROM inventory_issue_batch_staged_instances
WHERE batch_id IN (
  SELECT id FROM inventory_issue_batches WHERE finalized_at IS NOT NULL
);
