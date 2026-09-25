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
      is_consumable,
      allows_partial_consumption,
      requires_instance_tracking,
      reorder_level,
      created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [
    itemCode.trim().toUpperCase(),
    name.trim(),
    description?.trim() || null,
    category?.trim() || null,
    unit.trim(),
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
    Boolean(isConsumable),
    Boolean(allowsPartialConsumption),
    Boolean(requiresInstanceTracking),
    Number(reorderLevel) || 0,
    status || 'ACTIVE',
    id
  ]);

  return getItemMasterById(id);
}


module.exports = {
  listItemMasters,
  getItemMasterById,
  createItemMaster,
  updateItemMaster
};