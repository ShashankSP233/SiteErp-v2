const express = require('express');
const vendorRepo = require('../repositories/vendorRepo');
const { logAudit } = require('../repositories/auditRepo');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();

router.get('/vendors', requireAuth, async (req, res, next) => {
  try { res.render('vendors/list', { title: 'Vendors', vendors: await vendorRepo.listVendors() }); } catch (e) { next(e); }
});
router.get('/vendors/new', requireAuth, requireRole('admin', 'manager'), (req, res) => res.render('vendors/form', { title: 'Add Vendor', vendor: {} }));
router.post('/vendors', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const id = await vendorRepo.createVendor(req.body);
    await logAudit({ userId: req.session.user.id, action: 'CREATE_VENDOR', entity: 'vendors', entityId: id, ip: req.ip });
    req.session.success = 'Vendor added.'; res.redirect('/vendors');
  } catch (err) { req.session.error = err.message; res.redirect('/vendors/new'); }
});
router.get('/vendors/:id/edit', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const vendor = await vendorRepo.getVendor(req.params.id);
    if (!vendor) return res.status(404).render('errors/404', { title: 'Vendor not found' });
    res.render('vendors/form', { title: 'Edit Vendor', vendor });
  } catch (e) { next(e); }
});
router.post('/vendors/:id', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    await vendorRepo.updateVendor(req.params.id, req.body);
    await logAudit({ userId: req.session.user.id, action: 'UPDATE_VENDOR', entity: 'vendors', entityId: req.params.id, ip: req.ip });
    req.session.success = 'Vendor updated.'; res.redirect('/vendors');
  } catch (err) { req.session.error = err.message; res.redirect(`/vendors/${req.params.id}/edit`); }
});
module.exports = router;
