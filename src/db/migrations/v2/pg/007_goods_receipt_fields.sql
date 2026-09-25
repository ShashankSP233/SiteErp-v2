-- ============================================================
-- SITE-ERP V2
-- Migration 007: Goods Receipt Fields
--
-- Adds the final GRN header fields:
--   - delivery reference
--   - delivery date
--   - system receipt timestamp
-- ============================================================

ALTER TABLE goods_receipts
    ADD COLUMN delivery_reference TEXT;

ALTER TABLE goods_receipts
    ADD COLUMN delivery_date DATE;

ALTER TABLE goods_receipts
    ADD COLUMN received_at TIMESTAMPTZ;

CREATE INDEX idx_goods_receipts_delivery_date
    ON goods_receipts(delivery_date);

CREATE INDEX idx_goods_receipts_received_at
    ON goods_receipts(received_at);