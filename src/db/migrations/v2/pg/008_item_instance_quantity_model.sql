-- ============================================================
-- SITE-ERP V2
-- Migration 008: Item Instance Quantity Model
--
-- Defines how much measurable content belongs to one
-- physical inventory instance.
--
-- Example:
--   OIL-20L
--   unit = BARREL
--   instance_quantity = 20
--   instance_quantity_unit = L
--
--   5 BARREL received
--   -> 5 physical instances
--   -> 20 L in each instance
-- ============================================================


ALTER TABLE item_masters
    ADD COLUMN instance_quantity NUMERIC(14,3),
    ADD COLUMN instance_quantity_unit TEXT;


-- Existing item masters are test data created under the
-- previous model. Give them a safe temporary value so the
-- migration does not invalidate existing rows.
--
-- These values will be corrected/recreated when we finalize
-- the new Item Master configuration.

UPDATE item_masters
SET
    instance_quantity = 1,
    instance_quantity_unit = unit
WHERE instance_quantity IS NULL;


ALTER TABLE item_masters
    ALTER COLUMN instance_quantity SET NOT NULL,
    ALTER COLUMN instance_quantity_unit SET NOT NULL;


ALTER TABLE item_masters
    ADD CONSTRAINT item_master_instance_quantity_positive
    CHECK (instance_quantity > 0);


ALTER TABLE item_masters
    ADD CONSTRAINT item_master_instance_quantity_unit_not_blank
    CHECK (btrim(instance_quantity_unit) <> '');


CREATE INDEX idx_item_masters_instance_quantity_unit
    ON item_masters(instance_quantity_unit);