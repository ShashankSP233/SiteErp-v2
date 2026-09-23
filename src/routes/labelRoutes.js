const express = require('express');
const label = require('../repositories/labelRepo');
const inv = require('../repositories/inventoryRepo');
const { logAudit } = require('../repositories/auditRepo');
const { requireAuth, requireRole } = require('../middleware/auth');
const { toCsv } = require('../utils/csv');
const router = express.Router();

router.get('/barcodes', requireAuth, async (req, res, next) => {
  try {
    const itemId = req.query.itemId ? Number(req.query.itemId) : null;
    const [labels, items] = await Promise.all([
      label.listLabels({ itemId, onlyUnprinted: req.query.unprinted === '1', limit: 500 }),
      inv.listItems(true)
    ]);
    res.render('barcodes/index', { title: 'Print Barcodes', labels, items, itemId, unprinted: req.query.unprinted === '1' });
  } catch (e) { next(e); }
});

router.post('/barcodes/generate', requireAuth, requireRole('admin', 'manager', 'operator'), async (req, res) => {
  try {
    const codes = await label.generateForItem({ itemId: Number(req.body.itemId), qty: req.body.qty, location: req.body.location, userId: req.session.user.id });
    await logAudit({ userId: req.session.user.id, action: 'GENERATE_LABELS', entity: 'labels', entityId: req.body.itemId, details: { count: codes.length, qty: req.body.qty }, ip: req.ip });
    req.session.success = `${codes.length} label(s) generated.`;
    res.redirect('/barcodes?itemId=' + Number(req.body.itemId));
  } catch (err) { req.session.error = err.message; res.redirect('/barcodes'); }
});

router.post('/barcodes/print', requireAuth, async (req, res, next) => {
  try {
    let codes = req.body.codes || [];
    if (!Array.isArray(codes)) codes = [codes];
    if (!codes.length) { req.session.error = 'Select at least one label to print.'; return res.redirect('/barcodes'); }
    const labels = await label.getByCodes(codes);
    await label.markPrinted(codes);
    res.render('barcodes/print', { title: 'Barcode Labels', labels, layout: false });
  } catch (e) { next(e); }
});

router.get('/barcodes/print/item/:id', requireAuth, async (req, res, next) => {
  try {
    const labels = await label.listLabels({ itemId: Number(req.params.id), limit: 1000 });
    if (labels.length) await label.markPrinted(labels.map(l => l.label_code));
    res.render('barcodes/print', { title: 'Barcode Labels', labels, layout: false });
  } catch (e) { next(e); }
});

router.get('/barcodes/export.csv', requireAuth, async (req, res, next) => {
  try {
    const itemId = req.query.itemId ? Number(req.query.itemId) : null;
    const rows = (await label.listLabels({ itemId, limit: 100000 })).map(l => ({
      label_code: l.label_code, item_code: l.item_code, description: l.description, year: l.year,
      serial: l.serial, qty: l.qty, label_mode: l.label_mode, location: l.location || '', status: l.status,
      created_at: l.created_at, printed: l.printed_at ? 'yes' : 'no'
    }));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="barcode-labels.csv"');
    res.send(toCsv(rows));
  } catch (e) { next(e); }
});

module.exports = router;
