const express = require('express');

const {
    listStockTransfersForUser
} = require('../repositories/stockTransferListRepo');

const { requireAuth } = require('../middleware/auth');

const router = express.Router();


/*
 * ============================================================
 * TRANSFER REGISTER
 * ============================================================
 *
 * Shows all stock transfers accessible to the logged-in user.
 *
 * Filters:
 *   - Transfer Number
 *   - From Site
 *   - To Site
 *   - Status
 *   - Date From
 *   - Date To
 */
router.get(
    '/inventory/transfer-register',
    requireAuth,
    async (req, res, next) => {
        try {
            const filters = {
                transferNumber:
                    String(req.query.transferNumber || '').trim(),

                fromSiteId:
                    String(req.query.fromSiteId || '').trim(),

                toSiteId:
                    String(req.query.toSiteId || '').trim(),

                status:
                    String(req.query.status || '').trim(),

                dateFrom:
                    String(req.query.dateFrom || '').trim(),

                dateTo:
                    String(req.query.dateTo || '').trim()
            };

            const transfers =
                await listStockTransfersForUser(
                    req.session.user,
                    filters
                );

            res.render(
                'inventory/transfer-register',
                {
                    title: 'Transfer Register',
                    transfers,
                    filters
                }
            );
        } catch (error) {
            next(error);
        }
    }
);


module.exports = router;