const express = require('express');
const po = require('../repositories/poRepo');
const inv = require('../repositories/inventoryRepo');
const { logAudit } = require('../repositories/auditRepo');
const { requireAuth, requireRole } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const router = express.Router();

router.get('/purchase-orders', requireAuth, async (req, res, next) => {
  try {
    const pageSize = 100, page = Math.max(1, Number(req.query.page) || 1);
    const total = await po.countPOs();
    const pos = await po.listPOs(pageSize, (page - 1) * pageSize);
    res.render('po/list', { title: 'Purchase Orders', pos, page, totalPages: Math.max(1, Math.ceil(total / pageSize)), total });
  } catch (e) { next(e); }
});

router.get('/purchase-orders/new', requireAuth, requireRole('admin', 'manager', 'operator'), async (req, res, next) => {
  try {
    const [items, vendors] = await Promise.all([inv.listItems(true), inv.listVendors()]);
    res.render('po/form', { title: 'New Purchase Order', items, vendors });
  } catch (e) { next(e); }
});

router.post('/purchase-orders', requireAuth, requireRole('admin', 'manager', 'operator'), upload.single('attachment'), async (req, res) => {
  try {
    const rawLines = req.body.lines || [];
    const lines = (Array.isArray(rawLines) ? rawLines : Object.values(rawLines))
      .map(l => ({ itemId: l.itemId, quantity: l.quantity, rate: l.rate, notes: l.notes }));
    const attachment = req.file ? `/uploads/${req.file.filename}` : null;
    const id = await po.createPO({ vendor: req.body.vendor, poDate: req.body.poDate, deliveryTo: req.body.deliveryTo, notes: req.body.notes, attachment, lines }, req.session.user.id);
    await logAudit({ userId: req.session.user.id, action: 'CREATE_PO', entity: 'purchase_orders', entityId: id, ip: req.ip });
    req.session.success = 'Purchase order created and submitted for approval.';
    res.redirect(`/purchase-orders/${id}`);
  } catch (err) { req.session.error = err.message; res.redirect('/purchase-orders/new'); }
});

router.get('/purchase-orders/:id', requireAuth, async (req, res, next) => {
  try {
    const doc = await po.getPO(req.params.id);
    if (!doc) return res.status(404).render('errors/404', { title: 'PO not found' });
    const locations = await inv.listLocations();
    res.render('po/view', { title: `PO ${doc.po_no}`, po: doc, locations });
  } catch (e) { next(e); }
});

router.post('/purchase-orders/:id/decision', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const status = req.body.decision === 'approve' ? 'approved' : 'rejected';
    await po.setPOStatus(req.params.id, status, req.session.user.id, req.body.remarks);
    await logAudit({ userId: req.session.user.id, action: `PO_${status.toUpperCase()}`, entity: 'purchase_orders', entityId: req.params.id, ip: req.ip });
    req.session.success = `Purchase order ${status}.`;
  } catch (err) { req.session.error = err.message; }
  res.redirect(`/purchase-orders/${req.params.id}`);
});

router.post('/purchase-orders/:id/receive', requireAuth, requireRole('admin', 'manager', 'operator'), async (req, res) => {
  try {
    const raw = req.body.receipts || [];
    const receipts = (Array.isArray(raw) ? raw : Object.values(raw))
      .map(r => ({ lineId: r.lineId, receiveQty: r.receiveQty, location: r.location }));
    const result = await po.receiveAgainstPO(req.params.id, receipts, req.session.user.id);
    await logAudit({ userId: req.session.user.id, action: 'PO_RECEIVE', entity: 'purchase_orders', entityId: req.params.id, details: { grn: result.grnNo }, ip: req.ip });
    req.session.success = `Goods received. GRN ${result.grnNo}. PO ${result.status}.`;
  } catch (err) { req.session.error = err.message; }
  res.redirect(`/purchase-orders/${req.params.id}`);
});

module.exports = router;
