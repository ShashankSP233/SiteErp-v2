const db = require('../config/db');
const clean = (v) => { if (v === undefined || v === null) return null; const s = String(v).trim(); return s || null; };
const MAX_UNIT_LABELS = 1000; // safety cap for per-unit generation in one receipt

function fmtCode(itemCode, year, serial) {
  return `${itemCode}-${String(year).slice(-2)}-${String(serial).padStart(4, '0')}`;
}
// Per-(item, calendar year) running serial; continues across receipts, resets each year.
async function nextLabelSerial(c, itemCode, year) {
  const row = await c.one(
    `INSERT INTO sequence_counters(name, financial_year, last_number) VALUES (?,?,1)
     ON CONFLICT (name, financial_year) DO UPDATE SET last_number = sequence_counters.last_number + 1
     RETURNING last_number`, ['LBL:' + itemCode, String(year)]);
  return Number(row.last_number);
}

async function insertLabel(c, o) {
  await c.query(
    `INSERT INTO labels(label_code, item_id, item_code, year, serial, qty, label_mode, transaction_id, location, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [o.code, o.itemId, o.itemCode, o.year, o.serial, o.qty, o.labelMode, o.transactionId || null, clean(o.location), o.userId || null]);
}

// Generate labels for a received quantity. Per-unit -> one label per unit;
// per-batch -> a single label carrying the quantity. Runs inside caller's tx.
async function generateReceiptLabels(c, { itemId, itemCode, qty, labelMode, transactionId, location, userId }) {
  const year = new Date().getFullYear();
  const codes = [];
  if (labelMode === 'batch') {
    const serial = await nextLabelSerial(c, itemCode, year);
    const code = fmtCode(itemCode, year, serial);
    await insertLabel(c, { code, itemId, itemCode, year, serial, qty: Number(qty), labelMode, transactionId, location, userId });
    codes.push(code);
  } else {
    const n = Math.min(Math.floor(Number(qty)), MAX_UNIT_LABELS);
    for (let i = 0; i < n; i++) {
      const serial = await nextLabelSerial(c, itemCode, year);
      const code = fmtCode(itemCode, year, serial);
      await insertLabel(c, { code, itemId, itemCode, year, serial, qty: 1, labelMode, transactionId, location, userId });
      codes.push(code);
    }
  }
  return codes;
}

// Manual generation (label existing stock) — opens its own transaction.
async function generateForItem({ itemId, qty, location, userId }) {
  return db.tx(async (c) => {
    const it = await c.one('SELECT id, item_code, label_mode FROM items WHERE id=?', [itemId]);
    if (!it) throw new Error('Item not found.');
    if (!it.item_code) throw new Error('Item has no code.');
    if (!(Number(qty) > 0)) throw new Error('Quantity must be greater than zero.');
    return generateReceiptLabels(c, { itemId: it.id, itemCode: it.item_code, qty, labelMode: it.label_mode || 'unit', location, userId });
  });
}

async function listLabels({ itemId, onlyUnprinted, limit = 500 } = {}) {
  const where = [], params = [];
  if (itemId) { where.push('l.item_id=?'); params.push(itemId); }
  if (onlyUnprinted) where.push('l.printed_at IS NULL');
  const sql = `SELECT l.*, i.description FROM labels l JOIN items i ON i.id=l.item_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY l.created_at DESC, l.id DESC LIMIT ?`;
  params.push(limit);
  return db.many(sql, params);
}
async function getByCodes(codes) {
  if (!codes || !codes.length) return [];
  const ph = codes.map(() => '?').join(',');
  return db.many(`SELECT l.*, i.description FROM labels l JOIN items i ON i.id=l.item_id WHERE l.label_code IN (${ph}) ORDER BY l.item_code, l.serial`, codes);
}
async function getByCode(code) {
  return db.one(`SELECT l.*, i.description, i.label_mode AS item_label_mode FROM labels l JOIN items i ON i.id=l.item_id WHERE l.label_code=?`, [clean(code)]);
}
async function markPrinted(codes) {
  if (!codes || !codes.length) return;
  const ph = codes.map(() => '?').join(',');
  await db.query(`UPDATE labels SET printed_at=CURRENT_TIMESTAMP WHERE label_code IN (${ph}) AND printed_at IS NULL`, codes);
}

module.exports = { generateReceiptLabels, generateForItem, listLabels, getByCodes, getByCode, markPrinted, fmtCode };
