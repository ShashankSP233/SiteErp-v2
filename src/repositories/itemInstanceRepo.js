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
  const normalizedItemCode = String(itemCode || '').trim().toUpperCase().replace(/\s+/g, '-');
  return `${normalizedItemCode}-${String(number).padStart(4, "0")}`;
}

function normalizeBarcodeCode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '-');
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

/** Stage direct-receive labels without adding stock yet. */
async function prepareDirectReceiptBatch({
  lines,
  siteId,
  performedBy,
  reason = null,
}) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('Add at least one item to receive.');
  if (lines.length > 100) throw new Error('A single stock receipt can contain up to 100 item rows.');

  return db.tx(async tx => {
    const site = await tx.one(
      `SELECT id, status FROM sites WHERE id = ? FOR UPDATE`,
      [siteId]
    );
    if (site.status !== 'ACTIVE') throw new Error('Cannot receive inventory into an inactive site.');

    const batch = await tx.one(
      `INSERT INTO inventory_receipt_batches
         (source_type, site_id, status, reason, created_by)
       VALUES ('DIRECT', ?, 'AWAITING_SCAN', ?, ?)
       RETURNING id`,
      [siteId, reason || null, performedBy]
    );
    let totalInstances = 0;
    const itemCodes = [];
    for (const line of lines) {
      const itemMasterId = Number(line.itemMasterId);
      const count = Number(line.instanceCount);
      if (!Number.isInteger(itemMasterId) || itemMasterId <= 0) throw new Error('Each stock row must have an item selected.');
      if (!Number.isInteger(count) || count <= 0) throw new Error('Each stock row must have a positive whole-number quantity.');
      if (line.serialNumber && count !== 1) throw new Error('A serial number can only be entered for a row with one physical instance.');

      const item = await tx.one(
        `SELECT id, item_code, name, status, unit, instance_quantity,
                instance_quantity_unit, requires_instance_tracking
         FROM item_masters WHERE id = ? FOR UPDATE`,
        [itemMasterId]
      );
      if (!item || item.status !== 'ACTIVE' || !item.requires_instance_tracking) {
        throw new Error('Select an active, instance-tracked item for every row.');
      }
      if (!Number.isFinite(Number(item.instance_quantity)) || Number(item.instance_quantity) <= 0 || !String(item.instance_quantity_unit || '').trim()) {
        throw new Error(`Item ${item.item_code} has invalid quantity-per-instance settings.`);
      }

      for (let i = 0; i < count; i += 1) {
        const number = await allocateInstanceNumber(tx, item.id);
        const code = buildInstanceCode(item.item_code, number);
        await tx.query(
          `INSERT INTO inventory_receipt_labels
             (receipt_batch_id, item_master_id, item_condition, instance_code,
              brand, barcode, batch_number, serial_number, manufacture_date, expiry_date)
           VALUES (?, ?, 'GOOD', ?, ?, ?, ?, ?, ?, ?)`,
          [batch.id, item.id, code, String(line.brand || '').trim() || null, code,
           String(line.batchNumber || '').trim() || null,
           String(line.serialNumber || '').trim() || null,
           line.manufactureDate || null, line.expiryDate || null]
        );
      }
      totalInstances += count;
      itemCodes.push(item.item_code);
    }
    return { batchId: batch.id, itemCodes: [...new Set(itemCodes)], totalInstances };
  });
}

async function getDirectReceiptBatch(batchId) {
  const batch = await db.one(
    `SELECT b.id, b.status, b.site_id, b.reason, b.labels_printed_at,
            s.code AS site_code, s.name AS site_name
     FROM inventory_receipt_batches b
     JOIN sites s ON s.id = b.site_id
     WHERE b.id = ? AND b.source_type = 'DIRECT'`,
    [batchId]
  );
  const result = await db.query(
    `SELECT l.id, l.instance_code, l.barcode, l.item_condition, l.brand,
            l.scanned_at, im.item_code, im.name AS item_name,
            im.instance_quantity, im.instance_quantity_unit
     FROM inventory_receipt_labels l
     JOIN item_masters im ON im.id = l.item_master_id
     WHERE l.receipt_batch_id = ? ORDER BY l.id`,
    [batch.id]
  );
  const labels = result.rows || result;
  return {
    ...batch,
    reference_number: `Direct receipt ${batch.id}`,
    labels,
    scannedCount: labels.filter(label => label.scanned_at).length,
    labelCount: labels.length
  };
}

async function listPendingDirectReceiptBatches(user) {
  const accessFilter = user?.role === 'admin'
    ? ''
    : `AND EXISTS (
        SELECT 1 FROM site_assignments sa
        JOIN sites assigned_site ON assigned_site.id = sa.site_id AND assigned_site.status = 'ACTIVE'
        WHERE sa.site_id = b.site_id AND sa.user_id = ? AND sa.assigned_until IS NULL
      )`;
  const result = await db.query(
    `SELECT b.id, b.site_id, b.reason, b.created_at, b.labels_printed_at,
            s.code AS site_code, s.name AS site_name,
            (SELECT COUNT(*) FROM inventory_receipt_labels l WHERE l.receipt_batch_id = b.id) AS label_count,
            (SELECT COUNT(*) FROM inventory_receipt_labels l WHERE l.receipt_batch_id = b.id AND l.scanned_at IS NOT NULL) AS scanned_count,
            (SELECT COUNT(DISTINCT l.item_master_id) FROM inventory_receipt_labels l WHERE l.receipt_batch_id = b.id) AS item_type_count
     FROM inventory_receipt_batches b
     JOIN sites s ON s.id = b.site_id
     WHERE b.source_type = 'DIRECT' AND b.status = 'AWAITING_SCAN'
       ${accessFilter}
     ORDER BY b.created_at DESC
     LIMIT 20`,
    user?.role === 'admin' ? [] : [user.id]
  );
  return result.rows || result;
}

async function markDirectReceiptLabelsPrinted({ batchId, performedBy }) {
  const result = await db.query(
    `UPDATE inventory_receipt_batches
     SET labels_printed_at = COALESCE(labels_printed_at, now()),
         labels_printed_by = COALESCE(labels_printed_by, ?), updated_at = now()
     WHERE id = ? AND source_type = 'DIRECT'
       AND status IN ('AWAITING_SCAN', 'COMPLETED')
     RETURNING id`,
    [performedBy, batchId]
  );
  const rows = result.rows || result;
  if (!rows.length) throw new Error('Direct receipt label batch was not found or is not ready to print.');
}

async function scanDirectReceiptBarcode({ batchId, barcode, performedBy }) {
  const value = normalizeBarcodeCode(barcode);
  if (!value) throw new Error('Scan or enter a barcode.');
  return db.tx(async tx => {
    const batch = await tx.one(
      `SELECT id, status, labels_printed_at
       FROM inventory_receipt_batches
       WHERE id = ? AND source_type = 'DIRECT' FOR UPDATE`,
      [batchId]
    );
    if (batch.status !== 'AWAITING_SCAN') throw new Error('This receipt batch is no longer open.');
    if (!batch.labels_printed_at) throw new Error('Start printing the barcode labels before scanning them.');
    const result = await tx.query(
      `UPDATE inventory_receipt_labels
       SET scanned_at = now(), scanned_by = ?
       WHERE receipt_batch_id = ? AND REPLACE(UPPER(barcode), ' ', '-') = ? AND scanned_at IS NULL
       RETURNING instance_code`,
      [performedBy, batch.id, value]
    );
    const rows = result.rows || result;
    if (!rows.length) {
      const exists = await tx.query(
        `SELECT id FROM inventory_receipt_labels
         WHERE receipt_batch_id = ? AND REPLACE(UPPER(barcode), ' ', '-') = ?`,
        [batch.id, value]
      );
      if ((exists.rows || exists).length) throw new Error('This barcode was already scanned.');
      const expected = await tx.query(
        `SELECT instance_code FROM inventory_receipt_labels
         WHERE receipt_batch_id = ? AND scanned_at IS NULL
         ORDER BY id LIMIT 5`,
        [batch.id]
      );
      const codes = (expected.rows || expected).map(row => normalizeBarcodeCode(row.instance_code));
      throw new Error(`Barcode “${value}” is not in this receipt. Scan one of the labels shown${codes.length ? ` (for example: ${codes.join(', ')})` : ''}.`);
    }
    return { ...rows[0], instance_code: normalizeBarcodeCode(rows[0].instance_code) };
  });
}

async function completeDirectReceiptBatch({ batchId, performedBy }) {
  return db.tx(async tx => {
    const batch = await tx.one(
      `SELECT b.id, b.site_id, b.status, b.reason, b.labels_printed_at
       FROM inventory_receipt_batches b
       WHERE b.id = ? AND b.source_type = 'DIRECT' FOR UPDATE`,
      [batchId]
    );
    if (batch.status !== 'AWAITING_SCAN') throw new Error('This receipt batch cannot be completed.');
    if (!batch.labels_printed_at) throw new Error('Print the labels before completing this receipt.');
    const counts = await tx.one(
      `SELECT COUNT(*) AS label_count, COUNT(scanned_at) AS scanned_count
       FROM inventory_receipt_labels WHERE receipt_batch_id = ?`,
      [batch.id]
    );
    if (Number(counts.label_count) !== Number(counts.scanned_count)) {
      throw new Error(`Scan all barcodes before adding stock (${counts.scanned_count}/${counts.label_count}).`);
    }
    const labels = await tx.query(
      `SELECT l.*, im.instance_quantity, im.instance_quantity_unit
       FROM inventory_receipt_labels l
       JOIN item_masters im ON im.id = l.item_master_id
       WHERE l.receipt_batch_id = ? ORDER BY l.id FOR UPDATE OF l`,
      [batch.id]
    );
    const instances = [];
    for (const label of (labels.rows || labels)) {
      const instanceCode = normalizeBarcodeCode(label.instance_code);
      const barcode = normalizeBarcodeCode(label.barcode);
      const instance = await tx.one(
        `INSERT INTO item_instances (
           item_master_id, instance_code, barcode, brand, original_quantity,
           current_quantity, unit, site_id, lifecycle_status, condition,
           batch_number, serial_number, manufacture_date, expiry_date
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'GOOD', ?, ?, ?, ?)
         RETURNING *`,
        [label.item_master_id, instanceCode, barcode, label.brand,
         label.instance_quantity, label.instance_quantity,
         label.instance_quantity_unit, batch.site_id, label.batch_number,
         label.serial_number, label.manufacture_date, label.expiry_date]
      );
      await tx.query(
        `INSERT INTO inventory_movements (
           instance_id, movement_type, quantity, from_site_id, to_site_id,
           reference_type, reference_id, reason, performed_by
         ) VALUES (?, 'RECEIVE', ?, NULL, ?, 'DIRECT_RECEIVE', ?, ?, ?)`,
        [instance.id, instance.original_quantity, batch.site_id,
         instance.instance_code, batch.reason || 'Direct inventory receipt', performedBy]
      );
      instances.push(instance);
    }
    await tx.query(
      `UPDATE inventory_receipt_batches
       SET status = 'COMPLETED', completed_by = ?, completed_at = now(), updated_at = now()
       WHERE id = ?`,
      [performedBy, batch.id]
    );
    return instances;
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
         ii.brand,
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
       ii.brand,
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
      ii.brand,
      ii.manufacture_date,
      ii.expiry_date,

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

async function updateInstanceDetails({ user, instanceId, condition, lifecycleStatus, brand, batchNumber, serialNumber, manufactureDate, expiryDate }) {
  const normalizedCondition = String(condition || '').toUpperCase();
  let normalizedStatus = String(lifecycleStatus || '').toUpperCase();
  if (!['GOOD', 'DAMAGED'].includes(normalizedCondition)) {
    throw new Error('Condition must be Good or Damaged.');
  }
  if (!['ACTIVE', 'QUARANTINED'].includes(normalizedStatus)) {
    throw new Error('Status must be Active or Quarantined.');
  }
  if (normalizedCondition === 'DAMAGED') normalizedStatus = 'QUARANTINED';

  const current = await db.one(
    `SELECT id, lifecycle_status FROM item_instances WHERE id = ?`,
    [instanceId]
  );
  if (!current) throw new Error('Inventory instance not found.');
  if (!['ACTIVE', 'QUARANTINED'].includes(current.lifecycle_status)) {
    throw new Error('Condition and traceability details can only be changed for active or quarantined instances.');
  }

  const result = await db.query(
    `UPDATE item_instances
     SET condition = ?, lifecycle_status = ?, brand = ?, batch_number = ?,
         serial_number = ?, manufacture_date = ?, expiry_date = ?, updated_at = now()
     WHERE id = ?
       AND (? = 'admin' OR EXISTS (
         SELECT 1 FROM site_assignments sa
         WHERE sa.site_id = item_instances.site_id
           AND sa.user_id = ? AND sa.assigned_until IS NULL
       ))
     RETURNING id`,
    [normalizedCondition, normalizedStatus, String(brand || '').trim() || null,
      String(batchNumber || '').trim() || null, String(serialNumber || '').trim() || null,
      manufactureDate || null, expiryDate || null, instanceId, user.role, user.id]
  );
  const rows = result.rows || result;
  if (!rows.length) throw new Error('You do not have access to update this inventory instance.');
  return rows[0];
}


module.exports = {
  getItemMasterForInstance,
  allocateInstanceNumber,
  buildInstanceCode,
  normalizeBarcodeCode,
  receiveInstancesWithinTransaction,
  receiveInstances,
  prepareDirectReceiptBatch,
  getDirectReceiptBatch,
  listPendingDirectReceiptBatches,
  markDirectReceiptLabelsPrinted,
  scanDirectReceiptBarcode,
  completeDirectReceiptBatch,
  listInstancesForUser,
  findInstanceForUser,
  updateInstanceDetails,
};
