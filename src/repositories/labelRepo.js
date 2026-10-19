const db = require("../config/db");

/**
 * Barcode/label repository for the V2 inventory model.
 *
 * IMPORTANT:
 * A barcode is the permanent identity of an item instance.
 * This repository does NOT generate a new barcode and does NOT
 * create a separate labels table.
 *
 * V2 identity:
 *
 *   item_instances.instance_code
 *   item_instances.barcode
 *
 * The label system simply retrieves those existing instances
 * and passes them to the printable label view.
 */

/**
 * Build the site-access condition for a user.
 *
 * Admin:
 *   Can access every instance.
 *
 * Manager / Operator / Viewer:
 *   Can access instances belonging to their currently assigned sites.
 *
 * Instances with site_id NULL are intentionally not returned to
 * non-admin users.
 */
function buildSiteAccess(user, params) {
  if (!user) {
    throw new Error("User is required.");
  }

  if (user.role === "admin") {
    return {
      clause: "",
      params,
    };
  }

  params.push(user.id);

  return {
    clause: `
      JOIN site_assignments sa
        ON sa.site_id = ii.site_id
       AND sa.user_id = ?
       AND sa.assigned_until IS NULL
    `,
    params,
  };
}

/**
 * List physical inventory instances that the user is allowed to print.
 *
 * Optional filters:
 *   itemMasterId
 *   instanceId
 *   onlyActive
 *   limit
 */
async function listLabels({
  user,
  itemMasterId = null,
  instanceId = null,
  onlyActive = false,
  search = '',
  siteId = null,
  status = '',
  sort = 'newest',
  direction = 'desc',
  limit = 500,
} = {}) {
  if (!user) {
    throw new Error("User is required.");
  }

  const params = [];

  const access = buildSiteAccess(user, params);

  const where = [];

  if (itemMasterId !== null && itemMasterId !== undefined) {
    where.push("ii.item_master_id = ?");
    params.push(Number(itemMasterId));
  }

  if (instanceId !== null && instanceId !== undefined) {
    where.push("ii.id = ?");
    params.push(Number(instanceId));
  }

  if (onlyActive) {
    where.push("ii.lifecycle_status = 'ACTIVE'");
  }

  if (search) {
    where.push(`(LOWER(ii.instance_code) LIKE ? OR LOWER(COALESCE(ii.barcode, '')) LIKE ? OR LOWER(im.item_code) LIKE ? OR LOWER(im.name) LIKE ?)`);
    const pattern = `%${String(search).trim().toLowerCase()}%`;
    params.push(pattern, pattern, pattern, pattern);
  }
  if (siteId !== null && siteId !== undefined && siteId !== '') {
    where.push('ii.site_id = ?');
    params.push(Number(siteId));
  }
  if (status) {
    where.push('ii.lifecycle_status = ?');
    params.push(status);
  }

  const orderBy = {
    newest: 'ii.created_at',
    name: 'im.name',
    itemCode: 'im.item_code',
    instanceCode: 'ii.instance_code',
    location: 's.name',
    status: 'ii.lifecycle_status'
  }[sort] || 'ii.created_at';
  const orderDirection = direction === 'asc' ? 'ASC' : 'DESC';

  const sql = `
    SELECT
      ii.id AS instance_id,
      ii.instance_code,
      ii.barcode,

      ii.original_quantity,
      ii.current_quantity,
      ii.unit,

      ii.lifecycle_status,
      ii.condition,

      ii.batch_number,
      ii.serial_number,
      ii.manufacture_date,
      ii.expiry_date,

      ii.site_id,
      s.code AS site_code,
      s.name AS site_name,

      im.id AS item_master_id,
      im.item_code,
      im.name AS item_name,
      im.description AS item_description,
      im.unit AS item_unit,
      im.instance_quantity,
      im.instance_quantity_unit,

      ii.created_at,
      ii.updated_at

    FROM item_instances ii

    JOIN item_masters im
      ON im.id = ii.item_master_id

    LEFT JOIN sites s
      ON s.id = ii.site_id

    ${access.clause}

    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}

    ORDER BY ${orderBy} ${orderDirection}, im.item_code ASC, ii.instance_code ASC

    LIMIT ?
  `;

  params.push(Math.min(Number(limit) || 500, 5000));

  return db.many(sql, params);
}

async function listSitesForUser(user) {
  if (user?.role === 'admin') {
    return db.many(`SELECT id, code, name FROM sites WHERE status='ACTIVE' ORDER BY name`);
  }
  return db.many(
    `SELECT DISTINCT s.id, s.code, s.name FROM sites s
     JOIN site_assignments sa ON sa.site_id=s.id
     WHERE s.status='ACTIVE' AND sa.user_id=? AND sa.assigned_until IS NULL
     ORDER BY s.name`, [user.id]
  );
}

/**
 * Get one physical instance for label printing.
 *
 * Site access is enforced here as well as in listLabels().
 * This is important because a user could otherwise manually
 * change the instance ID in the URL.
 */
async function getByInstanceId(instanceId, user) {
  if (!user) {
    throw new Error("User is required.");
  }

    const params = [];

  let accessJoin = "";

  if (user.role !== "admin") {
    params.push(user.id);

    accessJoin = `
      JOIN site_assignments sa
        ON sa.site_id = ii.site_id
       AND sa.user_id = ?
       AND sa.assigned_until IS NULL
    `;
  }

  params.push(Number(instanceId)); // WHERE ii.id = ? comes after the join

  return db.one(
    `
      SELECT
        ii.id AS instance_id,
        ii.instance_code,
        ii.barcode,

        ii.original_quantity,
        ii.current_quantity,
        ii.unit,

        ii.lifecycle_status,
        ii.condition,

        ii.batch_number,
        ii.serial_number,
        ii.manufacture_date,
        ii.expiry_date,

        ii.site_id,
        s.code AS site_code,
        s.name AS site_name,

        im.id AS item_master_id,
        im.item_code,
        im.name AS item_name,
        im.description AS item_description,
        im.unit AS item_unit,
        im.instance_quantity,
        im.instance_quantity_unit,

        ii.created_at,
        ii.updated_at

      FROM item_instances ii

      JOIN item_masters im
        ON im.id = ii.item_master_id

      LEFT JOIN sites s
        ON s.id = ii.site_id

      ${accessJoin}

      WHERE ii.id = ?
    `,
    params,
  );
}

/**
 * Resolve an instance by either:
 *
 *   instance_code
 *   barcode
 *
 * This intentionally uses the V2 physical instance identity.
 */
async function getByCodeOrBarcode(code, user) {
  if (!user) {
    throw new Error("User is required.");
  }

  const value = String(code || "").trim();

  if (!value) {
    return null;
  }

  const params = [];

  let accessJoin = "";

  if (user.role !== "admin") {
    params.push(user.id);

    accessJoin = `
      JOIN site_assignments sa
        ON sa.site_id = ii.site_id
       AND sa.user_id = ?
       AND sa.assigned_until IS NULL
    `;
  }
  params.push(value, value); // WHERE instance_code = ? OR barcode = ? comes after the join
  return db.one(
    `
      SELECT
        ii.id AS instance_id,
        ii.instance_code,
        ii.barcode,

        ii.original_quantity,
        ii.current_quantity,
        ii.unit,

        ii.lifecycle_status,
        ii.condition,

        ii.batch_number,
        ii.serial_number,
        ii.manufacture_date,
        ii.expiry_date,

        ii.site_id,
        s.code AS site_code,
        s.name AS site_name,

        im.id AS item_master_id,
        im.item_code,
        im.name AS item_name,
        im.description AS item_description,
        im.unit AS item_unit,
        im.instance_quantity,
        im.instance_quantity_unit

      FROM item_instances ii

      JOIN item_masters im
        ON im.id = ii.item_master_id

      LEFT JOIN sites s
        ON s.id = ii.site_id

      ${accessJoin}

      WHERE
        ii.instance_code = ?
        OR ii.barcode = ?

      LIMIT 1
    `,
    params,
  );
}

module.exports = {
  listLabels,
  listSitesForUser,
  getByInstanceId,
  getByCodeOrBarcode,
};
