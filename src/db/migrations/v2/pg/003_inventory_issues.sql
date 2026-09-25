-- ============================================================
-- SITE-ERP V2
-- Migration 003: Inventory Issues
--
-- Tracks physical inventory issued from a site to a
-- recipient/project/location.
-- ============================================================

CREATE TABLE inventory_issues (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    issue_number TEXT NOT NULL UNIQUE,

    instance_id BIGINT NOT NULL
        REFERENCES item_instances(id),

    site_id BIGINT NOT NULL
        REFERENCES sites(id),

    issued_quantity NUMERIC(14,3) NOT NULL,

    remaining_quantity NUMERIC(14,3) NOT NULL,

    recipient_type TEXT NOT NULL,

    recipient_reference TEXT,

    reason TEXT,

    issued_by BIGINT NOT NULL
        REFERENCES users(id),

    status TEXT NOT NULL DEFAULT 'OPEN',

    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT inventory_issues_issued_quantity_check
        CHECK (issued_quantity > 0),

    CONSTRAINT inventory_issues_remaining_quantity_check
        CHECK (
            remaining_quantity >= 0
            AND remaining_quantity <= issued_quantity
        ),

    CONSTRAINT inventory_issues_status_check
        CHECK (
            status = ANY (
                ARRAY[
                    'OPEN',
                    'PARTIALLY_CONSUMED',
                    'RETURNED',
                    'CLOSED'
                ]
            )
        ),

    CONSTRAINT inventory_issues_recipient_type_check
        CHECK (
            recipient_type = ANY (
                ARRAY[
                    'PROJECT',
                    'EMPLOYEE',
                    'DEPARTMENT',
                    'OTHER'
                ]
            )
        )
);

CREATE INDEX idx_inventory_issues_instance
    ON inventory_issues(instance_id);

CREATE INDEX idx_inventory_issues_site
    ON inventory_issues(site_id);

CREATE INDEX idx_inventory_issues_status
    ON inventory_issues(status);

CREATE INDEX idx_inventory_issues_issued_by
    ON inventory_issues(issued_by);

CREATE INDEX idx_inventory_issues_issued_at
    ON inventory_issues(issued_at);



CREATE TABLE inventory_issue_counters (
    id INTEGER PRIMARY KEY DEFAULT 1,

    next_number BIGINT NOT NULL DEFAULT 1,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT inventory_issue_counters_singleton_check
        CHECK (id = 1),

    CONSTRAINT inventory_issue_counters_next_number_check
        CHECK (next_number > 0)
);

INSERT INTO inventory_issue_counters (id, next_number)
VALUES (1, 1);    