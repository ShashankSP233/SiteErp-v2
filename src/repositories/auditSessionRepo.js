const db = require('../config/db');
const label = require('./labelRepo');
const { round2 } = require('../utils/finance');
const clean = (v) => { if (v === undefined || v === null) return null; const s = String(v).trim(); return s || null; };

async function createSession({ name, location, period, notes, userId }) {
  const n = clean(name); if (!n) throw new Error('Audit name is required.');
  const row = await db.one(
    `INSERT INTO audit_session(name, location, period, notes, started_by) VALUES (?,?,?,?,?) RETURNING id`,
    [n, clean(location), clean(period), clean(notes), userId || null]);
  return row.id;
}
const listSessions = () => db.many(
  `SELECT s.*, su.username AS started_by_name, cu.username AS closed_by_name,
     (SELECT COUNT(*) FROM audit_scan a WHERE a.session_id=s.id) AS scan_count
   FROM audit_session s LEFT JOIN users su ON su.id=s.started_by LEFT JOIN users cu ON cu.id=s.closed_by
   ORDER BY s.started_at DESC`);
const getSession = (id) => db.one(
  `SELECT s.*, su.username AS started_by_name, cu.username AS closed_by_name
   FROM audit_session s LEFT JOIN users su ON su.id=s.started_by LEFT JOIN users cu ON cu.id=s.closed_by WHERE s.id=?`, [id]);
const listScans = (sessionId) => db.many(
  `SELECT a.*, u.username FROM audit_scan a LEFT JOIN users u ON u.id=a.scanned_by
   WHERE a.session_id=? ORDER BY a.scanned_at DESC, a.id DESC`, [sessionId]);

// Record one scan; classify against ERP labels and audit scope.
async function recordScan(sessionId, code, userId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error('Audit session not found.');
  if (session.status !== 'open') throw new Error('This audit is closed.');
  const scanned = clean(code);
  if (!scanned) throw new Error('Empty scan.');

  const lab = await label.getByCode(scanned);
  const already = await db.one('SELECT id FROM audit_scan WHERE session_id=? AND scanned_code=?', [sessionId, scanned]);

  let result;
  if (already) result = 'duplicate';
  else if (!lab) result = 'unknown';
  else if (session.location && String(lab.location || '').toLowerCase() !== String(session.location).toLowerCase()) result = 'unexpected';
  else result = 'matched';

  await db.query(
    `INSERT INTO audit_scan(session_id, scanned_code, label_id, item_id, item_code, result, location, scanned_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [sessionId, scanned, lab ? lab.id : null, lab ? lab.item_id : null, lab ? lab.item_code : null, result, lab ? lab.location : null, userId || null]);

  return { result, code: scanned, item_code: lab ? lab.item_code : null, description: lab ? lab.description : null, qty: lab ? Number(lab.qty) : null, location: lab ? lab.location : null };
}

async function closeSession(id, userId) {
  const s = await getSession(id);
  if (!s) throw new Error('Audit session not found.');
  if (s.status === 'closed') throw new Error('Audit is already closed.');
  await db.query('UPDATE audit_session SET status=?, closed_by=?, closed_at=CURRENT_TIMESTAMP WHERE id=?', ['closed', userId, id]);
}

// Reconcile the physical scan against the ledger (inventory report):
// scanned quantity per item vs book stock per item, with discrepancy and value.
async function reconcile(sessionId) {
  const session = await getSession(sessionId);
  const inv = require('./inventoryRepo');

  // Physical: sum of scanned label quantities per item (per-unit label = 1,
  // per-batch label = its quantity). Duplicates and unknowns excluded.
  const scanned = await db.many(
    `SELECT s.item_code, l.qty, i.description
     FROM audit_scan s JOIN labels l ON l.id=s.label_id JOIN items i ON i.id=s.item_id
     WHERE s.session_id=? AND s.result IN ('matched','unexpected')`, [sessionId]);
  const scannedByItem = new Map();
  for (const s of scanned) {
    let g = scannedByItem.get(s.item_code) || { scanned_qty: 0, description: s.description };
    g.scanned_qty += Number(s.qty) || 0; scannedByItem.set(s.item_code, g);
  }

  // Book: ledger stock per item (scoped to the audit location if set).
  const ledgerByItem = new Map();
  if (session.location) {
    const rows = await inv.stockByLocation();
    for (const r of rows) {
      if (String(r.location).toLowerCase() !== String(session.location).toLowerCase()) continue;
      ledgerByItem.set(r.item_code, { ledger_qty: Number(r.quantity), avg_cost: Number(r.avg_cost), description: r.description });
    }
  } else {
    const rows = await inv.stockStatus();
    for (const r of rows) ledgerByItem.set(r.item_code, { ledger_qty: Number(r.current_balance), avg_cost: Number(r.avg_cost), description: r.description });
  }

  const codes = new Set([...scannedByItem.keys(), ...ledgerByItem.keys()]);
  const rows = [];
  let ledgerValue = 0, scannedValue = 0, missingValue = 0, excessValue = 0, discrepItems = 0;
  for (const code of codes) {
    const b = ledgerByItem.get(code) || { ledger_qty: 0, avg_cost: 0, description: null };
    const p = scannedByItem.get(code) || { scanned_qty: 0, description: null };
    const ledgerQty = round2(b.ledger_qty), scannedQty = round2(p.scanned_qty), cost = round2(b.avg_cost || 0);
    const discrepancy = round2(scannedQty - ledgerQty);
    const missing = discrepancy < 0 ? -discrepancy : 0;
    const excess = discrepancy > 0 ? discrepancy : 0;
    if (discrepancy !== 0) discrepItems++;
    ledgerValue += ledgerQty * cost; scannedValue += scannedQty * cost;
    missingValue += missing * cost; excessValue += excess * cost;
    rows.push({
      item_code: code, description: b.description || p.description || '', ledger_qty: ledgerQty, scanned_qty: scannedQty,
      discrepancy, avg_cost: cost, missing_value: round2(missing * cost), excess_value: round2(excess * cost),
      discrepancy_value: round2(discrepancy * cost)
    });
  }
  rows.sort((a, b) => Math.abs(b.discrepancy_value) - Math.abs(a.discrepancy_value) || a.item_code.localeCompare(b.item_code));

  const scans = await listScans(sessionId);
  const unknownScans = scans.filter(s => s.result === 'unknown');

  return {
    session, rows,
    totals: {
      ledgerValue: round2(ledgerValue), scannedValue: round2(scannedValue),
      missingValue: round2(missingValue), excessValue: round2(excessValue),
      netValue: round2(scannedValue - ledgerValue), discrepItems, itemsCounted: rows.length
    },
    unknownScans,
    scanCounts: scans.reduce((a, s) => { a[s.result] = (a[s.result] || 0) + 1; return a; }, {})
  };
}

module.exports = { createSession, listSessions, getSession, listScans, recordScan, closeSession, reconcile };
