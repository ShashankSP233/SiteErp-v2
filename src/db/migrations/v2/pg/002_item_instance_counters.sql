-- ============================================================
-- SITE-ERP V2
-- Migration 002: Item Instance Number Counters
--
-- Safely allocates sequential instance numbers per Item Master.
-- Prevents duplicate instance codes when multiple users receive
-- inventory concurrently.
-- ============================================================

CREATE TABLE item_instance_counters (
    item_master_id BIGINT PRIMARY KEY
                    REFERENCES item_masters(id)
                    ON DELETE CASCADE,

    next_number    BIGINT NOT NULL DEFAULT 1,

    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT item_instance_counters_next_number_check
        CHECK (next_number > 0)
);
