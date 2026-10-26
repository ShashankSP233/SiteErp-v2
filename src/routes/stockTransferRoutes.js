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
 * Open a print-ready Stock Transfer Note and launch the browser print dialog.
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
      const date = value => value ? new Date(value).toLocaleString() : '-';
      const rows = items.map((item, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escape(item.instance_code)}</td>
          <td>${escape(item.barcode || '-')}</td>
          <td>${escape(item.item_code)}</td>
          <td>${escape(item.item_name)}</td>
          <td>${escape(Number(item.quantity).toLocaleString())} ${escape(item.unit)}</td>
          <td>${escape(item.status.replaceAll('_', ' '))}</td>
          <td>${item.received_at
            ? `${escape(transfer.to_site_code)} - ${escape(transfer.to_site_name)}<br>${escape(date(item.received_at))}`
            : '-'}</td>
        </tr>`).join('');

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', 'inline');
      res.send(`<!doctype html>
        <html lang="en"><head><meta charset="utf-8">
        <title>${escape(transfer.transfer_number)} - Stock Transfer Note</title>
        <style>
          @page { size: A4 landscape; margin: 10mm; }
          * { box-sizing: border-box; }
          body { margin: 0; color: #17202a; font: 10px Arial, sans-serif; }
          .toolbar { margin: 12px auto; max-width: 1100px; }
          .toolbar button { padding: 9px 18px; font-size: 14px; cursor: pointer; }
          main { max-width: 1100px; margin: 0 auto; }
          header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #263b55; padding-bottom: 10px; margin-bottom: 12px; }
          h1 { margin: 0 0 4px; font-size: 20px; } .stn { font-size: 16px; font-weight: bold; }
          .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 18px; margin-bottom: 14px; }
          .label { display: block; color: #596674; font-size: 8px; text-transform: uppercase; margin-bottom: 3px; }
          table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 8px; }
          th, td { border: 1px solid #aeb8c2; padding: 5px 4px; text-align: left; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
          th { background: #e9eef3; font-size: 8px; }
          th:nth-child(1), td:nth-child(1) { width: 3%; text-align: center; }
          th:nth-child(2), td:nth-child(2), th:nth-child(3), td:nth-child(3) { width: 13%; }
          th:nth-child(4), td:nth-child(4) { width: 10%; }
          th:nth-child(5), td:nth-child(5) { width: 21%; }
          th:nth-child(6), td:nth-child(6) { width: 9%; }
          th:nth-child(7), td:nth-child(7) { width: 10%; }
          th:nth-child(8), td:nth-child(8) { width: 21%; }
          thead { display: table-header-group; } tr { break-inside: avoid; page-break-inside: avoid; }
          h2 { font-size: 10px; margin: 16px 0 5px; text-transform: uppercase; }
          .notes { border: 1px solid #aeb8c2; padding: 7px; white-space: pre-wrap; min-height: 28px; }
          .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 50px; margin-top: 38px; }
          .sign { border-top: 1px solid #263b55; padding-top: 5px; }
          @media print { .toolbar { display: none; } main { max-width: none; } }
        </style></head><body>
        <div class="toolbar"><button type="button" onclick="window.print()">Print Stock Transfer Note</button></div>
        <main>
          <header><div><h1>Stock Transfer Note</h1><div>Site to site inventory movement</div></div><div class="stn">${escape(transfer.transfer_number)}</div></header>
          <section class="meta">
            <div><span class="label">From site</span><strong>${escape(transfer.from_site_code)} - ${escape(transfer.from_site_name)}</strong></div>
            <div><span class="label">To site</span><strong>${escape(transfer.to_site_code)} - ${escape(transfer.to_site_name)}</strong></div>
            <div><span class="label">Status</span>${escape(transfer.status.replaceAll('_', ' '))}</div>
            <div><span class="label">Created</span>${escape(date(transfer.created_at))}</div>
            <div><span class="label">Prepared by</span>${escape(transfer.created_by_name || '-')}</div>
            <div><span class="label">Dispatched</span>${escape(date(transfer.dispatched_at))}${transfer.dispatched_by_name ? ` by ${escape(transfer.dispatched_by_name)}` : ''}</div>
          </section>
          <table><thead><tr><th>#</th><th>Instance code</th><th>Barcode</th><th>Item code</th><th>Description</th><th>Quantity</th><th>Status</th><th>Received at</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="8">No items have been added to this transfer.</td></tr>'}</tbody></table>
          <h2>Transfer notes</h2><div class="notes">${escape(transfer.notes || '-')}</div>
          <div class="signatures"><div class="sign">Released by (name, signature and date)</div><div class="sign">Received by (name, signature and date)</div></div>
        </main>
        <script>window.addEventListener('load', () => setTimeout(() => window.print(), 250));</script>
        </body></html>`);
    } catch (error) {
      next(error);
    }
  }
);

/*
 * Print barcode labels for every physical instance on an STN.
 */
router.get(
  '/inventory/transfers/:id/barcodes',
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

      const labels = result.items.filter(item => item.barcode).map(item => ({
        ...item,
        site_name: result.transfer.from_site_name,
        site_code: result.transfer.from_site_code,
        current_quantity: item.quantity,
        unit: item.unit
      }));

      if (!labels.length) {
        req.session.error = 'There are no item barcodes on this transfer to print.';
        return res.redirect(`/inventory/transfers/${result.transfer.id}`);
      }

      return res.render('barcodes/print', {
        title: `${result.transfer.transfer_number} Barcodes`,
        layout: false,
        labels
      });
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
