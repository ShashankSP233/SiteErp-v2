try { require('dotenv').config(); } catch (_) {}
const db = require('../src/config/db');
const env = require('../src/config/env');
const { runMigrations, ensureAdmin } = require('../src/db/setup');

(async () => {
  await runMigrations(); // ensure tables exist first
  const created = await ensureAdmin();
  console.log(created
    ? `Admin created: ${env.defaultAdminUsername} (must change password on first login).`
    : `Admin "${env.defaultAdminUsername}" already exists — nothing to do.`);
  await db.close();
})().catch(err => { console.error('Seed failed:', err.message); process.exit(1); });
