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

function createStnPdf(transfer, items) {
  const pageWidth = 842;
  const pageHeight = 595;
  const margin = 36;
  const operations = [];
  let y = pageHeight - margin;
  let pages = [];

  const safe = value => String(value ?? '-')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/→/g, 'to')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '');
  const pdfText = value => safe(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const text = (value, x, top, size = 9, bold = false) => {
    operations.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${top - size} Td (${pdfText(value)}) Tj ET`);
  };
  const line = (x1, y1, x2, y2, gray = 0.78) => {
    operations.push(`${gray} G ${x1} ${y1} m ${x2} ${y2} l S 0 G`);
  };
  const rect = (x, top, width, height, fill = 0.93) => {
    operations.push(`${fill} g ${x} ${top - height} ${width} ${height} re f 0 g`);
  };
  const newPage = () => {
    if (operations.length) pages.push(operations.splice(0));
    y = pageHeight - margin;
  };
  const ensureSpace = height => { if (y - height < margin) newPage(); };
  const wrap = (value, limit) => {
    const words = safe(value).split(/\s+/);
    const lines = [];
    let current = '';
    for (const word of words) {
      if (word.length > limit) {
        if (current) lines.push(current);
        current = '';
        for (let i = 0; i < word.length; i += limit) lines.push(word.slice(i, i + limit));
      } else if ((current ? current.length + 1 : 0) + word.length > limit) {
        lines.push(current); current = word;
      } else current += `${current ? ' ' : ''}${word}`;
    }
    if (current) lines.push(current);
    return lines.length ? lines : ['-'];
  };
  const section = title => {
    ensureSpace(25); y -= 7; text(title.toUpperCase(), margin, y, 9, true);
    y -= 5; line(margin, y, pageWidth - margin, y); y -= 13;
  };

  text('STOCK TRANSFER NOTE', margin, y, 19, true);
  text(transfer.transfer_number, pageWidth - margin - 160, y, 14, true);
  y -= 25;
  text('Site to site inventory movement', margin, y, 9);
  y -= 15; line(margin, y, pageWidth - margin, y, 0.35); y -= 18;

  const field = (label, value, x, top, width = 360) => {
    text(label.toUpperCase(), x, top, 7, true);
    const lines = wrap(value, Math.floor(width / 5.3));
    lines.slice(0, 2).forEach((item, i) => text(item, x, top - 11 - i * 11, 9));
  };
  const date = value => value ? new Date(value).toLocaleString() : '-';
  field('From site', `${transfer.from_site_code} - ${transfer.from_site_name}`, margin, y);
  field('To site', `${transfer.to_site_code} - ${transfer.to_site_name}`, 430, y);
  y -= 35;
  field('Status', transfer.status.replaceAll('_', ' '), margin, y);
  field('Created', date(transfer.created_at), 240, y);
  field('Prepared by', transfer.created_by_name || '-', 430, y);
  field('Dispatched', `${date(transfer.dispatched_at)}${transfer.dispatched_by_name ? ` by ${transfer.dispatched_by_name}` : ''}`, 620, y, 180);
  y -= 37;

  section(`Items (${items.length})`);
  const columns = [
    { title: '#', width: 25, limit: 4 }, { title: 'Instance code', width: 92, limit: 17 },
    { title: 'Barcode', width: 92, limit: 17 }, { title: 'Item code', width: 75, limit: 14 },
    { title: 'Description', width: 190, limit: 36 }, { title: 'Quantity', width: 75, limit: 13 },
    { title: 'Status', width: 80, limit: 15 }, { title: 'Received at', width: 105, limit: 20 }
  ];
  const tableX = margin;
  const row = (values, header = false) => {
    const wrapped = values.map((value, index) => wrap(value, columns[index].limit));
    const rowHeight = Math.max(22, Math.min(44, Math.max(...wrapped.map(lines => lines.length)) * 10 + 8));
    ensureSpace(rowHeight + 3);
    if (header) rect(tableX, y, pageWidth - margin * 2, rowHeight, 0.9);
    line(tableX, y, pageWidth - margin, y);
    let x = tableX;
    columns.forEach((column, index) => {
      wrapped[index].slice(0, 3).forEach((value, lineIndex) => text(value, x + 3, y - 5 - lineIndex * 10, 7, header));
      x += column.width;
      line(x, y, x, y - rowHeight);
    });
    line(tableX, y - rowHeight, pageWidth - margin, y - rowHeight);
    y -= rowHeight;
  };
  row(columns.map(column => column.title), true);
  items.forEach((item, index) => row([
    index + 1, item.instance_code, item.barcode || '-', item.item_code, item.item_name,
    `${Number(item.quantity).toLocaleString()} ${item.unit}`, item.status.replaceAll('_', ' '),
    item.received_at
      ? `${transfer.to_site_code} - ${transfer.to_site_name}; ${date(item.received_at)}`
      : '-'
  ]));
  if (!items.length) row(['', 'No items have been added to this transfer.', '', '', '', '', '', '']);

  section('Transfer notes');
  const noteLines = wrap(transfer.notes || '-', 130);
  noteLines.forEach(noteLine => {
    ensureSpace(13); text(noteLine, margin, y, 9); y -= 13;
  });
  ensureSpace(65); y -= 45;
  line(margin, y, 365, y, 0.35); line(430, y, pageWidth - margin, y, 0.35);
  text('Released by (name, signature and date)', margin, y - 5, 8);
  text('Received by (name, signature and date)', 430, y - 5, 8);

  pages.push(operations.splice(0));
  const objects = [];
  const addObject = value => { objects.push(value); return objects.length; };
  const catalogId = addObject('');
  const pagesId = addObject('');
  const fontRegularId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBoldId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds = [];
  pages.forEach(pageOps => {
    const stream = pageOps.join('\n');
    const streamId = addObject(`<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`);
    const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${streamId} 0 R >>`);
    pageIds.push(pageId);
  });
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'ascii');
}


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
      const pdf = createStnPdf(transfer, items);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${transfer.transfer_number}.pdf"`);
      res.send(pdf);
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
