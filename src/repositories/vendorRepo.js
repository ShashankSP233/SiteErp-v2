const db = require('../config/db');

async function listVendors({ includeInactive = false } = {}) {
    const conditions = [];
    const params = [];

    if (!includeInactive) {
        conditions.push('is_active = TRUE');
    }

    const where = conditions.length
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

    const result = await db.query(
        `
        SELECT
            id,
            vendor_code,
            name,
            contact_person,
            email,
            phone,
            address,
            tax_identifier,
            notes,
            is_active,
            created_at,
            updated_at
        FROM vendors
        ${where}
        ORDER BY name ASC, vendor_code ASC
        `,
        params
    );

    return result.rows;
}

async function getVendorById(id) {
    const result = await db.query(
        `
        SELECT
            id,
            vendor_code,
            name,
            contact_person,
            email,
            phone,
            address,
            tax_identifier,
            notes,
            is_active,
            created_at,
            updated_at
        FROM vendors
        WHERE id = $1
        `,
        [id]
    );

    return result.rows[0] || null;
}

async function createVendor({
    vendorCode,
    name,
    contactPerson = null,
    email = null,
    phone = null,
    address = null,
    taxIdentifier = null,
    notes = null
}) {
    const cleanVendorCode = String(vendorCode || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanVendorCode) {
        throw new Error('Vendor code is required.');
    }

    if (!cleanName) {
        throw new Error('Vendor name is required.');
    }

    const result = await db.query(
        `
        INSERT INTO vendors (
            vendor_code,
            name,
            contact_person,
            email,
            phone,
            address,
            tax_identifier,
            notes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
        `,
        [
            cleanVendorCode,
            cleanName,
            contactPerson || null,
            email || null,
            phone || null,
            address || null,
            taxIdentifier || null,
            notes || null
        ]
    );

    return result.rows[0];
}

async function updateVendor(
    id,
    {
        vendorCode,
        name,
        contactPerson = null,
        email = null,
        phone = null,
        address = null,
        taxIdentifier = null,
        notes = null,
        isActive = true
    }
) {
    const cleanVendorCode = String(vendorCode || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanVendorCode) {
        throw new Error('Vendor code is required.');
    }

    if (!cleanName) {
        throw new Error('Vendor name is required.');
    }

    const result = await db.query(
        `
        UPDATE vendors
        SET
            vendor_code = $1,
            name = $2,
            contact_person = $3,
            email = $4,
            phone = $5,
            address = $6,
            tax_identifier = $7,
            notes = $8,
            is_active = $9,
            updated_at = NOW()
        WHERE id = $10
        RETURNING *
        `,
        [
            cleanVendorCode,
            cleanName,
            contactPerson || null,
            email || null,
            phone || null,
            address || null,
            taxIdentifier || null,
            notes || null,
            Boolean(isActive),
            id
        ]
    );

    return result.rows[0] || null;
}

async function setVendorActive(id, isActive) {
    const result = await db.query(
        `
        UPDATE vendors
        SET
            is_active = $1,
            updated_at = NOW()
        WHERE id = $2
        RETURNING *
        `,
        [Boolean(isActive), id]
    );

    return result.rows[0] || null;
}

module.exports = {
    listVendors,
    getVendorById,
    createVendor,
    updateVendor,
    setVendorActive
};