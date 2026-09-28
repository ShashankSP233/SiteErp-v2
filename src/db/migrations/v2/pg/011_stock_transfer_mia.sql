-- ============================================================
-- SITE-ERP V2
-- Migration 011: Stock Transfer MIA / Close Inward
--
-- Allows the receiver to close an inward operation.
--
-- Any transfer item that is still IN_TRANSIT at the time
-- of closing is marked MIA (Missing In Action).
--
-- The corresponding physical instance becomes MIA and
-- remains without a site assignment.
-- ============================================================


-- ------------------------------------------------------------
-- Stock transfer header
-- ------------------------------------------------------------
-- CLOSED means the inward operation has been completed.
-- The transfer may contain RECEIVED and/or MIA items.
-- ------------------------------------------------------------

ALTER TABLE stock_transfers
DROP CONSTRAINT IF EXISTS stock_transfers_status_check;

ALTER TABLE stock_transfers
ADD CONSTRAINT stock_transfers_status_check
CHECK (
    status IN (
        'DRAFT',
        'IN_TRANSIT',
        'PARTIALLY_RECEIVED',
        'RECEIVED',
        'CLOSED',
        'CANCELLED'
    )
);


-- ------------------------------------------------------------
-- Stock transfer items
-- ------------------------------------------------------------
-- MIA = the physical instance was not received/scanned
-- before the receiver closed the inward operation.
-- ------------------------------------------------------------

ALTER TABLE stock_transfer_items
DROP CONSTRAINT IF EXISTS stock_transfer_items_status_check;

ALTER TABLE stock_transfer_items
ADD CONSTRAINT stock_transfer_items_status_check
CHECK (
    status IN (
        'DRAFT',
        'IN_TRANSIT',
        'RECEIVED',
        'MIA'
    )
);


-- ------------------------------------------------------------
-- MIA tracking information
-- ------------------------------------------------------------

ALTER TABLE stock_transfer_items
ADD COLUMN IF NOT EXISTS mia_by BIGINT
    REFERENCES users(id);

ALTER TABLE stock_transfer_items
ADD COLUMN IF NOT EXISTS mia_at TIMESTAMPTZ;

ALTER TABLE stock_transfer_items
ADD COLUMN IF NOT EXISTS mia_reason TEXT;


-- ------------------------------------------------------------
-- Index for MIA investigation later.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_mia
ON stock_transfer_items(status)
WHERE status = 'MIA';