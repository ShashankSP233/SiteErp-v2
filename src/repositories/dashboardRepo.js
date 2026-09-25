const db = require('../config/db');

async function getDashboardStats() {
  const result = await db.one(`
    SELECT
      (
        SELECT COUNT(*)
        FROM sites
        WHERE status = 'ACTIVE'
      ) AS sites,

      (
        SELECT COUNT(*)
        FROM item_masters
        WHERE status = 'ACTIVE'
      ) AS item_masters,

      (
        SELECT COUNT(*)
        FROM item_instances
        WHERE lifecycle_status = 'ACTIVE'
      ) AS instances,

      (
        SELECT COUNT(*)
        FROM users
        WHERE is_active = TRUE
      ) AS users
  `);

  return {
    sites: Number(result.sites),
    itemMasters: Number(result.item_masters),
    instances: Number(result.instances),
    users: Number(result.users)
  };
}

module.exports = {
  getDashboardStats
};