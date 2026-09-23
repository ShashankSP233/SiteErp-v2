const test = require('node:test');
const assert = require('node:assert');
const { financialYearCode, formatDocumentNo, round2 } = require('../src/utils/finance');
const { hashPassword, verifyPassword } = require('../src/utils/password');
const { toCsv } = require('../src/utils/csv');

test('financial year: Mar 31 vs Apr 1 boundary', () => {
  assert.strictEqual(financialYearCode(new Date('2027-03-31T10:00:00Z')), '2627');
  assert.strictEqual(financialYearCode(new Date('2027-04-01T10:00:00Z')), '2728');
});
test('document number format', () => {
  assert.strictEqual(formatDocumentNo('2627', 1), '262700001');
  assert.strictEqual(formatDocumentNo('2728', 42), '272800042');
});
test('round2 avoids float drift', () => {
  assert.strictEqual(round2(0.1 + 0.2), 0.3);
  assert.strictEqual(round2(160 * 14.999999), 2400);
});
test('scrypt password verify', () => {
  const h = hashPassword('secret123');
  assert.ok(verifyPassword('secret123', h));
  assert.ok(!verifyPassword('nope', h));
});

// Mirror of the weighted-average replay used in inventoryRepo.computeAverageCosts
function movingAverage(events) {
  let qty = 0, avg = 0;
  for (const e of events) {
    if (e.type === 'in') { const t = qty * avg + e.qty * e.cost; qty += e.qty; avg = qty > 0 ? t / qty : e.cost; }
    else qty -= e.qty;
  }
  return { qty, avg };
}
test('weighted-average costing', () => {
  let r = movingAverage([{ type: 'in', qty: 100, cost: 10 }, { type: 'in', qty: 100, cost: 20 }]);
  assert.strictEqual(r.qty, 200); assert.strictEqual(r.avg, 15);
  r = movingAverage([{ type: 'in', qty: 10, cost: 100 }, { type: 'out', qty: 4 }, { type: 'in', qty: 6, cost: 200 }]);
  assert.strictEqual(r.avg, 150);
});
test('csv escaping', () => {
  const csv = toCsv([{ a: 'x', b: 'has,comma' }, { a: 'q"ote', b: 1 }]);
  assert.ok(csv.includes('"has,comma"'));
  assert.ok(csv.includes('"q""ote"'));
});
