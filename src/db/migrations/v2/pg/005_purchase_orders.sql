-- ============================================================
-- Site-ERP V2
-- Migration 004: Purchase Orders
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Purchase Order Header
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS purchase_orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    po_number TEXT NOT NULL UNIQUE,

    vendor_id BIGINT NOT NULL
        REFERENCES vendors(id),

    po_date DATE NOT NULL,

    site_id BIGINT NOT NULL
        REFERENCES sites(id),

    expected_delivery_date DATE,

    status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (
            status IN (
                'DRAFT',
                'SENT',
                'PARTIALLY_RECEIVED',
                'COMPLETED',
                'CANCELLED'
            )
        ),

    reference_text TEXT,

    notes TEXT,

    created_by BIGINT NOT NULL
        REFERENCES users(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT purchase_orders_expected_delivery_chk
        CHECK (
            expected_delivery_date IS NULL
            OR expected_delivery_date >= po_date
        )
);

-- ------------------------------------------------------------
-- Purchase Order Lines
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS purchase_order_lines (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    purchase_order_id BIGINT NOT NULL
        REFERENCES purchase_orders(id)
        ON DELETE CASCADE,

    item_master_id BIGINT NOT NULL
        REFERENCES item_masters(id),

    ordered_quantity NUMERIC(14,3) NOT NULL
        CHECK (ordered_quantity > 0),

    unit TEXT NOT NULL,

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Indexes
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_purchase_orders_vendor
    ON purchase_orders(vendor_id);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_site
    ON purchase_orders(site_id);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_status
    ON purchase_orders(status);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_po_date
    ON purchase_orders(po_date);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_expected_delivery
    ON purchase_orders(expected_delivery_date);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_created_by
    ON purchase_orders(created_by);

CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_po
    ON purchase_order_lines(purchase_order_id);

CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_item
    ON purchase_order_lines(item_master_id);

COMMIT;