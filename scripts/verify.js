// End-to-end self-test of the real repositories against the local engine.
// Usage: npm run verify
const db = require('../src/config/db');
const { runMigrations, ensureAdmin } = require('../src/db/setup');
const inv = require('../src/repositories/inventoryRepo');
const bill = require('../src/repositories/billRepo');
const { authenticate } = require('../src/repositories/userRepo');

let n = 0; const ok = (m) => { n++; console.log('  ok  -', m); };

(async () => {
  await runMigrations();
  await ensureAdmin();
  ok(`migrations + admin seeded (backend: ${db.backend})`);

  const admin = await authenticate('admin', 'admin123');
  if (!admin || admin.role !== 'admin') throw new Error('admin auth failed');
  ok('admin authenticates; password hash not leaked: ' + (admin.password_hash === undefined));
  const uid = admin.id;

  // Inventory
  const boltId = await inv.createItem({ description: 'M8 Bolt', unit: 'Nos', type: 'Consumable', category: 'Hardware', reorderLevel: 20 }, uid);
  await inv.createTransaction({ itemId: boltId, transactionType: 'RECEIVED', quantity: 100, cost: 10, sourceLocation: 'Site A' }, uid);
  await inv.createTransaction({ itemId: boltId, transactionType: 'RECEIVED', quantity: 100, cost: 20, sourceLocation: 'Site B' }, uid);
  const status1 = (await inv.stockStatus()).find(r => Number(r.id) === Number(boltId));
  if (Number(status1.current_balance) !== 200) throw new Error('balance != 200');
  if (Number(status1.avg_cost) !== 15) throw new Error('WAC != 15, got ' + status1.avg_cost);
  if (Number(status1.inventory_value) !== 3000) throw new Error('value != 3000');
  ok('two receipts: balance 200, weighted-avg cost 15, value 3000');

  const avail = await inv.itemAvailability(boltId);
  const a = avail.find(x => x.location === 'Site A');
  if (!a || Number(a.balance) !== 100) throw new Error('Site A availability wrong');
  ok('per-location availability: Site A = 100');

  await inv.createTransaction({ itemId: boltId, transactionType: 'ISSUED', quantity: 30, issueLocation: 'Site A' }, uid);
  let blocked = false;
  try { await inv.createTransaction({ itemId: boltId, transactionType: 'ISSUED', quantity: 5, issueLocation: 'Site C' }, uid); }
  catch (e) { blocked = /Insufficient stock at "Site C"/.test(e.message); }
  if (!blocked) throw new Error('issue from empty location not blocked');
  ok('issue 30 from Site A; issue from empty Site C rejected');

  // Low stock
  await inv.createTransaction({ itemId: boltId, transactionType: 'ISSUED', quantity: 70, issueLocation: 'Site A' }, uid);
  await inv.createTransaction({ itemId: boltId, transactionType: 'ISSUED', quantity: 85, issueLocation: 'Site B' }, uid);
  if (!(await inv.lowStockList()).some(r => Number(r.id) === Number(boltId))) throw new Error('low-stock not flagged');
  ok('low-stock alert fires at balance 15 (reorder 20)');

  // Ledger running balance
  const led = await inv.itemLedger(boltId);
  if (Number(led[0].running_balance) !== 15) throw new Error('running balance != 15');
  ok('item ledger running balance ends at 15');

  // GRN numbering
  const grns = await inv.grnList();
  if (!grns.length || !/^\d{9}$/.test(grns[0].grn_no)) throw new Error('GRN numbering wrong');
  ok(`GRN auto-numbered (${grns[0].grn_no})`);

  // Bills -> approval -> payment
  const billId = await bill.createBill({ billNo: 'INV-001', vendor: 'Acme Supplies', amount: 1000, tax: 180 }, uid);
  let b = await bill.getBill(billId);
  if (Number(b.total) !== 1180 || b.status !== 'submitted') throw new Error('bill total/status wrong');
  ok('bill created: total 1180, status submitted');

  let payBlocked = false;
  try { await bill.addPayment(billId, { amount: 100, mode: 'bank' }, uid); }
  catch (e) { payBlocked = /approved bill/.test(e.message); }
  if (!payBlocked) throw new Error('payment before approval not blocked');
  ok('payment blocked before approval');

  await bill.setBillStatus(billId, 'approved', uid, 'ok');
  await bill.addPayment(billId, { amount: 500, mode: 'bank' }, uid);
  b = await bill.getBill(billId);
  if (b.status !== 'part_paid' || Number(b.outstanding) !== 680) throw new Error('part-payment wrong: ' + b.status + '/' + b.outstanding);
  ok('approved; paid 500 -> part_paid, outstanding 680');

  await bill.addPayment(billId, { amount: 680, mode: 'upi' }, uid);
  b = await bill.getBill(billId);
  if (b.status !== 'paid' || Number(b.outstanding) !== 0) throw new Error('full-payment wrong');
  ok('paid remainder -> status paid, outstanding 0');

  let overpay = false;
  const b2 = await bill.createBill({ billNo: 'INV-002', vendor: 'Acme Supplies', amount: 100 }, uid);
  await bill.setBillStatus(b2, 'approved', uid, '');
  try { await bill.addPayment(b2, { amount: 500, mode: 'cash' }, uid); } catch (e) { overpay = /exceeds outstanding/.test(e.message); }
  if (!overpay) throw new Error('overpayment not blocked');
  ok('overpayment rejected');

  const payables = await bill.vendorPayables();
  if (!payables.some(p => p.vendor === 'Acme Supplies' && Number(p.outstanding) === 100)) throw new Error('payables wrong');
  ok('vendor payables: Acme outstanding 100');

  const bs = await bill.billStats();
  if (bs.pendingApprovals !== 0) throw new Error('pending approvals should be 0');
  ok(`bill stats: ${bs.totalBills} bills, outstanding ${bs.outstanding}`);

  // ---- V6: master-data enrichment ----
  const po = require('../src/repositories/poRepo');
  const vendorRepo = require('../src/repositories/vendorRepo');
  const cementId = await inv.createItem({ description: 'Cement OPC 53', unit: 'Bag', type: 'Material', category: 'Civil',
    hsnCode: '2523', gstRate: 28, minLevel: 50, maxLevel: 500, reorderLevel: 100 }, uid);
  const it = await inv.getItem(cementId);
  if (it.hsn_code !== '2523' || Number(it.gst_rate) !== 28 || Number(it.min_level) !== 50) throw new Error('item enrichment not stored');
  ok('item master enrichment stored (HSN 2523, GST 28%, min 50)');

  // vendor master detail
  const vId = await vendorRepo.createVendor({ name: 'BuildWell Traders', contactName: 'R. Kumar', mobile: '9990001111', gstin: '29ABCDE1234F1Z5' });
  const ven = await vendorRepo.getVendor(vId);
  if (ven.gstin !== '29ABCDE1234F1Z5' || ven.mobile !== '9990001111') throw new Error('vendor detail not stored');
  ok('vendor master detail stored (GSTIN, mobile, contact)');

  // ---- V6: procurement PO -> approve -> receive -> stock ----
  const poId = await po.createPO({ vendor: 'BuildWell Traders', deliveryTo: 'Site A', lines: [
    { itemId: cementId, quantity: 100, rate: 350 }, { itemId: boltId, quantity: 50, rate: 12 }
  ] }, uid);
  let poDoc = await po.getPO(poId);
  if (poDoc.status !== 'submitted' || poDoc.lines.length !== 2 || Number(poDoc.value) !== 100 * 350 + 50 * 12) throw new Error('PO create wrong');
  ok(`PO created: ${poDoc.po_no}, 2 lines, value ${poDoc.value}, status submitted`);

  let recvBlocked = false;
  try { await po.receiveAgainstPO(poId, [{ lineId: poDoc.lines[0].id, receiveQty: 10, location: 'Site A' }], uid); }
  catch (e) { recvBlocked = /approved PO/.test(e.message); }
  if (!recvBlocked) throw new Error('receiving before approval not blocked');
  ok('receiving blocked before PO approval');

  await po.setPOStatus(poId, 'approved', uid, 'ok');
  const cementBefore = (await inv.stockStatus()).find(r => Number(r.id) === Number(cementId));
  const r1 = await po.receiveAgainstPO(poId, [{ lineId: poDoc.lines[0].id, receiveQty: 60, location: 'Site A' }], uid);
  poDoc = await po.getPO(poId);
  const cementAfter = (await inv.stockStatus()).find(r => Number(r.id) === Number(cementId));
  if (Number(cementAfter.current_balance) - Number(cementBefore ? cementBefore.current_balance : 0) !== 60) throw new Error('receipt did not add 60 to stock');
  if (poDoc.status !== 'partially_received') throw new Error('PO should be partially_received, got ' + poDoc.status);
  ok(`received 60 cement -> stock +60, GRN ${r1.grnNo}, PO partially_received`);

  let overRecv = false;
  try { await po.receiveAgainstPO(poId, [{ lineId: poDoc.lines[0].id, receiveQty: 999, location: 'Site A' }], uid); }
  catch (e) { overRecv = /pending/.test(e.message); }
  if (!overRecv) throw new Error('over-receipt not blocked');
  ok('over-receipt beyond PO quantity rejected');

  await po.receiveAgainstPO(poId, [
    { lineId: poDoc.lines[0].id, receiveQty: 40, location: 'Site A' },
    { lineId: poDoc.lines[1].id, receiveQty: 50, location: 'Site A' }
  ], uid);
  poDoc = await po.getPO(poId);
  if (poDoc.status !== 'received' || !poDoc.fully_received) throw new Error('PO should be fully received');
  ok('received remaining lines -> PO status received');

  const ps = await po.poStats();
  ok(`PO stats: ${ps.pendingPO} pending, ${ps.openPO} open`);

  // ---- V6.1: Transfers (site->vessel, vessel->site, site->site) ----
  const pipeId = await inv.createItem({ description: 'GI Pipe 2 inch', unit: 'Mtr', type: 'Material', category: 'Piping' }, uid);
  await inv.createTransaction({ itemId: pipeId, transactionType: 'RECEIVED', quantity: 100, cost: 200, sourceLocation: 'Site A' }, uid);

  // distribute site -> vessel
  await inv.createTransaction({ itemId: pipeId, transactionType: 'TRANSFER', quantity: 40, sourceLocation: 'Site A', destinationLocation: 'Vessel-X', notes: 'deploy to vessel' }, uid);
  let bal = (await inv.stockStatus()).find(r => Number(r.id) === Number(pipeId));
  if (Number(bal.current_balance) !== 100) throw new Error('transfer changed total (should be net-zero): ' + bal.current_balance);
  const availPipe = await inv.itemAvailability(pipeId);
  const at = (loc) => { const x = availPipe.find(a => a.location === loc); return x ? Number(x.balance) : 0; };
  if (at('Site A') !== 60 || at('Vessel-X') !== 40) throw new Error(`site->vessel wrong: A=${at('Site A')} V=${at('Vessel-X')}`);
  ok('transfer Site A -> Vessel-X: total 100 unchanged, Site A 60, Vessel-X 40');

  // return vessel -> site
  await inv.createTransaction({ itemId: pipeId, transactionType: 'TRANSFER', quantity: 10, sourceLocation: 'Vessel-X', destinationLocation: 'Site A', notes: 'return from vessel' }, uid);
  const availPipe2 = await inv.itemAvailability(pipeId);
  const at2 = (loc) => { const x = availPipe2.find(a => a.location === loc); return x ? Number(x.balance) : 0; };
  if (at2('Site A') !== 70 || at2('Vessel-X') !== 30) throw new Error('vessel->site return wrong');
  ok('return Vessel-X -> Site A: Site A 70, Vessel-X 30');

  // site -> site
  await inv.createTransaction({ itemId: pipeId, transactionType: 'TRANSFER', quantity: 20, sourceLocation: 'Site A', destinationLocation: 'Site B', notes: 'site to site' }, uid);
  const availPipe3 = await inv.itemAvailability(pipeId);
  const at3 = (loc) => { const x = availPipe3.find(a => a.location === loc); return x ? Number(x.balance) : 0; };
  if (at3('Site A') !== 50 || at3('Site B') !== 20) throw new Error('site->site wrong');
  ok('transfer Site A -> Site B: Site A 50, Site B 20');

  // guards
  let g1 = false, g2 = false, g3 = false;
  try { await inv.createTransaction({ itemId: pipeId, transactionType: 'TRANSFER', quantity: 5, sourceLocation: 'Site A', destinationLocation: 'Site A', notes: 'x' }, uid); } catch (e) { g1 = /different/.test(e.message); }
  try { await inv.createTransaction({ itemId: pipeId, transactionType: 'TRANSFER', quantity: 5, sourceLocation: 'Site A', destinationLocation: 'Site B' }, uid); } catch (e) { g2 = /transfer note/.test(e.message); }
  try { await inv.createTransaction({ itemId: pipeId, transactionType: 'TRANSFER', quantity: 999, sourceLocation: 'Site A', destinationLocation: 'Site B', notes: 'x' }, uid); } catch (e) { g3 = /Insufficient/.test(e.message); }
  if (!g1 || !g2 || !g3) throw new Error('transfer guards failed');
  ok('transfer guards: same-location, missing-note, insufficient-stock all rejected');

  // adjustment out captures location + validates
  await inv.createTransaction({ itemId: pipeId, transactionType: 'ADJUSTMENT_OUT', quantity: 5, issueLocation: 'Site B' }, uid);
  const availPipe4 = await inv.itemAvailability(pipeId);
  const at4 = (loc) => { const x = availPipe4.find(a => a.location === loc); return x ? Number(x.balance) : 0; };
  if (at4('Site B') !== 15) throw new Error('adjustment-out location not captured: Site B=' + at4('Site B'));
  ok('adjustment-out from Site B captured (Site B 20 -> 15)');

  // stock-by-location report
  const sbl = await inv.stockByLocation();
  const pipeCode = (await inv.getItem(pipeId)).item_code;
  const pipeSiteA = sbl.find(r => r.item_code === pipeCode && r.location === 'Site A');
  if (!pipeSiteA || Number(pipeSiteA.quantity) !== 50 || Number(pipeSiteA.value) !== 50 * 200) throw new Error('stock-by-location wrong');
  ok('stock-by-location: pipe @ Site A = 50, value 10000');

  // ---- V6.2: item coding (CAT-SUB-NNNN) ----
  const cats = await inv.listItemCategories();
  if (cats.length !== 12) throw new Error('expected 12 categories, got ' + cats.length);
  const subs = await inv.listAllSubcategories();
  if (subs.length !== 51) throw new Error('expected 51 sub-categories, got ' + subs.length);
  ok(`coding masters seeded: ${cats.length} categories, ${subs.length} sub-categories`);

  const brg1 = await inv.createItem({ catCode: 'MEC', subCode: 'BRG', description: 'Bearing 6205-2RS', unit: 'NOS', criticality: 'B' }, uid);
  const brg1i = await inv.getItem(brg1);
  if (brg1i.item_code !== 'MEC-BRG-0001') throw new Error('first code wrong: ' + brg1i.item_code);
  if (brg1i.label_mode !== 'unit') throw new Error('MEC should default to per-unit label mode');
  const brg2 = await inv.createItem({ catCode: 'MEC', subCode: 'BRG', description: 'Bearing 6206' }, uid);
  if ((await inv.getItem(brg2)).item_code !== 'MEC-BRG-0002') throw new Error('serial did not increment');
  const sea1 = await inv.createItem({ catCode: 'MEC', subCode: 'SEA', description: 'Oil seal' }, uid);
  if ((await inv.getItem(sea1)).item_code !== 'MEC-SEA-0001') throw new Error('per-subcategory series wrong');
  ok('codes generated: MEC-BRG-0001, MEC-BRG-0002, MEC-SEA-0001 (per CAT-SUB serial)');

  const oil = await inv.createItem({ catCode: 'LUB', subCode: 'EOL', description: 'Engine oil 15W40', unit: 'LTR' }, uid);
  const oili = await inv.getItem(oil);
  if (oili.item_code !== 'LUB-EOL-0001' || oili.label_mode !== 'batch') throw new Error('LUB should default to per-batch label mode');
  ok('LUB-EOL-0001 defaults to per-batch label mode; format matches ^[A-Z]{3}-[A-Z]{3}-[0-9]{4}$');

  let badSub = false;
  try { await inv.createItem({ catCode: 'MEC', subCode: 'ZZZ', description: 'x' }, uid); } catch (e) { badSub = /Unknown or inactive/.test(e.message); }
  if (!badSub) throw new Error('invalid sub-category not rejected');
  ok('invalid sub-category rejected');

  // ---- V6.3: barcode label generation on receipt ----
  const label = require('../src/repositories/labelRepo');
  const yy = String(new Date().getFullYear()).slice(-2);
  await inv.createTransaction({ itemId: brg1, transactionType: 'RECEIVED', quantity: 5, cost: 100, sourceLocation: 'Store-1' }, uid);
  let labs = await label.listLabels({ itemId: brg1 });
  if (labs.length !== 5) throw new Error('per-unit receive should make 5 labels, got ' + labs.length);
  if (!labs.every(l => Number(l.qty) === 1)) throw new Error('unit labels should each be qty 1');
  if (!labs.some(l => l.label_code === `MEC-BRG-0001-${yy}-0001`) || !labs.some(l => l.label_code === `MEC-BRG-0001-${yy}-0005`)) throw new Error('unit label codes wrong');
  ok(`per-unit receive(5): labels MEC-BRG-0001-${yy}-0001..0005`);

  await inv.createTransaction({ itemId: brg1, transactionType: 'RECEIVED', quantity: 3, cost: 100, sourceLocation: 'Store-1' }, uid);
  labs = await label.listLabels({ itemId: brg1 });
  if (labs.length !== 8 || !labs.some(l => l.label_code === `MEC-BRG-0001-${yy}-0008`)) throw new Error('serial did not continue to 0008');
  ok('same item received again: serial continues to 0008');

  await inv.createTransaction({ itemId: oil, transactionType: 'RECEIVED', quantity: 200, cost: 90, sourceLocation: 'Store-1' }, uid);
  const olabs = await label.listLabels({ itemId: oil });
  if (olabs.length !== 1 || Number(olabs[0].qty) !== 200) throw new Error('batch item should make 1 label of qty 200');
  if (olabs[0].label_code !== `LUB-EOL-0001-${yy}-0001`) throw new Error('batch label code wrong: ' + olabs[0].label_code);
  ok(`per-batch receive(200): single label ${olabs[0].label_code} qty 200`);

  const found = await label.getByCode(`MEC-BRG-0001-${yy}-0003`);
  if (!found || found.item_code !== 'MEC-BRG-0001') throw new Error('label lookup by code failed');
  ok('label lookup by scanned code resolves to the item');

  // ---- V6.4: Inventory Audit (scan + reconcile) ----
  const audit = require('../src/repositories/auditSessionRepo');
  const motor = await inv.createItem({ catCode: 'ELE', subCode: 'MOT', description: 'Test motor', unit: 'NOS' }, uid);
  await inv.createTransaction({ itemId: motor, transactionType: 'RECEIVED', quantity: 3, cost: 500, sourceLocation: 'Audit-Store' }, uid);
  const sess = await audit.createSession({ name: 'Cycle count Audit-Store', location: 'Audit-Store', userId: uid });
  const ar1 = await audit.recordScan(sess, `ELE-MOT-0001-${yy}-0001`, uid);
  if (ar1.result !== "matched") throw new Error('known label should be matched, got ' + r1.result);
  const ar2 = await audit.recordScan(sess, `ELE-MOT-0001-${yy}-0001`, uid);
  if (ar2.result !== "duplicate") throw new Error('re-scan should be duplicate');
  const ar3 = await audit.recordScan(sess, 'FAKE-XYZ-00-0000', uid);
  if (ar3.result !== "unknown") throw new Error('unknown code should be flagged unknown');
  ok('scan results: matched, duplicate re-scan, unknown code flagged');

  const rec = await audit.reconcile(sess);
  const mrow = rec.rows.find(r => r.item_code === 'ELE-MOT-0001');
  if (!mrow || mrow.ledger_qty !== 3 || mrow.scanned_qty !== 1 || mrow.discrepancy !== -2) throw new Error('ledger comparison wrong: ' + JSON.stringify(mrow));
  if (mrow.avg_cost !== 500 || mrow.missing_value !== 1000) throw new Error('missing value should be 2*500=1000, got ' + (mrow && mrow.missing_value));
  if (rec.totals.missingValue !== 1000 || rec.totals.discrepItems !== 1) throw new Error('totals wrong: ' + JSON.stringify(rec.totals));
  if ((rec.scanCounts.unknown || 0) !== 1) throw new Error('one unknown scan expected');
  ok('reconcile vs ledger: ELE-MOT-0001 book 3, scanned 1 -> missing 2 = value 1000; total missing value 1000');

  await audit.closeSession(sess, uid);
  let afterClose = false;
  try { await audit.recordScan(sess, `ELE-MOT-0001-${yy}-0002`, uid); } catch (e) { afterClose = /closed/.test(e.message); }
  if (!afterClose) throw new Error('scanning a closed audit should be blocked');
  ok('closing the audit locks it; further scans rejected');

  await db.close();
  console.log(`\nALL ${n} END-TO-END CHECKS PASSED (${db.backend})`);
})().catch(err => { console.error('\nVERIFY FAILED:', err.message); process.exit(1); });
