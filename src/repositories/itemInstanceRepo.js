const db = require("../config/db");

/**
 * Get an item master by ID.
 */
async function getItemMasterForInstance(itemMasterId) {
  return db.one(
    `SELECT
      id,
      item_code,
      name,
      unit,
      instance_quantity,
      instance_quantity_unit,
      is_consumable,
      allows_partial_consumption,
      requires_instance_tracking,
      status
    FROM item_masters
    WHERE id = ?`,
    [itemMasterId],
  );
}

/**
 * Allocate the next instance number for an item master.
 *
 * This MUST be called inside a database transaction.
 *
 * The row is locked with FOR UPDATE so two simultaneous
 * receiving operations cannot receive the same number.
 */
async function allocateInstanceNumber(tx, itemMasterId) {
  const result = await tx.query(
    `SELECT item_master_id, next_number
    FROM item_instance_counters
    WHERE item_master_id = ?
    FOR UPDATE`,
    [itemMasterId],
  );

  const existing = result.rows[0] || null;

  if (!existing) {
    await tx.query(
      `INSERT INTO item_instance_counters
         (item_master_id, next_number)
       VALUES (?, 2)`,
      [itemMasterId],
    );

    return 1;
  }

  const number = Number(existing.next_number);

  await tx.query(
    `UPDATE item_instance_counters
     SET next_number = ?,
         updated_at = now()
     WHERE item_master_id = ?`,
    [number + 1, itemMasterId],
  );

  return number;
}

/**
 * Format an instance code.
 *
 * Example:
 * CEMENT-001 + 1 -> CEMENT-001-0001
 */
function buildInstanceCode(itemCode, number) {
  return `${itemCode}-${String(number).padStart(4, "0")}`;
}

/**
 * Create multiple physical inventory instances and their RECEIVE movements
 * using an existing database transaction.
 *
 * instanceCount means the number of physical units received.
 *
 * Example:
 *   instanceCount = 5
 *   item master = OIL-20L
 *   instance_quantity = 20
 *   instance_quantity_unit = L
 *
 * Result:
 *   5 physical instances
 *   each containing 20 L
 *
 * IMPORTANT:
 * The caller owns the transaction.
 */
async function receiveInstancesWithinTransaction(
  tx,
  {
    itemMasterId,
    instanceCount,
    siteId,
    performedBy,
    batchNumber = null,
    serialNumber = null,
    manufactureDate = null,
    expiryDate = null,
    reason = null,
  },
) {
  const count = Number(instanceCount);

  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("Instance count must be a positive whole number.");
  }

  // Lock and validate the item master.
  const itemMaster = await tx.one(
    `SELECT
       id,
       item_code,
       name,
       unit,
       instance_quantity,
       instance_quantity_unit,
       is_consumable,
       allows_partial_consumption,
       requires_instance_tracking,
       status
     FROM item_masters
     WHERE id = ?
     FOR UPDATE`,
    [itemMasterId],
  );

  if (itemMaster.status !== "ACTIVE") {
    throw new Error("Cannot receive inventory for an inactive item master.");
  }

  if (!itemMaster.requires_instance_tracking) {
    throw new Error(
      "This item master is not configured for physical instance tracking.",
    );
  }

  const instanceQuantity = Number(itemMaster.instance_quantity);

  if (!Number.isFinite(instanceQuantity) || instanceQuantity <= 0) {
    throw new Error("Item master has an invalid instance quantity.");
  }

  if (!itemMaster.instance_quantity_unit?.trim()) {
    throw new Error("Item master has no instance quantity unit configured.");
  }

  // Validate the destination site.
  const site = await tx.one(
    `SELECT
       id,
       code,
       name,
       site_type,
       status
     FROM sites
     WHERE id = ?
     FOR UPDATE`,
    [siteId],
  );

  if (site.status !== "ACTIVE") {
    throw new Error("Cannot receive inventory into an inactive site.");
  }

  const createdInstances = [];

  for (let i = 0; i < count; i += 1) {
    // Allocate a unique instance number.
    const instanceNumber = await allocateInstanceNumber(tx, itemMaster.id);

    const instanceCode = buildInstanceCode(
      itemMaster.item_code,
      instanceNumber,
    );

    // Barcode is the permanent identity of this physical instance.
    const barcode = instanceCode;

    // Create the physical instance.
    const instance = await tx.one(
      `INSERT INTO item_instances (
         item_master_id,
         instance_code,
         barcode,
         original_quantity,
         current_quantity,
         unit,
         site_id,
         lifecycle_status,
         condition,
         batch_number,
         serial_number,
         manufacture_date,
         expiry_date
       )
       VALUES (
         ?,
         ?,
         ?,
         ?,
         ?,
         ?,
         ?,
         'ACTIVE',
         'GOOD',
         ?,
         ?,
         ?,
         ?
       )
       RETURNING *`,
      [
        itemMaster.id,
        instanceCode,
        barcode,
        instanceQuantity,
        instanceQuantity,
        itemMaster.instance_quantity_unit,
        site.id,
        batchNumber || null,
        serialNumber || null,
        manufactureDate || null,
        expiryDate || null,
      ],
    );

    // Create the corresponding inventory movement.
    await tx.query(
      `INSERT INTO inventory_movements (
         instance_id,
         movement_type,
         quantity,
         from_site_id,
         to_site_id,
         reference_type,
         reference_id,
         reason,
         performed_by
       )
       VALUES (
         ?,
         'RECEIVE',
         ?,
         NULL,
         ?,
         'DIRECT_RECEIVE',
         ?,
         ?,
         ?
       )`,
      [
        instance.id,
        instanceQuantity,
        site.id,
        instanceCode,
        reason || "Inventory received",
        performedBy,
      ],
    );

    createdInstances.push(instance);
  }

  return {
    instances: createdInstances,
    itemMaster,
    site,
  };
}

async function receiveInstances({
  itemMasterId,
  instanceCount,
  siteId,
  performedBy,
  batchNumber = null,
  serialNumber = null,
  manufactureDate = null,
  expiryDate = null,
  reason = null,
}) {
  return db.tx(async (tx) => {
    return receiveInstancesWithinTransaction(tx, {
      itemMasterId,
      instanceCount,
      siteId,
      performedBy,
      batchNumber,
      serialNumber,
      manufactureDate,
      expiryDate,
      reason,
    });
  });
}
/**
 * List inventory instances accessible to a user.
 *
 * Admins can see everything.
 * Other users only see their assigned active sites.
 */
async function listInstancesForUser(user) {
  if (user.role === "admin") {
    return db.many(
      `SELECT
         ii.id,
         ii.instance_code,
         ii.barcode,
         ii.original_quantity,
          ii.current_quantity,
          ii.unit,

          COALESCE((
              SELECT SUM(inv.remaining_quantity)
              FROM inventory_issues inv
              WHERE inv.instance_id = ii.id
                AND inv.status IN ('OPEN', 'PARTIALLY_CONSUMED')
          ), 0) AS issued_quantity,

          ii.current_quantity - COALESCE((
              SELECT SUM(inv.remaining_quantity)
              FROM inventory_issues inv
              WHERE inv.instance_id = ii.id
                AND inv.status IN ('OPEN', 'PARTIALLY_CONSUMED')
          ), 0) AS available_quantity,

         ii.lifecycle_status,
         ii.condition,
         ii.batch_number,
         ii.serial_number,
         ii.manufacture_date,
         ii.expiry_date,
         ii.created_at,
         ii.updated_at,
         im.id AS item_master_id,
         im.item_code,
         im.name AS item_name,
         im.unit AS physical_unit,
         im.instance_quantity,
         im.instance_quantity_unit,
         s.id AS site_id,
         s.code AS site_code,
         s.name AS site_name
       FROM item_instances ii
       JOIN item_masters im ON im.id = ii.item_master_id
       LEFT JOIN sites s ON s.id = ii.site_id
       ORDER BY ii.created_at DESC`,
    );
  }

  return db.many(
    `SELECT
       ii.id,
       ii.instance_code,
       ii.barcode,
       ii.original_quantity,
        ii.current_quantity,
        ii.unit,

        COALESCE((
            SELECT SUM(inv.remaining_quantity)
            FROM inventory_issues inv
            WHERE inv.instance_id = ii.id
              AND inv.status IN ('OPEN', 'PARTIALLY_CONSUMED')
        ), 0) AS issued_quantity,

        ii.current_quantity - COALESCE((
            SELECT SUM(inv.remaining_quantity)
            FROM inventory_issues inv
            WHERE inv.instance_id = ii.id
              AND inv.status IN ('OPEN', 'PARTIALLY_CONSUMED')
        ), 0) AS available_quantity,
       ii.lifecycle_status,
       ii.condition,
       ii.batch_number,
       ii.serial_number,
       ii.manufacture_date,
       ii.expiry_date,
       ii.created_at,
       ii.updated_at,
       im.id AS item_master_id,
       im.item_code,
       im.name AS item_name,
       im.unit AS physical_unit,
       im.instance_quantity,
       im.instance_quantity_unit,
       s.id AS site_id,
       s.code AS site_code,
       s.name AS site_name
     FROM item_instances ii
     JOIN item_masters im ON im.id = ii.item_master_id
     JOIN site_assignments sa
       ON sa.site_id = ii.site_id
      AND sa.user_id = ?
      AND sa.assigned_until IS NULL
     JOIN sites s ON s.id = ii.site_id
     ORDER BY ii.created_at DESC`,
    [user.id],
  );
}

async function findInstanceForUser(user, code) {
  const selectSql = `
    SELECT
      ii.id,
      ii.item_master_id,
      ii.instance_code,
      ii.barcode,
      ii.original_quantity,
      ii.current_quantity,
      ii.unit,
      ii.site_id,
      ii.lifecycle_status,
      ii.condition,
      ii.batch_number,
      ii.serial_number,

      im.item_code,
      im.name AS item_name,

      s.code AS site_code,
      s.name AS site_name,

      COALESCE((
        SELECT SUM(inv.remaining_quantity)
        FROM inventory_issues inv
        WHERE inv.instance_id = ii.id
          AND inv.status IN ('OPEN', 'PARTIALLY_CONSUMED')
      ), 0) AS allocated_quantity,

      ii.current_quantity - COALESCE((
        SELECT SUM(inv.remaining_quantity)
        FROM inventory_issues inv
        WHERE inv.instance_id = ii.id
          AND inv.status IN ('OPEN', 'PARTIALLY_CONSUMED')
      ), 0) AS available_quantity,

      COALESCE((
        SELECT SUM(mv.quantity)
        FROM inventory_movements mv
        WHERE mv.instance_id = ii.id
          AND mv.movement_type = 'CONSUME'
      ), 0) AS consumed_quantity

    FROM item_instances ii
    JOIN item_masters im
      ON im.id = ii.item_master_id
    LEFT JOIN sites s
      ON s.id = ii.site_id

    WHERE (
      LOWER(ii.instance_code) = LOWER(?)
      OR LOWER(COALESCE(ii.barcode, '')) = LOWER(?)
    )
  `;

  if (user.role === 'admin') {
    return db.one(
      `${selectSql} LIMIT 1`,
      [code, code]
    );
  }

  return db.one(
    `${selectSql}
      AND EXISTS (
        SELECT 1
        FROM site_assignments sa
        WHERE sa.site_id = ii.site_id
          AND sa.user_id = ?
          AND sa.assigned_until IS NULL
      )
      LIMIT 1`,
    [code, code, user.id]
  );
}


module.exports = {
  getItemMasterForInstance,
  allocateInstanceNumber,
  buildInstanceCode,
  receiveInstancesWithinTransaction,
  receiveInstances,
  listInstancesForUser,
  findInstanceForUser,
};
