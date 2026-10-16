const db = require('../config/db');

function buildIssueNumber(number) {
  return `ISS-${String(number).padStart(6, '0')}`;
}

async function allocateIssueNumber(tx) {
  const result = await tx.query(
    `SELECT next_number
     FROM inventory_issue_counters
     WHERE id = 1
     ${db.rowLock}`
  );

  if (result.rows.length === 0) {
    await tx.query(
      `INSERT INTO inventory_issue_counters (id, next_number)
       VALUES (1, 2)`
    );

    return 1;
  }

  const number = Number(result.rows[0].next_number);

  await tx.query(
    `UPDATE inventory_issue_counters
     SET next_number = $1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = 1`,
    [number + 1]
  );

  return number;
}

async function issueInstance({
  instanceCode,
  quantity,
  recipientType,
  recipientReference,
  reason,
  issuedBy,
  userRole,
  batchId = null
}) {
  return db.tx(async (tx) => {

    let batch = null;
    if (batchId) {
      batch = await tx.one(`SELECT * FROM inventory_issue_batches WHERE id=?${db.rowLock}`, [batchId]);
      if (!batch || batch.status !== 'OPEN') throw new Error('This issue batch is no longer accepting items.');
      recipientType = batch.recipient_type;
      recipientReference = batch.recipient_reference;
      reason = batch.reason;
    }

    const normalizedInstanceCode =
      String(instanceCode || '').trim();

    if (!normalizedInstanceCode) {
      throw new Error('Inventory instance not found.');
    }

    /*
     * Lock the physical instance before making any changes.
     */
    const instanceResult = await tx.query(
      `SELECT
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

         im.item_code,
         im.name AS item_name,
         im.is_consumable,
         im.allows_partial_consumption

       FROM item_instances ii

       JOIN item_masters im
         ON im.id = ii.item_master_id

       WHERE ii.instance_code = $1 OR ii.barcode = $1

       ${db.rowLock}`,
      [normalizedInstanceCode]
    );

    if (instanceResult.rows.length === 0) {
      throw new Error('Inventory instance not found.');
    }

    const instance = instanceResult.rows[0];

    const membership = await tx.one(
      `SELECT l.kit_id, k.kit_code FROM item_kit_lines l JOIN item_kits k ON k.id=l.kit_id WHERE l.item_instance_id=? AND k.status='ACTIVE'`,
      [instance.id]
    );
    if (membership && !batch) {
      throw new Error(`Instance ${instance.instance_code} belongs to kit ${membership.kit_code}. Issue it as part of an issue batch.`);
    }

    if (batch) {
      if (batch.site_id && Number(batch.site_id) !== Number(instance.site_id)) {
        throw new Error('All instances in an issue batch must come from the same site.');
      }
      if (membership) {
        const selected = await tx.one(`SELECT 1 FROM inventory_issue_batch_kits WHERE batch_id=? AND kit_id=?`, [batch.id, membership.kit_id]);
        if (!selected) throw new Error(`Instance ${instance.instance_code} belongs to kit ${membership.kit_code}. Add that kit to this batch before issuing its instances.`);
      }
    }

    /*
     * The instance must currently belong to a site.
     */
    if (!instance.site_id) {
      throw new Error(
        'This inventory instance is not currently at a site.'
      );
    }

    /*
     * Only ACTIVE instances can be issued.
     */
    if (instance.lifecycle_status !== 'ACTIVE') {
      throw new Error(
        `This inventory instance cannot be issued because its status is ${instance.lifecycle_status}.`
      );
    }

    const currentQuantity = Number(instance.current_quantity);

    if (!Number.isFinite(currentQuantity) || currentQuantity <= 0) {
      throw new Error(
        'This inventory instance has no quantity available.'
      );
    }

    /*
     * Calculate the quantity not already allocated to another active issue.
     */
    const allocationResult = await tx.query(
      `SELECT COALESCE(SUM(remaining_quantity), 0) AS allocated_quantity
       FROM inventory_issues
       WHERE instance_id = $1
         AND status IN ('OPEN', 'PARTIALLY_CONSUMED')`,
      [instance.id]
    );

    const allocatedQuantity = Number(
      allocationResult.rows[0].allocated_quantity
    );

    const availableQuantity =
      currentQuantity - allocatedQuantity;

    if (!Number.isFinite(availableQuantity) || availableQuantity <= 0) {
      throw new Error(
        'This inventory instance has no available quantity to issue.'
      );
    }

    const quantityText =
      quantity === undefined || quantity === null
        ? ''
        : String(quantity).trim();

    const issueQuantity = quantityText === ''
      ? availableQuantity
      : Number(quantityText);

    if (
      !Number.isFinite(issueQuantity) ||
      issueQuantity <= 0
    ) {
      throw new Error(
        'Issue quantity must be greater than zero.'
      );
    }

    if (issueQuantity > availableQuantity) {
      throw new Error(
        `Cannot issue more than the available quantity of ${availableQuantity} ${instance.unit}.`
      );
    }

    /*
     * Non-consumable items represent a complete physical unit.
     *
     * Example:
     *   Non-consumable item = 1 EA
     *
     * It cannot be partially issued.
     */
    if (!instance.is_consumable && issueQuantity !== currentQuantity) {
      throw new Error(
        `This item is not consumable. The full quantity of ${currentQuantity} ${instance.unit} must be issued.`
      );
    }

    /*
     * Consumable items that do not allow partial consumption
     * must also be issued as a complete quantity.
     */
    if (
      instance.is_consumable &&
      !instance.allows_partial_consumption &&
      issueQuantity !== availableQuantity
    ) {
      throw new Error(
        'This item is a non-partial consumable and must be issued as its complete available quantity.'
      );
    }

    /*
     * Authorization:
     *
     * Admins can issue from any active site.
     *
     * Other users must have an active assignment to
     * the instance's current site.
     */
    if (userRole !== 'admin') {
      const accessResult = await tx.query(
        `SELECT 1
         FROM site_assignments sa
         JOIN sites s
           ON s.id = sa.site_id
         WHERE sa.user_id = $1
           AND sa.site_id = $2
           AND sa.assigned_until IS NULL
           AND s.status = 'ACTIVE'
         LIMIT 1`,
        [
          issuedBy,
          instance.site_id
        ]
      );

      if (accessResult.rows.length === 0) {
        throw new Error(
          'You do not have permission to issue inventory from this site.'
        );
      }
    }

    /*
     * One physical instance can have only one active issue
     * allocation at a time.
     */
    const existingIssue = await tx.query(
      `SELECT id
       FROM inventory_issues
       WHERE instance_id = $1
         AND status IN (
           'OPEN',
           'PARTIALLY_CONSUMED'
         )
       LIMIT 1`,
      [instance.id]
    );

    if (existingIssue.rows.length > 0) {
      throw new Error(
        'This inventory instance already has an active issue.'
      );
    }

    /*
     * Allocate the next issue number safely.
     */
    const issueNumberValue =
      await allocateIssueNumber(tx);

    const issueNumber =
      buildIssueNumber(issueNumberValue);

    const automaticallyConsume =
      instance.is_consumable &&
      !instance.allows_partial_consumption;

    const issueStatus = automaticallyConsume
      ? 'CLOSED'
      : 'OPEN';

    const issueRemainingQuantity = automaticallyConsume
      ? 0
      : issueQuantity;

    /*
     * IMPORTANT:
     *
     * site_id remains the original site's ID.
     *
    * For an ordinary issue, the issue record represents
    * the quantity currently allocated to the recipient.
     *
     * Example:
     *
     * Instance = 20 L
     * Issue    = 5 L
     *
     * item_instances.current_quantity = 20
     * inventory_issues.remaining_quantity = 5
     *
     * Therefore site-available quantity is:
     *
     * 20 - 5 = 15 L
     *
    * The physical instance/barcode remains unchanged for
    * allocation-only issues.
     */
    const issueResult = await tx.query(
      `INSERT INTO inventory_issues (
         batch_id,
         issue_number,
         instance_id,
         site_id,
         issued_quantity,
         remaining_quantity,
         recipient_type,
         recipient_reference,
         reason,
         issued_by,
         status
       )
       VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         $6,
         $7,
         $8,
         $9,
         $10,
         $11
       )
       RETURNING *`,
      [
        batch ? batch.id : null,
        issueNumber,
        instance.id,
        instance.site_id,
        issueQuantity,
        issueRemainingQuantity,
        recipientType,
        recipientReference || null,
        reason || null,
        issuedBy,
        issueStatus
      ]
    );

    if (batch && !batch.site_id) {
      await tx.query(`UPDATE inventory_issue_batches SET site_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [instance.site_id, batch.id]);
    }

    /*
     * The ordinary issue path only allocates quantity.
     * Automatic consumption below is the exception for
     * non-partial consumable items.
     */

    /*
     * Record the actual quantity issued.
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
         $1,
         'ISSUE',
         $2,
         $3,
         NULL,
         'INVENTORY_ISSUE',
         $4,
         $5,
         $6
       )`,
      [
        instance.id,
        issueQuantity,
        instance.site_id,
        issueNumber,
        reason || null,
        issuedBy
      ]
    );

    let automaticConsumption = null;

    if (automaticallyConsume) {
      const newInstanceQuantity =
        currentQuantity - issueQuantity;

      const lifecycleStatus =
        newInstanceQuantity === 0
          ? 'CONSUMED'
          : 'ACTIVE';

      await tx.query(
        `UPDATE item_instances
         SET
           current_quantity = $1,
           lifecycle_status = $2,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [
          newInstanceQuantity,
          lifecycleStatus,
          instance.id
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
           $1,
           'CONSUME',
           $2,
           NULL,
           NULL,
           'INVENTORY_ISSUE',
           $3,
           $4,
           $5
         )`,
        [
          instance.id,
          issueQuantity,
          issueNumber,
          reason || null,
          issuedBy
        ]
      );

      automaticConsumption = {
        consumedQuantity: issueQuantity,
        remainingQuantity: 0,
        unit: instance.unit,
        status: 'CLOSED',
        lifecycleStatus
      };
    }

    return {
      issue: issueResult.rows[0],
      instance,
      automaticConsumption
    };
  });
}

async function listOpenIssuesForUser(user) {
  if (user.role === 'admin') {
    const result = await db.query(
      `SELECT
         inv.id,
         inv.issue_number,
         inv.instance_id,
         inv.site_id,
         inv.issued_quantity,
         inv.remaining_quantity,
         inv.recipient_type,
         inv.recipient_reference,
         inv.reason,
         inv.status,
         inv.issued_at,
         ii.instance_code,
         ii.barcode,
         ii.unit,
         im.item_code,
         im.name AS item_name,
         im.is_consumable,
         im.allows_partial_consumption,
         s.code AS site_code,
         s.name AS site_name,
         u.full_name AS issued_by_name
       FROM inventory_issues inv
       JOIN item_instances ii
         ON ii.id = inv.instance_id
       JOIN item_masters im
         ON im.id = ii.item_master_id
       LEFT JOIN sites s
         ON s.id = inv.site_id
       JOIN users u
         ON u.id = inv.issued_by
       WHERE inv.status IN ('OPEN', 'PARTIALLY_CONSUMED')
       ORDER BY inv.issued_at DESC`
    );

    return result.rows;
  }

  const result = await db.query(
    `SELECT
       inv.id,
       inv.issue_number,
       inv.instance_id,
       inv.site_id,
       inv.issued_quantity,
       inv.remaining_quantity,
       inv.recipient_type,
       inv.recipient_reference,
       inv.reason,
       inv.status,
       inv.issued_at,
       ii.instance_code,
       ii.barcode,
       ii.unit,
       im.item_code,
       im.name AS item_name,
      im.is_consumable,
      im.allows_partial_consumption,
       s.code AS site_code,
       s.name AS site_name,
       u.full_name AS issued_by_name
     FROM inventory_issues inv
     JOIN item_instances ii
       ON ii.id = inv.instance_id
     JOIN item_masters im
       ON im.id = ii.item_master_id
     LEFT JOIN sites s
       ON s.id = inv.site_id
     JOIN users u
       ON u.id = inv.issued_by
     WHERE inv.status IN ('OPEN', 'PARTIALLY_CONSUMED')
       AND EXISTS (
         SELECT 1
         FROM site_assignments sa
         WHERE sa.user_id = $1
           AND sa.site_id = inv.site_id
           AND sa.assigned_until IS NULL
       )
     ORDER BY inv.issued_at DESC`,
    [user.id]
  );

  return result.rows;
}

async function consumeIssue({
  issueId,
  quantity,
  consumedBy,
  reason
}) {
  return db.tx(async (tx) => {
    const issueResult = await tx.query(
      `SELECT
         inv.id,
         inv.issue_number,
         inv.instance_id,
         inv.site_id,
         inv.issued_quantity,
         inv.remaining_quantity,
         inv.status,
         ii.instance_code,
         ii.current_quantity,
         ii.lifecycle_status,
         ii.unit,
         im.is_consumable,
         im.allows_partial_consumption
       FROM inventory_issues inv
       JOIN item_instances ii
         ON ii.id = inv.instance_id
       JOIN item_masters im
         ON im.id = ii.item_master_id
       WHERE inv.id = $1${db.rowLock}`,
      [issueId]
    );

    if (issueResult.rows.length === 0) {
      throw new Error('Inventory issue not found.');
    }

    const issue = issueResult.rows[0];

    if (!['OPEN', 'PARTIALLY_CONSUMED'].includes(issue.status)) {
      throw new Error(
        `This issue cannot be consumed because its status is ${issue.status}.`
      );
    }

    if (!issue.is_consumable) {
      throw new Error(
        'This inventory item is not marked as consumable.'
      );
    }

    const consumeQuantity = Number(quantity);
    const remainingQuantity = Number(issue.remaining_quantity);

    if (!Number.isFinite(consumeQuantity) || consumeQuantity <= 0) {
      throw new Error('Consume quantity must be greater than zero.');
    }

    if (consumeQuantity > remainingQuantity) {
      throw new Error(
        `Cannot consume more than the remaining quantity of ${remainingQuantity} ${issue.unit}.`
      );
    }

    /*
     * If the item does not allow partial consumption,
     * the entire remaining quantity must be consumed.
     */
    if (
      !issue.allows_partial_consumption &&
      consumeQuantity !== remainingQuantity
    ) {
      throw new Error(
        `This item does not allow partial consumption. Consume the full remaining quantity of ${remainingQuantity} ${issue.unit}.`
      );
    }

    const newRemainingQuantity =
      remainingQuantity - consumeQuantity;

    const newInstanceQuantity =
      Number(issue.current_quantity) - consumeQuantity;

    if (newInstanceQuantity < 0) {
      throw new Error(
        'Consumption would result in a negative instance quantity.'
      );
    }

    const issueStatus =
      newRemainingQuantity === 0
        ? 'CLOSED'
        : 'PARTIALLY_CONSUMED';

    const lifecycleStatus =
      newInstanceQuantity === 0
        ? 'CONSUMED'
        : 'ACTIVE';

    await tx.query(
      `UPDATE inventory_issues
       SET
         remaining_quantity = $1,
         status = $2
       WHERE id = $3`,
      [
        newRemainingQuantity,
        issueStatus,
        issue.id
      ]
    );

    await tx.query(
      `UPDATE item_instances
       SET
         current_quantity = $1,
         lifecycle_status = $2,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [
        newInstanceQuantity,
        lifecycleStatus,
        issue.instance_id
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
         $1,
         'CONSUME',
         $2,
         NULL,
         NULL,
         'INVENTORY_ISSUE',
         $3,
         $4,
         $5
       )`,
      [
        issue.instance_id,
        consumeQuantity,
        issue.issue_number,
        reason || null,
        consumedBy
      ]
    );

    return {
      issueNumber: issue.issue_number,
      instanceId: issue.instance_id,
      instanceCode: issue.instance_code,
      consumedQuantity: consumeQuantity,
      remainingQuantity: newRemainingQuantity,
      unit: issue.unit,
      status: issueStatus,
      lifecycleStatus
    };
  });
}

async function returnIssue({
  issueId,
  returnedBy,
  reason,
  userRole
}) {
  return db.tx(async (tx) => {
    const issueResult = await tx.query(
      `SELECT
         inv.id,
         inv.issue_number,
         inv.instance_id,
         inv.site_id,
         inv.issued_quantity,
         inv.remaining_quantity,
         inv.status,
         ii.instance_code,
         ii.current_quantity,
         ii.lifecycle_status,
         ii.unit
       FROM inventory_issues inv
       JOIN item_instances ii
         ON ii.id = inv.instance_id
       WHERE inv.id = $1
       ${db.rowLock}`,
      [issueId]
    );

    if (issueResult.rows.length === 0) {
      throw new Error('Inventory issue not found.');
    }

    const issue = issueResult.rows[0];

    if (userRole !== 'admin') {
      const access = await tx.query(
        `SELECT 1 FROM site_assignments sa
         JOIN sites s ON s.id=sa.site_id
         WHERE sa.user_id=$1 AND sa.site_id=$2
           AND sa.assigned_until IS NULL AND s.status='ACTIVE'
         LIMIT 1`,
        [returnedBy, issue.site_id]
      );
      if (!access.rows.length) {
        throw new Error('You do not have permission to receive inventory for this site.');
      }
    }

    if (!['OPEN', 'PARTIALLY_CONSUMED'].includes(issue.status)) {
      throw new Error(
        `This issue cannot be returned because its status is ${issue.status}.`
      );
    }

    if (!issue.site_id) {
      throw new Error(
        'The original site for this issue could not be determined.'
      );
    }

    const returnQuantity = Number(issue.remaining_quantity);

    if (returnQuantity <= 0) {
      throw new Error(
        'There is no remaining quantity available to return.'
      );
    }

    /*
     * Make sure the original site is still active.
     */
    const siteResult = await tx.query(
      `SELECT id, status
       FROM sites
       WHERE id = $1${db.rowLock}`,
      [issue.site_id]
    );

    if (siteResult.rows.length === 0) {
      throw new Error('The original site no longer exists.');
    }

    if (siteResult.rows[0].status !== 'ACTIVE') {
      throw new Error(
        'The original site is inactive and cannot receive the returned inventory.'
      );
    }

    /*
     * The instance quantity already represents the quantity
     * remaining with the recipient.
     *
     * Returning it therefore does not change current_quantity.
     * It only restores the instance's site.
     */
    await tx.query(
      `UPDATE inventory_issues
       SET
         remaining_quantity = 0,
         status = 'RETURNED'
       WHERE id = $1`,
      [issue.id]
    );

    await tx.query(
      `UPDATE item_instances
       SET
         site_id = $1,
         lifecycle_status = 'ACTIVE',
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [
        issue.site_id,
        issue.instance_id
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
         $1,
         'RETURN',
         $2,
         NULL,
         $3,
         'INVENTORY_ISSUE',
         $4,
         $5,
         $6
       )`,
      [
        issue.instance_id,
        returnQuantity,
        issue.site_id,
        issue.issue_number,
        reason || null,
        returnedBy
      ]
    );

    return {
      issueNumber: issue.issue_number,
      instanceId: issue.instance_id,
      instanceCode: issue.instance_code,
      returnedQuantity: returnQuantity,
      unit: issue.unit,
      siteId: issue.site_id,
      status: 'RETURNED'
    };
  });
}

async function findOpenIssueByInstanceCode(instanceCode) {
  const normalized = String(instanceCode || '').trim();
  if (!normalized) throw new Error('Scan or enter an instance code.');
  const issue = await db.one(
    `SELECT inv.id, inv.issue_number, inv.status, ii.instance_code,
            im.item_code, im.name AS item_name, inv.recipient_type,
            inv.recipient_reference, s.code AS site_code, s.name AS site_name
     FROM inventory_issues inv
     JOIN item_instances ii ON ii.id=inv.instance_id
     JOIN item_masters im ON im.id=ii.item_master_id
     LEFT JOIN sites s ON s.id=inv.site_id
     WHERE (ii.instance_code=? OR ii.barcode=?) AND inv.status IN ('OPEN','PARTIALLY_CONSUMED')
     ORDER BY inv.issued_at DESC LIMIT 1`,
    [normalized, normalized]
  );
  if (!issue) throw new Error(`No open issue was found for instance ${normalized}.`);
  return issue;
}

async function createIssueBatch({ recipientType, recipientReference, reason, issuedBy, kitIds = [] }) {
  const uniqueKitIds = [...new Set((Array.isArray(kitIds) ? kitIds : [kitIds]).map(Number).filter(Number.isInteger))];
  return db.tx(async tx => {
    const result = await tx.query(
      `INSERT INTO inventory_issue_batches(recipient_type,recipient_reference,reason,issued_by) VALUES (?,?,?,?) RETURNING id`,
      [recipientType, recipientReference || null, reason || null, issuedBy]
    );
    const batchId = result.rows[0].id;
    for (const kitId of uniqueKitIds) {
      const kit = await tx.one(`SELECT id FROM item_kits WHERE id=? AND status='ACTIVE'`, [kitId]);
      const members = await tx.one(`SELECT COUNT(*) AS n FROM item_kit_lines WHERE kit_id=?`, [kitId]);
      if (!kit || Number(members.n) === 0) throw new Error('Choose active kits that contain physical instances.');
      const consumables = await tx.one(
        `SELECT COUNT(*) AS n FROM item_kit_lines l JOIN item_instances ii ON ii.id=l.item_instance_id JOIN item_masters im ON im.id=ii.item_master_id WHERE l.kit_id=? AND im.is_consumable=true`,
        [kitId]
      );
      if (Number(consumables.n) > 0) throw new Error('A kit in an issue batch must contain returnable, non-consumable item instances.');
      await tx.query(`INSERT INTO inventory_issue_batch_kits(batch_id,kit_id) VALUES (?,?)`, [batchId, kitId]);
    }
    return batchId;
  });
}

async function getIssueBatch(batchId) {
  const batch = await db.one(
    `SELECT b.*, s.code AS site_code, s.name AS site_name, u.full_name AS issued_by_name
     FROM inventory_issue_batches b LEFT JOIN sites s ON s.id=b.site_id JOIN users u ON u.id=b.issued_by WHERE b.id=?`,
    [batchId]
  );
  if (!batch) return null;
  batch.kits = await db.many(`SELECT k.id, k.kit_code, k.name FROM inventory_issue_batch_kits bk JOIN item_kits k ON k.id=bk.kit_id WHERE bk.batch_id=? ORDER BY k.kit_code`, [batchId]);
  for (const kit of batch.kits) {
    kit.items = await db.many(
      `SELECT ii.instance_code, ii.item_master_id, im.item_code, im.name AS item_name, inv.id AS issue_id, inv.status AS issue_status
       FROM item_kit_lines l JOIN item_instances ii ON ii.id=l.item_instance_id
       JOIN item_masters im ON im.id=ii.item_master_id
       LEFT JOIN inventory_issues inv ON inv.instance_id=ii.id AND inv.batch_id=?
       WHERE l.kit_id=? ORDER BY im.item_code, ii.instance_code`,
      [batchId, kit.id]
    );
  }
  batch.issues = await db.many(
    `SELECT inv.id, inv.issue_number, inv.issued_quantity, inv.remaining_quantity, inv.status, inv.issued_at,
            ii.id AS instance_id, ii.instance_code, ii.barcode, ii.item_master_id, im.item_code, im.name AS item_name, ii.unit,
            k.kit_code
     FROM inventory_issues inv JOIN item_instances ii ON ii.id=inv.instance_id
     JOIN item_masters im ON im.id=ii.item_master_id
     LEFT JOIN item_kit_lines kl ON kl.item_instance_id=ii.id
     LEFT JOIN item_kits k ON k.id=kl.kit_id AND k.status='ACTIVE'
     WHERE inv.batch_id=? ORDER BY inv.issued_at, inv.id`,
    [batchId]
  );
  batch.returnScannedIds = new Set((await db.many(`SELECT issue_id FROM inventory_issue_batch_return_scans WHERE batch_id=?`, [batchId])).map(row => Number(row.issue_id)));
  batch.stagedInstances = await db.many(
    `SELECT ii.id AS instance_id, ii.instance_code, ii.barcode, im.item_code, im.name AS item_name,
            ii.current_quantity, ii.unit, k.kit_code
     FROM inventory_issue_batch_staged_instances st
     JOIN item_instances ii ON ii.id=st.instance_id
     JOIN item_masters im ON im.id=ii.item_master_id
     LEFT JOIN item_kit_lines kl ON kl.item_instance_id=ii.id
     LEFT JOIN item_kits k ON k.id=kl.kit_id AND k.status='ACTIVE'
     WHERE st.batch_id=? ORDER BY st.scanned_at, ii.instance_code`,
    [batchId]
  );
  return batch;
}

async function stageIssueBatchInstance({ batchId, instanceCode, scannedBy }) {
  const batch = await db.one(`SELECT id, status, finalized_at FROM inventory_issue_batches WHERE id=?`, [batchId]);
  if (!batch || batch.status !== 'OPEN' || batch.finalized_at) throw new Error('This issue batch is no longer accepting items.');
  const code = String(instanceCode || '').trim();
  if (!code) throw new Error('Scan or enter an instance code.');
  const instance = await db.one(
    `SELECT ii.id, ii.instance_code, ii.barcode, im.item_code, im.name AS item_name
     FROM item_instances ii JOIN item_masters im ON im.id=ii.item_master_id
     WHERE ii.instance_code=? OR ii.barcode=?`, [code, code]
  );
  if (!instance) throw new Error(`No item instance was found for ${code}.`);
  const membership = await db.one(
    `SELECT k.kit_id, k.kit_code FROM item_kit_lines l JOIN item_kits k ON k.id=l.kit_id
     WHERE l.item_instance_id=? AND k.status='ACTIVE'`, [instance.id]
  );
  if (membership) {
    const selected = await db.one(`SELECT 1 AS yes FROM inventory_issue_batch_kits WHERE batch_id=? AND kit_id=?`, [batchId, membership.kit_id]);
    if (!selected) throw new Error(`Instance ${instance.instance_code} belongs to kit ${membership.kit_code}. Add that kit to this batch before scanning its members.`);
  }
  const alreadyStaged = await db.one(`SELECT 1 AS yes FROM inventory_issue_batch_staged_instances WHERE batch_id=? AND instance_id=?`, [batchId, instance.id]);
  if (alreadyStaged) throw new Error(`${instance.instance_code} is already in the pending issue list.`);
  await db.query(`INSERT INTO inventory_issue_batch_staged_instances(batch_id,instance_id,scanned_by) VALUES (?,?,?)`, [batchId, instance.id, scannedBy]);
  return instance;
}

async function removeStagedIssueBatchInstance({ batchId, instanceId }) {
  const batch = await db.one(`SELECT status, finalized_at FROM inventory_issue_batches WHERE id=?`, [batchId]);
  if (!batch || batch.status !== 'OPEN' || batch.finalized_at) throw new Error('Items can only be removed before the batch is issued.');
  const staged = await db.one(`SELECT 1 AS yes FROM inventory_issue_batch_staged_instances WHERE batch_id=? AND instance_id=?`, [batchId, instanceId]);
  if (!staged) throw new Error('That pending item was not found in this batch.');
  await db.query(`DELETE FROM inventory_issue_batch_staged_instances WHERE batch_id=? AND instance_id=?`, [batchId, instanceId]);
}

async function finalizeIssueBatch({ batchId, issuedBy, userRole }) {
  const batch = await db.one(`SELECT status, finalized_at FROM inventory_issue_batches WHERE id=?`, [batchId]);
  if (!batch || batch.status !== 'OPEN' || batch.finalized_at) throw new Error('This batch has already been issued or is no longer open.');
  const staged = await db.many(`SELECT ii.instance_code FROM inventory_issue_batch_staged_instances st JOIN item_instances ii ON ii.id=st.instance_id WHERE st.batch_id=? ORDER BY st.scanned_at, st.instance_id`, [batchId]);
  if (!staged.length) throw new Error('Scan at least one item before issuing this batch.');
  const selectedKits = await db.many(`SELECT kit_id FROM inventory_issue_batch_kits WHERE batch_id=?`, [batchId]);
  for (const { kit_id: kitId } of selectedKits) {
    const members = await db.many(`SELECT item_instance_id FROM item_kit_lines WHERE kit_id=?`, [kitId]);
    const stagedIds = await db.many(`SELECT instance_id FROM inventory_issue_batch_staged_instances WHERE batch_id=?`, [batchId]);
    const stagedSet = new Set(stagedIds.map(row => Number(row.instance_id)));
    const missing = members.filter(row => !stagedSet.has(Number(row.item_instance_id)));
    if (missing.length) {
      const kit = await db.one(`SELECT kit_code FROM item_kits WHERE id=?`, [kitId]);
      throw new Error(`Scan all ${members.length} instances in kit ${kit.kit_code} before issuing this batch.`);
    }
  }
  for (const item of staged) await issueInstance({ instanceCode: item.instance_code, issuedBy, userRole, batchId });
  await db.query(`UPDATE inventory_issue_batches SET finalized_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [batchId]);
  await db.query(`DELETE FROM inventory_issue_batch_staged_instances WHERE batch_id=?`, [batchId]);
  return staged.length;
}

async function canAccessIssueBatch(user, batch) {
  if (!user || !batch) return false;
  if (user.role === 'admin') return true;
  if (!batch.site_id) return Number(batch.issued_by) === Number(user.id);
  return Boolean(await db.one(
    `SELECT 1 FROM site_assignments sa JOIN sites s ON s.id=sa.site_id
     WHERE sa.user_id=? AND sa.site_id=? AND sa.assigned_until IS NULL AND s.status='ACTIVE' LIMIT 1`,
    [user.id, batch.site_id]
  ));
}

async function listOpenIssueBatches(user) {
  const where = user?.role === 'admin'
    ? ''
    : `AND ((b.site_id IS NULL AND b.issued_by=?) OR (b.site_id IS NOT NULL AND EXISTS (SELECT 1 FROM site_assignments sa JOIN sites ax ON ax.id=sa.site_id WHERE sa.user_id=? AND sa.site_id=b.site_id AND sa.assigned_until IS NULL AND ax.status='ACTIVE'))) `;
  const params = user?.role === 'admin' ? [] : [user.id, user.id];
  return db.many(
    `SELECT b.id, b.recipient_type, b.recipient_reference, b.status, b.created_at,
            b.site_id, s.code AS site_code, s.name AS site_name,
            SUM(CASE WHEN inv.status<>'CLOSED' THEN 1 ELSE 0 END) AS item_count,
            SUM(CASE WHEN inv.status='RETURNED' THEN 1 ELSE 0 END) AS returned_count
     FROM inventory_issue_batches b LEFT JOIN inventory_issues inv ON inv.batch_id=b.id
     LEFT JOIN sites s ON s.id=b.site_id
     WHERE b.status IN ('OPEN','PARTIALLY_RETURNED') ${where}
     GROUP BY b.id, s.code, s.name
     HAVING SUM(CASE WHEN inv.status IN ('OPEN','PARTIALLY_CONSUMED') THEN 1 ELSE 0 END) > 0
     ORDER BY b.created_at DESC`,
    params
  );
}

async function scanIssueBatchReturn({ batchId, instanceCode, returnedBy, userRole, reason }) {
  const batch = await getIssueBatch(batchId);
  if (!batch) throw new Error('Issue batch not found.');
  if (!batch.finalized_at) throw new Error('This issue batch has not been issued yet.');
  if (batch.status === 'RETURNED') throw new Error('This issue batch is already fully returned.');
  for (const kit of batch.kits) {
    const issuedMembers = kit.items.filter(item => item.issue_status && ['OPEN','PARTIALLY_CONSUMED'].includes(item.issue_status));
    const returnedMembers = kit.items.filter(item => item.issue_status === 'RETURNED');
    if (returnedMembers.length === kit.items.length) continue;
    if (issuedMembers.length !== kit.items.length) {
      throw new Error(`Finish scanning every instance in kit ${kit.kit_code} into the issue batch before receiving any items.`);
    }
  }
  const normalized = String(instanceCode || '').trim();
  if (!normalized) throw new Error('Scan or enter an instance code.');
  const issue = await db.one(
    `SELECT inv.id, inv.issue_number, inv.instance_id, ii.instance_code
     FROM inventory_issues inv JOIN item_instances ii ON ii.id=inv.instance_id
     WHERE inv.batch_id=? AND (ii.instance_code=? OR ii.barcode=?) AND inv.status IN ('OPEN','PARTIALLY_CONSUMED')`,
    [batchId, normalized, normalized]
  );
  if (!issue) throw new Error(`No unreturned issue for ${normalized} exists in this batch.`);
  const membership = await db.one(
    `SELECT k.id AS kit_id, k.kit_code FROM item_kit_lines l JOIN item_kits k ON k.id=l.kit_id
     JOIN inventory_issue_batch_kits bk ON bk.kit_id=k.id AND bk.batch_id=?
     WHERE l.item_instance_id=? AND k.status='ACTIVE'`,
    [batchId, issue.instance_id]
  );
  if (!membership) {
    const result = await returnIssue({ issueId: issue.id, returnedBy, userRole, reason });
    await updateIssueBatchStatus(batchId);
    return { ...result, completed: true, kitCode: null };
  }

  const expected = await db.many(
    `SELECT inv.id, ii.instance_code FROM item_kit_lines l
     JOIN inventory_issues inv ON inv.instance_id=l.item_instance_id AND inv.batch_id=?
     JOIN item_instances ii ON ii.id=inv.instance_id
     WHERE l.kit_id=? ORDER BY ii.instance_code`,
    [batchId, membership.kit_id]
  );
  const memberCount = Number((await db.one(`SELECT COUNT(*) AS n FROM item_kit_lines WHERE kit_id=?`, [membership.kit_id])).n);
  if (expected.length !== memberCount) {
    throw new Error(`Kit ${membership.kit_code} cannot be received yet: all of its instances must first be issued in this batch.`);
  }
  const existingScan = await db.one(`SELECT 1 FROM inventory_issue_batch_return_scans WHERE batch_id=? AND issue_id=?`, [batchId, issue.id]);
  if (existingScan) throw new Error(`${issue.instance_code} has already been scanned for kit ${membership.kit_code}. Scan another instance in the kit.`);
  await db.query(`INSERT INTO inventory_issue_batch_return_scans(batch_id,issue_id,scanned_by) VALUES (?,?,?)`, [batchId, issue.id, returnedBy]);
  const scanned = await db.many(`SELECT issue_id FROM inventory_issue_batch_return_scans WHERE batch_id=?`, [batchId]);
  const scannedIds = new Set(scanned.map(row => Number(row.issue_id)));
  const kitScanned = expected.filter(row => scannedIds.has(Number(row.id)));
  if (kitScanned.length < memberCount) {
    return { pending: true, instanceCode: issue.instance_code, kitCode: membership.kit_code, scannedCount: kitScanned.length, expectedCount: memberCount };
  }
  const returned = [];
  for (const member of expected) {
    returned.push(await returnIssue({ issueId: member.id, returnedBy, userRole, reason: reason || `Returned with kit ${membership.kit_code}` }));
  }
  await db.query(`DELETE FROM inventory_issue_batch_return_scans WHERE batch_id=? AND issue_id IN (${expected.map(() => '?').join(',')})`, [batchId, ...expected.map(row => row.id)]);
  await updateIssueBatchStatus(batchId);
  return { completed: true, kitCode: membership.kit_code, returned };
}

async function updateIssueBatchStatus(batchId) {
  const result = await db.one(
    `SELECT SUM(CASE WHEN status<>'CLOSED' THEN 1 ELSE 0 END) AS total,
            SUM(CASE WHEN status='RETURNED' THEN 1 ELSE 0 END) AS returned
     FROM inventory_issues WHERE batch_id=?`,
    [batchId]
  );
  const total = Number(result.total || 0);
  const returned = Number(result.returned || 0);
  const status = total === 0 || returned === total ? 'RETURNED' : returned > 0 ? 'PARTIALLY_RETURNED' : 'OPEN';
  await db.query(`UPDATE inventory_issue_batches SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [status, batchId]);
}


module.exports = {
  issueInstance,
  createIssueBatch,
  getIssueBatch,
  stageIssueBatchInstance,
  removeStagedIssueBatchInstance,
  finalizeIssueBatch,
  canAccessIssueBatch,
  listOpenIssueBatches,
  scanIssueBatchReturn,
  listOpenIssuesForUser,
  consumeIssue,
  returnIssue,
  findOpenIssueByInstanceCode
};
