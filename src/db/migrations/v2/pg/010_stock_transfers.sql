-- ============================================================
-- SITE-ERP V2
-- Migration 010: Stock Transfers
--
-- Site-to-site transfer of physical inventory instances.
--
-- Dispatch:
--   source site -> IN_TRANSIT
--
-- Stock Inward:
--   IN_TRANSIT -> destination site
-- ============================================================


-- ------------------------------------------------------------
-- Allow physical instances to exist in transit.
-- ------------------------------------------------------------

ALTER TABLE item_instances
DROP CONSTRAINT IF EXISTS item_instances_lifecycle_status_check;

ALTER TABLE item_instances
ADD CONSTRAINT item_instances_lifecycle_status_check
CHECK (
    lifecycle_status IN (
        'ACTIVE',
        'IN_TRANSIT',
        'CONSUMED',
        'MIA',
        'LOST',
        'DISPOSED'
    )
);


-- ------------------------------------------------------------
-- Transfer number counter.
-- ------------------------------------------------------------

CREATE TABLE stock_transfer_counters (
    id INTEGER PRIMARY KEY DEFAULT 1,

    next_number BIGINT NOT NULL DEFAULT 1,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT stock_transfer_counters_singleton_check
        CHECK (id = 1),

    CONSTRAINT stock_transfer_counters_next_number_check
        CHECK (next_number > 0)
);

INSERT INTO stock_transfer_counters (
    id,
    next_number
)
VALUES (1, 1);


-- ------------------------------------------------------------
-- Stock transfer header.
-- ------------------------------------------------------------

CREATE TABLE stock_transfers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    transfer_number TEXT NOT NULL UNIQUE,

    from_site_id BIGINT NOT NULL
        REFERENCES sites(id),

    to_site_id BIGINT NOT NULL
        REFERENCES sites(id),

    status TEXT NOT NULL DEFAULT 'DRAFT',

    notes TEXT,

    created_by BIGINT NOT NULL
        REFERENCES users(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    dispatched_by BIGINT
        REFERENCES users(id),

    dispatched_at TIMESTAMPTZ,

    completed_at TIMESTAMPTZ,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT stock_transfers_different_sites_check
        CHECK (from_site_id <> to_site_id),

    CONSTRAINT stock_transfers_status_check
        CHECK (
            status IN (
                'DRAFT',
                'IN_TRANSIT',
                'PARTIALLY_RECEIVED',
                'RECEIVED',
                'CANCELLED'
            )
        )
);


CREATE INDEX idx_stock_transfers_from_site
    ON stock_transfers(from_site_id);

CREATE INDEX idx_stock_transfers_to_site
    ON stock_transfers(to_site_id);

CREATE INDEX idx_stock_transfers_status
    ON stock_transfers(status);

CREATE INDEX idx_stock_transfers_created
    ON stock_transfers(created_at);


-- ------------------------------------------------------------
-- Physical instances included in a transfer.
-- ------------------------------------------------------------

CREATE TABLE stock_transfer_items (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    transfer_id BIGINT NOT NULL
        REFERENCES stock_transfers(id)
        ON DELETE CASCADE,

    instance_id BIGINT NOT NULL
        REFERENCES item_instances(id),

    quantity NUMERIC(14,3) NOT NULL,

    status TEXT NOT NULL DEFAULT 'DRAFT',

    received_by BIGINT
        REFERENCES users(id),

    received_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT stock_transfer_items_quantity_check
        CHECK (quantity > 0),

    CONSTRAINT stock_transfer_items_status_check
        CHECK (
            status IN (
                'DRAFT',
                'IN_TRANSIT',
                'RECEIVED'
            )
        ),

    CONSTRAINT stock_transfer_items_unique_instance
        UNIQUE (transfer_id, instance_id)
);


CREATE INDEX idx_stock_transfer_items_transfer
    ON stock_transfer_items(transfer_id);

CREATE INDEX idx_stock_transfer_items_instance
    ON stock_transfer_items(instance_id);

CREATE INDEX idx_stock_transfer_items_status
    ON stock_transfer_items(status);


-- ------------------------------------------------------------
-- An instance cannot be in two active/draft transfers.
-- Once received, it can be transferred again later.
-- ------------------------------------------------------------

CREATE UNIQUE INDEX idx_stock_transfer_items_active_instance
ON stock_transfer_items(instance_id)
WHERE status IN ('DRAFT', 'IN_TRANSIT');