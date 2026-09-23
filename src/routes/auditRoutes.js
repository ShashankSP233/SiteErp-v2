// Mounted at /inventory-audit (distinct from the system Audit Trail at /audit).
const express = require('express');
const audit = require('../repositories/auditSessionRepo');
const inv = require('../repositories/inventoryRepo');
const { logAudit } = require('../repositories/auditRepo');
const { requireAuth, requireRole } = require('../middleware/auth');
const { toCsv } = require('../utils/csv');
const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const [sessions, locations] = await Promise.all([audit.listSessions(), inv.listLocations()]);
    res.render('audit/index', { title: 'Inventory Audit', sessions, locations });
  } catch (e) { next(e); }
});

router.post('/', requireAuth, requireRole('admin', 'manager', 'operator'), async (req, res) => {
  try {
    const id = await audit.createSession({ name: req.body.name, location: req.body.location, period: req.body.period, notes: req.body.notes, userId: req.session.user.id });
    await logAudit({ userId: req.session.user.id, action: 'INV_AUDIT_START', entity: 'audit_session', entityId: id, details: { name: req.body.name, location: req.body.location, period: req.body.period }, ip: req.ip });
    res.redirect('/inventory-audit/' + id);
  } catch (err) { req.session.error = err.message; res.redirect('/inventory-audit'); }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const session = await audit.getSession(req.params.id);
    if (!session) return res.status(404).render('errors/404', { title: 'Audit not found' });
    if (session.status === 'closed') return res.redirect('/inventory-audit/' + req.params.id + '/report');
    const scans = await audit.listScans(req.params.id);
    const counts = scans.reduce((a, s) => { a[s.result] = (a[s.result] || 0) + 1; return a; }, {});
    res.render('audit/session', { title: 'Inventory Audit — ' + session.name, session, scans, counts });
  } catch (e) { next(e); }
});

router.post('/:id/scan', requireAuth, async (req, res) => {
  try {
    const result = await audit.recordScan(req.params.id, req.body.code, req.session.user.id);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

router.post('/:id/close', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    await audit.closeSession(req.params.id, req.session.user.id);
    await logAudit({ userId: req.session.user.id, action: 'INV_AUDIT_CLOSE', entity: 'audit_session', entityId: req.params.id, ip: req.ip });
    req.session.success = 'Audit closed. Reconciliation against the ledger is ready.';
  } catch (err) { req.session.error = err.message; }
  res.redirect('/inventory-audit/' + req.params.id + '/report');
});

router.get('/:id/report', requireAuth, async (req, res, next) => {
  try {
    const rec = await audit.reconcile(req.params.id);
    if (!rec.session) return res.status(404).render('errors/404', { title: 'Audit not found' });
    res.render('audit/report', { title: 'Audit Report — ' + rec.session.name, rec });
  } catch (e) { next(e); }
});

router.get('/:id/export.csv', requireAuth, async (req, res, next) => {
  try {
    const rec = await audit.reconcile(req.params.id);
    const rows = rec.rows.map(r => ({
      item_code: r.item_code, description: r.description, ledger_qty: r.ledger_qty, scanned_qty: r.scanned_qty,
      discrepancy: r.discrepancy, avg_cost: r.avg_cost, missing_value: r.missing_value, discrepancy_value: r.discrepancy_value
    }));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="inventory-audit-${req.params.id}.csv"`);
    res.send(toCsv(rows));
  } catch (e) { next(e); }
});

module.exports = router;
