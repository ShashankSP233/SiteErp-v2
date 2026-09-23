// Validates the Supabase/Postgres connection, schema, and a write/read/auth
// round-trip WITHOUT leaving test data behind. Usage: npm run smoke
try { require('dotenv').config(); } catch (_) {}
const db = require('../src/config/db');
const { runMigrations } = require('../src/db/setup');
const { hashPassword, verifyPassword } = require('../src/utils/password');

const REQUIRED_TABLES = ['users', 'items', 'transactions', 'categories', 'vendors', 'locations', 'bills', 'payments', 'audit_logs', 'sequence_counters', 'purchase_orders', 'po_lines', 'item_category', 'item_subcategory', 'labels', 'audit_session', 'audit_scan'];

async function run() {
  let ok = 0;
  const pass = (m) => { ok++; console.log('  ok  -', m); };

  await runMigrations();
  const v = await db.one(db.backend === 'pg' ? 'SELECT version() AS v' : "SELECT 'SQLite ' || sqlite_version() AS v");
  pass(`connected (${db.backend}): ${String(v.v).split(',')[0]}`);

  const present = new Set((await db.many(db.systemTables)).map(r => r.name));
  const missing = REQUIRED_TABLES.filter(t => !present.has(t));
  if (missing.length) { console.error('  FAIL - missing tables:', missing.join(', '), '\n  Run "npm run migrate" first.'); process.exit(1); }
  pass(`all ${REQUIRED_TABLES.length} core tables exist`);

  // Password hashing works
  const h = hashPassword('smoke-Test-123');
  if (!verifyPassword('smoke-Test-123', h) || verifyPassword('wrong', h)) { console.error('  FAIL - password hashing'); process.exit(1); }
  pass('scrypt password hashing verifies correctly');

  // Non-destructive write/read/delete round-trip
  const uname = `smoke_${Date.CURRENT_TIMESTAMP}`;
  const u = await db.one('INSERT INTO users(username, password_hash, role) VALUES (?,?,?) RETURNING id', [uname, h, 'viewer']);
  try {
    const back = await db.one('SELECT username, role FROM users WHERE id=?', [u.id]);
    if (back.username !== uname) throw new Error('read-back mismatch');
    pass('write/read round-trip on users table');
  } finally {
    await db.query('DELETE FROM users WHERE id=?', [u.id]);
    pass('cleanup: temp row removed (no test data left behind)');
  }

  console.log(`\nSMOKE TEST PASSED (${ok} checks). Your database is ready.`);
  await db.close();
}
run().catch(err => { console.error('\nSMOKE TEST FAILED:', err.message); process.exit(1); });
