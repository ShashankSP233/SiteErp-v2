-- ============================================================
-- Site-ERP V2
-- Migration 004: Vendors
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Vendors
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vendors (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    vendor_code TEXT NOT NULL UNIQUE,

    name TEXT NOT NULL,

    contact_person TEXT,

    email TEXT,

    phone TEXT,

    address TEXT,

    tax_identifier TEXT,

    notes TEXT,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT vendors_name_not_blank
        CHECK (BTRIM(name) <> ''),

    CONSTRAINT vendors_code_not_blank
        CHECK (BTRIM(vendor_code) <> '')
);

-- ------------------------------------------------------------
-- Indexes
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_vendors_name
    ON vendors(name);

CREATE INDEX IF NOT EXISTS idx_vendors_active
    ON vendors(is_active);

COMMIT;