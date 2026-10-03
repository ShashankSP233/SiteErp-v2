-- GRNs stay open until accepted items are scanned.
ALTER TABLE goods_receipts
DROP CONSTRAINT IF EXISTS goods_receipts_status_check;

ALTER TABLE goods_receipts
ADD CONSTRAINT goods_receipts_status_check
CHECK (
    status IN (
        'DRAFT',
        'AWAITING_BARCODE_SCAN',
        'RECEIVED',
        'CANCELLED'
    )
);

-- Record the condition of each GRN line.
ALTER TABLE goods_receipt_lines
ADD COLUMN IF NOT EXISTS item_condition TEXT NOT NULL DEFAULT 'GOOD';

ALTER TABLE goods_receipt_lines
ADD CONSTRAINT goods_receipt_lines_item_condition_check
CHECK (
    item_condition IN (
        'GOOD',
        'DAMAGED',
        'DEFECTIVE',
        'REJECTED'
    )
);

-- Damaged items remain tracked but quarantined from normal use.
ALTER TABLE item_instances
DROP CONSTRAINT IF EXISTS item_instances_lifecycle_status_check;

ALTER TABLE item_instances
ADD CONSTRAINT item_instances_lifecycle_status_check
CHECK (
    lifecycle_status IN (
        'ACTIVE',
        'IN_TRANSIT',
        'QUARANTINED',
        'CONSUMED',
        'MIA',
        'LOST',
        'DISPOSED'
    )
);

ALTER TABLE item_instances
DROP CONSTRAINT IF EXISTS item_instances_condition_check;

ALTER TABLE item_instances
ADD CONSTRAINT item_instances_condition_check
CHECK (
    condition IN ('GOOD', 'DAMAGED')
);

-- One staged batch per GRN, or one batch for each direct receipt.
CREATE TABLE inventory_receipt_batches (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    source_type         TEXT NOT NULL
                        CHECK (source_type IN ('GRN', 'DIRECT')),

    goods_receipt_id    BIGINT
                        REFERENCES goods_receipts(id)
                        ON DELETE CASCADE,

    site_id             BIGINT NOT NULL
                        REFERENCES sites(id),

    status              TEXT NOT NULL DEFAULT 'AWAITING_SCAN'
                        CHECK (
                            status IN (
                                'AWAITING_SCAN',
                                'COMPLETED',
                                'CANCELLED'
                            )
                        ),

    reason              TEXT,
    created_by          BIGINT NOT NULL REFERENCES users(id),
    completed_by        BIGINT REFERENCES users(id),
    completed_at        TIMESTAMPTZ,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT receipt_batch_source_valid CHECK (
        (source_type = 'GRN' AND goods_receipt_id IS NOT NULL)
        OR
        (source_type = 'DIRECT' AND goods_receipt_id IS NULL)
    )
);

CREATE UNIQUE INDEX inventory_receipt_batches_one_per_grn
    ON inventory_receipt_batches(goods_receipt_id)
    WHERE goods_receipt_id IS NOT NULL;

CREATE INDEX inventory_receipt_batches_status
    ON inventory_receipt_batches(status, created_at);

-- One row per expected physical instance/barcode.
CREATE TABLE inventory_receipt_labels (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    receipt_batch_id        BIGINT NOT NULL
                            REFERENCES inventory_receipt_batches(id)
                            ON DELETE CASCADE,

    goods_receipt_line_id   BIGINT
                            REFERENCES goods_receipt_lines(id)
                            ON DELETE CASCADE,

    item_master_id          BIGINT NOT NULL
                            REFERENCES item_masters(id),

    item_condition          TEXT NOT NULL
                            CHECK (item_condition IN ('GOOD', 'DAMAGED')),

    instance_code           TEXT NOT NULL UNIQUE,
    barcode                 TEXT NOT NULL UNIQUE,

    batch_number            TEXT,
    serial_number           TEXT,
    manufacture_date        DATE,
    expiry_date             DATE,

    scanned_at              TIMESTAMPTZ,
    scanned_by              BIGINT REFERENCES users(id),

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT receipt_label_scan_pair CHECK (
        (scanned_at IS NULL AND scanned_by IS NULL)
        OR
        (scanned_at IS NOT NULL AND scanned_by IS NOT NULL)
    )
);

CREATE INDEX inventory_receipt_labels_batch
    ON inventory_receipt_labels(receipt_batch_id);

CREATE INDEX inventory_receipt_labels_pending
    ON inventory_receipt_labels(receipt_batch_id, scanned_at);