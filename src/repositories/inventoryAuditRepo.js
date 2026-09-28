const db = require('../config/db');

const AUDIT_TYPES = [
  'MANUAL',
  'MONTHLY_FULL',
  'DAILY_CHANGED',
  'FIFTEEN_DAY_FULL'
];

const AUDIT_STATUSES = [
  'NOT_REQUIRED',
  'REQUIRED',
  'IN_PROGRESS',
  'COMPLETED',
  'RECHECK_REQUIRED'
];

const RESULT_TYPES = [
  'NOT_COUNTED',
  'MATCHED',
  'MISSING',
  'UNEXPECTED',
  'UNKNOWN',
  'DUPLICATE'
];

function clean(value) {
  return String(value ?? '').trim();
}

function numericQuantity(value) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error('Physical quantity must be zero or greater.');
  }
  return quantity;
}

async function getAccessibleSites(user) {
  if (user.role === 'admin') {
    return db.many(`
      SELECT
        id,
        code,
        name,
        site_type,
        status
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
      s.site_type,
      s.status
    FROM site_assignments sa
    JOIN sites s
      ON s.id = sa.site_id
    WHERE sa.user_id = ?
      AND sa.assigned_until IS NULL
      AND s.status = 'ACTIVE'
    ORDER BY s.name ASC
  `, [user.id]);
}

async function assertSiteAccess(tx, user, siteId) {
  const site = await tx.one(`
    SELECT
      id,
      code,
      name,
      site_type,
      status
    FROM sites
    WHERE id = ?
    FOR UPDATE
  `, [siteId]);

  if (!site) {
    throw new Error('Site not found.');
  }

  if (site.status !== 'ACTIVE') {
    throw new Error('The selected site is inactive.');
  }

  if (user.role === 'admin') {
    return site;
  }

  const assignment = await tx.one(`
    SELECT 1
    FROM site_assignments
    WHERE user_id = ?
      AND site_id = ?
      AND assigned_until IS NULL
  `, [user.id, site.id]);

  if (!assignment) {
    throw new Error('You do not have access to this site.');
  }

  return site;
}

async function createAudit({
  name,
  siteId,
  auditType = 'MANUAL',
  notes = null,
  user
}) {
  const auditName = clean(name);
  const type = clean(auditType).toUpperCase();
  const numericSiteId = Number(siteId);

  if (!auditName) {
    throw new Error('Audit name is required.');
  }

  if (!Number.isInteger(numericSiteId) || numericSiteId <= 0) {
    throw new Error('A valid site is required.');
  }

  if (!AUDIT_TYPES.includes(type)) {
    throw new Error('Invalid audit type.');
  }

  return db.tx(async tx => {
    const site = await assertSiteAccess(tx, user, numericSiteId);

    const audit = await tx.one(`
      INSERT INTO inventory_audits (
        name,
        site_id,
        audit_type,
        status,
        notes,
        started_by
      )
      VALUES (?, ?, ?, 'IN_PROGRESS', ?, ?)
      RETURNING *
    `, [
      auditName,
      site.id,
      type,
      clean(notes) || null,
      user.id
    ]);

    /*
     * Snapshot the current physical inventory state.
     *
     * The audit compares against this snapshot, not against a
     * later transaction-derived value. This is important because
     * the physical count is a point-in-time observation.
     */
    const instances = await tx.many(`
      SELECT
        ii.id,
        ii.instance_code,
        ii.barcode,
        ii.current_quantity,
        ii.unit,
        ii.lifecycle_status,
        im.item_code,
        im.name AS item_name
      FROM item_instances ii
      JOIN item_masters im
        ON im.id = ii.item_master_id
      WHERE ii.site_id = ?
        AND ii.lifecycle_status = 'ACTIVE'
      ORDER BY ii.instance_code ASC
    `, [site.id]);

    for (const instance of instances) {
      await tx.query(`
        INSERT INTO inventory_audit_items (
          audit_id,
          instance_id,
          scanned_code,
          expected_quantity,
          unit,
          result
        )
        VALUES (?, ?, ?, ?, ?, 'NOT_COUNTED')
      `, [
        audit.id,
        instance.id,
        instance.instance_code,
        Number(instance.current_quantity),
        instance.unit
      ]);
    }

    return {
      audit,
      site,
      expectedCount: instances.length
    };
  });
}

async function listAuditsForUser(user) {
  const params = [];
  let accessSql;

  if (user.role === 'admin') {
    accessSql = `TRUE`;
  } else {
    accessSql = `EXISTS (
      SELECT 1
      FROM site_assignments sa
      WHERE sa.user_id = ?
        AND sa.site_id = a.site_id
        AND sa.assigned_until IS NULL
    )`;
    params.push(user.id);
  }

  return db.many(`
    SELECT
      a.id,
      a.name,
      a.site_id,
      a.audit_type,
      a.status,
      a.notes,
      a.started_at,
      a.completed_at,
      s.code AS site_code,
      s.name AS site_name,
      u.full_name AS started_by_name,
      cu.full_name AS completed_by_name,
      COUNT(ai.id) FILTER (WHERE ai.result = 'NOT_COUNTED') AS not_counted_count,
      COUNT(ai.id) FILTER (WHERE ai.result = 'MATCHED') AS matched_count,
      COUNT(ai.id) FILTER (WHERE ai.result = 'MISSING') AS missing_count,
      COUNT(ai.id) FILTER (WHERE ai.result = 'UNEXPECTED') AS unexpected_count,
      COUNT(ai.id) FILTER (WHERE ai.result = 'UNKNOWN') AS unknown_count,
      COUNT(ai.id) FILTER (WHERE ai.result = 'DUPLICATE') AS duplicate_count,
      COUNT(ai.id) AS entry_count
    FROM inventory_audits a
    JOIN sites s
      ON s.id = a.site_id
    JOIN users u
      ON u.id = a.started_by
    LEFT JOIN users cu
      ON cu.id = a.completed_by
    LEFT JOIN inventory_audit_items ai
      ON ai.audit_id = a.id
    WHERE ${accessSql}
    GROUP BY
      a.id,
      s.id,
      u.id,
      cu.id
    ORDER BY a.started_at DESC, a.id DESC
  `, params);
}

async function getAuditForUser(user, auditId) {
  const id = Number(auditId);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid audit ID.');
  }

  const audit = await db.one(`
    SELECT
      a.*,
      s.code AS site_code,
      s.name AS site_name,
      s.site_type,
      u.full_name AS started_by_name,
      cu.full_name AS completed_by_name
    FROM inventory_audits a
    JOIN sites s
      ON s.id = a.site_id
    JOIN users u
      ON u.id = a.started_by
    LEFT JOIN users cu
      ON cu.id = a.completed_by
    WHERE a.id = ?
  `, [id]);

  if (!audit) {
    return null;
  }

  if (user.role !== 'admin') {
    const access = await db.one(`
      SELECT 1
      FROM site_assignments
      WHERE user_id = ?
        AND site_id = ?
        AND assigned_until IS NULL
    `, [user.id, audit.site_id]);

    if (!access) {
      throw new Error('You do not have access to this audit.');
    }
  }

  const items = await db.many(`
    SELECT
      ai.id,
      ai.audit_id,
      ai.instance_id,
      ai.scanned_code,
      ai.expected_quantity,
      ai.counted_quantity,
      ai.unit,
      ai.result,
      ai.counted_by,
      ai.counted_at,
      ai.notes,
      ii.instance_code,
      ii.barcode,
      im.item_code,
      im.name AS item_name,
      u.full_name AS counted_by_name
    FROM inventory_audit_items ai
    LEFT JOIN item_instances ii
      ON ii.id = ai.instance_id
    LEFT JOIN item_masters im
      ON im.id = ii.item_master_id
    LEFT JOIN users u
      ON u.id = ai.counted_by
    WHERE ai.audit_id = ?
    ORDER BY
      CASE WHEN ai.result = 'NOT_COUNTED' THEN 0 ELSE 1 END,
      COALESCE(ii.instance_code, ai.scanned_code) ASC,
      ai.id ASC
  `, [id]);

  return {
    audit,
    items
  };
}

async function recordCount({
  auditId,
  scannedCode,
  countedQuantity,
  notes = null,
  user
}) {
  const id = Number(auditId);
  const code = clean(scannedCode);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid audit ID.');
  }

  if (!code) {
    throw new Error('Inventory instance code or barcode is required.');
  }

  const quantity = numericQuantity(countedQuantity);

  return db.tx(async tx => {
    const audit = await tx.one(`
      SELECT
        id,
        site_id,
        status
      FROM inventory_audits
      WHERE id = ?
      FOR UPDATE
    `, [id]);

    if (!audit) {
      throw new Error('Audit not found.');
    }

    if (audit.status !== 'IN_PROGRESS') {
      throw new Error('This audit is not open for counting.');
    }

    await assertSiteAccess(tx, user, audit.site_id);

    /*
     * Barcode scanners may send either the permanent barcode or
     * the human-readable instance code.
     */
    const instance = await tx.one(`
      SELECT
        ii.id,
        ii.instance_code,
        ii.barcode,
        ii.current_quantity,
        ii.original_quantity,
        ii.unit,
        ii.site_id,
        ii.lifecycle_status,
        im.item_code,
        im.name AS item_name
      FROM item_instances ii
      JOIN item_masters im
        ON im.id = ii.item_master_id
      WHERE ii.instance_code = ?
         OR ii.barcode = ?
      LIMIT 1
    `, [code, code]);

    if (!instance) {
      const entry = await tx.one(`
        INSERT INTO inventory_audit_items (
          audit_id,
          scanned_code,
          counted_quantity,
          result,
          counted_by,
          counted_at,
          notes
        )
        VALUES (?, ?, ?, 'UNKNOWN', ?, now(), ?)
        RETURNING *
      `, [
        audit.id,
        code,
        quantity,
        user.id,
        clean(notes) || null
      ]);

      return {
        result: 'UNKNOWN',
        entry,
        code
      };
    }

    /*
     * If this physical instance does not belong to the audit site,
     * it is physically found but unexpected for this audit.
     */
    if (
      instance.site_id !== audit.site_id ||
      instance.lifecycle_status !== 'ACTIVE'
    ) {
      const entry = await tx.one(`
        INSERT INTO inventory_audit_items (
          audit_id,
          instance_id,
          scanned_code,
          counted_quantity,
          unit,
          result,
          counted_by,
          counted_at,
          notes
        )
        VALUES (?, ?, ?, ?, ?, 'UNEXPECTED', ?, now(), ?)
        RETURNING *
      `, [
        audit.id,
        instance.id,
        code,
        quantity,
        instance.unit,
        user.id,
        clean(notes) || null
      ]);

      return {
        result: 'UNEXPECTED',
        entry,
        code,
        instanceCode: instance.instance_code,
        itemCode: instance.item_code,
        siteId: instance.site_id
      };
    }

    const existing = await tx.one(`
      SELECT
        id,
        result,
        counted_at
      FROM inventory_audit_items
      WHERE audit_id = ?
        AND instance_id = ?
        AND result NOT IN ('UNEXPECTED', 'UNKNOWN', 'DUPLICATE')
      ORDER BY id ASC
      LIMIT 1
    `, [audit.id, instance.id]);

    if (!existing) {
      throw new Error('Audit snapshot entry is missing for this instance.');
    }

    if (existing.counted_at) {
      const duplicate = await tx.one(`
        INSERT INTO inventory_audit_items (
          audit_id,
          instance_id,
          scanned_code,
          counted_quantity,
          unit,
          result,
          counted_by,
          counted_at,
          notes
        )
        VALUES (?, ?, ?, ?, ?, 'DUPLICATE', ?, now(), ?)
        RETURNING *
      `, [
        audit.id,
        instance.id,
        code,
        quantity,
        instance.unit,
        user.id,
        clean(notes) || null
      ]);

      return {
        result: 'DUPLICATE',
        entry: duplicate,
        code,
        instanceCode: instance.instance_code,
        itemCode: instance.item_code
      };
    }

    if (quantity > Number(instance.original_quantity)) {
      throw new Error(
        `Physical quantity cannot exceed the instance capacity of ${instance.original_quantity} ${instance.unit}.`
      );
    }

    const expected = Number(existing.expected_quantity);
    const result = quantity === 0
      ? 'MISSING'
      : 'MATCHED';

    const updated = await tx.one(`
      UPDATE inventory_audit_items
      SET
        scanned_code = ?,
        counted_quantity = ?,
        result = ?,
        counted_by = ?,
        counted_at = now(),
        notes = ?,
        updated_at = now()
      WHERE id = ?
      RETURNING *
    `, [
      code,
      quantity,
      result,
      user.id,
      clean(notes) || null,
      existing.id
    ]);

    return {
      result,
      entry: updated,
      code,
      instanceCode: instance.instance_code,
      itemCode: instance.item_code,
      itemName: instance.item_name,
      expectedQuantity: expected,
      countedQuantity: quantity,
      difference: quantity - expected,
      unit: instance.unit
    };
  });
}

async function completeAudit({ auditId, user }) {
  const id = Number(auditId);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid audit ID.');
  }

  return db.tx(async tx => {
    const audit = await tx.one(`
      SELECT
        id,
        site_id,
        status
      FROM inventory_audits
      WHERE id = ?
      FOR UPDATE
    `, [id]);

    if (!audit) {
      throw new Error('Audit not found.');
    }

    if (!['admin', 'manager'].includes(user.role)) {
      throw new Error('Only a manager or administrator can complete an audit.');
    }

    await assertSiteAccess(tx, user, audit.site_id);

    if (audit.status !== 'IN_PROGRESS') {
      throw new Error('This audit is not open for completion.');
    }

    /*
     * Any expected instance that was never physically counted is
     * classified as missing when the audit is completed.
     */
    await tx.query(`
      UPDATE inventory_audit_items
      SET
        result = 'MISSING',
        updated_at = now()
      WHERE audit_id = ?
        AND result = 'NOT_COUNTED'
    `, [audit.id]);

    const completed = await tx.one(`
      UPDATE inventory_audits
      SET
        status = 'COMPLETED',
        completed_by = ?,
        completed_at = now(),
        updated_at = now()
      WHERE id = ?
      RETURNING *
    `, [user.id, audit.id]);

    return completed;
  });
}

module.exports = {
  AUDIT_TYPES,
  AUDIT_STATUSES,
  RESULT_TYPES,
  getAccessibleSites,
  createAudit,
  listAuditsForUser,
  getAuditForUser,
  recordCount,
  completeAudit
};
