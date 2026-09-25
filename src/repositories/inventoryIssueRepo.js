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
  instanceId,
  recipientType,
  recipientReference,
  reason,
  issuedBy
}) {
  return db.tx(async (tx) => {
    /*
     * Lock the instance so two users cannot issue it simultaneously.
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
       WHERE ii.id = $1
       FOR UPDATE`,
      [instanceId]
    );

    if (instanceResult.rows.length === 0) {
      throw new Error('Inventory instance not found.');
    }

    const instance = instanceResult.rows[0];

    if (!instance.site_id) {
      throw new Error('This inventory instance is not currently at a site.');
    }

    if (instance.lifecycle_status !== 'ACTIVE') {
      throw new Error(
        `This inventory instance cannot be issued because its status is ${instance.lifecycle_status}.`
      );
    }

    if (Number(instance.current_quantity) <= 0) {
      throw new Error('This inventory instance has no quantity available.');
    }

    /*
     * An instance is issued as a whole physical instance.
     * Partial issue is deliberately not supported because one instance
     * cannot simultaneously belong to two locations.
     */
    const existingIssue = await tx.query(
      `SELECT id
       FROM inventory_issues
       WHERE instance_id = $1
         AND status IN ('OPEN', 'PARTIALLY_CONSUMED')
       LIMIT 1
       FOR UPDATE`,
      [instanceId]
    );

    if (existingIssue.rows.length > 0) {
      throw new Error('This inventory instance is already issued.');
    }

    const issueNumberValue = await allocateIssueNumber(tx);
    const issueNumber = buildIssueNumber(issueNumberValue);

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
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, 'OPEN')
       RETURNING *`,
      [
        issueNumber,
        instance.id,
        instance.site_id,
        instance.current_quantity,
        recipientType,
        recipientReference || null,
        reason || null,
        issuedBy
      ]
    );

    /*
     * The quantity stays with the physical instance.
     * site_id becomes NULL because the instance is now outside site stock
     * and its current location is represented by the open issue.
     */
    await tx.query(
      `UPDATE item_instances
       SET site_id = NULL,
           updated_at = now()
       WHERE id = $1`,
      [instance.id]
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
       VALUES ($1, 'ISSUE', $2, $3, NULL, 'INVENTORY_ISSUE', $4, $5, $6)`,
      [
        instance.id,
        instance.current_quantity,
        instance.site_id,
        issueNumber,
        reason || null,
        issuedBy
      ]
    );

    return {
      issue: issueResult.rows[0],
      instance
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
         s.code AS site_code,
         s.name AS site_name,
         u.full_name AS issued_by_name
       FROM inventory_issues inv
       JOIN item_instances ii ON ii.id = inv.instance_id
       JOIN item_masters im ON im.id = ii.item_master_id
       LEFT JOIN sites s ON s.id = inv.site_id
       JOIN users u ON u.id = inv.issued_by
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
       s.code AS site_code,
       s.name AS site_name,
       u.full_name AS issued_by_name
     FROM inventory_issues inv
     JOIN item_instances ii ON ii.id = inv.instance_id
     JOIN item_masters im ON im.id = ii.item_master_id
     LEFT JOIN sites s ON s.id = inv.site_id
     JOIN users u ON u.id = inv.issued_by
     WHERE inv.status IN ('OPEN', 'PARTIALLY_CONSUMED')
       AND EXISTS (
         SELECT 1
         FROM site_assignments sa
         WHERE sa.user_id = $1
           AND sa.site_id = inv.site_id
           AND sa.assigned_from <= CURRENT_DATE
           AND (
             sa.assigned_until IS NULL
             OR sa.assigned_until >= CURRENT_DATE
           )
       )
     ORDER BY inv.issued_at DESC`,
    [user.id]
  );

  return result.rows;
}

module.exports = {
  issueInstance,
  listOpenIssuesForUser
};