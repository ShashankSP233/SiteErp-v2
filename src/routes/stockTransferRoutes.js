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
 * Download a print-ready Stock Transfer Note.
 */
router.get(
  '/inventory/transfers/:id/stn',
  requireAuth,
  async (req, res, next) => {
    try {
      const result = await getTransferForUser(
        req.params.id,
        req.session.user
      );

      if (!result) {
        return res.status(404).render('errors/404', {
          title: 'Stock transfer not found'
        });
      }

      const { transfer, items } = result;
      const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[char]));
      const date = value => value ? new Date(value).toLocaleString() : '—';
      const rows = items.map((item, index) => `
        <tr>
          <td>${index + 1}</td><td>${escape(item.instance_code)}</td>
          <td>${escape(item.barcode || '—')}</td><td>${escape(item.item_code)}</td>
          <td>${escape(item.item_name)}</td><td>${escape(Number(item.quantity).toLocaleString())} ${escape(item.unit)}</td>
          <td>${escape(item.status.replaceAll('_', ' '))}</td>
          <td>${escape(item.received_at ? date(item.received_at) : '—')}</td>
        </tr>`).join('');

      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(transfer.transfer_number)} - Stock Transfer Note</title>
        <style>
          @page{size:A4;margin:16mm}*{box-sizing:border-box}body{font:13px Arial,sans-serif;color:#17202a;margin:0}
          header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #263b55;padding-bottom:14px;margin-bottom:20px}
          h1{font-size:24px;margin:0 0 5px}.number{font-size:18px;font-weight:bold;color:#263b55}h2{font-size:14px;margin:22px 0 8px;text-transform:uppercase;letter-spacing:.04em}
          .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 28px}.field{padding:8px 0;border-bottom:1px solid #d7dde3}.label{display:block;color:#65717d;font-size:10px;text-transform:uppercase;margin-bottom:4px}
          table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #cbd2d9;padding:7px;text-align:left}th{background:#eef2f6}td:first-child{text-align:center}
          .notes{border:1px solid #cbd2d9;min-height:50px;padding:9px;white-space:pre-wrap}.signatures{display:grid;grid-template-columns:1fr 1fr;gap:50px;margin-top:50px}.sign{border-top:1px solid #263b55;padding-top:8px;color:#46515b}
          footer{margin-top:28px;padding-top:8px;border-top:1px solid #d7dde3;color:#65717d;font-size:10px}.print{margin:12px 0;padding:8px 14px}
          @media print{.print{display:none}}
        </style></head><body>
        <button class="print" onclick="window.print()">Print Stock Transfer Note</button>
        <header><div><h1>Stock Transfer Note</h1><div>Site to site inventory movement</div></div><div class="number">${escape(transfer.transfer_number)}</div></header>
        <div class="grid">
          <div class="field"><span class="label">From site</span><strong>${escape(transfer.from_site_code)} — ${escape(transfer.from_site_name)}</strong></div>
          <div class="field"><span class="label">To site</span><strong>${escape(transfer.to_site_code)} — ${escape(transfer.to_site_name)}</strong></div>
          <div class="field"><span class="label">Status</span>${escape(transfer.status.replaceAll('_', ' '))}</div>
          <div class="field"><span class="label">Created</span>${escape(date(transfer.created_at))}</div>
          <div class="field"><span class="label">Prepared by</span>${escape(transfer.created_by_name || '—')}</div>
          <div class="field"><span class="label">Dispatched</span>${escape(date(transfer.dispatched_at))}${transfer.dispatched_by_name ? ` by ${escape(transfer.dispatched_by_name)}` : ''}</div>
        </div>
        <h2>Items (${items.length})</h2><table><thead><tr><th>#</th><th>Instance code</th><th>Barcode</th><th>Item code</th><th>Description</th><th>Quantity</th><th>Status</th><th>Received at</th></tr></thead><tbody>${rows || '<tr><td colspan="8">No items have been added to this transfer.</td></tr>'}</tbody></table>
        <h2>Transfer notes</h2><div class="notes">${escape(transfer.notes || '—')}</div>
        <div class="signatures"><div class="sign">Released by (name, signature and date)</div><div class="sign">Received by (name, signature and date)</div></div>
        <footer>Generated ${escape(date(new Date()))} · ${escape(transfer.transfer_number)}</footer>
        </body></html>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${transfer.transfer_number}.html"`);
      res.send(html);
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
