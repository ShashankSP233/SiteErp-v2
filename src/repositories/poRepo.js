const db = require('../config/db');

const PO_STATUSES = [
    'DRAFT',
    'SENT',
    'PARTIALLY_RECEIVED',
    'COMPLETED',
    'CANCELLED'
];

function validatePoStatus(status) {
    if (!PO_STATUSES.includes(status)) {
        throw new Error(`Invalid purchase order status: ${status}`);
    }
}

function normalizePoNumber(value) {
    const valueString = String(value || '').trim();

    if (!valueString) {
        throw new Error('PO number is required.');
    }

    return valueString;
}

function normalizeQuantity(value) {
    const quantity = Number(value);

    if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error('Quantity must be greater than zero.');
    }

    return quantity;
}

async function listPurchaseOrders({
    status = null,
    siteId = null,
    vendorId = null
} = {}) {
    const conditions = [];
    const params = [];

    if (status) {
        validatePoStatus(status);
        params.push(status);
        conditions.push(`po.status = $${params.length}`);
    }

    if (siteId) {
        params.push(siteId);
        conditions.push(`po.site_id = $${params.length}`);
    }

    if (vendorId) {
        params.push(vendorId);
        conditions.push(`po.vendor_id = $${params.length}`);
    }

    const whereClause = conditions.length
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

    const result = await db.query(
        `
        SELECT
            po.id,
            po.po_number,
            po.vendor_id,
            v.vendor_code,
            v.name AS vendor_name,
            po.po_date,
            po.site_id,
            s.code,
            s.name AS site_name,
            po.expected_delivery_date,
            po.status,
            po.reference_text,
            po.notes,
            po.created_by,
            u.full_name AS created_by_name,
            po.created_at,
            po.updated_at,

            COALESCE(
                SUM(pol.ordered_quantity),
                0
            ) AS total_ordered_quantity,

            COUNT(pol.id) AS line_count

        FROM purchase_orders po

        JOIN vendors v
            ON v.id = po.vendor_id

        JOIN sites s
            ON s.id = po.site_id

        JOIN users u
            ON u.id = po.created_by

        LEFT JOIN purchase_order_lines pol
            ON pol.purchase_order_id = po.id

        ${whereClause}

        GROUP BY
            po.id,
            v.vendor_code,
            v.name,
            s.code,
            s.name,
            u.full_name

        ORDER BY
            po.po_date DESC,
            po.id DESC
        `,
        params
    );

    return result.rows;
}

async function getPurchaseOrderById(id) {
    const headerResult = await db.query(
        `
        SELECT
            po.id,
            po.po_number,
            po.vendor_id,
            v.vendor_code,
            v.name AS vendor_name,
            v.contact_person AS vendor_contact_person,
            v.email AS vendor_email,
            v.phone AS vendor_phone,

            po.po_date,
            po.site_id,
            s.code,
            s.name AS site_name,

            po.expected_delivery_date,
            po.status,
            po.reference_text,
            po.notes,

            po.created_by,
            u.full_name AS created_by_name,

            po.created_at,
            po.updated_at

        FROM purchase_orders po

        JOIN vendors v
            ON v.id = po.vendor_id

        JOIN sites s
            ON s.id = po.site_id

        JOIN users u
            ON u.id = po.created_by

        WHERE po.id = $1
        `,
        [id]
    );

    const header = headerResult.rows[0];

    if (!header) {
        return null;
    }

    const linesResult = await db.query(
        `
        SELECT
            pol.id,
            pol.purchase_order_id,
            pol.item_master_id,
            im.item_code,
            im.name AS item_name,
            im.description AS item_description,
            im.category,
            im.unit AS item_master_unit,
            im.instance_quantity,
            im.instance_quantity_unit,
            im.is_consumable,
            im.allows_partial_consumption,
            im.requires_instance_tracking,

            pol.ordered_quantity,
            pol.unit,
            pol.notes,

            pol.created_at,
            pol.updated_at

        FROM purchase_order_lines pol

        JOIN item_masters im
            ON im.id = pol.item_master_id

        WHERE pol.purchase_order_id = $1

        ORDER BY pol.id ASC
        `,
        [id]
    );

    return {
        ...header,
        lines: linesResult.rows
    };
}

async function createPurchaseOrder({
    poNumber,
    vendorId,
    poDate,
    siteId,
    expectedDeliveryDate = null,
    referenceText = null,
    notes = null,
    createdBy
}) {
    const cleanPoNumber = normalizePoNumber(poNumber);

    if (!vendorId) {
        throw new Error('Vendor is required.');
    }

    if (!poDate) {
        throw new Error('PO date is required.');
    }

    if (!siteId) {
        throw new Error('Site is required.');
    }

    if (!createdBy) {
        throw new Error('Creating user is required.');
    }

    if (
        expectedDeliveryDate &&
        expectedDeliveryDate < poDate
    ) {
        throw new Error(
            'Expected delivery date cannot be before the PO date.'
        );
    }

    const result = await db.query(
        `
        INSERT INTO purchase_orders (
            po_number,
            vendor_id,
            po_date,
            site_id,
            expected_delivery_date,
            status,
            reference_text,
            notes,
            created_by
        )
        VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            'DRAFT',
            $6,
            $7,
            $8
        )
        RETURNING *
        `,
        [
            cleanPoNumber,
            vendorId,
            poDate,
            siteId,
            expectedDeliveryDate || null,
            referenceText || null,
            notes || null,
            createdBy
        ]
    );

    return result.rows[0];
}

async function updatePurchaseOrder(
    id,
    {
        poNumber,
        vendorId,
        poDate,
        siteId,
        expectedDeliveryDate = null,
        referenceText = null,
        notes = null
    }
) {
    const cleanPoNumber = normalizePoNumber(poNumber);

    if (!vendorId) {
        throw new Error('Vendor is required.');
    }

    if (!poDate) {
        throw new Error('PO date is required.');
    }

    if (!siteId) {
        throw new Error('Site is required.');
    }

    if (
        expectedDeliveryDate &&
        expectedDeliveryDate < poDate
    ) {
        throw new Error(
            'Expected delivery date cannot be before the PO date.'
        );
    }

    const result = await db.query(
        `
        UPDATE purchase_orders
        SET
            po_number = $1,
            vendor_id = $2,
            po_date = $3,
            site_id = $4,
            expected_delivery_date = $5,
            reference_text = $6,
            notes = $7,
            updated_at = NOW()
        WHERE id = $8
        RETURNING *
        `,
        [
            cleanPoNumber,
            vendorId,
            poDate,
            siteId,
            expectedDeliveryDate || null,
            referenceText || null,
            notes || null,
            id
        ]
    );

    return result.rows[0] || null;
}

async function addPurchaseOrderLine({
    purchaseOrderId,
    itemMasterId,
    orderedQuantity,
    unit,
    notes = null
}) {
    const quantity = normalizeQuantity(orderedQuantity);

    if (!purchaseOrderId) {
        throw new Error('Purchase order is required.');
    }

    if (!itemMasterId) {
        throw new Error('Item Master is required.');
    }

    const itemResult = await db.query(
        `
        SELECT
            id,
            item_code,
            name,
            unit,
            instance_quantity,
            instance_quantity_unit,
            status
        FROM item_masters
        WHERE id = $1
        `,
        [itemMasterId]
    );

    const itemMaster = itemResult.rows[0];

    if (!itemMaster) {
        throw new Error('Item Master not found.');
    }

    if (itemMaster.status !== 'ACTIVE') {
        throw new Error('Only active Item Masters can be added to a Purchase Order.');
    }

    const physicalUnit = String(itemMaster.unit || '').trim();

    if (!physicalUnit) {
        throw new Error('Item Master physical unit is not configured.');
    }

    if (unit && String(unit).trim() !== physicalUnit) {
        throw new Error(
            `Invalid unit for ${itemMaster.item_code}. `
            + `Purchase Order unit must be ${physicalUnit}.`
        );
    }

    const result = await db.query(
        `
        INSERT INTO purchase_order_lines (
            purchase_order_id,
            item_master_id,
            ordered_quantity,
            unit,
            notes
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
        `,
        [
            purchaseOrderId,
            itemMasterId,
            quantity,
            physicalUnit,
            notes || null
        ]
    );

    return result.rows[0];
}

async function updatePurchaseOrderLine(
    lineId,
    {
        itemMasterId,
        orderedQuantity,
        unit,
        notes = null
    }
) {
    const quantity = normalizeQuantity(orderedQuantity);

    if (!itemMasterId) {
        throw new Error('Item Master is required.');
    }

    const itemResult = await db.query(
        `
        SELECT
            id,
            item_code,
            name,
            unit,
            instance_quantity,
            instance_quantity_unit,
            status
        FROM item_masters
        WHERE id = $1
        `,
        [itemMasterId]
    );

    const itemMaster = itemResult.rows[0];

    if (!itemMaster) {
        throw new Error('Item Master not found.');
    }

    if (itemMaster.status !== 'ACTIVE') {
        throw new Error('Only active Item Masters can be used in a Purchase Order.');
    }

    const physicalUnit = String(itemMaster.unit || '').trim();

    if (!physicalUnit) {
        throw new Error('Item Master physical unit is not configured.');
    }

    if (unit && String(unit).trim() !== physicalUnit) {
        throw new Error(
            `Invalid unit for ${itemMaster.item_code}. `
            + `Purchase Order unit must be ${physicalUnit}.`
        );
    }

    const result = await db.query(
        `
        UPDATE purchase_order_lines
        SET
            item_master_id = $1,
            ordered_quantity = $2,
            unit = $3,
            notes = $4,
            updated_at = NOW()
        WHERE id = $5
        RETURNING *
        `,
        [
            itemMasterId,
            quantity,
            physicalUnit,
            notes || null,
            lineId
        ]
    );

    return result.rows[0] || null;
}

async function deletePurchaseOrderLine(lineId) {
    const result = await db.query(
        `
        DELETE FROM purchase_order_lines
        WHERE id = $1
        RETURNING *
        `,
        [lineId]
    );

    return result.rows[0] || null;
}

async function setPurchaseOrderStatus(id, status) {
    validatePoStatus(status);

    const result = await db.query(
        `
        UPDATE purchase_orders
        SET
            status = $1,
            updated_at = NOW()
        WHERE id = $2
        RETURNING *
        `,
        [status, id]
    );

    return result.rows[0] || null;
}

module.exports = {
    PO_STATUSES,
    listPurchaseOrders,
    getPurchaseOrderById,
    createPurchaseOrder,
    updatePurchaseOrder,
    addPurchaseOrderLine,
    updatePurchaseOrderLine,
    deletePurchaseOrderLine,
    setPurchaseOrderStatus
};