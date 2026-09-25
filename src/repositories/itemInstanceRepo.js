const db = require('../config/db');

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
       is_consumable,
       allows_partial_consumption,
       requires_instance_tracking,
       status
     FROM item_masters
     WHERE id = ?`,
    [itemMasterId]
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
    [itemMasterId]
  );

  const existing = result.rows[0] || null;

  if (!existing) {
    await tx.query(
      `INSERT INTO item_instance_counters
         (item_master_id, next_number)
       VALUES (?, 2)`,
      [itemMasterId]
    );

    return 1;
  }

  const number = Number(existing.next_number);

  await tx.query(
    `UPDATE item_instance_counters
     SET next_number = ?,
         updated_at = now()
     WHERE item_master_id = ?`,
    [number + 1, itemMasterId]
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
  return `${itemCode}-${String(number).padStart(4, '0')}`;
}

/**
 * Create one physical inventory instance and its RECEIVE movement.
 *
 * The entire operation happens inside one PostgreSQL transaction.
 */
async function receiveInstance({
  itemMasterId,
  quantity,
  siteId,
  performedBy,
  batchNumber = null,
  serialNumber = null,
  manufactureDate = null,
  expiryDate = null,
  reason = null
}) {
  if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
    throw new Error('Quantity must be greater than zero.');
  }

  const qty = Number(quantity);

  return db.tx(async (tx) => {
    // Lock and validate the item master.
    const itemMaster = await tx.one(
      `SELECT
         id,
         item_code,
         name,
         unit,
         is_consumable,
         allows_partial_consumption,
         requires_instance_tracking,
         status
       FROM item_masters
       WHERE id = ?
       FOR UPDATE`,
      [itemMasterId]
    );

    if (itemMaster.status !== 'ACTIVE') {
      throw new Error('Cannot receive inventory for an inactive item master.');
    }

    if (!itemMaster.requires_instance_tracking) {
      throw new Error(
        'This item master is not configured for physical instance tracking.'
      );
    }

    // Validate the destination site.
    const site = await tx.one(
      `SELECT id, code, name, site_type, status
       FROM sites
       WHERE id = ?
       FOR UPDATE`,
      [siteId]
    );

    if (site.status !== 'ACTIVE') {
      throw new Error('Cannot receive inventory into an inactive site.');
    }

    // Allocate a unique instance number.
    const instanceNumber = await allocateInstanceNumber(
      tx,
      itemMaster.id
    );

    const instanceCode = buildInstanceCode(
      itemMaster.item_code,
      instanceNumber
    );

    // For now the barcode value is the permanent instance code.
    // Later we can encode this same value into a printable QR/Code128 label.
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
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'GOOD', ?, ?, ?, ?)
       RETURNING *`,
      [
        itemMaster.id,
        instanceCode,
        barcode,
        qty,
        qty,
        itemMaster.unit,
        site.id,
        batchNumber || null,
        serialNumber || null,
        manufactureDate || null,
        expiryDate || null
      ]
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
        qty,
        site.id,
        instanceCode,
        reason || 'Inventory received',
        performedBy
      ]
    );

    return {
      instance,
      itemMaster,
      site
    };
  });
}

/**
 * List inventory instances accessible to a user.
 *
 * Admins can see everything.
 * Other users only see their assigned active sites.
 */
async function listInstancesForUser(user) {
  if (user.role === 'admin') {
    return db.many(
      `SELECT
         ii.id,
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
         ii.created_at,
         ii.updated_at,
         im.id AS item_master_id,
         im.item_code,
         im.name AS item_name,
         s.id AS site_id,
         s.code AS site_code,
         s.name AS site_name
       FROM item_instances ii
       JOIN item_masters im ON im.id = ii.item_master_id
       LEFT JOIN sites s ON s.id = ii.site_id
       ORDER BY ii.created_at DESC`
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
    [user.id]
  );
}

module.exports = {
  getItemMasterForInstance,
  allocateInstanceNumber,
  buildInstanceCode,
  receiveInstance,
  listInstancesForUser
};