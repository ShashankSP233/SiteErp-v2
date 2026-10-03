ALTER TABLE inventory_receipt_batches
ADD COLUMN labels_printed_at TIMESTAMPTZ,
ADD COLUMN labels_printed_by BIGINT REFERENCES users(id);

ALTER TABLE inventory_receipt_batches
ADD CONSTRAINT receipt_batch_print_pair CHECK (
    (labels_printed_at IS NULL AND labels_printed_by IS NULL)
    OR
    (labels_printed_at IS NOT NULL AND labels_printed_by IS NOT NULL)
);
