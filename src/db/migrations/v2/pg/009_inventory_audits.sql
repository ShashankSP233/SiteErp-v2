-- ============================================================
-- SITE-ERP V2
-- Migration 009: Inventory Audits
--
-- An audit snapshots the expected current state of active
-- physical inventory instances at a site. Physical counting is
-- recorded separately and does not directly modify inventory.
-- ============================================================

CREATE TABLE inventory_audits (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    name                TEXT NOT NULL,

    site_id             BIGINT NOT NULL
                        REFERENCES sites(id),

    audit_type          TEXT NOT NULL DEFAULT 'MANUAL'
                        CHECK (audit_type IN (
                            'MANUAL',
                            'MONTHLY_FULL',
                            'DAILY_CHANGED',
                            'FIFTEEN_DAY_FULL'
                        )),

    status              TEXT NOT NULL DEFAULT 'IN_PROGRESS'
                        CHECK (status IN (
                            'NOT_REQUIRED',
                            'REQUIRED',
                            'IN_PROGRESS',
                            'COMPLETED',
                            'RECHECK_REQUIRED'
                        )),

    notes               TEXT,

    started_by          BIGINT NOT NULL
                        REFERENCES users(id),

    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    completed_by        BIGINT
                        REFERENCES users(id),

    completed_at        TIMESTAMPTZ,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventory_audits_site
    ON inventory_audits(site_id);

CREATE INDEX idx_inventory_audits_status
    ON inventory_audits(status);

CREATE INDEX idx_inventory_audits_started
    ON inventory_audits(started_at);


CREATE TABLE inventory_audit_items (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    audit_id            BIGINT NOT NULL
                        REFERENCES inventory_audits(id)
                        ON DELETE CASCADE,

    instance_id         BIGINT
                        REFERENCES item_instances(id),

    scanned_code        TEXT,

    expected_quantity   NUMERIC(14,3),

    counted_quantity    NUMERIC(14,3),

    unit                TEXT,

    result              TEXT NOT NULL DEFAULT 'NOT_COUNTED'
                        CHECK (result IN (
                            'NOT_COUNTED',
                            'MATCHED',
                            'MISSING',
                            'UNEXPECTED',
                            'UNKNOWN',
                            'DUPLICATE'
                        )),

    counted_by          BIGINT
                        REFERENCES users(id),

    counted_at          TIMESTAMPTZ,

    notes               TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT inventory_audit_expected_quantity_nonnegative
        CHECK (
            expected_quantity IS NULL
            OR expected_quantity >= 0
        ),

    CONSTRAINT inventory_audit_counted_quantity_nonnegative
        CHECK (
            counted_quantity IS NULL
            OR counted_quantity >= 0
        )
);

CREATE INDEX idx_inventory_audit_items_audit
    ON inventory_audit_items(audit_id);

CREATE INDEX idx_inventory_audit_items_instance
    ON inventory_audit_items(instance_id);

CREATE INDEX idx_inventory_audit_items_result
    ON inventory_audit_items(result);

CREATE INDEX idx_inventory_audit_items_scanned_code
    ON inventory_audit_items(scanned_code);

-- One expected snapshot row per physical instance in an audit.
-- Unexpected/unknown/duplicate records may still have the same
-- instance_id or a NULL instance_id and are not covered by this index.
CREATE UNIQUE INDEX uq_inventory_audit_expected_instance
    ON inventory_audit_items(audit_id, instance_id)
    WHERE instance_id IS NOT NULL
      AND result = 'NOT_COUNTED';
