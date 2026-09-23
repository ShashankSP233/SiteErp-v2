const path = require('path');
const fs = require('fs');
const env = require('./env');

// Two interchangeable backends behind one interface, using a SHARED SQL dialect
// (written with "?" placeholders):
//   - Local: Node's built-in SQLite (node:sqlite) when DATABASE_URL is not set.
//   - Production: PostgreSQL via `pg` (Supabase) when DATABASE_URL is set.
const USE_PG = !!env.databaseUrl;
const backend = USE_PG ? 'pg' : 'sqlite';
const rowLock = USE_PG ? ' FOR UPDATE' : '';
const systemTables = USE_PG
  ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public'"
  : "SELECT name FROM sqlite_master WHERE type='table'";

let pool = null;
let sqlite = null;

function normParams(params) {
  const arr = params === undefined || params === null ? [] : (Array.isArray(params) ? params : [params]);
  return arr.map(v => { if (v === undefined) return null; if (typeof v === 'boolean') return USE_PG ? v : (v ? 1 : 0); return v; });
}
function toPg(sql) { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); }

function initPg() {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: env.databaseUrl, ssl: env.pgSsl ? { rejectUnauthorized: false } : false, max: 10, idleTimeoutMillis: 30000 });
  pool.on('error', (e) => console.error('[pg] idle client error:', e.message));
}
function initSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  const dbFile = path.join(env.rootDir, 'data', 'local.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  sqlite = new DatabaseSync(dbFile);
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA busy_timeout = 5000;');
}
function ensureSqlite() { if (!sqlite) initSqlite(); return sqlite; }

let lock = Promise.resolve();
function runExclusive(fn) { const r = lock.then(fn); lock = r.then(() => {}, () => {}); return r; }

async function query(text, params = []) {
  const p = normParams(params);
  if (USE_PG) { if (!pool) initPg(); return pool.query(toPg(text), p); }
  const rows = ensureSqlite().prepare(text).all(...p);
  return { rows, rowCount: rows.length };
}
async function exec(sql) {
  if (USE_PG) { if (!pool) initPg(); return pool.query(sql); }
  ensureSqlite().exec(sql);
}
async function one(t, p = []) { return (await query(t, p)).rows[0]; }
async function many(t, p = []) { return (await query(t, p)).rows; }

async function tx(callback) {
  if (USE_PG) {
    if (!pool) initPg();
    const client = await pool.connect();
    const api = {
      query: (t, p = []) => client.query(toPg(t), normParams(p)),
      exec: (s) => client.query(s),
      one: async (t, p = []) => (await client.query(toPg(t), normParams(p))).rows[0],
      many: async (t, p = []) => (await client.query(toPg(t), normParams(p))).rows
    };
    try { await client.query('BEGIN'); const r = await callback(api); await client.query('COMMIT'); return r; }
    catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { client.release(); }
  }
  const db = ensureSqlite();
  return runExclusive(async () => {
    const run = (t, p = []) => db.prepare(t).all(...normParams(p));
    const api = {
      query: (t, p = []) => { const rows = run(t, p); return { rows, rowCount: rows.length }; },
      exec: (s) => db.exec(s),
      one: (t, p = []) => run(t, p)[0],
      many: (t, p = []) => run(t, p)
    };
    db.exec('BEGIN IMMEDIATE;');
    try { const r = await callback(api); db.exec('COMMIT;'); return r; }
    catch (e) { try { db.exec('ROLLBACK;'); } catch (_) {} throw e; }
  });
}

async function close() { if (pool) await pool.end(); if (sqlite) sqlite.close(); }

module.exports = { query, exec, one, many, tx, close, backend, rowLock, systemTables, get pool() { if (USE_PG && !pool) initPg(); return pool; } };
