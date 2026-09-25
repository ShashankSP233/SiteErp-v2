-- ============================================================
-- SITE-ERP V2
-- Migration 006: Goods Receipts / GRN
--
-- A Purchase Order may have multiple GRNs.
-- Each GRN records an actual receipt against one PO.
-- ============================================================


-- ============================================================
-- GOODS RECEIPTS
-- ============================================================

CREATE TABLE goods_receipts (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    grn_number          TEXT NOT NULL UNIQUE,

    purchase_order_id   BIGINT NOT NULL
                        REFERENCES purchase_orders(id),

    site_id             BIGINT NOT NULL
                        REFERENCES sites(id),

    receipt_date        DATE NOT NULL,

    status              TEXT NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN (
                            'DRAFT',
                            'RECEIVED',
                            'CANCELLED'
                        )),

    reference_text      TEXT,

    notes               TEXT,

    received_by         BIGINT NOT NULL
                        REFERENCES users(id),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE INDEX idx_goods_receipts_po
    ON goods_receipts(purchase_order_id);

CREATE INDEX idx_goods_receipts_site
    ON goods_receipts(site_id);

CREATE INDEX idx_goods_receipts_date
    ON goods_receipts(receipt_date);

CREATE INDEX idx_goods_receipts_status
    ON goods_receipts(status);

CREATE INDEX idx_goods_receipts_received_by
    ON goods_receipts(received_by);


-- ============================================================
-- GOODS RECEIPT LINES
--
-- Each line represents the quantity actually received
-- against a specific Purchase Order line.
-- ============================================================

CREATE TABLE goods_receipt_lines (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    goods_receipt_id        BIGINT NOT NULL
                            REFERENCES goods_receipts(id)
                            ON DELETE CASCADE,

    purchase_order_line_id  BIGINT NOT NULL
                            REFERENCES purchase_order_lines(id),

    received_quantity       NUMERIC(14,3) NOT NULL
                            CHECK (received_quantity > 0),

    unit                    TEXT NOT NULL,

    notes                   TEXT,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE INDEX idx_goods_receipt_lines_grn
    ON goods_receipt_lines(goods_receipt_id);

CREATE INDEX idx_goods_receipt_lines_po_line
    ON goods_receipt_lines(purchase_order_line_id);