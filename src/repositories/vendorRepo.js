const db = require('../config/db');

// Shown to every logged-in user (no bank details).
const LIST_COLUMNS = `
    id, vendor_code, name, contact_person, email, phone, address, notes,
    is_active, gst_no, pan_no, udyam_id, created_at, updated_at`;

// Full record: admin/manager only.
const FULL_COLUMNS = `
    id, vendor_code, name, contact_person, email, phone, address, notes,
    is_active,
    gst_no, gst_certificate_file,
    pan_no, pan_certificate_file,
    udyam_id,
    bank_account_no, bank_name, ifsc_code, cancelled_cheque_file,
    created_at, updated_at`;

const DEFAULT_PREFIX = 'VEN-';
const DEFAULT_WIDTH = 4;
const CODE_LOCK_KEY = 70010; // advisory-lock id, only used for vendor code allocation

/**
 * Next vendor code, based on the most recently created vendor.
 * "VEN-0007" -> "VEN-0008". `q` is db or a transaction handle.
 */
async function nextVendorCode(q = db) {
    const { rows } = await q.query('SELECT vendor_code FROM vendors ORDER BY id DESC');

    let prefix = DEFAULT_PREFIX;
    let width = DEFAULT_WIDTH;

    const latest = rows.length ? /^(.*?)(\d+)$/.exec(String(rows[0].vendor_code).trim()) : null;
    if (latest) {
        prefix = latest[1];
        width = latest[2].length;
    }

    let max = 0;
    for (const row of rows) {
        const code = String(row.vendor_code).trim();
        if (!code.startsWith(prefix)) continue;
        const rest = code.slice(prefix.length);
        if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
    }

    return `${prefix}${String(max + 1).padStart(width, '0')}`;
}

async function listVendors({ includeInactive = false } = {}) {
    const where = includeInactive ? '' : 'WHERE is_active = TRUE';
    const result = await db.query(
        `SELECT ${LIST_COLUMNS} FROM vendors ${where} ORDER BY name ASC, vendor_code ASC`
    );
    return result.rows;
}

async function getVendorById(id) {
    const result = await db.query(`SELECT ${FULL_COLUMNS} FROM vendors WHERE id = $1`, [id]);
    return result.rows[0] || null;
}

/** Another vendor already using this GST / PAN number? Returns that vendor or null. */
async function findDuplicateTaxNumber({ gstNo, panNo, excludeId = null }) {
    if (!gstNo && !panNo) return null;
    const result = await db.query(
        `SELECT id, vendor_code, name FROM vendors
          WHERE (($1::text IS NOT NULL AND gst_no = $1) OR ($2::text IS NOT NULL AND pan_no = $2))
            AND ($3::bigint IS NULL OR id <> $3)
          LIMIT 1`,
        [gstNo || null, panNo || null, excludeId]
    );
    return result.rows[0] || null;
}

async function createVendor(v) {
    return db.tx(async (tx) => {
        // Serialise code allocation so two people saving at once never get the same code.
        await tx.query('SELECT pg_advisory_xact_lock($1)', [CODE_LOCK_KEY]);
        const vendorCode = await nextVendorCode(tx);

        const result = await tx.query(
            `INSERT INTO vendors (
                vendor_code, name, contact_person, email, phone, address, notes,
                gst_no, gst_certificate_file, pan_no, pan_certificate_file,
                udyam_id, bank_account_no, bank_name, ifsc_code, cancelled_cheque_file
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
            RETURNING *`,
            [
                vendorCode, v.name, v.contactPerson, v.email, v.phone, v.address, v.notes,
                v.gstNo, v.gstCertificateFile, v.panNo, v.panCertificateFile,
                v.udyamId, v.bankAccountNo, v.bankName, v.ifscCode, v.cancelledChequeFile
            ]
        );
        return result.rows[0];
    });
}

// vendor_code is never changed after creation.
async function updateVendor(id, v, isActive) {
    const result = await db.query(
        `UPDATE vendors SET
            name = $1, contact_person = $2, email = $3, phone = $4, address = $5, notes = $6,
            gst_no = $7, gst_certificate_file = $8, pan_no = $9, pan_certificate_file = $10,
            udyam_id = $11, bank_account_no = $12, bank_name = $13, ifsc_code = $14,
            cancelled_cheque_file = $15,
            is_active = $16,
            updated_at = NOW()
         WHERE id = $17
         RETURNING *`,
        [
            v.name, v.contactPerson, v.email, v.phone, v.address, v.notes,
            v.gstNo, v.gstCertificateFile, v.panNo, v.panCertificateFile,
            v.udyamId, v.bankAccountNo, v.bankName, v.ifscCode, v.cancelledChequeFile,
            Boolean(isActive), id
        ]
    );
    return result.rows[0] || null;
}

async function setVendorActive(id, isActive) {
    const result = await db.query(
        `UPDATE vendors SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [Boolean(isActive), id]
    );
    return result.rows[0] || null;
}

module.exports = {
    nextVendorCode,
    listVendors,
    getVendorById,
    findDuplicateTaxNumber,
    createVendor,
    updateVendor,
    setVendorActive
};