const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const env = require('../config/env');
const { hashPassword } = require('../utils/password');

const migrationsDir = path.join(
  __dirname,
  'migrations',
  'v2',
  db.backend
);

async function runMigrations() {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  const applied = new Set((await db.many('SELECT filename FROM schema_migrations')).map(r => r.filename));
  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await db.tx(async (c) => {
      await c.exec(sql);
      await c.query('INSERT INTO schema_migrations(filename) VALUES (?)', [file]);
    });
    ran++;
  }
  return { ran, total: files.length };
}

async function ensureAdmin() {
  const existing = await db.one('SELECT id FROM users WHERE username=?', [env.defaultAdminUsername]);
  if (existing) return false;
  await db.query(
    `INSERT INTO users(username, password_hash, full_name, role, must_change_password)
     VALUES (?,?,'System Administrator','admin',true)`,
    [env.defaultAdminUsername, hashPassword(env.defaultAdminPassword)]);
  return true;
}

module.exports = { runMigrations, ensureAdmin };
