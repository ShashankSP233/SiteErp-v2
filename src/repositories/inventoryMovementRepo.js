const db = require('../config/db');

const MOVEMENT_TYPES = [
  'RECEIVE',
  'ISSUE',
  'CONSUME',
  'RETURN',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
  'DISCARD'
];

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeDate(value) {
  const text = clean(value);

  if (!text) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error('Invalid date filter. Use YYYY-MM-DD.');
  }

  return text;
}

function nextDate(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);

  return date.toISOString().slice(0, 10);
}

async function listAccessibleSites(user) {
  if (user.role === 'admin') {
    return db.many(`
      SELECT
        id,
        code,
        name,
        site_type
      FROM sites
      WHERE status = 'ACTIVE'
      ORDER BY name ASC
    `);
  }

  return db.many(`
    SELECT
      s.id,
      s.code,
      s.name,
      s.site_type
    FROM site_assignments sa
    JOIN sites s
      ON s.id = sa.site_id
    WHERE sa.user_id = ?
      AND sa.assigned_until IS NULL
      AND s.status = 'ACTIVE'
    ORDER BY s.name ASC
  `, [user.id]);
}

async function listMovementsForUser(user, filters = {}) {
  const instanceCode = clean(filters.instanceCode);
  const movementType = clean(filters.movementType).toUpperCase();
  const siteId = clean(filters.siteId);
  const dateFrom = normalizeDate(filters.dateFrom);
  const dateTo = normalizeDate(filters.dateTo);

  if (
    movementType &&
    !MOVEMENT_TYPES.includes(movementType)
  ) {
    throw new Error('Invalid movement type.');
  }

  if (
    siteId &&
    !/^\d+$/.test(siteId)
  ) {
    throw new Error('Invalid site filter.');
  }

  const conditions = [];
  const params = [];

  if (instanceCode) {
    conditions.push('ii.instance_code = ?');
    params.push(instanceCode);
  }

  if (movementType) {
    conditions.push('mv.movement_type = ?');
    params.push(movementType);
  }

  if (siteId) {
    conditions.push(`(
      mv.from_site_id = ?
      OR mv.to_site_id = ?
      OR (
        mv.from_site_id IS NULL
        AND mv.to_site_id IS NULL
        AND ii.site_id = ?
      )
    )`);

    params.push(
      Number(siteId),
      Number(siteId),
      Number(siteId)
    );
  }

  if (dateFrom) {
    conditions.push('mv.created_at >= ?');
    params.push(dateFrom);
  }

  if (dateTo) {
    conditions.push('mv.created_at < ?');
    params.push(nextDate(dateTo));
  }

  /*
   * Server-side site access.
   *
   * Admin can see everything.
   *
   * Other users can only see movements involving
   * one of their currently assigned active sites.
   *
   * ISSUE/CONSUME can have both from/to site IDs NULL,
   * so those fall back to the instance's current site.
   *
   * Transfer movements do NOT fall back to the current site,
   * preventing a destination-site user from seeing the
   * historical source-side transfer.
   */
  if (user.role !== 'admin') {
    conditions.push(`(
      (
        mv.from_site_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM site_assignments access_from
          JOIN sites access_from_site
            ON access_from_site.id = access_from.site_id
          WHERE access_from.user_id = ?
            AND access_from.site_id = mv.from_site_id
            AND access_from.assigned_until IS NULL
            AND access_from_site.status = 'ACTIVE'
        )
      )

      OR

      (
        mv.to_site_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM site_assignments access_to
          JOIN sites access_to_site
            ON access_to_site.id = access_to.site_id
          WHERE access_to.user_id = ?
            AND access_to.site_id = mv.to_site_id
            AND access_to.assigned_until IS NULL
            AND access_to_site.status = 'ACTIVE'
        )
      )

      OR

      (
        mv.from_site_id IS NULL
        AND mv.to_site_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM site_assignments access_current
          JOIN sites access_current_site
            ON access_current_site.id = access_current.site_id
          WHERE access_current.user_id = ?
            AND access_current.site_id = ii.site_id
            AND access_current.assigned_until IS NULL
            AND access_current_site.status = 'ACTIVE'
        )
      )
    )`);

    params.push(
      user.id,
      user.id,
      user.id
    );
  }

  const where = conditions.length
    ? `WHERE ${conditions.join('\n      AND ')}`
    : '';

  return db.many(
    `SELECT
       mv.id,
       mv.instance_id,
       mv.movement_type,
       mv.quantity,
       mv.from_site_id,
       mv.to_site_id,
       mv.reference_type,
       mv.reference_id,
       mv.reason,
       mv.performed_by,
       mv.created_at,

       ii.instance_code,
       ii.barcode,
       ii.current_quantity,
       ii.unit,

       im.item_code,
       im.name AS item_name,

       fs.code AS from_site_code,
       fs.name AS from_site_name,

       ts.code AS to_site_code,
       ts.name AS to_site_name,

       u.username AS performed_by_username,
       u.full_name AS performed_by_name,

       CASE
         WHEN mv.movement_type IN (
           'RECEIVE',
           'ADJUSTMENT_IN'
         )
           THEN mv.quantity

         WHEN mv.movement_type IN (
           'CONSUME',
           'ADJUSTMENT_OUT',
           'DISCARD'
         )
           THEN -mv.quantity

         ELSE 0
       END AS quantity_effect

     FROM inventory_movements mv

     JOIN item_instances ii
       ON ii.id = mv.instance_id

     JOIN item_masters im
       ON im.id = ii.item_master_id

     LEFT JOIN sites fs
       ON fs.id = mv.from_site_id

     LEFT JOIN sites ts
       ON ts.id = mv.to_site_id

     JOIN users u
       ON u.id = mv.performed_by

     ${where}

     ORDER BY
       mv.created_at DESC,
       mv.id DESC

     LIMIT 500`,
    params
  );
}

async function getInstanceMovementSummary(
  user,
  instanceCode
) {
  const code = clean(instanceCode);

  if (!code) {
    throw new Error(
      'Inventory instance code is required.'
    );
  }

  return listMovementsForUser(
    user,
    {
      instanceCode: code
    }
  );
}

module.exports = {
  MOVEMENT_TYPES,
  listAccessibleSites,
  listMovementsForUser,
  getInstanceMovementSummary
};