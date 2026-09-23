const db = require('../config/db');
const inv = require('./inventoryRepo');
const { round2 } = require('../utils/finance');
const clean = (v) => { if (v === undefined || v === null) return null; const s = String(v).trim(); return s || null; };

async function findOrCreateVendor(c, name) {
  const n = clean(name); if (!n) return null;
  const row = await c.one(`INSERT INTO vendors(name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=excluded.name RETURNING id`, [n]);
  return row.id;
}

// input: { vendor, poDate, deliveryTo, notes, lines: [{itemId, quantity, rate, notes}] }
async function createPO(input, userId) {
  const lines = (input.lines || []).filter(l => Number(l.quantity) > 0 && l.itemId);
  if (!lines.length) throw new Error('Add at least one item line with a quantity.');
  return db.tx(async (c) => {
    const poNo = await inv.nextDocumentNo(c, 'PO', new Date());
    const vendorId = await findOrCreateVendor(c, input.vendor);
    const po = await c.one(
      `INSERT INTO purchase_orders(po_no, vendor_id, po_date, delivery_to, status, notes, attachment, created_by)
       VALUES (?,?,?,?, 'submitted', ?, ?, ?) RETURNING id`,
      [poNo, vendorId, input.poDate || new Date().toISOString().slice(0, 10), clean(input.deliveryTo), clean(input.notes), clean(input.attachment), userId || null]);
    for (const l of lines) {
      await c.query(
        `INSERT INTO po_lines(po_id, item_id, quantity, rate, notes) VALUES (?,?,?,?,?)`,
        [po.id, Number(l.itemId), Number(l.quantity), Number(l.rate || 0), clean(l.notes)]);
    }
    return po.id;
  });
}

async function listPOs(limit = 100, offset = 0) {
  return db.many(
    `SELECT po.*, v.name AS vendor,
       (SELECT COUNT(*) FROM po_lines l WHERE l.po_id=po.id) AS line_count,
       (SELECT COALESCE(SUM(l.quantity*l.rate),0) FROM po_lines l WHERE l.po_id=po.id) AS po_value
     FROM purchase_orders po LEFT JOIN vendors v ON v.id=po.vendor_id
     ORDER BY po.po_date DESC, po.id DESC LIMIT ? OFFSET ?`, [limit, offset]);
}
async function countPOs() { return Number((await db.one('SELECT COUNT(*) AS c FROM purchase_orders')).c); }

async function getPO(id) {
  const po = await db.one(
    `SELECT po.*, v.name AS vendor, cu.username AS created_by_name, au.username AS approved_by_name
     FROM purchase_orders po LEFT JOIN vendors v ON v.id=po.vendor_id
     LEFT JOIN users cu ON cu.id=po.created_by LEFT JOIN users au ON au.id=po.approved_by WHERE po.id=?`, [id]);
  if (!po) return null;
  const lines = await db.many(
    `SELECT l.*, i.item_code, i.description, i.unit, (l.quantity - l.received_qty) AS pending
     FROM po_lines l JOIN items i ON i.id=l.item_id WHERE l.po_id=? ORDER BY l.id`, [id]);
  po.lines = lines;
  po.value = round2(lines.reduce((s, l) => s + Number(l.quantity) * Number(l.rate), 0));
  po.fully_received = lines.length > 0 && lines.every(l => Number(l.received_qty) >= Number(l.quantity));
  return po;
}

async function setPOStatus(id, status, userId, remarks) {
  if (!['approved', 'rejected', 'cancelled'].includes(status)) throw new Error('Invalid PO action.');
  const po = await db.one('SELECT status FROM purchase_orders WHERE id=?', [id]);
  if (!po) throw new Error('Purchase order not found.');
  if (status !== 'cancelled' && po.status !== 'submitted') throw new Error(`Only submitted POs can be approved/rejected (current: ${po.status}).`);
  await db.query(
    `UPDATE purchase_orders SET status=?, approved_by=?, approved_at=CURRENT_TIMESTAMP, approval_remarks=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    [status, userId, clean(remarks), id]);
}

// receipts: [{ lineId, receiveQty, location }]
async function receiveAgainstPO(id, receipts, userId) {
  const toReceive = (receipts || []).filter(r => Number(r.receiveQty) > 0);
  if (!toReceive.length) throw new Error('Enter a quantity to receive for at least one line.');
  return db.tx(async (c) => {
    const po = await c.one('SELECT * FROM purchase_orders WHERE id=?' + db.rowLock, [id]);
    if (!po) throw new Error('Purchase order not found.');
    if (!['approved', 'partially_received'].includes(po.status)) {
      throw new Error(`Goods can only be received against an approved PO (current: ${po.status}).`);
    }
    const grnNo = await inv.nextDocumentNo(c, 'GRN', new Date());
    for (const r of toReceive) {
      const line = await c.one('SELECT * FROM po_lines WHERE id=? AND po_id=?', [r.lineId, id]);
      if (!line) throw new Error('PO line not found.');
      const pending = Number(line.quantity) - Number(line.received_qty);
      const qty = Number(r.receiveQty);
      if (qty > pending + 0.001) throw new Error(`Cannot receive ${qty} for ${line.item_id}; only ${pending} pending.`);
      await inv.insertReceipt(c, {
        itemId: line.item_id, quantity: qty, cost: line.rate, vendorId: po.vendor_id,
        location: r.location || po.delivery_to, grnNo, referenceNo: po.po_no, notes: `Against PO ${po.po_no}`
      }, userId);
      await c.query('UPDATE po_lines SET received_qty = received_qty + ? WHERE id=?', [qty, line.id]);
    }
    const lines = await c.many('SELECT quantity, received_qty FROM po_lines WHERE po_id=?', [id]);
    const allDone = lines.every(l => Number(l.received_qty) >= Number(l.quantity));
    await c.query('UPDATE purchase_orders SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      [allDone ? 'received' : 'partially_received', id]);
    return { grnNo, status: allDone ? 'received' : 'partially_received' };
  });
}

async function poStats() {
  const row = await db.one(
    `SELECT COUNT(*) FILTER (WHERE status='submitted') AS pending_po,
            COUNT(*) FILTER (WHERE status IN ('approved','partially_received')) AS open_po
     FROM purchase_orders`);
  return { pendingPO: Number(row.pending_po || 0), openPO: Number(row.open_po || 0) };
}

module.exports = { createPO, listPOs, countPOs, getPO, setPOStatus, receiveAgainstPO, poStats };
