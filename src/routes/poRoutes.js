const express = require('express');

const db = require('../config/db');
const poRepo = require('../repositories/poRepo');
const vendorRepo = require('../repositories/vendorRepo');
const siteRepo = require('../repositories/siteRepo');
const { logAudit } = require('../repositories/auditRepo');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const MANAGE_ROLES = ['admin', 'manager'];

async function getActiveItems() {
    const result = await db.query(`
        SELECT
            id,
            item_code,
            name,
            unit,
            instance_quantity,
            instance_quantity_unit
        FROM item_masters
        WHERE status = 'ACTIVE'
        ORDER BY item_code ASC
    `);

    return result.rows;
}

function asArray(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

function parseLines(body) {
    const itemMasterIds = asArray(body.lineItemMasterId);
    const quantities = asArray(body.lineQuantity);
    const units = asArray(body.lineUnit);
    const notes = asArray(body.lineNotes);

    const lines = [];

    for (let i = 0; i < itemMasterIds.length; i++) {
        const itemMasterId = String(itemMasterIds[i] || '').trim();
        const quantity = String(quantities[i] || '').trim();
        const unit = String(units[i] || '').trim();
        const note = String(notes[i] || '').trim();

        if (!itemMasterId && !quantity && !unit) continue;

        if (!itemMasterId || !quantity || !unit) {
            throw new Error(`PO line ${i + 1} is incomplete.`);
        }

        lines.push({
            itemMasterId,
            orderedQuantity: quantity,
            unit,
            notes: note || null
        });
    }

    if (lines.length === 0) {
        throw new Error('At least one PO item is required.');
    }

    return lines;
}


/*
 * PURCHASE ORDER LIST
 */
router.get(
    '/purchase-orders',
    requireAuth,
    async (req, res, next) => {
        try {
            const purchaseOrders = await poRepo.listPurchaseOrders({
                status: req.query.status || null,
                siteId: req.query.siteId || null,
                vendorId: req.query.vendorId || null
            });

            const sites = await siteRepo.listSites();
            const vendors = await vendorRepo.listVendors();

            res.render('purchase-orders/list', {
                title: 'Purchase Orders',
                purchaseOrders,
                sites,
                vendors,
                filters: {
                    status: req.query.status || '',
                    siteId: req.query.siteId || '',
                    vendorId: req.query.vendorId || ''
                }
            });
        } catch (err) {
            next(err);
        }
    }
);


/*
 * CREATE PURCHASE ORDER FORM
 */
router.get(
    '/purchase-orders/new',
    requireAuth,
    requireRole(...MANAGE_ROLES),
    async (req, res, next) => {
        try {
            const [vendors, sites, items] = await Promise.all([
                vendorRepo.listVendors(),
                siteRepo.listSites(),
                getActiveItems()
            ]);

            res.render('purchase-orders/form', {
                title: 'Create Purchase Order',
                purchaseOrder: null,
                vendors,
                sites,
                items
            });
        } catch (err) {
            next(err);
        }
    }
);


/*
 * CREATE PURCHASE ORDER
 */
router.post(
    '/purchase-orders',
    requireAuth,
    requireRole(...MANAGE_ROLES),
    async (req, res) => {
        try {
            const lines = parseLines(req.body);

            const purchaseOrder = await poRepo.createPurchaseOrder({
                poNumber: req.body.poNumber,
                vendorId: req.body.vendorId,
                poDate: req.body.poDate,
                siteId: req.body.siteId,
                expectedDeliveryDate:
                    req.body.expectedDeliveryDate || null,
                referenceText:
                    req.body.referenceText || null,
                notes:
                    req.body.notes || null,
                createdBy: req.session.user.id
            });

            for (const line of lines) {
                await poRepo.addPurchaseOrderLine({
                    purchaseOrderId: purchaseOrder.id,
                    itemMasterId: line.itemMasterId,
                    orderedQuantity: line.orderedQuantity,
                    unit: line.unit,
                    notes: line.notes
                });
            }

            await logAudit({
                userId: req.session.user.id,
                action: 'CREATE_PURCHASE_ORDER',
                entity: 'purchase_orders',
                entityId: purchaseOrder.id,
                details: {
                    poNumber: purchaseOrder.po_number,
                    lineCount: lines.length
                },
                ip: req.ip,
                userAgent: req.get('user-agent')
            });

            req.session.success = `Purchase Order ${purchaseOrder.po_number} created.`;

            res.redirect(`/purchase-orders/${purchaseOrder.id}`);
        } catch (err) {
            req.session.error = err.message;
            res.redirect('/purchase-orders/new');
        }
    }
);


/*
 * PURCHASE ORDER DETAIL
 */
router.get(
    '/purchase-orders/:id',
    requireAuth,
    async (req, res, next) => {
        try {
            const purchaseOrder = await poRepo.getPurchaseOrderById(
                req.params.id
            );

            if (!purchaseOrder) {
                return res.status(404).render('errors/404', {
                    title: 'Purchase Order Not Found'
                });
            }

            res.render('purchase-orders/detail', {
                title: `PO ${purchaseOrder.po_number}`,
                purchaseOrder
            });
        } catch (err) {
            next(err);
        }
    }
);


/*
 * EDIT PURCHASE ORDER FORM
 */
router.get(
    '/purchase-orders/:id/edit',
    requireAuth,
    requireRole(...MANAGE_ROLES),
    async (req, res, next) => {
        try {
            const purchaseOrder = await poRepo.getPurchaseOrderById(
                req.params.id
            );

            if (!purchaseOrder) {
                return res.status(404).render('errors/404', {
                    title: 'Purchase Order Not Found'
                });
            }

            if (purchaseOrder.status !== 'DRAFT') {
                req.session.error =
                    'Only draft Purchase Orders can be edited.';

                return res.redirect(
                    `/purchase-orders/${purchaseOrder.id}`
                );
            }

            const [vendors, sites, items] = await Promise.all([
                vendorRepo.listVendors(),
                siteRepo.listSites(),
                getActiveItems()
            ]);

            res.render('purchase-orders/form', {
                title: `Edit PO ${purchaseOrder.po_number}`,
                purchaseOrder,
                vendors,
                sites,
                items
            });
        } catch (err) {
            next(err);
        }
    }
);


/*
 * UPDATE PURCHASE ORDER HEADER
 */
router.post(
    '/purchase-orders/:id',
    requireAuth,
    requireRole(...MANAGE_ROLES),
    async (req, res) => {
        try {
            const existing = await poRepo.getPurchaseOrderById(
                req.params.id
            );

            if (!existing) {
                req.session.error = 'Purchase Order not found.';
                return res.redirect('/purchase-orders');
            }

            if (existing.status !== 'DRAFT') {
                req.session.error =
                    'Only draft Purchase Orders can be edited.';

                return res.redirect(
                    `/purchase-orders/${existing.id}`
                );
            }

            await poRepo.updatePurchaseOrder(req.params.id, {
                poNumber: req.body.poNumber,
                vendorId: req.body.vendorId,
                poDate: req.body.poDate,
                siteId: req.body.siteId,
                expectedDeliveryDate:
                    req.body.expectedDeliveryDate || null,
                referenceText:
                    req.body.referenceText || null,
                notes:
                    req.body.notes || null
            });

            /*
             * Rebuild draft lines.
             * This is safe because the PO is still DRAFT.
             */
            for (const line of existing.lines) {
                await poRepo.deletePurchaseOrderLine(line.id);
            }

            const lines = parseLines(req.body);

            for (const line of lines) {
                await poRepo.addPurchaseOrderLine({
                    purchaseOrderId: req.params.id,
                    itemMasterId: line.itemMasterId,
                    orderedQuantity: line.orderedQuantity,
                    unit: line.unit,
                    notes: line.notes
                });
            }

            await logAudit({
                userId: req.session.user.id,
                action: 'UPDATE_PURCHASE_ORDER',
                entity: 'purchase_orders',
                entityId: req.params.id,
                details: {
                    poNumber: req.body.poNumber,
                    lineCount: lines.length
                },
                ip: req.ip,
                userAgent: req.get('user-agent')
            });

            req.session.success = 'Purchase Order updated.';

            res.redirect(`/purchase-orders/${req.params.id}`);
        } catch (err) {
            req.session.error = err.message;

            res.redirect(
                `/purchase-orders/${req.params.id}/edit`
            );
        }
    }
);


/*
 * CHANGE PO STATUS
 */
router.post(
    '/purchase-orders/:id/status',
    requireAuth,
    requireRole(...MANAGE_ROLES),
    async (req, res) => {
        try {
            const purchaseOrder = await poRepo.getPurchaseOrderById(
                req.params.id
            );

            if (!purchaseOrder) {
                req.session.error = 'Purchase Order not found.';
                return res.redirect('/purchase-orders');
            }

            const newStatus = String(req.body.status || '').trim();

            if (!poRepo.PO_STATUSES.includes(newStatus)) {
                throw new Error('Invalid Purchase Order status.');
            }

            if (
                newStatus !== 'CANCELLED' &&
                (!purchaseOrder.lines ||
                    purchaseOrder.lines.length === 0)
            ) {
                throw new Error(
                    'A Purchase Order must contain at least one item.'
                );
            }

            await poRepo.setPurchaseOrderStatus(
                req.params.id,
                newStatus
            );

            await logAudit({
                userId: req.session.user.id,
                action: 'CHANGE_PURCHASE_ORDER_STATUS',
                entity: 'purchase_orders',
                entityId: req.params.id,
                details: {
                    from: purchaseOrder.status,
                    to: newStatus,
                    poNumber: purchaseOrder.po_number
                },
                ip: req.ip,
                userAgent: req.get('user-agent')
            });

            req.session.success =
                `Purchase Order status changed to ${newStatus}.`;

            res.redirect(`/purchase-orders/${req.params.id}`);
        } catch (err) {
            req.session.error = err.message;
            res.redirect(`/purchase-orders/${req.params.id}`);
        }
    }
);


module.exports = router;