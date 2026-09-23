const db = require('../config/db');
const { round2 } = require('../utils/finance');

const clean = (v) => { if (v === undefined || v === null) return null; const s = String(v).trim(); return s || null; };
function posNum(v, field = 'Amount') { const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new Error(`${field} must be greater than zero.`); return n; }

async function findOrCreateVendor(c, name) {
  const n = clean(name); if (!n) return null;
  const row = await c.one(`INSERT INTO vendors(name) VALUES (?)
    ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [n]);
  return row.id;
}

// ---- create a bill ----
async function createBill(input, userId) {
  return db.tx(async (c) => {
    const billNo = clean(input.billNo);
    if (!billNo) throw new Error('Bill number is required.');
    const amount = Number(input.amount || 0);
    const tax = Number(input.tax || 0);
    if (amount <= 0) throw new Error('Bill amount must be greater than zero.');
    const total = round2(amount + tax);
    const vendorId = await findOrCreateVendor(c, input.vendor);
    const row = await c.one(
      `INSERT INTO bills(bill_no, vendor_id, bill_date, grn_no, amount, tax, total, status, notes, attachment, created_by)
       VALUES (?,?,?,?,?,?,?,'submitted',?,?,?) RETURNING id`,
      [billNo, vendorId, input.billDate || new Date().toISOString().slice(0, 10), clean(input.grnNo),
       amount, tax, total, clean(input.notes), clean(input.attachment), userId || null]);
    return row.id;
  });
}

// ---- listings ----
async function listBills(limit = 100, offset = 0) {
  return db.many(
    `SELECT b.*, v.name AS vendor,
       COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.bill_id=b.id),0) AS paid
     FROM bills b LEFT JOIN vendors v ON v.id=b.vendor_id
     ORDER BY b.bill_date DESC, b.id DESC LIMIT ? OFFSET ?`, [limit, offset]);
}
async function countBills() { return Number((await db.one('SELECT COUNT(*) AS c FROM bills')).c); }

async function getBill(id) {
  const bill = await db.one(
    `SELECT b.*, v.name AS vendor, cu.username AS created_by_name, au.username AS approved_by_name
     FROM bills b LEFT JOIN vendors v ON v.id=b.vendor_id
     LEFT JOIN users cu ON cu.id=b.created_by LEFT JOIN users au ON au.id=b.approved_by
     WHERE b.id=?`, [id]);
  if (!bill) return null;
  const payments = await db.many(
    `SELECT p.*, u.username FROM payments p LEFT JOIN users u ON u.id=p.created_by
     WHERE p.bill_id=? ORDER BY p.payment_date ASC, p.id ASC`, [id]);
  const paid = round2(payments.reduce((s, p) => s + Number(p.amount), 0));
  bill.paid = paid;
  bill.outstanding = round2(Number(bill.total) - paid);
  bill.payments = payments;
  return bill;
}

// ---- approval workflow ----
async function setBillStatus(id, status, userId, remarks) {
  if (!['approved', 'rejected'].includes(status)) throw new Error('Invalid approval action.');
  const bill = await db.one('SELECT status FROM bills WHERE id=?', [id]);
  if (!bill) throw new Error('Bill not found.');
  if (bill.status !== 'submitted') throw new Error(`Only submitted bills can be approved or rejected (current: ${bill.status}).`);
  await db.query(
    `UPDATE bills SET status=?, approved_by=?, approved_at=CURRENT_TIMESTAMP, approval_remarks=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    [status, userId, clean(remarks), id]);
}

// ---- payments ----
async function addPayment(billId, input, userId) {
  return db.tx(async (c) => {
    const bill = await c.one('SELECT * FROM bills WHERE id=?' + db.rowLock, [billId]);
    if (!bill) throw new Error('Bill not found.');
    if (!['approved', 'part_paid'].includes(bill.status)) {
      throw new Error(`Payments can only be recorded against an approved bill (current: ${bill.status}).`);
    }
    const paidRow = await c.one('SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE bill_id=?', [billId]);
    const outstanding = round2(Number(bill.total) - Number(paidRow.paid));
    const amount = posNum(input.amount);
    if (amount > outstanding + 0.001) throw new Error(`Payment exceeds outstanding amount (${outstanding}).`);

    await c.query(
      `INSERT INTO payments(bill_id, amount, mode, payment_date, reference_no, notes, created_by)
       VALUES (?,?,?,?,?,?,?)`,
      [billId, amount, input.mode || 'bank', input.paymentDate || new Date().toISOString().slice(0, 10),
       clean(input.referenceNo), clean(input.notes), userId || null]);

    const newOutstanding = round2(outstanding - amount);
    const newStatus = newOutstanding <= 0.001 ? 'paid' : 'part_paid';
    await c.query('UPDATE bills SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [newStatus, billId]);
    return newStatus;
  });
}

// ---- summaries ----
async function pendingApprovals() {
  return db.many(
    `SELECT b.*, v.name AS vendor FROM bills b LEFT JOIN vendors v ON v.id=b.vendor_id
     WHERE b.status='submitted' ORDER BY b.bill_date ASC`);
}
async function vendorPayables() {
  return db.many(
    `SELECT v.name AS vendor,
       COALESCE(SUM(b.total),0) AS billed,
       COALESCE(SUM(b.total),0) - COALESCE(SUM(p.paid),0) AS outstanding
     FROM bills b LEFT JOIN vendors v ON v.id=b.vendor_id
     LEFT JOIN (SELECT bill_id, SUM(amount) AS paid FROM payments GROUP BY bill_id) p ON p.bill_id=b.id
     WHERE b.status IN ('approved','part_paid','paid')
     GROUP BY v.name HAVING COALESCE(SUM(b.total),0) - COALESCE(SUM(p.paid),0) > 0
     ORDER BY outstanding DESC`);
}
async function billStats() {
  const row = await db.one(
    `SELECT
       COUNT(*) AS total_bills,
       COUNT(*) FILTER (WHERE status='submitted') AS pending_approvals,
       COALESCE(SUM(total) FILTER (WHERE status IN ('approved','part_paid','paid')),0) AS approved_total,
       COALESCE((SELECT SUM(amount) FROM payments),0) AS total_paid
     FROM bills`);
  const outstanding = round2(Number(row.approved_total) - Number(row.total_paid));
  return {
    totalBills: Number(row.total_bills),
    pendingApprovals: Number(row.pending_approvals),
    totalPaid: round2(Number(row.total_paid)),
    outstanding: outstanding < 0 ? 0 : outstanding
  };
}

module.exports = {
  createBill, listBills, countBills, getBill, setBillStatus, addPayment,
  pendingApprovals, vendorPayables, billStats
};
