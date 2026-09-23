const db = require('../config/db');
const { financialYearCode, formatDocumentNo, round2 } = require('../utils/finance');
const labelRepo = require('./labelRepo');

const INFLOW = ['RECEIVED', 'ADJUSTMENT_IN'];
const OUTFLOW = ['ISSUED', 'RETURNED', 'DISCARD', 'ADJUSTMENT_OUT'];
const ALL_TYPES = [...INFLOW, ...OUTFLOW, 'TRANSFER'];

const clean = (v) => { if (v === undefined || v === null) return null; const s = String(v).trim(); return s || null; };
function posNum(v, field = 'Quantity') { const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new Error(`${field} must be greater than zero.`); return n; }

// ---- numbering ----
async function peekNextDocumentNo(name, date = new Date()) {
  const fy = financialYearCode(date);
  const row = await db.one('SELECT last_number FROM sequence_counters WHERE name=? AND financial_year=?', [name, fy]);
  return formatDocumentNo(fy, (row ? Number(row.last_number) : 0) + 1);
}
async function nextDocumentNo(client, name, date = new Date()) {
  const fy = financialYearCode(date);
  // Atomic upsert-increment; returns the new number.
  const row = await client.one(
    `INSERT INTO sequence_counters(name, financial_year, last_number) VALUES (?,?,1)
     ON CONFLICT (name, financial_year) DO UPDATE SET last_number = sequence_counters.last_number + 1
     RETURNING last_number`, [name, fy]);
  return formatDocumentNo(fy, Number(row.last_number));
}
async function nextItemCode(client) {
  const row = await client.one(
    `SELECT item_code FROM items WHERE item_code LIKE 'ITM-%'
     ORDER BY CAST(substr(item_code, 5) AS integer) DESC LIMIT 1`);
  const next = row ? Number(row.item_code.substring(4)) + 1 : 1;
  return `ITM-${String(next).padStart(4, '0')}`;
}

// ---- lookups (find-or-create) ----
async function findOrCreateVendor(c, name) {
  const n = clean(name); if (!n) return null;
  const row = await c.one(`INSERT INTO vendors(name) VALUES (?)
    ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [n]);
  return row.id;
}
async function findOrCreateCategory(c, name) {
  const n = clean(name); if (!n) return null;
  const row = await c.one(`INSERT INTO categories(name) VALUES (?)
    ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [n]);
  return row.id;
}
async function findOrCreateLocation(c, name) {
  const n = clean(name); if (!n) return null;
  await c.query('INSERT INTO locations(name) VALUES (?) ON CONFLICT (name) DO NOTHING', [n]);
  return n;
}
const listVendors = () => db.many('SELECT id, name FROM vendors ORDER BY name');
const listCategories = () => db.many('SELECT id, name FROM categories ORDER BY name');
const listLocations = () => db.many('SELECT id, name FROM locations ORDER BY name');

// ---- items ----
// ---- item coding (CAT-SUB-NNNN) ----
const listItemCategories = () => db.many('SELECT cat_code, cat_name, default_label_mode FROM item_category WHERE is_active ORDER BY cat_code');
const listSubcategories = (catCode) => db.many('SELECT cat_code, sub_code, sub_name FROM item_subcategory WHERE is_active AND cat_code=? ORDER BY sub_code', [catCode]);
const listAllSubcategories = () => db.many('SELECT cat_code, sub_code, sub_name FROM item_subcategory WHERE is_active ORDER BY cat_code, sub_code');

// Atomic serial allocation per CAT-SUB (row-updated inside the caller's tx).
async function generateItemCode(c, catCode, subCode) {
  const cat = clean(catCode), sub = clean(subCode);
  if (!cat || !sub) throw new Error('Category and sub-category are required to generate an item code.');
  const row = await c.one(
    'UPDATE item_subcategory SET next_serial = next_serial + 1 WHERE cat_code=? AND sub_code=? AND is_active RETURNING next_serial',
    [cat, sub]);
  if (!row) throw new Error(`Unknown or inactive sub-category ${cat}-${sub}.`);
  const serial = Number(row.next_serial) - 1;
  return { code: `${cat}-${sub}-${String(serial).padStart(4, '0')}`, serial };
}

async function createItem(input, userId) {
  return db.tx(async (c) => {
    let code, catCode = null, subCode = null, serialNo = null, labelMode = clean(input.labelMode);
    if (clean(input.catCode) && clean(input.subCode)) {
      catCode = clean(input.catCode); subCode = clean(input.subCode);
      const gen = await generateItemCode(c, catCode, subCode);
      code = gen.code; serialNo = gen.serial;
      if (!labelMode) {
        const cat = await c.one('SELECT default_label_mode FROM item_category WHERE cat_code=?', [catCode]);
        labelMode = cat ? cat.default_label_mode : 'unit';
      }
    } else {
      code = clean(input.itemCode) || await nextItemCode(c); // legacy fallback
      labelMode = labelMode || 'unit';
    }
    const categoryId = await findOrCreateCategory(c, input.category);
    const row = await c.one(
      `INSERT INTO items(item_code, description, unit, type, category_id, status, reorder_level, remarks, created_by,
        hsn_code, gst_rate, min_level, max_level, item_group,
        cat_code, sub_code, serial_no, specification, preferred_make, oem_part_no, criticality, label_mode)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      [code, clean(input.description), clean(input.unit), clean(input.type), categoryId,
       input.status || 'active', Number(input.reorderLevel || 0), clean(input.remarks), userId || null,
       clean(input.hsnCode), Number(input.gstRate || 0), Number(input.minLevel || 0), Number(input.maxLevel || 0), clean(input.itemGroup),
       catCode, subCode, serialNo, clean(input.specification), clean(input.preferredMake), clean(input.oemPartNo),
       clean(input.criticality), labelMode]);
    return row.id;
  });
}
async function updateItem(id, input) {
  return db.tx(async (c) => {
    const categoryId = await findOrCreateCategory(c, input.category);
    await c.query(
      `UPDATE items SET description=?, unit=?, type=?, category_id=?, status=?, reorder_level=?, remarks=?,
        hsn_code=?, gst_rate=?, min_level=?, max_level=?, item_group=?,
        specification=?, preferred_make=?, oem_part_no=?, criticality=?, label_mode=COALESCE(?, label_mode), updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [clean(input.description), clean(input.unit), clean(input.type), categoryId,
       input.status || 'active', Number(input.reorderLevel || 0), clean(input.remarks),
       clean(input.hsnCode), Number(input.gstRate || 0), Number(input.minLevel || 0), Number(input.maxLevel || 0), clean(input.itemGroup),
       clean(input.specification), clean(input.preferredMake), clean(input.oemPartNo), clean(input.criticality), clean(input.labelMode), id]);
  });
}
const getItem = (id) => db.one(
  `SELECT i.*, c.name AS category FROM items i LEFT JOIN categories c ON c.id=i.category_id WHERE i.id=?`, [id]);
const listItems = (activeOnly = false) => db.many(
  `SELECT i.*, c.name AS category FROM items i LEFT JOIN categories c ON c.id=i.category_id
   ${activeOnly ? "WHERE i.status='active'" : ''} ORDER BY i.item_code`);

// ---- weighted-average costing (replay in chronological order) ----
async function computeAverageCosts(runner = db) {
  const rows = await runner.many('SELECT item_id, transaction_type, quantity, cost FROM transactions ORDER BY transaction_date ASC, id ASC');
  const state = new Map();
  for (const r of rows) {
    let s = state.get(r.item_id); if (!s) { s = { qty: 0, avgCost: 0 }; state.set(r.item_id, s); }
    const qty = Number(r.quantity);
    if (INFLOW.includes(r.transaction_type)) {
      const cost = Number(r.cost) || 0;
      const total = s.qty * s.avgCost + qty * cost;
      s.qty += qty; s.avgCost = s.qty > 0 ? total / s.qty : cost;
    } else if (OUTFLOW.includes(r.transaction_type)) { s.qty -= qty; } // TRANSFER is net-zero for total
  }
  return state;
}
async function currentAverageCost(runner, itemId) {
  const m = await computeAverageCosts(runner);
  const s = m.get(Number(itemId));
  return s ? round2(s.avgCost) : 0;
}

// ---- balances ----
async function getCurrentBalance(runner, itemId) {
  const row = await runner.one(
    `SELECT COALESCE(SUM(CASE WHEN transaction_type IN ('RECEIVED','ADJUSTMENT_IN') THEN quantity
              WHEN transaction_type IN ('ISSUED','RETURNED','DISCARD','ADJUSTMENT_OUT') THEN -quantity ELSE 0 END),0) AS balance
     FROM transactions WHERE item_id=?`, [itemId]);
  return Number(row.balance);
}
async function getLocationBalance(runner, itemId, location) {
  const loc = clean(location); if (!loc) return getCurrentBalance(runner, itemId);
  const row = await runner.one(
    `SELECT COALESCE(SUM(CASE
        WHEN transaction_type IN ('RECEIVED','ADJUSTMENT_IN')
          AND lower(trim(COALESCE(source_location, issue_location, destination_location, '')))=lower(trim(?)) THEN quantity
        WHEN transaction_type IN ('ISSUED','RETURNED','DISCARD','ADJUSTMENT_OUT')
          AND lower(trim(COALESCE(issue_location, source_location, destination_location, '')))=lower(trim(?)) THEN -quantity
        WHEN transaction_type='TRANSFER' AND lower(trim(COALESCE(destination_location,'')))=lower(trim(?)) THEN quantity
        WHEN transaction_type='TRANSFER' AND lower(trim(COALESCE(source_location,'')))=lower(trim(?)) THEN -quantity
        ELSE 0 END),0) AS balance
     FROM transactions WHERE item_id=?`, [loc, loc, loc, loc, itemId]);
  return Number(row.balance);
}
async function itemAvailability(itemId) {
  const rows = await db.many(
    `SELECT t.transaction_type, t.quantity, t.cost, t.brand, t.serial_no, v.name AS vendor,
            t.source_location, t.issue_location, t.destination_location
     FROM transactions t LEFT JOIN vendors v ON v.id=t.vendor_id
     WHERE t.item_id=?`, [itemId]);
  const byLoc = new Map();
  const bucket = (loc) => {
    const key = (String(loc || '').trim()) || 'UNSPECIFIED';
    let g = byLoc.get(key);
    if (!g) { g = { location: key, balance: 0, brands: new Set(), vendors: new Set(), serials: new Set(), costSum: 0, costN: 0 }; byLoc.set(key, g); }
    return g;
  };
  for (const r of rows) {
    const qty = Number(r.quantity);
    if (r.transaction_type === 'TRANSFER') {
      // moves stock: out of source, into destination
      bucket(r.source_location).balance -= qty;
      bucket(r.destination_location).balance += qty;
      continue;
    }
    const inflow = INFLOW.includes(r.transaction_type);
    const raw = inflow ? (r.source_location || r.issue_location || r.destination_location)
                       : (r.issue_location || r.source_location || r.destination_location);
    const g = bucket(raw);
    g.balance += inflow ? qty : -qty;
    if (r.brand) g.brands.add(r.brand);
    if (r.vendor) g.vendors.add(r.vendor);
    if (r.serial_no) g.serials.add(r.serial_no);
    if (Number(r.cost) > 0) { g.costSum += Number(r.cost); g.costN++; }
  }
  return [...byLoc.values()]
    .filter(g => round2(g.balance) > 0)
    .map(g => ({
      location: g.location, balance: round2(g.balance),
      brand: [...g.brands].join(', '), vendor: [...g.vendors].join(', '), serial_no: [...g.serials].join(', '),
      cost: g.costN ? round2(g.costSum / g.costN) : 0
    }))
    .sort((a, b) => a.location.localeCompare(b.location));
}

// Stock grouped by item + location (the "sum where item_code and location match").
async function stockByLocation() {
  const items = await stockStatus();
  const avg = await computeAverageCosts();
  const out = [];
  for (const it of items) {
    const rows = await itemAvailability(it.id);
    for (const r of rows) {
      const a = avg.get(it.id);
      const cost = a ? round2(a.avgCost) : 0;
      out.push({
        item_code: it.item_code, description: it.description, unit: it.unit || '',
        location: r.location, quantity: r.balance, avg_cost: cost, value: round2(r.balance * cost)
      });
    }
  }
  return out.sort((a, b) => a.item_code.localeCompare(b.item_code) || a.location.localeCompare(b.location));
}

// ---- stock status + valuation ----
async function stockStatus() {
  const rows = await db.many(
    `SELECT i.id, i.item_code, i.description, i.unit, i.type, c.name AS category, i.status, i.reorder_level,
       COALESCE(SUM(CASE WHEN t.transaction_type IN ('RECEIVED','ADJUSTMENT_IN') THEN t.quantity ELSE 0 END),0) AS total_received,
       COALESCE(SUM(CASE WHEN t.transaction_type='ISSUED' THEN t.quantity ELSE 0 END),0) AS total_issued,
       COALESCE(SUM(CASE WHEN t.transaction_type='RETURNED' THEN t.quantity ELSE 0 END),0) AS total_returned,
       COALESCE(SUM(CASE WHEN t.transaction_type='DISCARD' THEN t.quantity ELSE 0 END),0) AS total_discarded,
       COALESCE(SUM(CASE WHEN t.transaction_type IN ('RECEIVED','ADJUSTMENT_IN') THEN t.quantity
                WHEN t.transaction_type IN ('ISSUED','RETURNED','DISCARD','ADJUSTMENT_OUT') THEN -t.quantity ELSE 0 END),0) AS current_balance
     FROM items i LEFT JOIN categories c ON c.id=i.category_id LEFT JOIN transactions t ON t.item_id=i.id
     GROUP BY i.id, c.name ORDER BY i.item_code`);
  const avg = await computeAverageCosts();
  for (const r of rows) {
    r.current_balance = Number(r.current_balance);
    r.total_received = Number(r.total_received); r.total_issued = Number(r.total_issued);
    r.total_returned = Number(r.total_returned); r.total_discarded = Number(r.total_discarded);
    const a = avg.get(r.id);
    r.avg_cost = a ? round2(a.avgCost) : 0;
    r.inventory_value = round2(r.current_balance * r.avg_cost);
    r.below_reorder = Number(r.reorder_level) > 0 && r.current_balance <= Number(r.reorder_level);
  }
  return rows;
}
async function lowStockList() { return (await stockStatus()).filter(r => r.below_reorder); }

// ---- create transaction ----
async function createTransaction(input, userId, imagePath = null) {
  return db.tx(async (c) => {
    const item = await c.one('SELECT id, item_code, label_mode FROM items WHERE id=?', [input.itemId]);
    if (!item) throw new Error('Selected item does not exist.');
    const qty = posNum(input.quantity);
    const type = input.transactionType;
    if (!ALL_TYPES.includes(type)) throw new Error('Invalid transaction type.');

    let grnNo = clean(input.grnNo), issueOrderNo = clean(input.issueOrderNo);
    const txDate = input.transactionDate ? new Date(input.transactionDate).toISOString() : new Date().toISOString();
    if (type === 'RECEIVED' && !grnNo) grnNo = await nextDocumentNo(c, 'GRN', txDate);
    if (type === 'ISSUED' && !issueOrderNo) issueOrderNo = await nextDocumentNo(c, 'ISSUE', txDate);
    if (type === 'RETURNED' && !grnNo) throw new Error('Please select GRN number for return entry.');
    if (type === 'DISCARD' && !clean(input.discardReason)) throw new Error('Discard reason is required.');

    let refNo = clean(input.referenceNo);

    if (type === 'TRANSFER') {
      const from = clean(input.sourceLocation), to = clean(input.destinationLocation);
      if (!from || !to) throw new Error('Transfer requires both a From location and a To location/vessel/equipment.');
      if (from.toLowerCase() === to.toLowerCase()) throw new Error('From and To must be different.');
      if (!clean(input.notes)) throw new Error('A transfer note is required.');
      const lb = await getLocationBalance(c, input.itemId, from);
      if (qty > lb) throw new Error(`Insufficient stock at "${from}". Available there: ${lb}.`);
      if (!refNo) refNo = await nextDocumentNo(c, 'TRF', txDate);
    } else if (OUTFLOW.includes(type)) {
      if (['ISSUED', 'DISCARD', 'ADJUSTMENT_OUT'].includes(type)) {
        const loc = clean(input.issueLocation);
        if (!loc) throw new Error('From-location is required for issue / discard / adjustment-out.');
        const lb = await getLocationBalance(c, input.itemId, loc);
        if (qty > lb) throw new Error(`Insufficient stock at "${loc}". Available there: ${lb}.`);
      } else { // RETURNED (to vendor)
        const b = await getCurrentBalance(c, input.itemId);
        if (qty > b) throw new Error(`Insufficient stock. Available balance is ${b}.`);
      }
    } else if (type === 'ADJUSTMENT_IN') {
      if (!clean(input.sourceLocation)) throw new Error('Location is required for adjustment-in (where the stock is added).');
    }

    let cost = Number(input.cost || 0);
    if ((OUTFLOW.includes(type) || type === 'TRANSFER') && !(cost > 0)) cost = await currentAverageCost(c, input.itemId);

    const vendorId = await findOrCreateVendor(c, input.vendor);
    await findOrCreateLocation(c, input.sourceLocation);
    await findOrCreateLocation(c, input.issueLocation);
    await findOrCreateLocation(c, input.destinationLocation);

    const row = await c.one(
      `INSERT INTO transactions(item_id, transaction_type, quantity, transaction_date, grn_no, issue_order_no, reference_no,
        brand, vendor_id, manufacturer, serial_no, source_location, destination_location, issue_location, cost,
        reorder_quantity, discard_reason, condition_text, notes, image_path, user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      [input.itemId, type, qty, txDate, grnNo, issueOrderNo, refNo, clean(input.brand), vendorId,
       clean(input.manufacturer), clean(input.serialNo), clean(input.sourceLocation), clean(input.destinationLocation),
       clean(input.issueLocation), cost, Number(input.reorderQuantity || 0), clean(input.discardReason),
       clean(input.conditionText), clean(input.notes), imagePath, userId]);
    if (type === 'RECEIVED' && item.item_code) {
      await labelRepo.generateReceiptLabels(c, { itemId: item.id, itemCode: item.item_code, qty,
        labelMode: item.label_mode || 'unit', transactionId: row.id, location: clean(input.sourceLocation), userId });
    }
    return row.id;
  });
}

// ---- ledger / listings ----
const listTransactions = (limit = 100, offset = 0) => db.many(
  `SELECT t.*, i.item_code, i.description, u.username, v.name AS vendor
   FROM transactions t JOIN items i ON i.id=t.item_id JOIN users u ON u.id=t.user_id LEFT JOIN vendors v ON v.id=t.vendor_id
   ORDER BY t.transaction_date DESC, t.id DESC LIMIT ? OFFSET ?`, [limit, offset]);
async function countTransactions() { return Number((await db.one('SELECT COUNT(*) AS c FROM transactions')).c); }

async function itemLedger(itemId) {
  const rows = await db.many(
    `SELECT t.*, v.name AS vendor, u.username FROM transactions t
     LEFT JOIN vendors v ON v.id=t.vendor_id JOIN users u ON u.id=t.user_id
     WHERE t.item_id=? ORDER BY t.transaction_date ASC, t.id ASC`, [itemId]);
  let running = 0;
  for (const r of rows) { running += INFLOW.includes(r.transaction_type) ? Number(r.quantity) : (OUTFLOW.includes(r.transaction_type) ? -Number(r.quantity) : 0); r.running_balance = round2(running); }
  return rows.reverse();
}
const grnList = () => db.many(
  `SELECT grn_no, MIN(transaction_date) AS transaction_date, COUNT(*) AS line_count
   FROM transactions WHERE transaction_type='RECEIVED' AND grn_no IS NOT NULL AND grn_no <> ''
   GROUP BY grn_no ORDER BY grn_no DESC`);
const grnItems = (grnNo) => db.many(
  `SELECT t.id AS transaction_id, t.item_id, i.item_code, i.description, t.quantity, t.brand, v.name AS vendor,
     t.manufacturer, t.serial_no, t.source_location, t.cost, t.reorder_quantity
   FROM transactions t JOIN items i ON i.id=t.item_id LEFT JOIN vendors v ON v.id=t.vendor_id
   WHERE t.transaction_type='RECEIVED' AND t.grn_no=? ORDER BY i.item_code`, [grnNo]);

async function dashboardStats() {
  const rows = await stockStatus();
  return {
    totalItems: rows.length,
    activeItems: rows.filter(r => r.status === 'active').length,
    lowStock: rows.filter(r => r.below_reorder).length,
    totalValue: round2(rows.reduce((s, r) => s + Number(r.inventory_value || 0), 0))
  };
}

// Low-level RECEIVED insert used by the procurement module when receiving goods
// against a purchase order. All received lines in one action share a GRN.
async function insertReceipt(c, input, userId) {
  const vendorId = input.vendorId || await findOrCreateVendor(c, input.vendor);
  await findOrCreateLocation(c, input.location);
  const it = await c.one('SELECT item_code, label_mode FROM items WHERE id=?', [input.itemId]);
  const row = await c.one(
    `INSERT INTO transactions(item_id, transaction_type, quantity, transaction_date, grn_no, reference_no,
       vendor_id, source_location, cost, notes, user_id)
     VALUES (?, 'RECEIVED', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [input.itemId, Number(input.quantity), new Date().toISOString(), input.grnNo, clean(input.referenceNo),
     vendorId, clean(input.location), Number(input.cost || 0), clean(input.notes), userId]);
  if (it && it.item_code) {
    await labelRepo.generateReceiptLabels(c, { itemId: input.itemId, itemCode: it.item_code, qty: Number(input.quantity),
      labelMode: it.label_mode || 'unit', transactionId: row.id, location: clean(input.location), userId });
  }
  return row.id;
}

async function listItemsWithBalance() {
  return (await stockStatus()).map(r => ({ id: r.id, item_code: r.item_code, description: r.description, unit: r.unit, balance: r.current_balance }));
}

module.exports = {
  peekNextDocumentNo, nextDocumentNo, createItem, updateItem, getItem, listItems, listVendors, listCategories, listLocations,
  stockStatus, lowStockList, itemAvailability, createTransaction, listTransactions, countTransactions,
  itemLedger, grnList, grnItems, dashboardStats, insertReceipt, listItemsWithBalance, stockByLocation,
  listItemCategories, listSubcategories, listAllSubcategories, generateItemCode
};
