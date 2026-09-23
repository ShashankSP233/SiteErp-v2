const db = require('../config/db');
const clean = (v) => { if (v === undefined || v === null) return null; const s = String(v).trim(); return s || null; };

async function listVendors() {
  return db.many(`SELECT v.*,
      COALESCE((SELECT SUM(b.total) FROM bills b WHERE b.vendor_id=v.id AND b.status IN ('approved','part_paid','paid')),0)
      - COALESCE((SELECT SUM(p.amount) FROM payments p JOIN bills b ON b.id=p.bill_id WHERE b.vendor_id=v.id),0) AS outstanding
    FROM vendors v ORDER BY v.name`);
}
const getVendor = (id) => db.one('SELECT * FROM vendors WHERE id=?', [id]);

async function createVendor(input) {
  const name = clean(input.name);
  if (!name) throw new Error('Vendor name is required.');
  const row = await db.one(
    `INSERT INTO vendors(name, contact_name, email, mobile, phone, address, gstin, notes)
     VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
    [name, clean(input.contactName), clean(input.email), clean(input.mobile), clean(input.phone),
     clean(input.address), clean(input.gstin), clean(input.notes)]);
  return row.id;
}
async function updateVendor(id, input) {
  await db.query(
    `UPDATE vendors SET name=?, contact_name=?, email=?, mobile=?, phone=?, address=?, gstin=?, notes=? WHERE id=?`,
    [clean(input.name), clean(input.contactName), clean(input.email), clean(input.mobile), clean(input.phone),
     clean(input.address), clean(input.gstin), clean(input.notes), id]);
}
module.exports = { listVendors, getVendor, createVendor, updateVendor };
