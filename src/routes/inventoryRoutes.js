const express = require('express');
const path = require('path');
const fs = require('fs');
const inv = require('../repositories/inventoryRepo');
const bill = require('../repositories/billRepo');
const po = require('../repositories/poRepo');
const { logAudit, listAuditLogs } = require('../repositories/auditRepo');
const { requireAuth, requireRole } = require('../middleware/auth');
const { toCsv } = require('../utils/csv');
const env = require('../config/env');

const router = express.Router();
const { upload, uploadDir } = require('../middleware/upload');

// Authenticated file serving (uploads are not public static).
router.get('/uploads/:file', requireAuth, (req, res) => {
  const full = path.join(uploadDir, path.basename(req.params.file));
  if (!full.startsWith(uploadDir) || !fs.existsSync(full)) return res.status(404).render('errors/404', { title: 'File not found' });
  res.sendFile(full);
});
// expose the configured upload middleware for other routers

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const [stats, bstats, pstats, lowStock, transactions, approvals] = await Promise.all([
      inv.dashboardStats(), bill.billStats(), po.poStats(), inv.lowStockList(), inv.listTransactions(8), bill.pendingApprovals()
    ]);
    res.render('dashboard', { title: 'Dashboard', stats, bstats, pstats, lowStock, transactions, approvals });
  } catch (err) { next(err); }
});

// ---- items ----
router.get('/items', requireAuth, async (req, res, next) => {
  try { res.render('inventory/items', { title: 'Item Master', items: await inv.listItems(false) }); } catch (e) { next(e); }
});
router.get('/items/new', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try { res.render('inventory/item-form', { title: 'Add Item', item: {}, itemCategories: await inv.listItemCategories(), subcategories: [] }); } catch (e) { next(e); }
});
router.post('/items', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    if (!req.body.description?.trim()) throw new Error('Item description is required.');
    const id = await inv.createItem(req.body, req.session.user.id);
    await logAudit({ userId: req.session.user.id, action: 'CREATE_ITEM', entity: 'items', entityId: id, details: req.body, ip: req.ip });
    req.session.success = 'Item created.'; res.redirect('/items');
  } catch (err) { req.session.error = err.message; res.redirect('/items/new'); }
});
router.get('/items/:id/edit', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const item = await inv.getItem(req.params.id);
    if (!item) return res.status(404).render('errors/404', { title: 'Item not found' });
    const [itemCategories, subcategories] = await Promise.all([inv.listItemCategories(), item.cat_code ? inv.listSubcategories(item.cat_code) : Promise.resolve([])]);
    res.render('inventory/item-form', { title: 'Edit Item', item, itemCategories, subcategories });
  } catch (e) { next(e); }
});
router.post('/items/:id', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    await inv.updateItem(req.params.id, req.body);
    await logAudit({ userId: req.session.user.id, action: 'UPDATE_ITEM', entity: 'items', entityId: req.params.id, details: req.body, ip: req.ip });
    req.session.success = 'Item updated.'; res.redirect('/items');
  } catch (err) { req.session.error = err.message; res.redirect(`/items/${req.params.id}/edit`); }
});
router.get('/items/:id/ledger', requireAuth, async (req, res, next) => {
  try {
    const item = await inv.getItem(req.params.id);
    if (!item) return res.status(404).render('errors/404', { title: 'Item not found' });
    const [entries, availability] = await Promise.all([inv.itemLedger(req.params.id), inv.itemAvailability(req.params.id)]);
    res.render('inventory/ledger', { title: `Ledger — ${item.item_code}`, item, entries, availability });
  } catch (e) { next(e); }
});

// ---- transactions ----
router.get('/transactions/new', requireAuth, requireRole('admin', 'manager', 'operator'), async (req, res, next) => {
  try {
    const [items, grns, vendors, locations] = await Promise.all([inv.listItems(true), inv.grnList(), inv.listVendors(), inv.listLocations()]);
    res.render('inventory/transaction-form', { title: 'Record Transaction', items, grns, vendors, locations });
  } catch (e) { next(e); }
});
router.post('/transactions', requireAuth, requireRole('admin', 'manager', 'operator'), upload.single('attachment'), async (req, res) => {
  try {
    const imagePath = req.file ? `/uploads/${req.file.filename}` : null;
    const id = await inv.createTransaction({
      itemId: Number(req.body.itemId), transactionType: req.body.transactionType, quantity: req.body.quantity,
      transactionDate: req.body.transactionDate, grnNo: req.body.grnNo, issueOrderNo: req.body.issueOrderNo,
      referenceNo: req.body.referenceNo, brand: req.body.brand, vendor: req.body.vendor, manufacturer: req.body.manufacturer,
      serialNo: req.body.serialNo, sourceLocation: req.body.sourceLocation, destinationLocation: req.body.destinationLocation,
      issueLocation: req.body.issueLocation, cost: req.body.cost, reorderQuantity: req.body.reorderQuantity,
      discardReason: req.body.discardReason, conditionText: req.body.conditionText, notes: req.body.notes
    }, req.session.user.id, imagePath);
    await logAudit({ userId: req.session.user.id, action: 'CREATE_TRANSACTION', entity: 'transactions', entityId: id, details: req.body, ip: req.ip });
    req.session.success = 'Transaction recorded.'; res.redirect('/transactions');
  } catch (err) { req.session.error = err.message; res.redirect('/transactions/new'); }
});
router.get('/transactions', requireAuth, async (req, res, next) => {
  try {
    const pageSize = 100, page = Math.max(1, Number(req.query.page) || 1);
    const total = await inv.countTransactions();
    const transactions = await inv.listTransactions(pageSize, (page - 1) * pageSize);
    res.render('inventory/transactions', { title: 'Transaction Ledger', transactions, page, totalPages: Math.max(1, Math.ceil(total / pageSize)), total });
  } catch (e) { next(e); }
});

// ---- json + reports ----
router.get('/api/subcategories/:catCode', requireAuth, async (req, res, next) => {
  try { res.json(await inv.listSubcategories(req.params.catCode)); } catch (e) { next(e); }
});
router.get('/api/items/:id/availability', requireAuth, async (req, res, next) => {
  try { res.json(await inv.itemAvailability(req.params.id)); } catch (e) { next(e); }
});
router.get('/api/grn/:grnNo/items', requireAuth, async (req, res, next) => {
  try { res.json(await inv.grnItems(req.params.grnNo)); } catch (e) { next(e); }
});
router.get('/reports/stock.csv', requireAuth, async (req, res, next) => {
  try { res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="stock.csv"'); res.send(toCsv(await inv.stockStatus())); } catch (e) { next(e); }
});
router.get('/reports/low-stock.csv', requireAuth, async (req, res, next) => {
  try { res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="low-stock.csv"'); res.send(toCsv(await inv.lowStockList())); } catch (e) { next(e); }
});
router.get('/reports/stock-by-location.csv', requireAuth, async (req, res, next) => {
  try { res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="stock-by-location.csv"'); res.send(toCsv(await inv.stockByLocation())); } catch (e) { next(e); }
});
router.get('/reports', requireAuth, async (req, res, next) => {
  try {
    const [stock, byLoc] = await Promise.all([inv.stockStatus(), inv.stockByLocation()]);
    const totalValue = stock.reduce((s, r) => s + Number(r.inventory_value || 0), 0);
    res.render('reports/index', { title: 'Reports', stock, byLoc, totalValue });
  } catch (e) { next(e); }
});
router.get('/reports/inventory-print', requireAuth, async (req, res, next) => {
  try {
    const view = req.query.view === 'location' ? 'location' : 'valuation';
    const [stock, byLoc] = await Promise.all([inv.stockStatus(), inv.stockByLocation()]);
    const totalValue = stock.reduce((s, r) => s + Number(r.inventory_value || 0), 0);
    const byLocValue = byLoc.reduce((s, r) => s + Number(r.value || 0), 0);
    res.render('reports/print', { title: 'Inventory Report', view, stock, byLoc, totalValue, byLocValue, appName: res.locals.appName, printedAt: new Date().toLocaleString(), layout: false });
  } catch (e) { next(e); }
});
router.get('/audit', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try { res.render('audit', { title: 'Audit Trail', logs: await listAuditLogs(300) }); } catch (e) { next(e); }
});

module.exports = router;
