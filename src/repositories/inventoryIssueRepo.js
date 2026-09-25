const db = require('../config/db');

function buildIssueNumber(number) {
  return `ISS-${String(number).padStart(6, '0')}`;
}

async function allocateIssueNumber(tx) {
  const result = await tx.query(
    `SELECT next_number
     FROM inventory_issue_counters
     WHERE id = 1
     FOR UPDATE`
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
         updated_at = now()
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
  userRole
}) {
  return db.tx(async (tx) => {

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

       WHERE ii.instance_code = $1

       FOR UPDATE`,
      [normalizedInstanceCode]
    );

    if (instanceResult.rows.length === 0) {
      throw new Error('Inventory instance not found.');
    }

    const instance = instanceResult.rows[0];

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
         $10
       )
       RETURNING *`,
      [
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
           updated_at = now()
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
       WHERE inv.id = $1
       FOR UPDATE`,
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
         updated_at = now()
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
         ii.unit
       FROM inventory_issues inv
       JOIN item_instances ii
         ON ii.id = inv.instance_id
       WHERE inv.id = $1
       FOR UPDATE`,
      [issueId]
    );

    if (issueResult.rows.length === 0) {
      throw new Error('Inventory issue not found.');
    }

    const issue = issueResult.rows[0];

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
       WHERE id = $1
       FOR UPDATE`,
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
         updated_at = now()
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


module.exports = {
  issueInstance,
  listOpenIssuesForUser,
  consumeIssue,
  returnIssue
};
