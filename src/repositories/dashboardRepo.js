const db = require('../config/db');

async function getDashboardStats(user) {
  const instanceScope = user?.role === 'admin'
    ? ''
    : `AND EXISTS (
        SELECT 1 FROM site_assignments sa
        JOIN sites assigned_site ON assigned_site.id = sa.site_id AND assigned_site.status = 'ACTIVE'
        WHERE sa.site_id = ii.site_id AND sa.user_id = ? AND sa.assigned_until IS NULL
      )`;
  const params = user?.role === 'admin' ? [] : [user.id];
  const result = await db.one(`
    SELECT
      (
        SELECT COUNT(*)
        FROM sites
        WHERE status = 'ACTIVE'
          ${user?.role === 'admin' ? '' : `AND EXISTS (
            SELECT 1 FROM site_assignments sa
            WHERE sa.site_id = sites.id AND sa.user_id = ? AND sa.assigned_until IS NULL
          )`}
      ) AS sites,

      (
        SELECT COUNT(*)
        FROM item_masters
        WHERE status = 'ACTIVE'
      ) AS item_masters,

      (
        SELECT COUNT(*)
        FROM item_instances ii
        WHERE ii.lifecycle_status = 'ACTIVE'
          ${instanceScope}
      ) AS instances,

      (
        SELECT COUNT(*)
        FROM users
        WHERE is_active = TRUE
      ) AS users
  `, user?.role === 'admin' ? [] : [user.id, ...params]);

  return {
    sites: Number(result.sites),
    itemMasters: Number(result.item_masters),
    instances: Number(result.instances),
    users: Number(result.users)
  };
}

async function getSiteInventorySummaries(user) {
  const isAdmin = user?.role === 'admin';
  return db.many(`
    SELECT s.id, s.code, s.name, s.site_type,
      COUNT(DISTINCT im.id) FILTER (WHERE ii.lifecycle_status = 'ACTIVE') AS active_item_types,
      COUNT(ii.id) FILTER (WHERE ii.lifecycle_status = 'ACTIVE') AS active_instances,
      COUNT(ii.id) FILTER (WHERE ii.lifecycle_status = 'QUARANTINED') AS quarantined_instances
    FROM sites s
    LEFT JOIN item_instances ii ON ii.site_id = s.id
    LEFT JOIN item_masters im ON im.id = ii.item_master_id AND im.status = 'ACTIVE'
    WHERE s.status = 'ACTIVE'
      ${isAdmin ? '' : `AND EXISTS (
        SELECT 1 FROM site_assignments sa
        WHERE sa.site_id = s.id AND sa.user_id = ? AND sa.assigned_until IS NULL
      )`}
    GROUP BY s.id
    ORDER BY s.name
  `, isAdmin ? [] : [user.id]);
}

module.exports = {
  getDashboardStats,
  getSiteInventorySummaries
};
