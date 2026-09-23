try { require('dotenv').config(); } catch (_) {}
const db = require('../src/config/db');
const { runMigrations } = require('../src/db/setup');

(async () => {
  console.log(`Applying migrations (${db.backend})...`);
  const { ran, total } = await runMigrations();
  console.log(ran ? `${ran} migration(s) applied. (${total} total)` : `Database already up to date. (${total} migrations)`);
  await db.close();
})().catch(err => { console.error('Migration failed:', err.message); process.exit(1); });
