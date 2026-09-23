const express = require('express');
const bill = require('../repositories/billRepo');
const inv = require('../repositories/inventoryRepo');
const { logAudit } = require('../repositories/auditRepo');
const { requireAuth, requireRole } = require('../middleware/auth');
const { upload } = require('../middleware/upload');

const router = express.Router();

// ---- list ----
router.get('/bills', requireAuth, async (req, res, next) => {
  try {
    const pageSize = 100, page = Math.max(1, Number(req.query.page) || 1);
    const total = await bill.countBills();
    const bills = await bill.listBills(pageSize, (page - 1) * pageSize);
    res.render('bills/list', { title: 'Bills', bills, page, totalPages: Math.max(1, Math.ceil(total / pageSize)), total });
  } catch (e) { next(e); }
});

// ---- create ----
router.get('/bills/new', requireAuth, requireRole('admin', 'manager', 'operator'), async (req, res, next) => {
  try {
    const [vendors, grns] = await Promise.all([inv.listVendors(), inv.grnList()]);
    res.render('bills/form', { title: 'Add Bill', vendors, grns });
  } catch (e) { next(e); }
});
router.post('/bills', requireAuth, requireRole('admin', 'manager', 'operator'), upload.single('attachment'), async (req, res) => {
  try {
    const attachment = req.file ? `/uploads/${req.file.filename}` : null;
    const id = await bill.createBill({
      billNo: req.body.billNo, vendor: req.body.vendor, billDate: req.body.billDate, grnNo: req.body.grnNo,
      amount: req.body.amount, tax: req.body.tax, notes: req.body.notes, attachment
    }, req.session.user.id);
    await logAudit({ userId: req.session.user.id, action: 'CREATE_BILL', entity: 'bills', entityId: id, details: { billNo: req.body.billNo, amount: req.body.amount }, ip: req.ip });
    req.session.success = 'Bill recorded and submitted for approval.'; res.redirect(`/bills/${id}`);
  } catch (err) { req.session.error = err.message; res.redirect('/bills/new'); }
});

// ---- view ----
router.get('/bills/:id', requireAuth, async (req, res, next) => {
  try {
    const b = await bill.getBill(req.params.id);
    if (!b) return res.status(404).render('errors/404', { title: 'Bill not found' });
    res.render('bills/view', { title: `Bill ${b.bill_no}`, bill: b });
  } catch (e) { next(e); }
});

// ---- approve / reject (manager/admin) ----
router.post('/bills/:id/decision', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const status = req.body.decision === 'approve' ? 'approved' : 'rejected';
    await bill.setBillStatus(req.params.id, status, req.session.user.id, req.body.remarks);
    await logAudit({ userId: req.session.user.id, action: `BILL_${status.toUpperCase()}`, entity: 'bills', entityId: req.params.id, details: { remarks: req.body.remarks }, ip: req.ip });
    req.session.success = `Bill ${status}.`;
  } catch (err) { req.session.error = err.message; }
  res.redirect(`/bills/${req.params.id}`);
});

// ---- record payment ----
router.post('/bills/:id/payments', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const newStatus = await bill.addPayment(req.params.id, {
      amount: req.body.amount, mode: req.body.mode, paymentDate: req.body.paymentDate,
      referenceNo: req.body.referenceNo, notes: req.body.notes
    }, req.session.user.id);
    await logAudit({ userId: req.session.user.id, action: 'BILL_PAYMENT', entity: 'bills', entityId: req.params.id, details: { amount: req.body.amount, mode: req.body.mode }, ip: req.ip });
    req.session.success = `Payment recorded. Bill is now ${newStatus}.`;
  } catch (err) { req.session.error = err.message; }
  res.redirect(`/bills/${req.params.id}`);
});

// ---- approvals queue + payables ----
router.get('/approvals', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try { res.render('bills/approvals', { title: 'Pending Approvals', approvals: await bill.pendingApprovals() }); } catch (e) { next(e); }
});
router.get('/payables', requireAuth, async (req, res, next) => {
  try { res.render('bills/payables', { title: 'Vendor Payables', payables: await bill.vendorPayables() }); } catch (e) { next(e); }
});

module.exports = router;
