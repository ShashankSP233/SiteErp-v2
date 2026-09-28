const db = require("../config/db");

/**
 * Adjust the recorded quantity of one physical inventory instance.
 *
 * ADJUSTMENT_OUT:
 *   Reduces current_quantity.
 *
 * ADJUSTMENT_IN:
 *   Increases current_quantity.
 *
 * The operation is performed inside one transaction and the
 * item_instances row is locked before any quantity calculation.
 */
async function adjustInstanceWithinTransaction(
  tx,
  {
    instanceCode,
    adjustmentType,
    quantity,
    reason,
    performedBy,
  },
) {
  const normalizedInstanceCode = String(instanceCode || "").trim();
  const normalizedType = String(adjustmentType || "").trim().toUpperCase();
  const normalizedReason = String(reason || "").trim();
  const adjustmentQuantity = Number(quantity);

  if (!normalizedInstanceCode) {
    throw new Error("Inventory instance code is required.");
  }

  if (!["ADJUSTMENT_IN", "ADJUSTMENT_OUT"].includes(normalizedType)) {
    throw new Error("Invalid adjustment type.");
  }

  if (!Number.isFinite(adjustmentQuantity) || adjustmentQuantity <= 0) {
    throw new Error("Adjustment quantity must be greater than zero.");
  }

  if (!normalizedReason) {
    throw new Error("A reason is required for every inventory adjustment.");
  }

  if (!performedBy) {
    throw new Error("Performing user is required.");
  }

  /*
   * IMPORTANT:
   * Lock ONLY item_instances here.
   *
   * Do not JOIN inventory_issues while using FOR UPDATE.
   * PostgreSQL rejects FOR UPDATE when an outer join makes
   * part of the result nullable.
   */
  const instance = await tx.one(
    `SELECT
       ii.id,
       ii.instance_code,
       ii.barcode,
       ii.item_master_id,
       ii.original_quantity,
       ii.current_quantity,
       ii.unit,
       ii.site_id,
       ii.lifecycle_status,
       ii.condition,
       im.item_code,
       im.name AS item_name,
       im.status AS item_master_status,
       s.code AS site_code,
       s.name AS site_name,
       s.status AS site_status
     FROM item_instances ii
     JOIN item_masters im
       ON im.id = ii.item_master_id
     JOIN sites s
       ON s.id = ii.site_id
     WHERE ii.instance_code = ?
     FOR UPDATE`,
    [normalizedInstanceCode],
  );

  if (!instance) {
    throw new Error("Inventory instance not found.");
  }

  if (instance.lifecycle_status !== "ACTIVE") {
    throw new Error(
      `Inventory instance ${instance.instance_code} is not active.`,
    );
  }

  if (instance.item_master_status !== "ACTIVE") {
    throw new Error("The item master for this inventory instance is inactive.");
  }

  if (instance.site_status !== "ACTIVE") {
    throw new Error("The inventory instance belongs to an inactive site.");
  }

  /*
   * Verify that the user is still active.
   */
  const user = await tx.one(
    `SELECT
       id,
       role,
       is_active
     FROM users
     WHERE id = ?`,
    [performedBy],
  );

  if (!user) {
    throw new Error("Performing user not found.");
  }

  if (!user.is_active) {
    throw new Error("Performing user is inactive.");
  }

  /*
   * Site access:
   *
   * Admin can adjust inventory anywhere.
   * Managers/operators must have an active assignment
   * to the inventory's site.
   *
   * The route currently restricts adjustment to admin/manager,
   * but keeping this check here protects the repository too.
   */
  if (user.role !== "admin") {
    const assignment = await tx.one(
      `SELECT 1
       FROM site_assignments sa
       WHERE sa.user_id = ?
         AND sa.site_id = ?
         AND sa.assigned_until IS NULL`,
      [performedBy, instance.site_id],
    );

    if (!assignment) {
      throw new Error(
        "You do not have access to adjust inventory at this site.",
      );
    }
  }

  /*
   * Calculate currently issued quantity separately.
   *
   * These quantities are reservations/active issues and therefore
   * cannot be removed through an adjustment OUT.
   */
  const issuedResult = await tx.one(
    `SELECT
       COALESCE(SUM(remaining_quantity), 0) AS issued_quantity
     FROM inventory_issues
     WHERE instance_id = ?
       AND status IN ('OPEN', 'PARTIALLY_CONSUMED')`,
    [instance.id],
  );

  const currentQuantity = Number(instance.current_quantity);
  const originalQuantity = Number(instance.original_quantity);
  const issuedQuantity = Number(issuedResult?.issued_quantity || 0);

  const availableQuantity = Math.max(
    0,
    currentQuantity - issuedQuantity,
  );

  /*
   * ADJUSTMENT OUT
   *
   * We can only remove quantity that is currently available.
   *
   * Example:
   *   Current = 20
   *   Issued  = 5
   *   Available = 15
   *
   *   OUT 15 -> allowed
   *   OUT 16 -> rejected
   */
  if (normalizedType === "ADJUSTMENT_OUT") {
    if (adjustmentQuantity > availableQuantity) {
      throw new Error(
        `Adjustment OUT cannot exceed available quantity (${availableQuantity} ${instance.unit}).`,
      );
    }
  }

  /*
   * ADJUSTMENT IN
   *
   * The database model defines:
   *
   *   current_quantity <= original_quantity
   *
   * Therefore an adjustment IN cannot push the instance above
   * its original quantity.
   */
  if (normalizedType === "ADJUSTMENT_IN") {
    const maximumIncrease = originalQuantity - currentQuantity;

    if (adjustmentQuantity > maximumIncrease) {
      throw new Error(
        `Adjustment IN cannot exceed the remaining quantity capacity (${maximumIncrease} ${instance.unit}).`,
      );
    }
  }

  const newQuantity =
    normalizedType === "ADJUSTMENT_OUT"
      ? currentQuantity - adjustmentQuantity
      : currentQuantity + adjustmentQuantity;

  /*
   * Final safety check.
   */
  if (newQuantity < 0) {
    throw new Error("Adjustment would make inventory quantity negative.");
  }

  if (newQuantity > originalQuantity) {
    throw new Error(
      "Adjustment would exceed the original quantity of this inventory instance.",
    );
  }

  /*
   * Update the actual inventory instance.
   */
  const updated = await tx.one(
    `UPDATE item_instances
     SET current_quantity = ?,
         updated_at = now()
     WHERE id = ?
     RETURNING *`,
    [newQuantity, instance.id],
  );

  if (!updated) {
    throw new Error("Inventory quantity could not be updated.");
  }

  /*
   * Record the movement.
   */
  const referenceId =
    `ADJ-${instance.instance_code}-${Date.now()}`;

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
       ?,
       ?,
       ?,
       ?,
       'INVENTORY_ADJUSTMENT',
       ?,
       ?,
       ?
     )`,
    [
      instance.id,
      normalizedType,
      adjustmentQuantity,
      normalizedType === "ADJUSTMENT_OUT" ? instance.site_id : null,
      normalizedType === "ADJUSTMENT_IN" ? instance.site_id : null,
      referenceId,
      normalizedReason,
      performedBy,
    ],
  );

  return {
    instance: updated,
    previousQuantity: currentQuantity,
    adjustmentQuantity,
    newQuantity,
    issuedQuantity,
    availableQuantity,
    adjustmentType: normalizedType,
    referenceId,
  };
}


async function adjustInstance({
  instanceCode,
  adjustmentType,
  quantity,
  reason,
  performedBy,
}) {
  return db.tx(async (tx) => {
    return adjustInstanceWithinTransaction(tx, {
      instanceCode,
      adjustmentType,
      quantity,
      reason,
      performedBy,
    });
  });
}


module.exports = {
  adjustInstanceWithinTransaction,
  adjustInstance,
};