const db = require('../config/db');

async function listSites() {
  return db.many(`
    SELECT
      id,
      code,
      name,
      site_type,
      address,
      status,
      created_at,
      updated_at
    FROM sites
    ORDER BY name ASC
  `);
}

async function getSiteById(id) {
  return db.one(`
    SELECT
      id,
      code,
      name,
      site_type,
      address,
      status,
      created_at,
      updated_at
    FROM sites
    WHERE id = ?
  `, [id]);
}

async function createSite({
  code,
  name,
  siteType,
  address
}) {
  const result = await db.one(`
    INSERT INTO sites (
      code,
      name,
      site_type,
      address
    )
    VALUES (?, ?, ?, ?)
    RETURNING id
  `, [
    code.trim().toUpperCase(),
    name.trim(),
    siteType,
    address?.trim() || null
  ]);

  return getSiteById(result.id);
}

async function updateSite(id, {
  name,
  siteType,
  address,
  status
}) {
  await db.query(`
    UPDATE sites
    SET
      name = ?,
      site_type = ?,
      address = ?,
      status = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    name.trim(),
    siteType,
    address?.trim() || null,
    status,
    id
  ]);

  return getSiteById(id);
}

async function listUserSites(userId) {
  return db.many(`
    SELECT
      s.id,
      s.code,
      s.name,
      s.site_type,
      s.status,
      sa.is_primary,
      sa.assigned_from,
      sa.assigned_until
    FROM site_assignments sa
    JOIN sites s
      ON s.id = sa.site_id
    WHERE sa.user_id = ?
      AND sa.assigned_until IS NULL
      AND s.status = 'ACTIVE'
    ORDER BY
      sa.is_primary DESC,
      s.name ASC
  `, [userId]);
}

async function assignUserToSite({
  userId,
  siteId,
  isPrimary = false
}) {
  return db.tx(async tx => {

    const user = await tx.one(`
      SELECT
        id,
        username,
        role,
        is_active
      FROM users
      WHERE id = ?
      FOR UPDATE
    `, [userId]);

    if (!user) {
      throw new Error('User not found.');
    }

    if (!user.is_active) {
      throw new Error(
        'Cannot assign a site to an inactive user.'
      );
    }

    if (user.role === 'admin') {
      throw new Error(
        'Administrators have access to all sites and do not require a site assignment.'
      );
    }


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
      throw new Error(
        'Cannot assign a user to an inactive site.'
      );
    }


    /*
     * Operators can belong to exactly one active site.
     *
     * Managers may belong to multiple sites.
     *
     * Viewer assignment remains supported for now;
     * its exact permission matrix will be finalized later.
     */
    if (user.role === 'operator') {

      const existing = await tx.one(`
        SELECT id
        FROM site_assignments
        WHERE user_id = ?
          AND assigned_until IS NULL
        LIMIT 1
      `, [userId]);

      if (existing) {

        if (existing.id !== Number(siteId)) {
          throw new Error(
            'An operator can only be assigned to one active site.'
          );
        }

      }
    }


    /*
     * For an operator, the only site is automatically primary.
     *
     * For managers/viewers, the caller can choose the
     * primary site.
     */
    if (user.role === 'operator') {
      isPrimary = true;
    }


    if (isPrimary) {
      await tx.query(`
        UPDATE site_assignments
        SET is_primary = FALSE
        WHERE user_id = ?
          AND assigned_until IS NULL
      `, [userId]);
    }


    const existingAssignment = await tx.one(`
      SELECT id
      FROM site_assignments
      WHERE user_id = ?
        AND site_id = ?
    `, [
      userId,
      siteId
    ]);


    if (existingAssignment) {

      await tx.query(`
        UPDATE site_assignments
        SET
          is_primary = ?,
          assigned_until = NULL
        WHERE id = ?
      `, [
        isPrimary,
        existingAssignment.id
      ]);

      return existingAssignment.id;
    }


    const result = await tx.one(`
      INSERT INTO site_assignments (
        user_id,
        site_id,
        is_primary
      )
      VALUES (?, ?, ?)
      RETURNING id
    `, [
      userId,
      siteId,
      isPrimary
    ]);

    return result.id;
  });
}

async function removeUserFromSite(userId, siteId) {
  await db.query(`
    UPDATE site_assignments
    SET assigned_until = CURRENT_TIMESTAMP
    WHERE user_id = ?
      AND site_id = ?
      AND assigned_until IS NULL
  `, [
    userId,
    siteId
  ]);
}

module.exports = {
  listSites,
  getSiteById,
  createSite,
  updateSite,
  listUserSites,
  assignUserToSite,
  removeUserFromSite
};