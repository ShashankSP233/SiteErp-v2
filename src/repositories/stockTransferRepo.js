const db = require('../config/db');


function clean(value) {
  return String(value ?? '').trim();
}


function buildTransferNumber(number) {
  return `STN-${String(number).padStart(6, '0')}`;
}


async function allocateTransferNumber(tx) {
  const result = await tx.query(
    `SELECT
       next_number
     FROM stock_transfer_counters
     WHERE id = 1
     FOR UPDATE`
  );

  if (!result.rows.length) {
    await tx.query(
      `INSERT INTO stock_transfer_counters (
         id,
         next_number
       )
       VALUES (1, 2)`
    );

    return 1;
  }

  const number =
    Number(result.rows[0].next_number);

  await tx.query(
    `UPDATE stock_transfer_counters
     SET
       next_number = ?,
       updated_at = now()
     WHERE id = 1`,
    [number + 1]
  );

  return number;
}


/**
 * Get sites the user can use as a source site.
 *
 * Admin:
 *   all active sites.
 *
 * Others:
 *   assigned active sites only.
 */
async function getTransferSourceSites(user) {

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


/**
 * Destination sites.
 *
 * Any active site can be a transfer destination.
 * The receiver's site access is checked when Stock Inward
 * is performed.
 */
async function getTransferDestinationSites() {

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


/**
 * Verify user access to a site.
 */
async function assertSiteAccess(
  tx,
  user,
  siteId
) {

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
    [siteId]
  );

  if (!site) {
    throw new Error('Site not found.');
  }

  if (site.status !== 'ACTIVE') {
    throw new Error('The selected site is inactive.');
  }

  if (user.role === 'admin') {
    return site;
  }

  const assignment = await tx.one(
    `SELECT 1
     FROM site_assignments
     WHERE user_id = ?
       AND site_id = ?
       AND assigned_until IS NULL`,
    [
      user.id,
      site.id
    ]
  );

  if (!assignment) {
    throw new Error(
      'You do not have access to this site.'
    );
  }

  return site;
}


/**
 * Create an empty Stock Transfer / STN.
 */
async function createTransfer({
  fromSiteId,
  toSiteId,
  notes,
  user
}) {

  const sourceId = Number(fromSiteId);
  const destinationId = Number(toSiteId);

  if (
    !Number.isInteger(sourceId) ||
    sourceId <= 0
  ) {
    throw new Error(
      'A valid source site is required.'
    );
  }

  if (
    !Number.isInteger(destinationId) ||
    destinationId <= 0
  ) {
    throw new Error(
      'A valid destination site is required.'
    );
  }

  if (sourceId === destinationId) {
    throw new Error(
      'Source and destination sites must be different.'
    );
  }

  return db.tx(async tx => {

    const source =
      await assertSiteAccess(
        tx,
        user,
        sourceId
      );

    const destination =
      await tx.one(
        `SELECT
           id,
           code,
           name,
           site_type,
           status
         FROM sites
         WHERE id = ?
         FOR UPDATE`,
        [destinationId]
      );

    if (!destination) {
      throw new Error(
        'Destination site not found.'
      );
    }

    if (destination.status !== 'ACTIVE') {
      throw new Error(
        'Destination site is inactive.'
      );
    }

    const number =
      await allocateTransferNumber(tx);

    const transferNumber =
      buildTransferNumber(number);

    const transfer = await tx.one(
      `INSERT INTO stock_transfers (
         transfer_number,
         from_site_id,
         to_site_id,
         status,
         notes,
         created_by
       )
       VALUES (
         ?,
         ?,
         ?,
         'DRAFT',
         ?,
         ?
       )
       RETURNING *`,
      [
        transferNumber,
        source.id,
        destination.id,
        clean(notes) || null,
        user.id
      ]
    );

    return {
      transfer,
      source,
      destination
    };
  });
}


/**
 * Add one physical instance to a DRAFT transfer.
 *
 * The instance remains at the source site until dispatch.
 */
async function addTransferItem({
  transferId,
  instanceCode,
  user
}) {

  const id = Number(transferId);
  const code = clean(instanceCode);

  if (
    !Number.isInteger(id) ||
    id <= 0
  ) {
    throw new Error(
      'Invalid transfer.'
    );
  }

  if (!code) {
    throw new Error(
      'Instance code or barcode is required.'
    );
  }

  return db.tx(async tx => {

    const transfer = await tx.one(
      `SELECT
         id,
         transfer_number,
         from_site_id,
         to_site_id,
         status
       FROM stock_transfers
       WHERE id = ?
       FOR UPDATE`,
      [id]
    );

    if (!transfer) {
      throw new Error(
        'Stock transfer not found.'
      );
    }

    if (transfer.status !== 'DRAFT') {
      throw new Error(
        'Items can only be added to a draft transfer.'
      );
    }

    await assertSiteAccess(
      tx,
      user,
      transfer.from_site_id
    );

    const instance = await tx.one(
      `SELECT
         ii.id,
         ii.instance_code,
         ii.barcode,
         ii.current_quantity,
         ii.unit,
         ii.site_id,
         ii.lifecycle_status,
         ii.condition,

         im.item_code,
         im.name AS item_name

       FROM item_instances ii

       JOIN item_masters im
         ON im.id = ii.item_master_id

       WHERE (
         ii.instance_code = ?
         OR ii.barcode = ?
       )

       FOR UPDATE`,
      [
        code,
        code
      ]
    );

    if (!instance) {
      throw new Error(
        'Inventory instance not found.'
      );
    }

    if (
      Number(instance.site_id) !==
      Number(transfer.from_site_id)
    ) {
      throw new Error(
        'This inventory instance is not currently at the transfer source site.'
      );
    }

    if (instance.lifecycle_status !== 'ACTIVE') {
      throw new Error(
        `This inventory instance cannot be transferred because its status is ${instance.lifecycle_status}.`
      );
    }

    const quantity =
      Number(instance.current_quantity);

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      throw new Error(
        'This inventory instance has no quantity to transfer.'
      );
    }

    /*
     * An allocated/issued instance cannot be transferred.
     */
    const issueResult = await tx.one(
      `SELECT
         COALESCE(
           SUM(remaining_quantity),
           0
         ) AS allocated_quantity
       FROM inventory_issues
       WHERE instance_id = ?
         AND status IN (
           'OPEN',
           'PARTIALLY_CONSUMED'
         )`,
      [instance.id]
    );

    const allocated =
      Number(
        issueResult?.allocated_quantity || 0
      );

    if (allocated > 0) {
      throw new Error(
        `This instance has ${allocated} ${instance.unit} allocated to an active issue and cannot be transferred.`
      );
    }

    /*
     * Prevent the same physical instance from appearing
     * in another active/draft transfer.
     */
    const activeTransfer = await tx.one(
      `SELECT
         sti.id,
         st.transfer_number
       FROM stock_transfer_items sti
       JOIN stock_transfers st
         ON st.id = sti.transfer_id
       WHERE sti.instance_id = ?
         AND sti.status IN (
           'DRAFT',
           'IN_TRANSIT'
         )
       LIMIT 1`,
      [instance.id]
    );

    if (activeTransfer) {
      throw new Error(
        `This instance is already included in transfer ${activeTransfer.transfer_number}.`
      );
    }

    const item = await tx.one(
      `INSERT INTO stock_transfer_items (
         transfer_id,
         instance_id,
         quantity,
         status
       )
       VALUES (
         ?,
         ?,
         ?,
         'DRAFT'
       )
       RETURNING *`,
      [
        transfer.id,
        instance.id,
        quantity
      ]
    );

    return {
      transfer,
      item,
      instance
    };
  });
}

/** Remove an accidentally scanned instance while its transfer is still a draft. */
async function removeTransferItem({ transferId, itemId, user }) {
  const id = Number(transferId);
  const lineId = Number(itemId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(lineId) || lineId <= 0) {
    throw new Error('Invalid transfer item.');
  }

  return db.tx(async tx => {
    const transfer = await tx.one(
      `SELECT id, transfer_number, from_site_id, status
       FROM stock_transfers WHERE id = ? FOR UPDATE`,
      [id]
    );
    if (!transfer) throw new Error('Stock transfer not found.');
    if (transfer.status !== 'DRAFT') throw new Error('Instances can only be removed from a draft transfer.');

    await assertSiteAccess(tx, user, transfer.from_site_id);

    const item = await tx.one(
      `SELECT id, instance_id, status FROM stock_transfer_items
       WHERE id = ? AND transfer_id = ? FOR UPDATE`,
      [lineId, transfer.id]
    );
    if (!item) throw new Error('Transfer item not found.');
    if (item.status !== 'DRAFT') throw new Error('This instance can no longer be removed from the transfer.');

    await tx.query(
      'DELETE FROM stock_transfer_items WHERE id = ?',
      [item.id]
    );

    return { transfer, instanceId: item.instance_id };
  });
}


/**
 * Get one transfer with all physical instances.
 */
async function getTransferForUser(
  transferId,
  user
) {

  const id = Number(transferId);

  if (
    !Number.isInteger(id) ||
    id <= 0
  ) {
    throw new Error(
      'Invalid transfer.'
    );
  }

  const transfer = await db.one(
    `SELECT
       st.*,

       fs.code AS from_site_code,
       fs.name AS from_site_name,

       ts.code AS to_site_code,
       ts.name AS to_site_name,

       cu.full_name AS created_by_name,
       du.full_name AS dispatched_by_name

     FROM stock_transfers st

     JOIN sites fs
       ON fs.id = st.from_site_id

     JOIN sites ts
       ON ts.id = st.to_site_id

     JOIN users cu
       ON cu.id = st.created_by

     LEFT JOIN users du
       ON du.id = st.dispatched_by

     WHERE st.id = ?`,
    [id]
  );

  if (!transfer) {
    return null;
  }

  if (user.role !== 'admin') {

    const access = await db.one(
      `SELECT 1
       FROM site_assignments
       WHERE user_id = ?
         AND site_id IN (?, ?)
         AND assigned_until IS NULL
       LIMIT 1`,
      [
        user.id,
        transfer.from_site_id,
        transfer.to_site_id
      ]
    );

    if (!access) {
      throw new Error(
        'You do not have access to this transfer.'
      );
    }
  }

  const items = await db.many(
    `SELECT
       sti.id,
       sti.transfer_id,
       sti.instance_id,
       sti.quantity,
       sti.status,
       sti.received_by,
       sti.received_at,
       sti.receiver_notes,

       ii.instance_code,
       ii.barcode,
       ii.current_quantity,
       ii.unit,
       ii.lifecycle_status,

       im.item_code,
       im.name AS item_name,

       ru.full_name AS received_by_name

     FROM stock_transfer_items sti

     JOIN item_instances ii
       ON ii.id = sti.instance_id

     JOIN item_masters im
       ON im.id = ii.item_master_id

     LEFT JOIN users ru
       ON ru.id = sti.received_by

     WHERE sti.transfer_id = ?

     ORDER BY sti.id ASC`,
    [id]
  );

  return {
    transfer,
    items
  };
}


/**
 * List transfers visible to the current user.
 */
async function listTransfersForUser(user) {

  const params = [];

  let accessSql;

  if (user.role === 'admin') {

    accessSql = 'TRUE';

  } else {

    accessSql = `EXISTS (
      SELECT 1
      FROM site_assignments sa
      WHERE sa.user_id = ?
        AND sa.site_id IN (
          st.from_site_id,
          st.to_site_id
        )
        AND sa.assigned_until IS NULL
    )`;

    params.push(user.id);
  }

  return db.many(
    `SELECT
       st.id,
       st.transfer_number,
       st.status,
       st.notes,
       st.created_at,
       st.dispatched_at,
       st.completed_at,

       fs.code AS from_site_code,
       fs.name AS from_site_name,

       ts.code AS to_site_code,
       ts.name AS to_site_name,

       cu.full_name AS created_by_name,

       COUNT(sti.id) AS item_count,

       COUNT(sti.id) FILTER (
         WHERE sti.status = 'RECEIVED'
       ) AS received_count,

       COUNT(sti.id) FILTER (
         WHERE sti.status = 'IN_TRANSIT'
       ) AS in_transit_count

     FROM stock_transfers st

     JOIN sites fs
       ON fs.id = st.from_site_id

     JOIN sites ts
       ON ts.id = st.to_site_id

     JOIN users cu
       ON cu.id = st.created_by

     LEFT JOIN stock_transfer_items sti
       ON sti.transfer_id = st.id

     WHERE ${accessSql}

     GROUP BY
       st.id,
       fs.id,
       ts.id,
       cu.id

     ORDER BY
       st.created_at DESC,
       st.id DESC`,
    params
  );
}


/**
 * Dispatch a complete DRAFT transfer.
 *
 * Every item in the transfer is moved to IN_TRANSIT.
 */
async function dispatchTransfer({
  transferId,
  user
}) {

  const id = Number(transferId);

  return db.tx(async tx => {

    const transfer = await tx.one(
      `SELECT
         id,
         transfer_number,
         from_site_id,
         to_site_id,
         status
       FROM stock_transfers
       WHERE id = ?
       FOR UPDATE`,
      [id]
    );

    if (!transfer) {
      throw new Error(
        'Stock transfer not found.'
      );
    }

    if (transfer.status !== 'DRAFT') {
      throw new Error(
        'Only a draft transfer can be dispatched.'
      );
    }

    await assertSiteAccess(
      tx,
      user,
      transfer.from_site_id
    );

    const items = await tx.many(
      `SELECT
         sti.id,
         sti.instance_id,

         ii.instance_code,
         ii.current_quantity,
         ii.unit,
         ii.site_id,
         ii.lifecycle_status

       FROM stock_transfer_items sti

       JOIN item_instances ii
         ON ii.id = sti.instance_id

       WHERE sti.transfer_id = ?

       ORDER BY sti.id ASC

       FOR UPDATE`,
      [transfer.id]
    );

    if (!items.length) {
      throw new Error(
        'Cannot dispatch an empty stock transfer.'
      );
    }

    /*
     * Revalidate every physical instance at dispatch time.
     */
    for (const item of items) {

      if (
        Number(item.site_id) !==
        Number(transfer.from_site_id)
      ) {
        throw new Error(
          `Instance ${item.instance_code} is no longer at the transfer source site.`
        );
      }

      if (
        item.lifecycle_status !== 'ACTIVE'
      ) {
        throw new Error(
          `Instance ${item.instance_code} is no longer active.`
        );
      }

      const quantity =
        Number(item.current_quantity);

      if (
        !Number.isFinite(quantity) ||
        quantity <= 0
      ) {
        throw new Error(
          `Instance ${item.instance_code} has no quantity available for transfer.`
        );
      }

      const issue = await tx.one(
        `SELECT
           COALESCE(
             SUM(remaining_quantity),
             0
           ) AS allocated_quantity
         FROM inventory_issues
         WHERE instance_id = ?
           AND status IN (
             'OPEN',
             'PARTIALLY_CONSUMED'
           )`,
        [item.instance_id]
      );

      if (
        Number(issue?.allocated_quantity || 0) > 0
      ) {
        throw new Error(
          `Instance ${item.instance_code} has an active issue and cannot be dispatched.`
        );
      }
    }

    /*
     * Move each instance into transit.
     */
    for (const item of items) {

      const quantity =
        Number(item.current_quantity);

      await tx.query(
        `UPDATE item_instances
         SET
           site_id = NULL,
           lifecycle_status = 'IN_TRANSIT',
           updated_at = now()
         WHERE id = ?`,
        [item.instance_id]
      );

      await tx.query(
        `UPDATE stock_transfer_items
         SET
           quantity = ?,
           status = 'IN_TRANSIT',
           updated_at = now()
         WHERE id = ?`,
        [
          quantity,
          item.id
        ]
      );

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
           'TRANSFER_OUT',
           ?,
           ?,
           ?,
           'STOCK_TRANSFER',
           ?,
           ?,
           ?
         )`,
        [
          item.instance_id,
          quantity,
          transfer.from_site_id,
          transfer.to_site_id,
          transfer.transfer_number,
          'Stock transfer dispatched',
          user.id
        ]
      );
    }

    const updated = await tx.one(
      `UPDATE stock_transfers
       SET
         status = 'IN_TRANSIT',
         dispatched_by = ?,
         dispatched_at = now(),
         updated_at = now()
       WHERE id = ?
       RETURNING *`,
      [
        user.id,
        transfer.id
      ]
    );

    return updated;
  });
}


/**
 * Receive selected transfer items at the destination site.
 *
 * This is the Stock Inward operation.
 */
async function receiveTransferItems({
  transferId,
  itemIds,
  user
}) {

  const id = Number(transferId);

  const ids = (
    Array.isArray(itemIds)
      ? itemIds
      : [itemIds]
  )
    .map(Number)
    .filter(
      value =>
        Number.isInteger(value) &&
        value > 0
    );

  if (!ids.length) {
    throw new Error(
      'Select at least one inventory instance to receive.'
    );
  }

  return db.tx(async tx => {

    const transfer = await tx.one(
      `SELECT
         id,
         transfer_number,
         from_site_id,
         to_site_id,
         status
       FROM stock_transfers
       WHERE id = ?
       FOR UPDATE`,
      [id]
    );

    if (!transfer) {
      throw new Error(
        'Stock transfer not found.'
      );
    }

    if (
      ![
        'IN_TRANSIT',
        'PARTIALLY_RECEIVED'
      ].includes(transfer.status)
    ) {
      throw new Error(
        'This transfer is not available for Stock Inward.'
      );
    }

    /*
     * Receiver must have access to destination site.
     */
    await assertSiteAccess(
      tx,
      user,
      transfer.to_site_id
    );

    const received = [];

    for (const itemId of ids) {

      const item = await tx.one(
        `SELECT
           sti.id,
           sti.instance_id,
           sti.quantity,
           sti.status,

           ii.instance_code,
           ii.barcode,
           ii.current_quantity,
           ii.unit,
           ii.site_id,
           ii.lifecycle_status

         FROM stock_transfer_items sti

         JOIN item_instances ii
           ON ii.id = sti.instance_id

         WHERE sti.id = ?
           AND sti.transfer_id = ?

         FOR UPDATE`,
        [
          itemId,
          transfer.id
        ]
      );

      if (!item) {
        throw new Error(
          `Transfer item ${itemId} was not found.`
        );
      }

      if (item.status !== 'IN_TRANSIT') {
        throw new Error(
          `Instance ${item.instance_code} is not currently in transit.`
        );
      }

      if (
        item.lifecycle_status !==
        'IN_TRANSIT'
      ) {
        throw new Error(
          `Instance ${item.instance_code} is not marked as in transit.`
        );
      }

      if (item.site_id !== null) {
        throw new Error(
          `Instance ${item.instance_code} already has a site assignment.`
        );
      }

      await tx.query(
        `UPDATE item_instances
         SET
           site_id = ?,
           lifecycle_status = 'ACTIVE',
           updated_at = now()
         WHERE id = ?`,
        [
          transfer.to_site_id,
          item.instance_id
        ]
      );

      await tx.query(
        `UPDATE stock_transfer_items
         SET
           status = 'RECEIVED',
           received_by = ?,
           received_at = now(),
           updated_at = now()
         WHERE id = ?`,
        [
          user.id,
          item.id
        ]
      );

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
           'TRANSFER_IN',
           ?,
           ?,
           ?,
           'STOCK_TRANSFER',
           ?,
           ?,
           ?
         )`,
        [
          item.instance_id,
          item.quantity,
          transfer.from_site_id,
          transfer.to_site_id,
          transfer.transfer_number,
          'Stock transfer received',
          user.id
        ]
      );

      received.push(item);
    }

    const remaining = await tx.one(
      `SELECT
         COUNT(*) AS count
       FROM stock_transfer_items
       WHERE transfer_id = ?
         AND status = 'IN_TRANSIT'`,
      [transfer.id]
    );

    const remainingCount =
      Number(remaining.count);

    const newStatus =
      remainingCount === 0
        ? 'RECEIVED'
        : 'PARTIALLY_RECEIVED';

    const updated = await tx.one(
      `UPDATE stock_transfers
       SET
         status = ?,
         completed_at = CASE
           WHEN ? = 'RECEIVED'
             THEN now()
           ELSE completed_at
         END,
         updated_at = now()
       WHERE id = ?
       RETURNING *`,
      [
        newStatus,
        newStatus,
        transfer.id
      ]
    );

    return {
      transfer: updated,
      received
    };
  });
}

async function listIncomingTransfersForUser(user) {
  const params = [];

  let accessSql;

  if (user.role === 'admin') {
    accessSql = 'TRUE';
  } else {
    accessSql = `EXISTS (
      SELECT 1
      FROM site_assignments sa
      WHERE sa.user_id = ?
        AND sa.site_id = st.to_site_id
        AND sa.assigned_until IS NULL
    )`;

    params.push(user.id);
  }

  return db.many(
    `SELECT
       st.id,
       st.transfer_number,
       st.status,
       st.notes,
       st.created_at,
       st.dispatched_at,

       fs.code AS from_site_code,
       fs.name AS from_site_name,

       ts.code AS to_site_code,
       ts.name AS to_site_name,

       cu.full_name AS created_by_name,

       COUNT(sti.id) AS item_count,

       COUNT(sti.id) FILTER (
         WHERE sti.status = 'RECEIVED'
       ) AS received_count,

       COUNT(sti.id) FILTER (
         WHERE sti.status = 'IN_TRANSIT'
       ) AS in_transit_count

     FROM stock_transfers st

     JOIN sites fs
       ON fs.id = st.from_site_id

     JOIN sites ts
       ON ts.id = st.to_site_id

     JOIN users cu
       ON cu.id = st.created_by

     LEFT JOIN stock_transfer_items sti
       ON sti.transfer_id = st.id

     WHERE
       ${accessSql}

       AND st.status IN (
         'IN_TRANSIT',
         'PARTIALLY_RECEIVED'
       )

     GROUP BY
       st.id,
       fs.id,
       ts.id,
       cu.id

     ORDER BY
       st.dispatched_at DESC NULLS LAST,
       st.id DESC`,
    params
  );
}

/**
 * Receive ONE physical inventory instance by scanning
 * its barcode or instance code.
 *
 * The scanned instance MUST:
 *   - belong to this transfer
 *   - currently be IN_TRANSIT
 *   - not already be received
 *
 * The receiver must have access to the transfer's
 * destination site.
 */
async function receiveTransferItemByScan({
  transferId,
  scannedCode,
  user
}) {
  const id = Number(transferId);
  const code = clean(scannedCode);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid transfer.');
  }

  if (!code) {
    throw new Error(
      'Instance code or barcode is required.'
    );
  }

  return db.tx(async tx => {

    const transfer = await tx.one(
      `SELECT
         id,
         transfer_number,
         from_site_id,
         to_site_id,
         status
       FROM stock_transfers
       WHERE id = ?
       FOR UPDATE`,
      [id]
    );

    if (!transfer) {
      throw new Error(
        'Stock transfer not found.'
      );
    }

    if (
      ![
        'IN_TRANSIT',
        'PARTIALLY_RECEIVED'
      ].includes(transfer.status)
    ) {
      throw new Error(
        'This transfer is not available for receiving.'
      );
    }

    /*
     * Receiver must have access to the destination site.
     */
    await assertSiteAccess(
      tx,
      user,
      transfer.to_site_id
    );

    /*
     * Resolve the physical instance using either:
     *   - instance code
     *   - permanent barcode
     */
    const instance = await tx.one(
      `SELECT
         ii.id,
         ii.instance_code,
         ii.barcode,
         ii.current_quantity,
         ii.unit,
         ii.site_id,
         ii.lifecycle_status,

         im.item_code,
         im.name AS item_name

       FROM item_instances ii

       JOIN item_masters im
         ON im.id = ii.item_master_id

       WHERE (
         ii.instance_code = ?
         OR ii.barcode = ?
       )

       FOR UPDATE`,
      [
        code,
        code
      ]
    );

    if (!instance) {
      throw new Error(
        `No inventory instance found for "${code}".`
      );
    }

    /*
     * The instance must actually belong to THIS transfer.
     */
    const transferItem = await tx.one(
      `SELECT
         sti.id,
         sti.instance_id,
         sti.quantity,
         sti.status
       FROM stock_transfer_items sti
       WHERE sti.transfer_id = ?
         AND sti.instance_id = ?
       FOR UPDATE`,
      [
        transfer.id,
        instance.id
      ]
    );

    if (!transferItem) {
      throw new Error(
        `Instance ${instance.instance_code} is not part of transfer ${transfer.transfer_number}.`
      );
    }

    /*
     * Prevent receiving an item twice.
     */
    if (transferItem.status === 'RECEIVED') {
      throw new Error(
        `Instance ${instance.instance_code} has already been received.`
      );
    }

    if (transferItem.status !== 'IN_TRANSIT') {
      throw new Error(
        `Instance ${instance.instance_code} is not currently in transit.`
      );
    }

    if (
      instance.lifecycle_status !==
      'IN_TRANSIT'
    ) {
      throw new Error(
        `Instance ${instance.instance_code} is not marked as IN TRANSIT.`
      );
    }

    if (instance.site_id !== null) {
      throw new Error(
        `Instance ${instance.instance_code} already has a site assignment.`
      );
    }

    /*
     * Put the SAME physical instance at the
     * destination site.
     */
    await tx.query(
      `UPDATE item_instances
       SET
         site_id = ?,
         lifecycle_status = 'ACTIVE',
         updated_at = now()
       WHERE id = ?`,
      [
        transfer.to_site_id,
        instance.id
      ]
    );

    /*
     * Mark this individual transfer item received.
     */
    await tx.query(
      `UPDATE stock_transfer_items
       SET
         status = 'RECEIVED',
         received_by = ?,
         received_at = now(),
         updated_at = now()
       WHERE id = ?`,
      [
        user.id,
        transferItem.id
      ]
    );

    /*
     * Record the inward movement.
     */
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
         'TRANSFER_IN',
         ?,
         ?,
         ?,
         'STOCK_TRANSFER',
         ?,
         ?,
         ?
       )`,
      [
        instance.id,
        transferItem.quantity,
        transfer.from_site_id,
        transfer.to_site_id,
        transfer.transfer_number,
        'Stock transfer received by scan',
        user.id
      ]
    );

    /*
     * Determine whether the complete transfer has now
     * been received.
     */
    const remaining = await tx.one(
      `SELECT
         COUNT(*) AS count
       FROM stock_transfer_items
       WHERE transfer_id = ?
         AND status = 'IN_TRANSIT'`,
      [transfer.id]
    );

    const remainingCount =
      Number(remaining.count);

    const newStatus =
      remainingCount === 0
        ? 'RECEIVED'
        : 'PARTIALLY_RECEIVED';

    const updatedTransfer = await tx.one(
      `UPDATE stock_transfers
       SET
         status = ?,
         completed_at = CASE
           WHEN ? = 'RECEIVED'
             THEN now()
           ELSE completed_at
         END,
         updated_at = now()
       WHERE id = ?
       RETURNING *`,
      [
        newStatus,
        newStatus,
        transfer.id
      ]
    );

    return {
      transfer: updatedTransfer,

      instance: {
        ...instance,
        status: 'RECEIVED'
      },

      transferItem,

      remainingCount
    };
  });
}

async function updateTransferItemReceiverNote({ transferId, itemId, receiverNotes, user }) {
  const id = Number(transferId);
  const lineId = Number(itemId);
  const notes = clean(receiverNotes).slice(0, 1000) || null;
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(lineId) || lineId <= 0) {
    throw new Error('Invalid transfer item.');
  }

  return db.tx(async tx => {
    const transfer = await tx.one(
      `SELECT id, to_site_id FROM stock_transfers WHERE id = ? FOR UPDATE`,
      [id]
    );
    if (!transfer) throw new Error('Stock transfer not found.');
    await assertSiteAccess(tx, user, transfer.to_site_id);

    const item = await tx.one(
      `SELECT id, status FROM stock_transfer_items
       WHERE id = ? AND transfer_id = ? FOR UPDATE`,
      [lineId, transfer.id]
    );
    if (!item) throw new Error('Transfer item not found.');
    if (item.status !== 'RECEIVED') throw new Error('A receiver note can only be added after the instance is received.');

    await tx.query(
      `UPDATE stock_transfer_items SET receiver_notes = ?, updated_at = now() WHERE id = ?`,
      [notes, item.id]
    );
    return { transfer };
  });
}
/**
 * Close Stock Inward.
 *
 * Any transfer item that is still IN_TRANSIT is considered
 * missing and is marked MIA.
 *
 * MIA instances:
 *   - remain the same physical inventory instance
 *   - keep their quantity
 *   - have no site assignment
 *   - have lifecycle_status = MIA
 *
 * No TRANSFER_IN movement is created for MIA items because
 * they were never physically received at the destination.
 */
async function closeInward({
  transferId,
  user
}) {
  const id = Number(transferId);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid transfer.');
  }

  return db.tx(async tx => {

    /*
     * Lock the transfer so two users cannot close the
     * same inward operation simultaneously.
     */
    const transfer = await tx.one(
      `SELECT
         id,
         transfer_number,
         from_site_id,
         to_site_id,
         status
       FROM stock_transfers
       WHERE id = ?
       FOR UPDATE`,
      [id]
    );

    if (!transfer) {
      throw new Error(
        'Stock transfer not found.'
      );
    }

    if (
      ![
        'IN_TRANSIT',
        'PARTIALLY_RECEIVED'
      ].includes(transfer.status)
    ) {
      throw new Error(
        `This transfer cannot be closed from status ${transfer.status}.`
      );
    }

    /*
     * The user closing inward must have access to the
     * destination site.
     */
    await assertSiteAccess(
      tx,
      user,
      transfer.to_site_id
    );

    /*
     * Lock every item that has not yet been received.
     */
    const missingItems = await tx.many(
      `SELECT
         sti.id,
         sti.instance_id,
         sti.quantity,
         sti.status,

         ii.instance_code,
         ii.barcode,
         ii.lifecycle_status,
         ii.site_id

       FROM stock_transfer_items sti

       JOIN item_instances ii
         ON ii.id = sti.instance_id

       WHERE sti.transfer_id = ?
         AND sti.status = 'IN_TRANSIT'

       FOR UPDATE`,
      [transfer.id]
    );

    if (!missingItems.length) {
      throw new Error(
        'There are no outstanding items to mark as MIA.'
      );
    }

    /*
     * Mark every unreceived transfer item as MIA.
     */
    for (const item of missingItems) {

      /*
       * The physical instance is now officially missing.
       *
       * It stays the same instance and keeps its quantity,
       * but it no longer belongs to a site.
       */
      await tx.query(
        `UPDATE item_instances
         SET
           site_id = NULL,
           lifecycle_status = 'MIA',
           updated_at = now()
         WHERE id = ?`,
        [item.instance_id]
      );

      /*
       * Mark the transfer item as MIA.
       */
      await tx.query(
        `UPDATE stock_transfer_items
         SET
           status = 'MIA',
           mia_by = ?,
           mia_at = now(),
           mia_reason = ?,
           updated_at = now()
         WHERE id = ?`,
        [
          user.id,
          'Not received during Stock Inward.',
          item.id
        ]
      );
    }

    /*
     * The inward operation is now closed.
     *
     * The transfer can contain:
     *   RECEIVED + MIA
     */
    const updatedTransfer = await tx.one(
      `UPDATE stock_transfers
       SET
         status = 'CLOSED',
         completed_at = now(),
         updated_at = now()
       WHERE id = ?
       RETURNING *`,
      [transfer.id]
    );

    return {
      transfer: updatedTransfer,
      mia: missingItems
    };
  });
}
module.exports = {
  getTransferSourceSites,
  getTransferDestinationSites,
  createTransfer,
  addTransferItem,
  removeTransferItem,
  listTransfersForUser,
  getTransferForUser,
  dispatchTransfer,
  receiveTransferItems,
  listIncomingTransfersForUser,
  receiveTransferItemByScan,
  updateTransferItemReceiverNote,
  closeInward
};
