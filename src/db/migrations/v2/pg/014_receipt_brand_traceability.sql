ALTER TABLE goods_receipt_lines
    ADD COLUMN brand TEXT,
    ADD COLUMN batch_number TEXT,
    ADD COLUMN serial_number TEXT,
    ADD COLUMN manufacture_date DATE,
    ADD COLUMN expiry_date DATE;

ALTER TABLE inventory_receipt_labels
    ADD COLUMN brand TEXT;

ALTER TABLE item_instances
    ADD COLUMN brand TEXT;
