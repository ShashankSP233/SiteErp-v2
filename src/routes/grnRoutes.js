const express = require('express');

const db = require('../config/db');
const grnRepo = require('../repositories/grnRepo');
const poRepo = require('../repositories/poRepo');
const siteRepo = require('../repositories/siteRepo');

const { logAudit } = require('../repositories/auditRepo');

const {
    requireAuth,
    requireRole
} = require('../middleware/auth');

const router = express.Router();

const EDIT_ROLES = [
    'admin',
    'manager',
    'operator'
];


/*
 * ---------------------------------------------------------
 * SITE ACCESS
 * ---------------------------------------------------------
 */

async function getAccessibleSites(user) {

    const allSites =
        await siteRepo.listSites();

    if (user.role === 'admin') {

        return allSites.filter(
            site =>
                site.status === 'ACTIVE'
        );

    }

    const assignedSites =
        await siteRepo.listUserSites(
            user.id
        );

    return assignedSites.filter(
        site =>
            site.status === 'ACTIVE'
    );
}


function userCanAccessSite(
    sites,
    siteId
) {

    return sites.some(
        site =>
            String(site.id) ===
            String(siteId)
    );

}


/*
 * ---------------------------------------------------------
 * GOODS RECEIPT LIST
 * ---------------------------------------------------------
 */

router.get(
    '/goods-receipts',
    requireAuth,
    async (req, res, next) => {

        try {

            const user =
                req.session.user;

            const sites =
                await getAccessibleSites(
                    user
                );

            const accessibleSiteIds =
                sites.map(
                    site => site.id
                );


            /*
             * A supplied site filter must be accessible.
             */
            if (
                req.query.siteId &&
                !userCanAccessSite(
                    sites,
                    req.query.siteId
                )
            ) {

                return res
                    .status(403)
                    .render(
                        'errors/403',
                        {
                            title: 'Access denied'
                        }
                    );

            }


            const grns =
                await grnRepo.listGoodsReceipts({

                    status:
                        req.query.status ||
                        undefined,

                    siteId:
                        req.query.siteId ||
                        undefined,

                    purchaseOrderId:
                        req.query.purchaseOrderId ||
                        undefined,

                    siteIds:
                        accessibleSiteIds

                });


            return res.render(
                'goods-receipts/list',
                {
                    title:
                        'Goods Receipts',

                    grns,

                    sites,

                    filters: {

                        status:
                            req.query.status ||
                            '',

                        siteId:
                            req.query.siteId ||
                            '',

                        purchaseOrderId:
                            req.query.purchaseOrderId ||
                            ''

                    }

                }
            );

        } catch (err) {

            next(err);

        }

    }
);


/*
 * ---------------------------------------------------------
 * CREATE GRN
 * ---------------------------------------------------------
 */

router.get(
    '/goods-receipts/new',
    requireAuth,
    requireRole(
        'admin',
        'manager',
        'operator'
    ),
    async (req, res, next) => {

        try {

            const user =
                req.session.user;

            const {
                poId
            } = req.query;


            const sites =
                await getAccessibleSites(
                    user
                );

            const accessibleSiteIds =
                sites.map(
                    site => site.id
                );


            /*
             * -------------------------------------------------
             * STEP 1: PO selection
             * -------------------------------------------------
             */

            if (!poId) {

                const purchaseOrders =
                    await poRepo.listPurchaseOrders({
                        status: null,
                        siteId: null,
                        vendorId: null
                    });


                /*
                 * Only POs belonging to accessible sites
                 * and still receivable.
                 *
                 * DRAFT is intentionally excluded.
                 */
                const receivablePurchaseOrders =
                    purchaseOrders.filter(
                        po =>

                            accessibleSiteIds.includes(
                                po.site_id
                            ) &&

                            [
                                'SENT',
                                'PARTIALLY_RECEIVED'
                            ].includes(
                                String(
                                    po.status
                                ).toUpperCase()
                            )
                    );


                return res.render(
                    'goods-receipts/select-po',
                    {
                        title:
                            'Select Purchase Order',

                        purchaseOrders:
                            receivablePurchaseOrders
                    }
                );

            }


            /*
             * -------------------------------------------------
             * STEP 2: Load selected PO
             * -------------------------------------------------
             */

            const purchaseOrder =
                await poRepo.getPurchaseOrderById(
                    poId
                );


            if (!purchaseOrder) {

                req.session.error =
                    'Purchase Order not found.';

                return res.redirect(
                    '/goods-receipts/new'
                );

            }


            /*
             * Selected PO must belong to a site
             * the current user can access.
             */
            if (
                !userCanAccessSite(
                    sites,
                    purchaseOrder.site_id
                )
            ) {

                return res
                    .status(403)
                    .render(
                        'errors/403',
                        {
                            title:
                                'Access denied'
                        }
                    );

            }


            /*
             * Only SENT and PARTIALLY_RECEIVED POs
             * can receive goods.
             */
            if (
                ![
                    'SENT',
                    'PARTIALLY_RECEIVED'
                ].includes(
                    String(
                        purchaseOrder.status
                    ).toUpperCase()
                )
            ) {

                req.session.error =
                    'Only SENT or PARTIALLY_RECEIVED Purchase Orders can receive goods.';

                return res.redirect(
                    '/goods-receipts/new'
                );

            }


            const receivableLines =
                await grnRepo
                    .getReceivablePurchaseOrderLines(
                        purchaseOrder.id
                    );


            if (!receivableLines.length) {

                req.session.error =
                    'This Purchase Order has no remaining quantity to receive.';

                return res.redirect(
                    `/purchase-orders/${purchaseOrder.id}`
                );

            }


            /*
             * GRNs are received into the PO site.
             */
            const selectedSiteId =
                purchaseOrder.site_id;


            return res.render(
                'goods-receipts/form',
                {

                    title:
                        'Create Goods Receipt',

                    goodsReceipt:
                        null,

                    grn:
                        null,

                    purchaseOrder,

                    selectedPo:
                        purchaseOrder,

                    receivableLines,

                    sites,

                    selectedSiteId

                }
            );

        } catch (err) {

            next(err);

        }

    }
);


/*
 * ---------------------------------------------------------
 * CREATE DRAFT GRN
 * ---------------------------------------------------------
 */

router.post(
    '/goods-receipts',
    requireAuth,
    requireRole(
        'admin',
        'manager',
        'operator'
    ),
    async (req, res) => {

        try {

            const user =
                req.session.user;


            const {
                purchaseOrderId,
                siteId,
                deliveryReference,
                deliveryDate,
                notes
            } = req.body;


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


            const sites =
                await getAccessibleSites(
                    user
                );


            if (
                !userCanAccessSite(
                    sites,
                    siteId
                )
            ) {

                throw new Error(
                    'You are not authorized to receive inventory at the selected site.'
                );

            }


            const purchaseOrder =
                await poRepo.getPurchaseOrderById(
                    purchaseOrderId
                );


            if (!purchaseOrder) {

                throw new Error(
                    'Purchase Order not found.'
                );

            }


            /*
             * Receiving site must be the PO site.
             */
            if (
                String(siteId) !==
                String(purchaseOrder.site_id)
            ) {

                throw new Error(
                    'Goods must be received into the Purchase Order site.'
                );

            }


            if (
                ![
                    'SENT',
                    'PARTIALLY_RECEIVED'
                ].includes(
                    String(
                        purchaseOrder.status
                    ).toUpperCase()
                )
            ) {

                throw new Error(
                    'Only SENT or PARTIALLY_RECEIVED Purchase Orders can receive goods.'
                );

            }


            /*
             * Form structure:
             *
             * receivedQuantity[line_12] = 5
             * receivedQuantity[line_13] = 2
             */
            const receivedQuantities =
                req.body.receivedQuantity ||
                {};

            const lineNotes =
                req.body.lineNotes ||
                {};


            const lines =
                Object.entries(
                    receivedQuantities
                )
                    .map(
                        ([
                            fieldName,
                            receivedQuantity
                        ]) => {

                            const purchaseOrderLineId =
                                String(
                                    fieldName
                                )
                                    .replace(
                                        /^line_/,
                                        ''
                                    );


                            return {

                                purchaseOrderLineId,

                                receivedQuantity,

                                notes:
                                    lineNotes[
                                        fieldName
                                    ] || ''

                            };

                        }
                    )
                    .filter(
                        line => {

                            const value =
                                String(
                                    line.receivedQuantity
                                ).trim();

                            return (
                                value !== '' &&
                                Number(value) > 0
                            );

                        }
                    );


            if (lines.length === 0) {

                throw new Error(
                    'Enter a quantity for at least one Purchase Order item.'
                );

            }


            /*
             * Repository performs the authoritative
             * physical-unit validation.
             */
            const result =
                await grnRepo.createGoodsReceipt({

                    purchaseOrderId,

                    siteId,

                    deliveryReference,

                    deliveryDate,

                    notes,

                    receivedBy:
                        user.id,

                    lines

                });


            await logAudit({

                userId:
                    user.id,

                action:
                    'CREATE_GOODS_RECEIPT',

                entity:
                    'goods_receipts',

                entityId:
                    result.id,

                details: {

                    grnNumber:
                        result.grnNumber,

                    purchaseOrderId,

                    siteId,

                    lineCount:
                        result.lineCount

                },

                ip:
                    req.ip,

                userAgent:
                    req.get(
                        'user-agent'
                    )

            });


            req.session.success =
                `Goods Receipt ${result.grnNumber} created as draft.`;


            return res.redirect(
                `/goods-receipts/${result.id}/edit`
            );

        } catch (err) {

            req.session.error =
                err.message;


            const poId =
                req.body.purchaseOrderId;


            if (poId) {

                return res.redirect(
                    `/goods-receipts/new?poId=${encodeURIComponent(
                        poId
                    )}`
                );

            }


            return res.redirect(
                '/goods-receipts/new'
            );

        }

    }
);


/*
 * ---------------------------------------------------------
 * CONFIRM GRN
 * ---------------------------------------------------------
 */

router.post(
    '/goods-receipts/:id/receive',
    requireAuth,
    requireRole(
        'admin',
        'manager',
        'operator'
    ),
    async (req, res) => {

        const grnId =
            req.params.id;

        const userId =
            req.session.user.id;


        try {

            const result =
                await grnRepo.confirmGoodsReceipt({

                    goodsReceiptId:
                        grnId,

                    performedBy:
                        userId,

                    userRole:
                        req.session.user.role

                });


            await logAudit({

                userId,

                action:
                    'CONFIRM_GOODS_RECEIPT',

                entity:
                    'goods_receipts',

                entityId:
                    grnId,

                details: {

                    grnNumber:
                        result.grnNumber,

                    purchaseOrderId:
                        result.purchaseOrderId,

                    siteId:
                        result.siteId,

                    instancesCreated:
                        result.instancesCreated

                },

                ip:
                    req.ip,

                userAgent:
                    req.get(
                        'user-agent'
                    )

            });


            req.session.success =
                `Goods Receipt ${result.grnNumber} confirmed successfully.`;


            return res.redirect(
                `/goods-receipts/${grnId}`
            );

        } catch (err) {

            console.error(
                `[GRN RECEIVE] Failed to confirm GRN ${grnId}:`,
                err
            );


            req.session.error =
                err.userMessage ||
                err.message ||
                'Unable to confirm the Goods Receipt.';


            return res.redirect(
                `/goods-receipts/${grnId}`
            );

        }

    }
);


/*
 * ---------------------------------------------------------
 * GRN DETAIL
 * ---------------------------------------------------------
 */

router.get(
    '/goods-receipts/:id',
    requireAuth,
    async (req, res, next) => {

        try {

            const grn =
                await grnRepo.getGoodsReceiptById(
                    req.params.id
                );


            if (!grn) {

                return res
                    .status(404)
                    .render(
                        'errors/404',
                        {
                            title:
                                'Goods receipt not found'
                        }
                    );

            }


            const sites =
                await getAccessibleSites(
                    req.session.user
                );


            if (
                !userCanAccessSite(
                    sites,
                    grn.site_id
                )
            ) {

                return res
                    .status(403)
                    .render(
                        'errors/403',
                        {
                            title:
                                'Access denied'
                        }
                    );

            }


            return res.render(
                'goods-receipts/detail',
                {

                    title:
                        `GRN ${grn.grn_number}`,

                    grn

                }
            );

        } catch (err) {

            next(err);

        }

    }
);


/*
 * ---------------------------------------------------------
 * EDIT GRN
 * ---------------------------------------------------------
 */

router.get(
    '/goods-receipts/:id/edit',
    requireAuth,
    requireRole(...EDIT_ROLES),
    async (req, res, next) => {

        try {

            const grn =
                await grnRepo.getGoodsReceiptById(
                    req.params.id
                );


            if (!grn) {

                return res
                    .status(404)
                    .render(
                        'errors/404',
                        {
                            title:
                                'Goods receipt not found'
                        }
                    );

            }


            if (grn.status !== 'DRAFT') {

                req.session.error =
                    'Only draft GRNs can be edited.';

                return res.redirect(
                    `/goods-receipts/${grn.id}`
                );

            }


            const sites =
                await getAccessibleSites(
                    req.session.user
                );


            if (
                !userCanAccessSite(
                    sites,
                    grn.site_id
                )
            ) {

                return res
                    .status(403)
                    .render(
                        'errors/403',
                        {
                            title:
                                'Access denied'
                        }
                    );

            }


            const selectedPo =
                await poRepo.getPurchaseOrderById(
                    grn.purchase_order_id
                );


            if (!selectedPo) {

                throw new Error(
                    'Purchase Order linked to this GRN was not found.'
                );

            }


            const receivableLines =
                await grnRepo
                    .getReceivablePurchaseOrderLines(
                        grn.purchase_order_id
                    );


            return res.render(
                'goods-receipts/form',
                {

                    title:
                        `Edit GRN ${grn.grn_number}`,

                    goodsReceipt:
                        grn,

                    grn,

                    purchaseOrder:
                        selectedPo,

                    selectedPo,

                    sites,

                    selectedSiteId:
                        grn.site_id,

                    receivableLines

                }
            );

        } catch (err) {

            next(err);

        }

    }
);


/*
 * ---------------------------------------------------------
 * UPDATE GRN HEADER
 * ---------------------------------------------------------
 */

router.post(
    '/goods-receipts/:id',
    requireAuth,
    requireRole(...EDIT_ROLES),
    async (req, res) => {

        try {

            const grn =
                await grnRepo.getGoodsReceiptById(
                    req.params.id
                );


            if (!grn) {

                throw new Error(
                    'Goods Receipt not found.'
                );

            }


            if (grn.status !== 'DRAFT') {

                throw new Error(
                    'Only draft GRNs can be edited.'
                );

            }


            const sites =
                await getAccessibleSites(
                    req.session.user
                );


            const {
                siteId,
                deliveryReference,
                deliveryDate,
                notes
            } = req.body;


            if (
                !userCanAccessSite(
                    sites,
                    siteId
                )
            ) {

                throw new Error(
                    'You do not have access to the selected site.'
                );

            }


            /*
             * GRN receiving site must remain the PO site.
             */
            if (
                String(siteId) !==
                String(grn.site_id)
            ) {

                throw new Error(
                    'The receiving site cannot be changed from the original GRN site.'
                );

            }


            await grnRepo.updateGoodsReceipt({

                id:
                    req.params.id,

                siteId,

                deliveryReference,

                deliveryDate,

                notes

            });


            await logAudit({

                userId:
                    req.session.user.id,

                action:
                    'UPDATE_GOODS_RECEIPT',

                entity:
                    'goods_receipts',

                entityId:
                    req.params.id,

                details: {

                    siteId,

                    deliveryReference,

                    deliveryDate

                },

                ip:
                    req.ip,

                userAgent:
                    req.get(
                        'user-agent'
                    )

            });


            req.session.success =
                'Goods Receipt updated successfully.';


            return res.redirect(
                `/goods-receipts/${req.params.id}/edit`
            );

        } catch (err) {

            req.session.error =
                err.message;


            return res.redirect(
                `/goods-receipts/${req.params.id}/edit`
            );

        }

    }
);


/*
 * ---------------------------------------------------------
 * ADD / UPDATE GRN LINE
 * ---------------------------------------------------------
 */

router.post(
    '/goods-receipts/:id/lines',
    requireAuth,
    requireRole(...EDIT_ROLES),
    async (req, res) => {

        try {

            const {
                purchaseOrderLineId,
                receivedQuantity,
                notes
            } = req.body;


            if (!purchaseOrderLineId) {

                throw new Error(
                    'Purchase Order line is required.'
                );

            }


            const line =
                await grnRepo.addGoodsReceiptLine({

                    goodsReceiptId:
                        req.params.id,

                    purchaseOrderLineId,

                    receivedQuantity,

                    notes

                });


            await logAudit({

                userId:
                    req.session.user.id,

                action:
                    'SAVE_GOODS_RECEIPT_LINE',

                entity:
                    'goods_receipt_lines',

                entityId:
                    line.id,

                details: {

                    goodsReceiptId:
                        req.params.id,

                    purchaseOrderLineId,

                    receivedQuantity

                },

                ip:
                    req.ip,

                userAgent:
                    req.get(
                        'user-agent'
                    )

            });


            req.session.success =
                'Receipt line saved.';


            return res.redirect(
                `/goods-receipts/${req.params.id}/edit`
            );

        } catch (err) {

            req.session.error =
                err.message;


            return res.redirect(
                `/goods-receipts/${req.params.id}/edit`
            );

        }

    }
);


/*
 * ---------------------------------------------------------
 * DELETE GRN LINE
 * ---------------------------------------------------------
 */

router.post(
    '/goods-receipts/:id/lines/:lineId/delete',
    requireAuth,
    requireRole(...EDIT_ROLES),
    async (req, res) => {

        try {

            await grnRepo.deleteGoodsReceiptLine(
                req.params.id,
                req.params.lineId
            );


            await logAudit({

                userId:
                    req.session.user.id,

                action:
                    'DELETE_GOODS_RECEIPT_LINE',

                entity:
                    'goods_receipt_lines',

                entityId:
                    req.params.lineId,

                details: {

                    goodsReceiptId:
                        req.params.id

                },

                ip:
                    req.ip,

                userAgent:
                    req.get(
                        'user-agent'
                    )

            });


            req.session.success =
                'Receipt line removed.';


            return res.redirect(
                `/goods-receipts/${req.params.id}/edit`
            );

        } catch (err) {

            req.session.error =
                err.message;


            return res.redirect(
                `/goods-receipts/${req.params.id}/edit`
            );

        }

    }
);


/*
 * ---------------------------------------------------------
 * CANCEL GRN
 * ---------------------------------------------------------
 */

router.post(
    '/goods-receipts/:id/cancel',
    requireAuth,
    requireRole(...EDIT_ROLES),
    async (req, res) => {

        try {

            const grn =
                await grnRepo.getGoodsReceiptById(
                    req.params.id
                );


            if (!grn) {

                throw new Error(
                    'Goods Receipt not found.'
                );

            }


            const sites =
                await getAccessibleSites(
                    req.session.user
                );


            if (
                !userCanAccessSite(
                    sites,
                    grn.site_id
                )
            ) {

                return res
                    .status(403)
                    .render(
                        'errors/403',
                        {
                            title:
                                'Access denied'
                        }
                    );

            }


            const result =
                await grnRepo.cancelGoodsReceipt(
                    req.params.id
                );


            await logAudit({

                userId:
                    req.session.user.id,

                action:
                    'CANCEL_GOODS_RECEIPT',

                entity:
                    'goods_receipts',

                entityId:
                    req.params.id,

                details: {

                    grnNumber:
                        result.grn_number

                },

                ip:
                    req.ip,

                userAgent:
                    req.get(
                        'user-agent'
                    )

            });


            req.session.success =
                'Goods Receipt cancelled.';


            return res.redirect(
                '/goods-receipts'
            );

        } catch (err) {

            req.session.error =
                err.message;


            return res.redirect(
                `/goods-receipts/${req.params.id}`
            );

        }

    }
);


module.exports = router;