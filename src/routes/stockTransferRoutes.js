const express = require('express');

const {
  getTransferSourceSites,
  getTransferDestinationSites,
  createTransfer,
  addTransferItem,
  listTransfersForUser,
  getTransferForUser,
  dispatchTransfer,
  receiveTransferItems,
  receiveTransferItemByScan
} = require('../repositories/stockTransferRepo');

const {
  requireAuth,
  requireRole
} = require('../middleware/auth');

const {
  logAudit
} = require('../repositories/auditRepo');

const router = express.Router();

const TRANSFER_ROLES = [
  'admin',
  'manager',
  'operator'
];


/*
 * Transfer list.
 */
router.get(
  '/inventory/transfers',
  requireAuth,
  async (req, res, next) => {

    try {

      const transfers =
        await listTransfersForUser(
          req.session.user
        );

      res.render(
        'inventory/transfers',
        {
          title: 'Stock Transfers',
          transfers
        }
      );

    } catch (error) {
      next(error);
    }
  }
);


/*
 * New transfer form.
 */
router.get(
  '/inventory/transfers/new',
  requireAuth,
  requireRole(...TRANSFER_ROLES),
  async (req, res, next) => {

    try {

      const [
        sourceSites,
        destinationSites
      ] = await Promise.all([
        getTransferSourceSites(
          req.session.user
        ),
        getTransferDestinationSites()
      ]);

      res.render(
        'inventory/transfer-new',
        {
          title: 'Create Stock Transfer',
          sourceSites,
          destinationSites,
          form: {},
          error: null
        }
      );

    } catch (error) {
      next(error);
    }
  }
);


/*
 * Create transfer.
 */
router.post(
  '/inventory/transfers',
  requireAuth,
  requireRole(...TRANSFER_ROLES),
  async (req, res) => {

    try {

      const result =
        await createTransfer({
          fromSiteId:
            req.body.fromSiteId,

          toSiteId:
            req.body.toSiteId,

          notes:
            req.body.notes,

          user:
            req.session.user
        });

      await logAudit({
        userId:
          req.session.user.id,

        action:
          'CREATE_STOCK_TRANSFER',

        entity:
          'stock_transfer',

        entityId:
          result.transfer.id,

        details: {
          transferNumber:
            result.transfer.transfer_number,

          fromSite:
            result.source.code,

          toSite:
            result.destination.code
        },

        ip: req.ip,

        userAgent:
          req.get('user-agent')
      });

      req.session.success =
        `Stock transfer ${result.transfer.transfer_number} created.`;

      res.redirect(
        `/inventory/transfers/${result.transfer.id}`
      );

    } catch (error) {

      console.error(
        'Failed to create stock transfer:',
        error
      );

      req.session.error =
        error.message ||
        'Failed to create stock transfer.';

      res.redirect(
        '/inventory/transfers/new'
      );
    }
  }
);


/*
 * Transfer detail.
 */
router.get(
  '/inventory/transfers/:id',
  requireAuth,
  async (req, res, next) => {

    try {

      const result =
        await getTransferForUser(
          req.params.id,
          req.session.user
        );

      if (!result) {
        return res.status(404).render(
          'errors/404',
          {
            title:
              'Stock transfer not found'
          }
        );
      }

      res.render(
        'inventory/transfer',
        {
          title:
            result.transfer.transfer_number,

          transfer:
            result.transfer,

          items:
            result.items
        }
      );

    } catch (error) {
      next(error);
    }
  }
);


/*
 * Add physical instance to draft transfer.
 */
router.post(
  '/inventory/transfers/:id/items',
  requireAuth,
  requireRole(...TRANSFER_ROLES),
  async (req, res) => {

    try {

      const result =
        await addTransferItem({
          transferId:
            req.params.id,

          instanceCode:
            req.body.instanceCode,

          user:
            req.session.user
        });

      req.session.success =
        `Added ${result.instance.instance_code} to ${result.transfer.transfer_number}.`;

      res.redirect(
        `/inventory/transfers/${result.transfer.id}`
      );

    } catch (error) {

      console.error(
        'Failed to add transfer item:',
        error
      );

      req.session.error =
        error.message ||
        'Failed to add inventory instance to transfer.';

      res.redirect(
        `/inventory/transfers/${req.params.id}`
      );
    }
  }
);


/*
 * Dispatch transfer.
 */
router.post(
  '/inventory/transfers/:id/dispatch',
  requireAuth,
  requireRole(...TRANSFER_ROLES),
  async (req, res) => {

    try {

      const transfer =
        await dispatchTransfer({
          transferId:
            req.params.id,

          user:
            req.session.user
        });

      await logAudit({
        userId:
          req.session.user.id,

        action:
          'DISPATCH_STOCK_TRANSFER',

        entity:
          'stock_transfer',

        entityId:
          transfer.id,

        details: {
          transferNumber:
            transfer.transfer_number
        },

        ip: req.ip,

        userAgent:
          req.get('user-agent')
      });

      req.session.success =
        `${transfer.transfer_number} dispatched. Inventory is now in transit.`;

      res.redirect(
        `/inventory/transfers/${transfer.id}`
      );

    } catch (error) {

      console.error(
        'Failed to dispatch stock transfer:',
        error
      );

      req.session.error =
        error.message ||
        'Failed to dispatch stock transfer.';

      res.redirect(
        `/inventory/transfers/${req.params.id}`
      );
    }
  }
);


/*
 * Stock Inward.
 *
 * itemIds can be one ID or an array of IDs.
 */
router.post(
  '/inventory/transfers/:id/receive',
  requireAuth,
  requireRole(...TRANSFER_ROLES),
  async (req, res) => {

    try {

      const itemIds =
        req.body.itemIds || [];

      const result =
        await receiveTransferItems({
          transferId:
            req.params.id,

          itemIds,

          user:
            req.session.user
        });

      await logAudit({
        userId:
          req.session.user.id,

        action:
          'RECEIVE_STOCK_TRANSFER',

        entity:
          'stock_transfer',

        entityId:
          result.transfer.id,

        details: {
          transferNumber:
            result.transfer.transfer_number,

          receivedInstances:
            result.received.map(
              item =>
                item.instance_code
            )
        },

        ip: req.ip,

        userAgent:
          req.get('user-agent')
      });

      req.session.success =
        `${result.received.length} inventory instance(s) received.`;

      res.redirect(
        `/inventory/transfers/${result.transfer.id}`
      );

    } catch (error) {

      console.error(
        'Failed to receive stock transfer:',
        error
      );

      req.session.error =
        error.message ||
        'Failed to receive stock transfer.';

      res.redirect(
        `/inventory/transfers/${req.params.id}`
      );
    }
  }
);

router.post(
  '/inventory/transfers/:id/receive-scan',
  requireAuth,
  requireRole(...TRANSFER_ROLES),
  async (req, res) => {

    try {

      const result =
        await receiveTransferItemByScan({
          transferId:
            req.params.id,

          scannedCode:
            req.body.scannedCode,

          user:
            req.session.user
        });

      await logAudit({
        userId:
          req.session.user.id,

        action:
          'RECEIVE_STOCK_TRANSFER_ITEM',

        entity:
          'stock_transfer',

        entityId:
          result.transfer.id,

        details: {
          transferNumber:
            result.transfer.transfer_number,

          instanceCode:
            result.instance.instance_code,

          barcode:
            result.instance.barcode
        },

        ip:
          req.ip,

        userAgent:
          req.get('user-agent')
      });

      req.session.success =
        `${result.instance.instance_code} received successfully.`;

      res.redirect(
        `/inventory/transfers/${result.transfer.id}`
      );

    } catch (error) {

      console.error(
        'Failed to receive scanned transfer item:',
        error
      );

      req.session.error =
        error.message ||
        'Failed to receive inventory instance.';

      res.redirect(
        `/inventory/transfers/${req.params.id}`
      );
    }
  }
);


module.exports = router;