const db = require('../config/db');
const itemInstanceRepo = require('./itemInstanceRepo');

const GRN_STATUSES = [
    'DRAFT',
    'AWAITING_BARCODE_SCAN',
    'RECEIVED',
    'CANCELLED'
];

function normalizeGrnNumber(value) {
    const result = String(value || '').trim().toUpperCase();

    if (!result) {
        throw new Error('GRN number is required.');
    }

    if (result.length > 100) {
        throw new Error('GRN number is too long.');
    }

    return result;
}

function normalizeQuantity(value) {
    const quantity = Number(value);

    if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error('Quantity must be greater than zero.');
    }

    return quantity;
}

function getCurrentDateString() {
    const today = new Date();

    return `${today.getFullYear()}-${String(
        today.getMonth() + 1
    ).padStart(2, '0')}-${String(
        today.getDate()
    ).padStart(2, '0')}`;
}

function normalizeDateOnly(value) {
    if (value === undefined || value === null) {
        return null;
    }

    const date = String(value).trim();

    if (!date) {
        return null;
    }

    const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (!match) {
        throw new Error(
            'Delivery Date must be in YYYY-MM-DD format.'
        );
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    const daysInMonth = [
        31,
        year % 4 === 0 && (
            year % 100 !== 0 ||
            year % 400 === 0
        ) ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31
    ];

    if (
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > daysInMonth[month - 1]
    ) {
        throw new Error(
            'Delivery Date must be a valid calendar date.'
        );
    }

    return date;
}

function dateOnlySql(column) {
    return db.backend === 'pg'
        ? `TO_CHAR(${column}, 'YYYY-MM-DD')`
        : `strftime('%Y-%m-%d', ${column})`;
}

/**
 * Generate the next GRN number.
 *
 * Example:
 * GRN-2026-000001
 */
async function generateGrnNumber(executor = db) {
    const year = new Date().getFullYear();

    const result = await executor.query(
        `
        SELECT
            COALESCE(
                MAX(
                    CAST(
                        SUBSTRING(
                            grn_number
                            FROM '^GRN-[0-9]{4}-([0-9]+)$'
                        ) AS BIGINT
                    )
                ),
                0
            ) AS max_number
        FROM goods_receipts
        WHERE grn_number ~ ?
          AND grn_number LIKE ?
        `,
        [
            `^GRN-${year}-[0-9]+$`,
            `GRN-${year}-%`
        ]
    );

    const rows = result.rows || result;

    const maxNumber =
        Number(rows[0]?.max_number || 0);

    return `GRN-${year}-${String(
        maxNumber + 1
    ).padStart(6, '0')}`;
}

/**
 * List Goods Receipts.
 *
 * siteIds provides server-side site access control.
 */
async function listGoodsReceipts({
    status,
    siteId,
    purchaseOrderId,
    siteIds
} = {}) {
    const where = [];
    const params = [];

    if (status) {
        const normalizedStatus =
            String(status).toUpperCase();

        if (!GRN_STATUSES.includes(normalizedStatus)) {
            throw new Error(
                'Invalid Goods Receipt status.'
            );
        }

        where.push('gr.status = ?');
        params.push(normalizedStatus);
    }

    if (siteId) {
        where.push('gr.site_id = ?');
        params.push(siteId);
    }

    if (purchaseOrderId) {
        where.push('gr.purchase_order_id = ?');
        params.push(purchaseOrderId);
    }

    if (Array.isArray(siteIds)) {
        if (siteIds.length === 0) {
            return [];
        }

        const placeholders =
            siteIds.map(() => '?').join(', ');

        where.push(
            `gr.site_id IN (${placeholders})`
        );

        params.push(...siteIds);
    }

    const whereSql = where.length
        ? `WHERE ${where.join(' AND ')}`
        : '';

    const result = await db.query(
        `
        SELECT
            gr.id,
            gr.grn_number,
            gr.purchase_order_id,
            gr.site_id,

            gr.delivery_reference,
            ${dateOnlySql('gr.delivery_date')} AS delivery_date,
            ${dateOnlySql('gr.receipt_date')} AS receipt_date,
            gr.received_at,

            gr.status,
            gr.notes,

            gr.received_by,
            gr.created_at,
            gr.updated_at,

            po.po_number,

            v.id AS vendor_id,
            v.vendor_code,
            v.name AS vendor_name,

            s.code AS site_code,
            s.name AS site_name,

            u.full_name AS received_by_name,

            COUNT(grl.id) AS line_count,

            COALESCE(
                SUM(grl.received_quantity),
                0
            ) AS total_received_quantity

        FROM goods_receipts gr

        INNER JOIN purchase_orders po
            ON po.id = gr.purchase_order_id

        INNER JOIN vendors v
            ON v.id = po.vendor_id

        INNER JOIN sites s
            ON s.id = gr.site_id

        INNER JOIN users u
            ON u.id = gr.received_by

        LEFT JOIN goods_receipt_lines grl
            ON grl.goods_receipt_id = gr.id

        ${whereSql}

        GROUP BY
            gr.id,
            po.po_number,
            v.id,
            v.vendor_code,
            v.name,
            s.code,
            s.name,
            u.full_name

        ORDER BY
            gr.created_at DESC,
            gr.id DESC
        `,
        params
    );

    return result.rows || result;
}

/**
 * Get a single Goods Receipt with lines.
 */
async function getGoodsReceiptById(id) {
    const headerResult = await db.query(
        `
        SELECT
            gr.id,
            gr.grn_number,
            gr.purchase_order_id,
            gr.site_id,

            gr.delivery_reference,
            ${dateOnlySql('gr.delivery_date')} AS delivery_date,
            ${dateOnlySql('gr.receipt_date')} AS receipt_date,
            gr.received_at,

            gr.status,
            gr.notes,

            gr.received_by,
            gr.created_at,
            gr.updated_at,

            po.po_number,
            po.po_date,
            po.expected_delivery_date,
            po.status AS purchase_order_status,

            v.id AS vendor_id,
            v.vendor_code,
            v.name AS vendor_name,
            v.contact_person AS vendor_contact_person,
            v.email AS vendor_email,
            v.phone AS vendor_phone,

            s.code AS site_code,
            s.name AS site_name,

            u.full_name AS received_by_name

        FROM goods_receipts gr

        INNER JOIN purchase_orders po
            ON po.id = gr.purchase_order_id

        INNER JOIN vendors v
            ON v.id = po.vendor_id

        INNER JOIN sites s
            ON s.id = gr.site_id

        INNER JOIN users u
            ON u.id = gr.received_by

        WHERE gr.id = ?

        LIMIT 1
        `,
        [id]
    );

    const headerRows =
        headerResult.rows || headerResult;

    if (!headerRows.length) {
        return null;
    }

    const grn = headerRows[0];

    const linesResult = await db.query(
        `
        SELECT
            grl.id,
            grl.goods_receipt_id,
            grl.purchase_order_line_id,
            grl.received_quantity,
            grl.item_condition,
            grl.brand,
            grl.batch_number,
            grl.serial_number,
            grl.manufacture_date,
            grl.expiry_date,
            grl.unit,
            grl.notes,

            pol.item_master_id,
            pol.ordered_quantity,

            im.item_code,
            im.name AS item_name,
            im.description AS item_description,
            im.unit AS item_master_unit,
            im.instance_quantity,
            im.instance_quantity_unit,
            im.is_consumable,
            im.allows_partial_consumption,
            im.requires_instance_tracking

        FROM goods_receipt_lines grl

        INNER JOIN purchase_order_lines pol
            ON pol.id = grl.purchase_order_line_id

        INNER JOIN item_masters im
            ON im.id = pol.item_master_id

        WHERE grl.goods_receipt_id = ?

        ORDER BY grl.id ASC
        `,
        [id]
    );

    grn.lines =
        linesResult.rows ||
        linesResult;

    return grn;
}

/**
 * Get a PO line belonging to a specific PO.
 */
async function getPurchaseOrderLineForReceipt(
    purchaseOrderId,
    purchaseOrderLineId,
    executor = db
) {
    const poId = String(purchaseOrderId).trim();
    const lineId = String(purchaseOrderLineId).trim();

    if (!poId || !lineId) {
        return null;
    }

    const result = await executor.query(
        `
        SELECT
            pol.id,
            pol.purchase_order_id,
            pol.item_master_id,
            pol.ordered_quantity,
            pol.unit,
            pol.notes,

            im.item_code,
            im.name AS item_name,
            im.description AS item_description,
            im.unit AS item_master_unit,
            im.instance_quantity,
            im.instance_quantity_unit,
            im.is_consumable,
            im.allows_partial_consumption,
            im.requires_instance_tracking

        FROM purchase_order_lines pol

        INNER JOIN item_masters im
            ON im.id = pol.item_master_id

        WHERE CAST(pol.id AS TEXT) = ?
          AND CAST(pol.purchase_order_id AS TEXT) = ?

        LIMIT 1
        `,
        [
            lineId,
            poId
        ]
    );

    const rows =
        result.rows || result;

    return rows[0] || null;
}

/**
 * Get finalized received quantity for a PO line.
 */
async function getReceivedQuantityForPurchaseOrderLine(
    purchaseOrderLineId,
    executor = db
) {
    const result = await executor.query(
        `
        SELECT
            COALESCE(
                SUM(grl.received_quantity),
                0
            ) AS received_quantity

        FROM goods_receipt_lines grl

        INNER JOIN goods_receipts gr
            ON gr.id = grl.goods_receipt_id

        WHERE grl.purchase_order_line_id = ?
          AND gr.status = 'RECEIVED'
          AND grl.item_condition IN ('GOOD', 'DAMAGED')
        `,
        [purchaseOrderLineId]
    );

    const rows =
        result.rows || result;

    return Number(
        rows[0]?.received_quantity || 0
    );
}

/**
 * Get PO lines that still have receivable quantity.
 */
async function getReceivablePurchaseOrderLines(
    purchaseOrderId
) {
    const result = await db.query(
        `
        SELECT
            pol.id,
            pol.purchase_order_id,
            pol.item_master_id,
            pol.ordered_quantity,
            pol.unit,
            pol.notes,

            im.item_code,
            im.name AS item_name,
            im.description AS item_description,
            im.unit AS item_master_unit,
            im.instance_quantity,
            im.instance_quantity_unit,
            im.is_consumable,
            im.allows_partial_consumption,
            im.requires_instance_tracking,

            COALESCE(
                received.received_quantity,
                0
            ) AS received_quantity,

            GREATEST(
                pol.ordered_quantity
                - COALESCE(received.received_quantity, 0),
                0
            ) AS remaining_quantity

        FROM purchase_order_lines pol

        INNER JOIN item_masters im
            ON im.id = pol.item_master_id

        LEFT JOIN (
            SELECT
                grl.purchase_order_line_id,
                SUM(grl.received_quantity)
                    AS received_quantity

            FROM goods_receipt_lines grl

            INNER JOIN goods_receipts gr
                ON gr.id = grl.goods_receipt_id

            WHERE gr.purchase_order_id = ?
              AND gr.status = 'RECEIVED'
              AND grl.item_condition IN ('GOOD', 'DAMAGED')

            GROUP BY
                grl.purchase_order_line_id

        ) received
            ON received.purchase_order_line_id =
                pol.id

        WHERE pol.purchase_order_id = ?

          AND (
              pol.ordered_quantity
              - COALESCE(
                    received.received_quantity,
                    0
                )
          ) > 0

        ORDER BY pol.id ASC
        `,
        [
            purchaseOrderId,
            purchaseOrderId
        ]
    );

    return result.rows || result;
}

/**
 * Create a DRAFT GRN and its initial lines
 * in one database transaction.
 *
 * No inventory is changed here.
 */
async function createGoodsReceipt({
    purchaseOrderId,
    siteId,
    deliveryReference,
    deliveryDate,
    notes,
    receivedBy,
    lines = []
}) {
    if (!purchaseOrderId) {
        throw new Error(
            'Purchase Order is required.'
        );
    }

    if (!siteId) {
        throw new Error(
            'Receiving site is required.'
        );
    }

    if (!receivedBy) {
        throw new Error(
            'Receiving user is required.'
        );
    }

    if (!Array.isArray(lines)) {
        throw new Error(
            'Invalid receipt lines.'
        );
    }

    if (lines.length === 0) {
        throw new Error(
            'At least one receipt quantity must be entered.'
        );
    }

    return db.tx(async tx => {

        /*
         * Lock the PO while validating and creating
         * the draft receipt.
         */
        const poResult = await tx.query(
            `
            SELECT
                po.id,
                po.po_number,
                po.site_id AS po_site_id,
                po.vendor_id,
                po.status,

                v.name AS vendor_name

            FROM purchase_orders po

            INNER JOIN vendors v
                ON v.id = po.vendor_id

            WHERE po.id = ?

            FOR UPDATE
            `,
            [purchaseOrderId]
        );

        const poRows =
            poResult.rows ||
            poResult;

        if (!poRows.length) {
            throw new Error(
                'Purchase Order not found.'
            );
        }

        const purchaseOrder =
            poRows[0];

        if (
            [
                'CANCELLED',
                'COMPLETED'
            ].includes(
                String(
                    purchaseOrder.status
                ).toUpperCase()
            )
        ) {
            throw new Error(
                'A Goods Receipt cannot be created for this Purchase Order.'
            );
        }

        /*
         * Validate receiving site.
         */
        const siteResult = await tx.query(
            `
            SELECT
                id,
                code,
                name,
                status
            FROM sites
            WHERE id = ?
            FOR UPDATE
            `,
            [siteId]
        );

        const siteRows =
            siteResult.rows ||
            siteResult;

        if (!siteRows.length) {
            throw new Error(
                'Receiving site not found.'
            );
        }

        if (siteRows[0].status !== 'ACTIVE') {
            throw new Error(
                'The selected receiving site is not active.'
            );
        }

        /*
         * Normalize and validate submitted lines.
         */
        const normalizedLines = [];

        const seenLineIds = new Set();

        for (const rawLine of lines) {
            const purchaseOrderLineId =
                String(
                    rawLine.purchaseOrderLineId ||
                    ''
                ).trim();

            if (!purchaseOrderLineId) {
                continue;
            }

            if (!/^\d+$/.test(purchaseOrderLineId)) {
                throw new Error(
                    `Invalid Purchase Order line ID: ${purchaseOrderLineId}.`
                );
            }

            if (
                seenLineIds.has(
                    purchaseOrderLineId
                )
            ) {
                throw new Error(
                    'The same Purchase Order line was submitted more than once.'
                );
            }

            seenLineIds.add(
                purchaseOrderLineId
            );

            const quantity =
                normalizeQuantity(
                    rawLine.receivedQuantity
                );

            /*
             * GRN quantities represent physical units.
             *
             * A physical unit such as BAG, BARREL or TANK
             * cannot be received as a fractional object.
             */
            if (!Number.isInteger(quantity)) {
                throw new Error(
                    `Receipt quantity must be a whole number of physical units.`
                );
            }

            const itemCondition = String(rawLine.itemCondition || 'GOOD').toUpperCase();
            if (!['GOOD', 'DAMAGED', 'DEFECTIVE', 'REJECTED'].includes(itemCondition)) {
                throw new Error('Select a valid item condition.');
            }
            const traceability = {
                brand: String(rawLine.brand || '').trim() || null,
                batchNumber: String(rawLine.batchNumber || '').trim() || null,
                serialNumber: String(rawLine.serialNumber || '').trim() || null,
                manufactureDate: normalizeDateOnly(rawLine.manufactureDate),
                expiryDate: normalizeDateOnly(rawLine.expiryDate)
            };
            if (traceability.serialNumber && quantity !== 1) {
                throw new Error('Enter a serial number only when this receipt line contains exactly one physical item.');
            }

            /*
             * Lock the PO line so another transaction
             * cannot change its receiving state while
             * this draft is being created.
             */
            const poLine =
                await getPurchaseOrderLineForReceipt(
                    purchaseOrderId,
                    purchaseOrderLineId,
                    tx
                );

            if (!poLine) {
                throw new Error(
                    `Purchase Order line ${purchaseOrderLineId} does not belong to Purchase Order ${purchaseOrderId}.`
                );
            }

            /*
             * The PO physical unit must match the
             * Item Master physical unit.
             */
            if (
                String(poLine.unit).trim().toLowerCase() !==
                String(poLine.item_master_unit).trim().toLowerCase()
            ) {
                throw new Error(
                    `Unit mismatch for ${poLine.item_code}. Purchase Order unit is ${poLine.unit}, but the Item Master physical unit is ${poLine.item_master_unit}.`
                );
            }

            const alreadyReceived =
                await getReceivedQuantityForPurchaseOrderLine(
                    purchaseOrderLineId,
                    tx
                );

            const remaining =
                Number(
                    poLine.ordered_quantity
                ) -
                alreadyReceived;

            if (
                ['GOOD', 'DAMAGED'].includes(itemCondition) &&
                quantity > remaining
            ) {
                throw new Error(
                    `Receipt quantity for ${poLine.item_code} cannot exceed the remaining Purchase Order quantity. Remaining: ${remaining} ${poLine.unit}.`
                );
            }

            normalizedLines.push({
                purchaseOrderLineId:
                    Number(
                        purchaseOrderLineId
                    ),

                receivedQuantity:
                    quantity,

                itemCondition,

                brand: traceability.brand,

                batchNumber: traceability.batchNumber,

                serialNumber: traceability.serialNumber,

                manufactureDate: traceability.manufactureDate,

                expiryDate: traceability.expiryDate,

                unit:
                    poLine.unit,

                notes:
                    String(
                        rawLine.notes || ''
                    ).trim() || null
            });
        }

        if (normalizedLines.length === 0) {
            throw new Error(
                'Enter a quantity for at least one Purchase Order item.'
            );
        }

        /*
         * Generate the GRN number while inside the
         * transaction.
         */
        const grnNumber =
            await generateGrnNumber(tx);

        const finalDeliveryDate =
            normalizeDateOnly(deliveryDate) ||
            getCurrentDateString();

        /*
         * Create header.
         */
        const headerResult =
            await tx.query(
                `
                INSERT INTO goods_receipts (
                    grn_number,
                    purchase_order_id,
                    site_id,

                    /*
                     * Legacy field.
                     *
                     * The current database still requires
                     * receipt_date NOT NULL.
                     *
                     * Until the legacy column is retired,
                     * keep it synchronized with delivery_date.
                     */
                    receipt_date,

                    /*
                     * New GRN fields.
                     */
                    delivery_reference,
                    delivery_date,

                    status,
                    notes,

                    received_by
                )
                VALUES (
                    ?,
                    ?,
                    ?,

                    ?,

                    ?,
                    ?,

                    'DRAFT',
                    ?,

                    ?
                )

                RETURNING id
                `,
                [
                    normalizeGrnNumber(
                        grnNumber
                    ),

                    purchaseOrderId,

                    siteId,

                    /*
                     * Legacy receipt_date
                     */
                    finalDeliveryDate,

                    /*
                     * delivery_reference
                     */
                    String(
                        deliveryReference || ''
                    ).trim() || null,

                    /*
                     * delivery_date
                     */
                    finalDeliveryDate,

                    /*
                     * notes
                     */
                    String(
                        notes || ''
                    ).trim() || null,

                    /*
                     * received_by
                     */
                    receivedBy
                ]
            );

        const headerRows =
            headerResult.rows ||
            headerResult;

        if (!headerRows.length) {
            throw new Error(
                'Goods Receipt could not be created.'
            );
        }

        const grnId =
            headerRows[0].id;

        /*
         * Create initial receipt lines.
         */
        for (
            const line of normalizedLines
        ) {
            await tx.query(
                `
                INSERT INTO goods_receipt_lines (
                    goods_receipt_id,
                    purchase_order_line_id,
                    received_quantity,
                    item_condition,
                    brand,
                    batch_number,
                    serial_number,
                    manufacture_date,
                    expiry_date,
                    unit,
                    notes
                )
                VALUES (
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?
                )
                `,
                [
                    grnId,

                    line.purchaseOrderLineId,

                    line.receivedQuantity,

                    line.itemCondition,

                    line.brand,

                    line.batchNumber,

                    line.serialNumber,

                    line.manufactureDate,

                    line.expiryDate,

                    line.unit,

                    line.notes
                ]
            );
        }

        return {
            id: grnId,

            grnNumber,

            purchaseOrderId,

            siteId,

            poSiteId:
                purchaseOrder.po_site_id,

            vendorId:
                purchaseOrder.vendor_id,

            vendorName:
                purchaseOrder.vendor_name,

            deliveryDate:
                finalDeliveryDate,

            lineCount:
                normalizedLines.length
        };
    });
}

/**
 * Update a DRAFT GRN header.
 */
async function updateGoodsReceipt({
    id,
    siteId,
    deliveryReference,
    deliveryDate,
    notes
}) {
    const finalDeliveryDate =
        normalizeDateOnly(deliveryDate) ||
        getCurrentDateString();

    const result = await db.query(
        `
        UPDATE goods_receipts

        SET
            site_id = ?,
            delivery_reference = ?,
            delivery_date = ?,
            receipt_date = ?,
            notes = ?,
            updated_at = now()

        WHERE id = ?
          AND status = 'DRAFT'

        RETURNING id
        `,
        [
            siteId,

            String(
                deliveryReference || ''
            ).trim() || null,

            finalDeliveryDate,

            finalDeliveryDate,

            String(
                notes || ''
            ).trim() || null,

            id
        ]
    );

    const rows =
        result.rows || result;

    if (!rows.length) {
        throw new Error(
            'Goods Receipt was not found or is no longer a draft.'
        );
    }

    return rows[0];
}

/**
 * Add/update a line on an existing DRAFT GRN.
 */
async function addGoodsReceiptLine({
    goodsReceiptId,
    purchaseOrderLineId,
    receivedQuantity,
    itemCondition = 'GOOD',
    brand = null,
    batchNumber = null,
    serialNumber = null,
    manufactureDate = null,
    expiryDate = null,
    notes
}) {
    const allowedConditions = [
        'GOOD',
        'DAMAGED',
        'DEFECTIVE',
        'REJECTED'
    ];

    const condition =
        String(itemCondition).toUpperCase();

    const traceability = {
        brand: String(brand || '').trim() || null,
        batchNumber: String(batchNumber || '').trim() || null,
        serialNumber: String(serialNumber || '').trim() || null,
        manufactureDate: manufactureDate || null,
        expiryDate: expiryDate || null
    };

    if (!allowedConditions.includes(condition)) {
        throw new Error('Select a valid item condition.');
    }

    const quantity =
        normalizeQuantity(
            receivedQuantity
        );

    if (traceability.serialNumber && quantity !== 1) {
        throw new Error('Enter a serial number only when this receipt line contains exactly one physical item.');
    }

    if (!Number.isInteger(quantity)) {
        throw new Error(
            'Receipt quantity must be a whole number of physical units.'
        );
    }

    const grnResult =
        await db.query(
            `
            SELECT
                id,
                purchase_order_id,
                status
            FROM goods_receipts
            WHERE id = ?
            LIMIT 1
            `,
            [goodsReceiptId]
        );

    const grnRows =
        grnResult.rows ||
        grnResult;

    if (!grnRows.length) {
        throw new Error(
            'Goods Receipt not found.'
        );
    }

    const grn = grnRows[0];

    if (grn.status !== 'DRAFT') {
        throw new Error(
            'Receipt lines can only be changed on a DRAFT Goods Receipt.'
        );
    }

    const poLine =
        await getPurchaseOrderLineForReceipt(
            grn.purchase_order_id,
            purchaseOrderLineId
        );

    if (!poLine) {
        throw new Error(
            'The selected Purchase Order line does not belong to this Purchase Order.'
        );
    }

    /*
     * PO physical unit must match Item Master physical unit.
     */
    if (
        String(poLine.unit).trim().toLowerCase() !==
        String(poLine.item_master_unit).trim().toLowerCase()
    ) {
        throw new Error(
            `Unit mismatch for ${poLine.item_code}. Purchase Order unit is ${poLine.unit}, but the Item Master physical unit is ${poLine.item_master_unit}.`
        );
    }
        if (
        String(poLine.unit).trim().toLowerCase() !==
        String(poLine.item_master_unit).trim().toLowerCase()
    ) {
        throw new Error(
            `Unit mismatch for ${poLine.item_code}. Purchase Order unit is ${poLine.unit}, but the Item Master physical unit is ${poLine.item_master_unit}.`
        );
    }

    const instanceQuantity =
        Number(poLine.instance_quantity);

    if (
        !Number.isFinite(instanceQuantity) ||
        instanceQuantity <= 0
    ) {
        throw new Error(
            `Item ${poLine.item_code} has an invalid quantity per instance.`
        );
    }

    if (
        !poLine.instance_quantity_unit ||
        !String(
            poLine.instance_quantity_unit
        ).trim()
    ) {
        throw new Error(
            `Item ${poLine.item_code} has no quantity unit configured for its physical instances.`
        );
    }

    const existingResult =
        await db.query(
            `
            SELECT
                id,
                received_quantity,
                item_condition
            FROM goods_receipt_lines
            WHERE goods_receipt_id = ?
              AND purchase_order_line_id = ?
              AND item_condition = ?
            LIMIT 1
            `,
            [
                goodsReceiptId,
                purchaseOrderLineId,
                condition
            ]
        );

    const existingRows =
        existingResult.rows ||
        existingResult;

    const existingLine =
        existingRows[0] || null;

    const otherDraftResult =
        await db.query(
            `
            SELECT COALESCE(SUM(received_quantity), 0) AS quantity
            FROM goods_receipt_lines
            WHERE goods_receipt_id = ?
              AND purchase_order_line_id = ?
              AND id <> COALESCE(?, -1)
            `,
            [
                goodsReceiptId,
                purchaseOrderLineId,
                existingLine?.id || null
            ]
        );

    const otherDraftRows =
        otherDraftResult.rows || otherDraftResult;

    const otherDraftQuantity =
        Number(otherDraftRows[0]?.quantity || 0);

    const alreadyReceived =
        await getReceivedQuantityForPurchaseOrderLine(
            purchaseOrderLineId
        );

    const availableForDraft =
        Number(
            poLine.ordered_quantity
        ) -
        alreadyReceived -
        otherDraftQuantity;

    if (
        quantity >
        availableForDraft
    ) {
        throw new Error(
            `Receipt quantity cannot exceed the remaining Purchase Order quantity. Remaining: ${availableForDraft} ${poLine.unit}.`
        );
    }

    if (existingLine) {
        const result =
            await db.query(
                `
                UPDATE goods_receipt_lines

                SET
                    received_quantity = ?,
                    item_condition = ?,
                    brand = ?,
                    batch_number = ?,
                    serial_number = ?,
                    manufacture_date = ?,
                    expiry_date = ?,
                    notes = ?,
                    updated_at = now()

                WHERE id = ?

                RETURNING
                    id,
                    goods_receipt_id,
                    purchase_order_line_id,
                    received_quantity,
                    item_condition,
                    brand,
                    batch_number,
                    serial_number,
                    manufacture_date,
                    expiry_date,
                    unit,
                    notes
                `,
                [
                    quantity,

                    condition,

                    traceability.brand,

                    traceability.batchNumber,

                    traceability.serialNumber,

                    traceability.manufactureDate,

                    traceability.expiryDate,

                    String(
                        notes || ''
                    ).trim() || null,

                    existingLine.id
                ]
            );

        const rows =
            result.rows ||
            result;

        return rows[0];
    }

    const result =
        await db.query(
            `
            INSERT INTO goods_receipt_lines (
                goods_receipt_id,
                purchase_order_line_id,
                received_quantity,
                item_condition,
                brand,
                batch_number,
                serial_number,
                manufacture_date,
                expiry_date,
                unit,
                notes
            )
            VALUES (
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?
            )

            RETURNING
                id,
                goods_receipt_id,
                purchase_order_line_id,
                received_quantity,
                item_condition,
                brand,
                batch_number,
                serial_number,
                manufacture_date,
                expiry_date,
                unit,
                notes
            `,
            [
                goodsReceiptId,

                purchaseOrderLineId,

                quantity,

                condition,

                traceability.brand,

                traceability.batchNumber,

                traceability.serialNumber,

                traceability.manufactureDate,

                traceability.expiryDate,

                poLine.unit,

                String(
                    notes || ''
                ).trim() || null
            ]
        );

    const rows =
        result.rows ||
        result;

    return rows[0];
}

/**
 * Delete a line from a DRAFT GRN.
 */
async function deleteGoodsReceiptLine(
    goodsReceiptId,
    lineId
) {
    const result =
        await db.query(
            `
            DELETE FROM goods_receipt_lines

            WHERE id = ?
              AND goods_receipt_id = ?

              AND EXISTS (
                  SELECT 1
                  FROM goods_receipts gr
                  WHERE gr.id = ?
                    AND gr.status = 'DRAFT'
              )

            RETURNING id
            `,
            [
                lineId,
                goodsReceiptId,
                goodsReceiptId
            ]
        );

    const rows =
        result.rows ||
        result;

    if (!rows.length) {
        throw new Error(
            'Receipt line was not found or the Goods Receipt is no longer editable.'
        );
    }

    return rows[0];
}

/**
 * Confirm a DRAFT Goods Receipt.
 *
 * This is the point where the receipt becomes physical inventory.
 *
 * Everything happens inside ONE transaction:
 *
 * - lock GRN
 * - lock PO
 * - lock PO lines
 * - validate receipt quantities
 * - create physical inventory instances
 * - create RECEIVE movements
 * - mark GRN RECEIVED
 * - update PO status
 *
 * If anything fails, the entire transaction rolls back.
 */
async function prepareGoodsReceiptLabels({
    goodsReceiptId,
    performedBy,
    userRole
}) {
    return db.tx(async tx => {
        const grnResult = await tx.query(
            `SELECT id, grn_number, purchase_order_id, site_id, status
             FROM goods_receipts
             WHERE id = ?
             FOR UPDATE`,
            [goodsReceiptId]
        );
        const grn = (grnResult.rows || grnResult)[0];
        if (!grn) throw new Error('Goods Receipt not found.');
        if (grn.status !== 'DRAFT') {
            throw new Error('Only a draft Goods Receipt can prepare barcode labels.');
        }

        if (userRole !== 'admin') {
            const access = await tx.query(
                `SELECT 1
                 FROM site_assignments
                 WHERE user_id = ? AND site_id = ? AND assigned_until IS NULL
                 LIMIT 1`,
                [performedBy, grn.site_id]
            );
            if (!(access.rows || access).length) {
                throw new Error('You do not have permission to receive at this site.');
            }
        }

        const site = await tx.one(
            `SELECT status FROM sites WHERE id = ? FOR UPDATE`,
            [grn.site_id]
        );
        if (site.status !== 'ACTIVE') throw new Error('The receiving site is inactive.');

        const purchaseOrder = await tx.one(
            `SELECT status FROM purchase_orders WHERE id = ? FOR UPDATE`,
            [grn.purchase_order_id]
        );
        if (['CANCELLED', 'COMPLETED'].includes(String(purchaseOrder.status).toUpperCase())) {
            throw new Error(`Purchase Order cannot receive goods in its current status (${purchaseOrder.status}).`);
        }

        const linesResult = await tx.query(
            `SELECT grl.id, grl.purchase_order_line_id, grl.received_quantity,
                    grl.unit, grl.item_condition, grl.brand, grl.batch_number,
                    grl.serial_number, grl.manufacture_date, grl.expiry_date,
                    pol.item_master_id,
                    pol.ordered_quantity, im.item_code, im.status AS item_status,
                    im.instance_quantity, im.instance_quantity_unit,
                    im.requires_instance_tracking, im.unit AS item_unit
             FROM goods_receipt_lines grl
             JOIN purchase_order_lines pol ON pol.id = grl.purchase_order_line_id
             JOIN item_masters im ON im.id = pol.item_master_id
             WHERE grl.goods_receipt_id = ?
             ORDER BY grl.id
             FOR UPDATE OF grl, pol`,
            [goodsReceiptId]
        );
        const lines = linesResult.rows || linesResult;
        if (!lines.length) throw new Error('This Goods Receipt has no receipt lines.');

        const acceptedByPoLine = new Map();
        for (const line of lines) {
            if (!['GOOD', 'DAMAGED', 'DEFECTIVE', 'REJECTED'].includes(line.item_condition)) {
                throw new Error(`Invalid condition for ${line.item_code}.`);
            }
            const count = Number(line.received_quantity);
            if (!Number.isInteger(count) || count < 1) {
                throw new Error(`Receipt quantity for ${line.item_code} must be a positive whole number.`);
            }
            if (['DEFECTIVE', 'REJECTED'].includes(line.item_condition)) continue;
            if (line.item_status !== 'ACTIVE' || !line.requires_instance_tracking) {
                throw new Error(`Item ${line.item_code} must be active and instance tracked.`);
            }
            if (!Number.isFinite(Number(line.instance_quantity)) || Number(line.instance_quantity) <= 0 || !String(line.instance_quantity_unit || '').trim()) {
                throw new Error(`Item ${line.item_code} has invalid quantity-per-instance settings.`);
            }
            if (String(line.unit).trim().toLowerCase() !== String(line.item_unit).trim().toLowerCase()) {
                throw new Error(`Unit mismatch for ${line.item_code}.`);
            }
            acceptedByPoLine.set(
                String(line.purchase_order_line_id),
                (acceptedByPoLine.get(String(line.purchase_order_line_id)) || 0) + count
            );
        }

        for (const [poLineId, quantity] of acceptedByPoLine) {
            const poLine = lines.find(line => String(line.purchase_order_line_id) === poLineId);
            const prior = await getReceivedQuantityForPurchaseOrderLine(poLineId, tx);
            if (quantity + prior > Number(poLine.ordered_quantity)) {
                throw new Error(`Accepted quantity for ${poLine.item_code} exceeds the remaining PO quantity.`);
            }
        }

        const batch = await tx.one(
            `INSERT INTO inventory_receipt_batches
                (source_type, goods_receipt_id, site_id, status, created_by)
             VALUES ('GRN', ?, ?, 'AWAITING_SCAN', ?)
             RETURNING id`,
            [grn.id, grn.site_id, performedBy]
        );

        for (const line of lines) {
            if (!['GOOD', 'DAMAGED'].includes(line.item_condition)) continue;
            for (let i = 0; i < Number(line.received_quantity); i += 1) {
                const number = await itemInstanceRepo.allocateInstanceNumber(tx, line.item_master_id);
                const code = itemInstanceRepo.buildInstanceCode(line.item_code, number);
                await tx.query(
                    `INSERT INTO inventory_receipt_labels
                        (receipt_batch_id, goods_receipt_line_id, item_master_id,
                         item_condition, instance_code, barcode, brand,
                         batch_number, serial_number, manufacture_date, expiry_date)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [batch.id, line.id, line.item_master_id, line.item_condition,
                     code, code, line.brand, line.batch_number, line.serial_number,
                     line.manufacture_date, line.expiry_date]
                );
            }
        }

        await tx.query(
            `UPDATE goods_receipts
             SET status = 'AWAITING_BARCODE_SCAN', updated_at = now()
             WHERE id = ? AND status = 'DRAFT'`,
            [grn.id]
        );
        return { batchId: batch.id, grnNumber: grn.grn_number };
    });
}

async function getGoodsReceiptLabelBatch(goodsReceiptId) {
    const batch = await db.one(
        `SELECT b.id, b.status, b.site_id, b.labels_printed_at,
                gr.id AS grn_id, gr.grn_number,
                gr.status AS grn_status, s.code AS site_code, s.name AS site_name
         FROM inventory_receipt_batches b
         JOIN goods_receipts gr ON gr.id = b.goods_receipt_id
         JOIN sites s ON s.id = b.site_id
         WHERE gr.id = ? AND b.source_type = 'GRN'
         LIMIT 1`,
        [goodsReceiptId]
    );
    const result = await db.query(
        `SELECT l.id, l.instance_code, l.barcode, l.item_condition, l.brand,
                l.batch_number, l.serial_number,
                l.scanned_at, im.item_code, im.name AS item_name,
                im.instance_quantity, im.instance_quantity_unit
         FROM inventory_receipt_labels l
         JOIN item_masters im ON im.id = l.item_master_id
         WHERE l.receipt_batch_id = ?
         ORDER BY l.id`,
        [batch.id]
    );
    const labels = result.rows || result;
    return {
        ...batch,
        labels,
        scannedCount: labels.filter(label => label.scanned_at).length,
        labelCount: labels.length
    };
}

async function markGoodsReceiptLabelsPrinted({ goodsReceiptId, performedBy }) {
    return db.tx(async tx => {
        const result = await tx.query(
            `UPDATE inventory_receipt_batches b
             SET labels_printed_at = COALESCE(labels_printed_at, now()),
                 labels_printed_by = COALESCE(labels_printed_by, ?),
                 updated_at = now()
             FROM goods_receipts gr
             WHERE b.goods_receipt_id = gr.id
               AND gr.id = ?
               AND b.source_type = 'GRN'
               AND b.status IN ('AWAITING_SCAN', 'COMPLETED')
             RETURNING b.id`,
            [performedBy, goodsReceiptId]
        );
        const rows = result.rows || result;
        if (!rows.length) throw new Error('Barcode batch was not found or is not ready to print.');
        return rows[0];
    });
}

async function scanGoodsReceiptBarcode({ goodsReceiptId, barcode, performedBy }) {
    const value = String(barcode || '').trim();
    if (!value) throw new Error('Scan or enter a barcode.');
    return db.tx(async tx => {
        const batch = await tx.one(
            `SELECT b.id, b.status, b.labels_printed_at
             FROM inventory_receipt_batches b
             JOIN goods_receipts gr ON gr.id = b.goods_receipt_id
             WHERE gr.id = ? AND b.source_type = 'GRN'
             FOR UPDATE OF b`,
            [goodsReceiptId]
        );
        if (batch.status !== 'AWAITING_SCAN') throw new Error('This barcode batch is no longer open.');
        if (!batch.labels_printed_at) throw new Error('Start printing the barcode labels before scanning them.');
        const result = await tx.query(
            `UPDATE inventory_receipt_labels
             SET scanned_at = now(), scanned_by = ?
             WHERE receipt_batch_id = ? AND barcode = ? AND scanned_at IS NULL
             RETURNING instance_code`,
            [performedBy, batch.id, value]
        );
        const rows = result.rows || result;
        if (!rows.length) {
            const exists = await tx.query(
                `SELECT scanned_at FROM inventory_receipt_labels
                 WHERE receipt_batch_id = ? AND barcode = ?`,
                [batch.id, value]
            );
            if ((exists.rows || exists).length) throw new Error('This barcode was already scanned.');
            throw new Error('That barcode does not belong to this receipt.');
        }
        return rows[0];
    });
}

async function confirmGoodsReceipt({
    goodsReceiptId,
    performedBy,
    userRole
}) {
    if (!goodsReceiptId) {
        throw new Error(
            'Goods Receipt ID is required.'
        );
    }

    if (!performedBy) {
        throw new Error(
            'Receiving user is required.'
        );
    }

    return db.tx(async tx => {

        /*
         * ---------------------------------------------------------
         * 1. Lock the GRN
         * ---------------------------------------------------------
         */
        const grnResult = await tx.query(
            `
            SELECT
                gr.id,
                gr.grn_number,
                gr.purchase_order_id,
                gr.site_id,
                gr.status,
                gr.received_by
            FROM goods_receipts gr
            WHERE gr.id = ?
            FOR UPDATE
            `,
            [goodsReceiptId]
        );

        const grnRows =
            grnResult.rows ||
            grnResult;

        if (!grnRows.length) {
            throw new Error(
                'Goods Receipt not found.'
            );
        }

        const grn =
            grnRows[0];

        if (grn.status !== 'AWAITING_BARCODE_SCAN') {
            throw new Error(
                `This Goods Receipt cannot be completed because its status is ${grn.status}.`
            );
        }

        const batchResult = await tx.query(
            `SELECT b.id
             FROM inventory_receipt_batches b
             WHERE b.goods_receipt_id = ?
               AND b.source_type = 'GRN'
               AND b.status = 'AWAITING_SCAN'
             FOR UPDATE`,
            [goodsReceiptId]
        );
        const receiptBatch = (batchResult.rows || batchResult)[0];
        if (!receiptBatch) throw new Error('Prepare and scan this GRN\'s barcodes before completing it.');
        const scanCounts = await tx.one(
            `SELECT COUNT(*) AS label_count,
                    COUNT(scanned_at) AS scanned_count
             FROM inventory_receipt_labels
             WHERE receipt_batch_id = ?`,
            [receiptBatch.id]
        );
        receiptBatch.label_count = scanCounts.label_count;
        receiptBatch.scanned_count = scanCounts.scanned_count;
        if (Number(receiptBatch.scanned_count) !== Number(receiptBatch.label_count)) {
            throw new Error(`Scan all required barcodes before completing this GRN (${receiptBatch.scanned_count}/${receiptBatch.label_count} scanned).`);
        }

        /*
         * ---------------------------------------------------------
         * 2. Lock the Purchase Order
         * ---------------------------------------------------------
         */
        const poResult = await tx.query(
            `
            SELECT
                po.id,
                po.po_number,
                po.status,
                po.site_id,
                po.vendor_id
            FROM purchase_orders po
            WHERE po.id = ?
            FOR UPDATE
            `,
            [grn.purchase_order_id]
        );

        const poRows =
            poResult.rows ||
            poResult;

        if (!poRows.length) {
            throw new Error(
                'Purchase Order not found.'
            );
        }

        const purchaseOrder =
            poRows[0];

        if (
            ['CANCELLED', 'COMPLETED'].includes(
                String(
                    purchaseOrder.status
                ).toUpperCase()
            )
        ) {
            throw new Error(
                `Purchase Order ${purchaseOrder.po_number} cannot receive this Goods Receipt because its status is ${purchaseOrder.status}.`
            );
        }

        /*
         * ---------------------------------------------------------
         * 3. Validate receiving site and user site access
         * ---------------------------------------------------------
         */
        const siteResult = await tx.query(
            `
            SELECT
                id,
                code,
                name,
                site_type,
                status
            FROM sites
            WHERE id = ?
            FOR UPDATE
            `,
            [grn.site_id]
        );

        const siteRows =
            siteResult.rows ||
            siteResult;

        if (!siteRows.length) {
            throw new Error(
                'Receiving site not found.'
            );
        }

        const receivingSite =
            siteRows[0];

        if (receivingSite.status !== 'ACTIVE') {
            throw new Error(
                'The receiving site is inactive.'
            );
        }

        /*
         * Admin can receive into any active site.
         *
         * Other users must have an active assignment to
         * the receiving site.
         */
        if (userRole !== 'admin') {
            const accessResult = await tx.query(
                `
                SELECT 1
                FROM site_assignments sa
                JOIN sites s
                  ON s.id = sa.site_id
                WHERE sa.user_id = ?
                  AND sa.site_id = ?
                  AND sa.assigned_until IS NULL
                  AND s.status = 'ACTIVE'
                LIMIT 1
                `,
                [
                    performedBy,
                    grn.site_id
                ]
            );

            const accessRows =
                accessResult.rows ||
                accessResult;

            if (!accessRows.length) {
                throw new Error(
                    'You do not have permission to receive inventory into this site.'
                );
            }
        }

        /*
         * ---------------------------------------------------------
         * 4. Load all GRN lines
         * ---------------------------------------------------------
         */
        const linesResult = await tx.query(
            `
            SELECT
                grl.id,
                grl.goods_receipt_id,
                grl.purchase_order_line_id,
                grl.received_quantity,
                grl.item_condition,
                grl.unit,
                grl.notes,

                pol.purchase_order_id,
                pol.item_master_id,
                pol.ordered_quantity,
                pol.unit AS po_unit,

                im.item_code,
                im.name AS item_name,
                im.unit AS item_master_unit,
                im.instance_quantity,
                im.instance_quantity_unit,
                im.is_consumable,
                im.allows_partial_consumption,
                im.requires_instance_tracking,
                im.status AS item_master_status

            FROM goods_receipt_lines grl

            JOIN purchase_order_lines pol
              ON pol.id = grl.purchase_order_line_id

            JOIN item_masters im
              ON im.id = pol.item_master_id

            WHERE grl.goods_receipt_id = ?

            ORDER BY grl.id ASC
            `,
            [goodsReceiptId]
        );

        const lines =
            linesResult.rows ||
            linesResult;

        if (!lines.length) {
            throw new Error(
                'This Goods Receipt has no receipt lines.'
            );
        }

        /*
         * ---------------------------------------------------------
         * 5. Lock and validate every PO line
         * ---------------------------------------------------------
         */
        const lockedLines = [];

        for (const line of lines) {
            const poLineResult = await tx.query(
                `
                SELECT
                    pol.id,
                    pol.purchase_order_id,
                    pol.item_master_id,
                    pol.ordered_quantity,
                    pol.unit
                FROM purchase_order_lines pol
                WHERE pol.id = ?
                  AND pol.purchase_order_id = ?
                FOR UPDATE
                `,
                [
                    line.purchase_order_line_id,
                    grn.purchase_order_id
                ]
            );

            const poLineRows =
                poLineResult.rows ||
                poLineResult;

            if (!poLineRows.length) {
                throw new Error(
                    `Purchase Order line ${line.purchase_order_line_id} does not belong to Purchase Order ${purchaseOrder.po_number}.`
                );
            }

            const poLine =
                poLineRows[0];

            /*
             * GRN unit must match PO unit.
             */
            if (
                String(line.unit).trim().toLowerCase() !==
                String(poLine.unit).trim().toLowerCase()
            ) {
                throw new Error(
                    `Unit mismatch for ${line.item_code}. PO unit is ${poLine.unit}, but the GRN line uses ${line.unit}.`
                );
            }

            /*
             * PO physical unit must match Item Master
             * physical unit.
             */
            if (
                String(poLine.unit).trim().toLowerCase() !==
                String(line.item_master_unit).trim().toLowerCase()
            ) {
                throw new Error(
                    `Unit mismatch for ${line.item_code}. Purchase Order unit is ${poLine.unit}, but the Item Master physical unit is ${line.item_master_unit}.`
                );
            }

            /*
             * Item master must still be active.
             */
            if (
                ['GOOD', 'DAMAGED'].includes(line.item_condition) &&
                line.item_master_status !== 'ACTIVE'
            ) {
                throw new Error(
                    `Item ${line.item_code} is no longer active and cannot be received.`
                );
            }

            /*
             * Physical instance tracking is required for
             * the current Site-ERP inventory model.
             */
            if (
                ['GOOD', 'DAMAGED'].includes(line.item_condition) &&
                !line.requires_instance_tracking
            ) {
                throw new Error(
                    `Item ${line.item_code} is not configured for instance tracking.`
                );
            }

            const quantity =
                Number(line.received_quantity);

            if (
                !Number.isFinite(quantity) ||
                quantity <= 0
            ) {
                throw new Error(
                    `Invalid receipt quantity for ${line.item_code}.`
                );
            }

            /*
             * A GRN quantity is the number of physical units.
             *
             * Examples:
             *   5 BARREL
             *   6 BAG
             *   1 TANK
             *
             * Fractional physical units are not accepted.
             */
            if (!Number.isInteger(quantity)) {
                throw new Error(
                    `Receipt quantity for ${line.item_code} must be a whole number of physical units.`
                );
            }

            /*
             * Validate the Item Master instance quantity.
             */
            const instanceQuantity =
                Number(line.instance_quantity);

            const createsInstance = ['GOOD', 'DAMAGED'].includes(line.item_condition);
            if (createsInstance && (!Number.isFinite(instanceQuantity) || instanceQuantity <= 0)) {
                throw new Error(
                    `Item ${line.item_code} has an invalid quantity per instance.`
                );
            }

            if (createsInstance && !String(line.instance_quantity_unit || '').trim()) {
                throw new Error(
                    `Item ${line.item_code} has no quantity unit configured for its physical instances.`
                );
            }

            /*
             * Get only FINALIZED receipt quantity.
             *
             * The current GRN is still DRAFT, so it is not counted.
             */
            const alreadyReceived =
                await getReceivedQuantityForPurchaseOrderLine(
                    line.purchase_order_line_id,
                    tx
                );

            const orderedQuantity =
                Number(poLine.ordered_quantity);

            const remainingQuantity =
                orderedQuantity -
                alreadyReceived;

            if (
                ['GOOD', 'DAMAGED'].includes(line.item_condition) &&
                quantity > remainingQuantity
            ) {
                throw new Error(
                    `Receipt quantity for ${line.item_code} cannot exceed the remaining Purchase Order quantity. Remaining: ${remainingQuantity} ${poLine.unit}.`
                );
            }

            lockedLines.push({
                ...line,
                poLine,
                quantity,
                alreadyReceived,
                remainingQuantity
            });
        }

        /*
         * ---------------------------------------------------------
         * 6. Create physical inventory
         * ---------------------------------------------------------
         *
         * GRN quantity represents the number of physical units
         * received.
         *
         * Item Master instance_quantity represents the quantity
         * contained inside EACH physical instance.
         *
         * Examples:
         *
         *   6 BAG CEMENT-50KG
         *   -> 6 instances x 50 KG
         *
         *   5 BARREL OIL-20L
         *   -> 5 instances x 20 L
         *
         *   1 TANK GREASE-BULK
         *   -> 1 instance x 100 KG
         *
         * is_consumable does NOT determine instance count.
         * It determines whether the instance can later have
         * its quantity consumed.
         */
        const createdInstances = [];
        const labelsResult = await tx.query(
            `SELECT l.*, im.instance_quantity, im.instance_quantity_unit
             FROM inventory_receipt_labels l
             JOIN item_masters im ON im.id = l.item_master_id
             WHERE l.receipt_batch_id = ?
             ORDER BY l.id
             FOR UPDATE OF l`,
            [receiptBatch.id]
        );
        for (const label of (labelsResult.rows || labelsResult)) {
            const damaged = label.item_condition === 'DAMAGED';
            const instance = await tx.one(
                `INSERT INTO item_instances (
                    item_master_id, instance_code, barcode, brand,
                    original_quantity, current_quantity, unit, site_id,
                    lifecycle_status, condition, batch_number, serial_number,
                    manufacture_date, expiry_date, received_grn_id
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 RETURNING *`,
                [
                    label.item_master_id,
                    label.instance_code,
                    label.barcode,
                    label.brand,
                    label.instance_quantity,
                    label.instance_quantity,
                    label.instance_quantity_unit,
                    grn.site_id,
                    damaged ? 'QUARANTINED' : 'ACTIVE',
                    label.item_condition,
                    label.batch_number,
                    label.serial_number,
                    label.manufacture_date,
                    label.expiry_date,
                    grn.id
                ]
            );
            await tx.query(
                `INSERT INTO inventory_movements (
                    instance_id, movement_type, quantity, from_site_id,
                    to_site_id, reference_type, reference_id, reason, performed_by
                 ) VALUES (?, 'RECEIVE', ?, NULL, ?, 'GRN', ?, ?, ?)`,
                [
                    instance.id,
                    instance.original_quantity,
                    grn.site_id,
                    grn.grn_number,
                    damaged
                        ? `Damaged item received through GRN ${grn.grn_number}; quarantined`
                        : `Received through GRN ${grn.grn_number}`,
                    performedBy
                ]
            );
            createdInstances.push(instance);
        }

        /*
         * ---------------------------------------------------------
         * 7. Mark GRN as RECEIVED
         * ---------------------------------------------------------
         */
        const receivedResult = await tx.query(
            `
            UPDATE goods_receipts
            SET
                status = 'RECEIVED',
                received_at = now(),
                updated_at = now()
            WHERE id = ?
              AND status = 'AWAITING_BARCODE_SCAN'
            RETURNING
                id,
                grn_number,
                status,
                received_at
            `,
            [goodsReceiptId]
        );

        const receivedRows =
            receivedResult.rows ||
            receivedResult;

        if (!receivedRows.length) {
            throw new Error(
                'Goods Receipt could not be finalized.'
            );
        }

        await tx.query(
            `UPDATE inventory_receipt_batches
             SET status = 'COMPLETED', completed_by = ?, completed_at = now(), updated_at = now()
             WHERE id = ? AND status = 'AWAITING_SCAN'`,
            [performedBy, receiptBatch.id]
        );

        /*
         * ---------------------------------------------------------
         * 8. Recalculate Purchase Order status
         * ---------------------------------------------------------
         *
         * Only RECEIVED GRNs count here.
         */
        const poStatusResult = await tx.query(
            `
            SELECT
                COUNT(pol.id) AS line_count,

                COUNT(
                    CASE
                        WHEN COALESCE(
                            received.received_quantity,
                            0
                        ) >= pol.ordered_quantity
                        THEN 1
                    END
                ) AS fully_received_line_count,

                COUNT(
                    CASE
                        WHEN COALESCE(
                            received.received_quantity,
                            0
                        ) > 0
                        THEN 1
                    END
                ) AS started_line_count

            FROM purchase_order_lines pol

            LEFT JOIN (
                SELECT
                    grl.purchase_order_line_id,
                    SUM(grl.received_quantity)
                        AS received_quantity

                FROM goods_receipt_lines grl

                JOIN goods_receipts gr
                  ON gr.id = grl.goods_receipt_id

                WHERE gr.purchase_order_id = ?
                  AND gr.status = 'RECEIVED'
                  AND grl.item_condition IN ('GOOD', 'DAMAGED')

                GROUP BY
                    grl.purchase_order_line_id

            ) received
              ON received.purchase_order_line_id = pol.id

            WHERE pol.purchase_order_id = ?
            `,
            [
                purchaseOrder.id,
                purchaseOrder.id
            ]
        );

        const poStatusRows =
            poStatusResult.rows ||
            poStatusResult;

        const poStatus =
            poStatusRows[0];

        const lineCount =
            Number(
                poStatus.line_count || 0
            );

        const fullyReceivedLineCount =
            Number(
                poStatus.fully_received_line_count || 0
            );

        const startedLineCount =
            Number(
                poStatus.started_line_count || 0
            );

        let newPoStatus =
            purchaseOrder.status;

        if (
            lineCount > 0 &&
            fullyReceivedLineCount === lineCount
        ) {
            newPoStatus = 'COMPLETED';
        } else if (
            startedLineCount > 0
        ) {
            newPoStatus = 'PARTIALLY_RECEIVED';
        }

        if (
            newPoStatus !==
            purchaseOrder.status
        ) {
            await tx.query(
                `
                UPDATE purchase_orders
                SET
                    status = ?,
                    updated_at = now()
                WHERE id = ?
                `,
                [
                    newPoStatus,
                    purchaseOrder.id
                ]
            );
        }

        return {
            id: grn.id,

            grnNumber:
                grn.grn_number,

            purchaseOrderId:
                purchaseOrder.id,

            purchaseOrderNumber:
                purchaseOrder.po_number,

            previousPurchaseOrderStatus:
                purchaseOrder.status,

            purchaseOrderStatus:
                newPoStatus,

            siteId:
                grn.site_id,

            instancesCreated:
                createdInstances.length,

            instances:
                createdInstances.map(
                    instance => ({
                        id:
                            instance.id,

                        instanceCode:
                            instance.instance_code,

                        barcode:
                            instance.barcode,

                        itemMasterId:
                            instance.item_master_id,

                        quantity:
                            instance.original_quantity,

                        unit:
                            instance.unit
                    })
                ),

            receivedAt:
                receivedRows[0].received_at
        };
    });
}

/**
 * Cancel a DRAFT Goods Receipt.
 */
async function cancelGoodsReceipt(id) {
    const result =
        await db.query(
            `
            UPDATE goods_receipts

            SET
                status = 'CANCELLED',
                updated_at = now()

            WHERE id = ?
              AND status = 'DRAFT'

            RETURNING
                id,
                grn_number,
                status
            `,
            [id]
        );

    const rows =
        result.rows ||
        result;

    if (!rows.length) {
        throw new Error(
            'Goods Receipt was not found or cannot be cancelled.'
        );
    }

    return rows[0];
}

module.exports = {
    GRN_STATUSES,

    normalizeGrnNumber,
    normalizeQuantity,

    generateGrnNumber,

    listGoodsReceipts,
    getGoodsReceiptById,

    getPurchaseOrderLineForReceipt,
    getReceivedQuantityForPurchaseOrderLine,
    getReceivablePurchaseOrderLines,

    createGoodsReceipt,
    updateGoodsReceipt,

    addGoodsReceiptLine,
    deleteGoodsReceiptLine,

    prepareGoodsReceiptLabels,
    getGoodsReceiptLabelBatch,
    markGoodsReceiptLabelsPrinted,
    scanGoodsReceiptBarcode,

    confirmGoodsReceipt,
    cancelGoodsReceipt
};
