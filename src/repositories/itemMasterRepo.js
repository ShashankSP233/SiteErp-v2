const db = require('../config/db');

async function listItemMasters() {
  return db.many(`
    SELECT
      im.id,
      im.item_code,
      im.name,
      im.description,
      im.category,
      im.unit,
      im.instance_quantity,
      im.instance_quantity_unit,
      im.is_consumable,
      im.allows_partial_consumption,
      im.requires_instance_tracking,
      im.reorder_level,
      im.status,
      im.created_at,

      COUNT(ii.id) AS instance_count,

      COALESCE(
        SUM(ii.current_quantity),
        0
      ) AS total_current_quantity

    FROM item_masters im

    LEFT JOIN item_instances ii
      ON ii.item_master_id = im.id
      AND ii.lifecycle_status = 'ACTIVE'

    GROUP BY im.id

    ORDER BY im.name ASC
  `);
}

async function getItemMasterById(id) {
  return db.one(`
    SELECT
      id,
      item_code,
      name,
      description,
      category,
      unit,
      instance_quantity,
      instance_quantity_unit,
      is_consumable,
      allows_partial_consumption,
      requires_instance_tracking,
      reorder_level,
      status,
      created_at,
      updated_at
    FROM item_masters
    WHERE id = ?
  `, [id]);
}

async function createItemMaster({
  itemCode,
  name,
  description,
  category,
  unit,
  instanceQuantity,
  instanceQuantityUnit,
  isConsumable = false,
  allowsPartialConsumption = false,
  requiresInstanceTracking = true,
  reorderLevel = 0
}, userId) {

  if (!itemCode?.trim()) {
    throw new Error('Item code is required.');
  }

  if (!name?.trim()) {
    throw new Error('Item name is required.');
  }

  if (!unit?.trim()) {
    throw new Error('Unit is required.');
  }

  const normalizedInstanceQuantity = Number(instanceQuantity);

  if (
    !Number.isFinite(normalizedInstanceQuantity) ||
    normalizedInstanceQuantity <= 0
  ) {
    throw new Error('Instance quantity must be greater than zero.');
  }

  if (!instanceQuantityUnit?.trim()) {
    throw new Error('Instance quantity unit is required.');
  }

  if (
    allowsPartialConsumption &&
    !isConsumable
  ) {
    throw new Error(
      'Partial consumption can only be enabled for consumable items.'
    );
  }

  const result = await db.one(`
    INSERT INTO item_masters (
      item_code,
      name,
      description,
      category,
      unit,
      instance_quantity,
      instance_quantity_unit,
      is_consumable,
      allows_partial_consumption,
      requires_instance_tracking,
      reorder_level,
      created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [
    itemCode.trim().toUpperCase(),
    name.trim(),
    description?.trim() || null,
    category?.trim() || null,
    unit.trim(),
    normalizedInstanceQuantity,
    instanceQuantityUnit.trim(),
    Boolean(isConsumable),
    Boolean(allowsPartialConsumption),
    Boolean(requiresInstanceTracking),
    Number(reorderLevel) || 0,
    userId
  ]);

  return getItemMasterById(result.id);
}

async function updateItemMaster(id, {
  name,
  description,
  category,
  unit,
  instanceQuantity,
  instanceQuantityUnit,
  isConsumable,
  allowsPartialConsumption,
  requiresInstanceTracking,
  reorderLevel,
  status
}) {

  if (!name?.trim()) {
    throw new Error('Item name is required.');
  }

  if (!unit?.trim()) {
    throw new Error('Unit is required.');
  }

  const normalizedInstanceQuantity = Number(instanceQuantity);

  if (
    !Number.isFinite(normalizedInstanceQuantity) ||
    normalizedInstanceQuantity <= 0
  ) {
    throw new Error('Instance quantity must be greater than zero.');
  }

  if (!instanceQuantityUnit?.trim()) {
    throw new Error('Instance quantity unit is required.');
  }

  if (
    allowsPartialConsumption &&
    !isConsumable
  ) {
    throw new Error(
      'Partial consumption can only be enabled for consumable items.'
    );
  }

  await db.query(`
    UPDATE item_masters
    SET
      name = ?,
      description = ?,
      category = ?,
      unit = ?,
      instance_quantity = ?,
      instance_quantity_unit = ?,
      is_consumable = ?,
      allows_partial_consumption = ?,
      requires_instance_tracking = ?,
      reorder_level = ?,
      status = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    name.trim(),
    description?.trim() || null,
    category?.trim() || null,
    unit.trim(),
    normalizedInstanceQuantity,
    instanceQuantityUnit.trim(),
    Boolean(isConsumable),
    Boolean(allowsPartialConsumption),
    Boolean(requiresInstanceTracking),
    Number(reorderLevel) || 0,
    status || 'ACTIVE',
    id
  ]);

  return getItemMasterById(id);
}

async function getItemMasterInstances(user, itemMasterId) {
  if (user?.role === 'admin') {
    return db.many(`
      SELECT
        ii.id,
        ii.instance_code,
        ii.barcode,

        ii.original_quantity,
        ii.current_quantity,
        ii.unit,

        ii.site_id,
        s.code AS site_code,
        s.name AS site_name,

        ii.lifecycle_status,
        ii.condition,

        ii.batch_number,
        ii.serial_number,
        ii.manufacture_date,
        ii.expiry_date,

        ii.received_grn_id,

        ii.created_at,
        ii.updated_at

      FROM item_instances ii

      LEFT JOIN sites s
        ON s.id = ii.site_id

      WHERE ii.item_master_id = ?

      ORDER BY
        CASE
          WHEN ii.lifecycle_status = 'ACTIVE' THEN 1
          WHEN ii.lifecycle_status = 'IN_TRANSIT' THEN 2
          WHEN ii.lifecycle_status = 'MIA' THEN 3
          WHEN ii.lifecycle_status = 'LOST' THEN 4
          WHEN ii.lifecycle_status = 'CONSUMED' THEN 5
          WHEN ii.lifecycle_status = 'DISPOSED' THEN 6
          ELSE 7
        END,
        ii.instance_code ASC
    `, [itemMasterId]);
  }

  return db.many(`
    SELECT
      ii.id,
      ii.instance_code,
      ii.barcode,

      ii.original_quantity,
      ii.current_quantity,
      ii.unit,

      ii.site_id,
      s.code AS site_code,
      s.name AS site_name,

      ii.lifecycle_status,
      ii.condition,

      ii.batch_number,
      ii.serial_number,
      ii.manufacture_date,
      ii.expiry_date,

      ii.received_grn_id,

      ii.created_at,
      ii.updated_at

    FROM item_instances ii

    JOIN site_assignments sa
      ON sa.site_id = ii.site_id
     AND sa.user_id = ?
     AND sa.assigned_until IS NULL

    LEFT JOIN sites s
      ON s.id = ii.site_id

    WHERE ii.item_master_id = ?

    ORDER BY
      CASE
        WHEN ii.lifecycle_status = 'ACTIVE' THEN 1
        WHEN ii.lifecycle_status = 'IN_TRANSIT' THEN 2
        WHEN ii.lifecycle_status = 'MIA' THEN 3
        WHEN ii.lifecycle_status = 'LOST' THEN 4
        WHEN ii.lifecycle_status = 'CONSUMED' THEN 5
        WHEN ii.lifecycle_status = 'DISPOSED' THEN 6
        ELSE 7
      END,
      ii.instance_code ASC
  `, [user.id, itemMasterId]);
}

module.exports = {
  listItemMasters,
  getItemMasterById,
  getItemMasterInstances,
  createItemMaster,
  updateItemMaster
};