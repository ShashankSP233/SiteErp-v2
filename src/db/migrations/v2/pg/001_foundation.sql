-- ============================================================
-- SITE-ERP V2
-- Migration 001: Foundation
--
-- This is a completely fresh schema.
-- No data from the old inventory system is migrated.
-- ============================================================


-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE users (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username            TEXT NOT NULL UNIQUE,
    password_hash       TEXT NOT NULL,
    full_name           TEXT,
    role                TEXT NOT NULL DEFAULT 'operator'
                        CHECK (role IN (
                            'admin',
                            'manager',
                            'operator',
                            'viewer'
                        )),
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE INDEX idx_users_role
    ON users(role);

CREATE INDEX idx_users_active
    ON users(is_active);


-- ============================================================
-- SITES
-- ============================================================

CREATE TABLE sites (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    code            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,

    site_type       TEXT NOT NULL
                    CHECK (site_type IN (
                        'NORMAL',
                        'SUPER_STORE'
                    )),

    address         TEXT,

    status          TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN (
                        'ACTIVE',
                        'INACTIVE'
                    )),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE INDEX idx_sites_type
    ON sites(site_type);

CREATE INDEX idx_sites_status
    ON sites(status);


-- ============================================================
-- USER ↔ SITE ASSIGNMENTS
-- ============================================================

CREATE TABLE site_assignments (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    user_id         BIGINT NOT NULL
                    REFERENCES users(id)
                    ON DELETE CASCADE,

    site_id         BIGINT NOT NULL
                    REFERENCES sites(id)
                    ON DELETE CASCADE,

    is_primary      BOOLEAN NOT NULL DEFAULT FALSE,

    assigned_from   TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_until  TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT site_assignment_dates
        CHECK (
            assigned_until IS NULL
            OR assigned_until > assigned_from
        ),

    CONSTRAINT unique_active_user_site
        UNIQUE (user_id, site_id)
);


CREATE INDEX idx_site_assignments_user
    ON site_assignments(user_id);

CREATE INDEX idx_site_assignments_site
    ON site_assignments(site_id);


-- ============================================================
-- ITEM MASTER
--
-- Defines WHAT an item is.
--
-- Example:
--   CEMENT-001
--   Cement
--   BAG
-- ============================================================

CREATE TABLE item_masters (
    id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    item_code                   TEXT NOT NULL UNIQUE,

    name                        TEXT NOT NULL,

    description                 TEXT,

    category                    TEXT,

    unit                        TEXT NOT NULL,

    is_consumable               BOOLEAN NOT NULL DEFAULT FALSE,

    allows_partial_consumption  BOOLEAN NOT NULL DEFAULT FALSE,

    requires_instance_tracking  BOOLEAN NOT NULL DEFAULT TRUE,

    reorder_level               NUMERIC(14,3) NOT NULL DEFAULT 0,

    status                      TEXT NOT NULL DEFAULT 'ACTIVE'
                                CHECK (status IN (
                                    'ACTIVE',
                                    'INACTIVE',
                                    'DISCONTINUED'
                                )),

    created_by                  BIGINT REFERENCES users(id),

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE INDEX idx_item_masters_status
    ON item_masters(status);

CREATE INDEX idx_item_masters_category
    ON item_masters(category);


-- ============================================================
-- PHYSICAL ITEM INSTANCES
--
-- Defines the actual physical thing.
--
-- Example:
--
-- Item Master:
--   Engine Oil
--
-- Instances:
--   OIL-000001
--   OIL-000002
--   OIL-000003
--
-- Each instance gets exactly one permanent barcode.
-- ============================================================

CREATE TABLE item_instances (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    item_master_id      BIGINT NOT NULL
                        REFERENCES item_masters(id),

    instance_code       TEXT NOT NULL UNIQUE,

    barcode             TEXT NOT NULL UNIQUE,

    original_quantity   NUMERIC(14,3) NOT NULL
                        CHECK (original_quantity > 0),

    current_quantity    NUMERIC(14,3) NOT NULL
                        CHECK (current_quantity >= 0),

    unit                TEXT NOT NULL,

    site_id             BIGINT
                        REFERENCES sites(id),

    lifecycle_status    TEXT NOT NULL DEFAULT 'ACTIVE'
                        CHECK (lifecycle_status IN (
                            'ACTIVE',
                            'CONSUMED',
                            'MIA',
                            'LOST',
                            'DISPOSED'
                        )),

    condition           TEXT NOT NULL DEFAULT 'GOOD'
                        CHECK (condition IN (
                            'GOOD',
                            'DAMAGED'
                        )),

    batch_number        TEXT,
    serial_number       TEXT,
    manufacture_date    DATE,
    expiry_date         DATE,

    received_grn_id     BIGINT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT instance_quantity_valid
        CHECK (current_quantity <= original_quantity)
);


CREATE INDEX idx_instances_item_master
    ON item_instances(item_master_id);

CREATE INDEX idx_instances_site
    ON item_instances(site_id);

CREATE INDEX idx_instances_barcode
    ON item_instances(barcode);

CREATE INDEX idx_instances_status
    ON item_instances(lifecycle_status);


-- ============================================================
-- INVENTORY MOVEMENTS
--
-- Every physical quantity/location change is recorded here.
-- ============================================================

CREATE TABLE inventory_movements (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    instance_id         BIGINT NOT NULL
                        REFERENCES item_instances(id),

    movement_type       TEXT NOT NULL
                        CHECK (movement_type IN (
                            'RECEIVE',
                            'ISSUE',
                            'CONSUME',
                            'RETURN',
                            'TRANSFER_OUT',
                            'TRANSFER_IN',
                            'ADJUSTMENT_IN',
                            'ADJUSTMENT_OUT',
                            'DISCARD'
                        )),

    quantity            NUMERIC(14,3) NOT NULL
                        CHECK (quantity > 0),

    from_site_id        BIGINT REFERENCES sites(id),
    to_site_id          BIGINT REFERENCES sites(id),

    reference_type      TEXT,
    reference_id        TEXT,

    reason              TEXT,

    performed_by        BIGINT NOT NULL
                        REFERENCES users(id),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE INDEX idx_inventory_movements_instance
    ON inventory_movements(instance_id);

CREATE INDEX idx_inventory_movements_type
    ON inventory_movements(movement_type);

CREATE INDEX idx_inventory_movements_created
    ON inventory_movements(created_at);

CREATE INDEX idx_inventory_movements_from_site
    ON inventory_movements(from_site_id);

CREATE INDEX idx_inventory_movements_to_site
    ON inventory_movements(to_site_id);