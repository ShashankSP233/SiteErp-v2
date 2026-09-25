const { hashPassword, verifyPassword } = require('../utils/password');
const db = require('../config/db');


async function createUser({
  username,
  password,
  fullName,
  role = 'operator'
}) {
  const allowedRoles = [
    'operator',
    'manager',
    'viewer',
    'admin'
  ];

  if (!allowedRoles.includes(role)) {
    throw new Error('Invalid user role.');
  }

  const hash = hashPassword(password);

  const row = await db.one(
    `INSERT INTO users (
      username,
      password_hash,
      full_name,
      role,
      must_change_password
    )
    VALUES (?, ?, ?, ?, true)
    RETURNING id`,
    [
      username.trim().toLowerCase(),
      hash,
      fullName || username,
      role
    ]
  );

  return getUserById(row.id);
}


async function authenticate(username, password) {
  const user = await db.one(
    `SELECT *
     FROM users
     WHERE username = ?
       AND is_active`,
    [username.trim().toLowerCase()]
  );

  if (!user) return null;

  if (!verifyPassword(password, user.password_hash)) {
    return null;
  }

  delete user.password_hash;

  return user;
}


async function getUserById(id) {
  return db.one(
    `SELECT
      id,
      username,
      full_name,
      role,
      is_active,
      must_change_password,
      created_at
    FROM users
    WHERE id = ?`,
    [id]
  );
}


async function changePassword(userId, newPassword) {
  if (
    !newPassword ||
    String(newPassword).length < 8
  ) {
    throw new Error(
      'New password must be at least 8 characters long.'
    );
  }

  await db.query(
    `UPDATE users
     SET
       password_hash = ?,
       must_change_password = false,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      hashPassword(newPassword),
      userId
    ]
  );
}


async function listUsers() {
  return db.many(`
    SELECT
      u.id,
      u.username,
      u.full_name,
      u.role,
      u.is_active,
      u.created_at,

      COUNT(
        CASE
          WHEN sa.assigned_until IS NULL
           AND s.status = 'ACTIVE'
          THEN 1
        END
      ) AS site_count

    FROM users u

    LEFT JOIN site_assignments sa
      ON sa.user_id = u.id

    LEFT JOIN sites s
      ON s.id = sa.site_id

    GROUP BY u.id

    ORDER BY u.username
  `);
}


async function getUserWithSites(userId) {
  const user = await getUserById(userId);

  if (!user) {
    return null;
  }

  const sites = await db.many(`
    SELECT
      s.id,
      s.code,
      s.name,
      s.site_type,
      s.status,

      sa.id AS assignment_id,
      sa.is_primary,
      sa.assigned_from,
      sa.assigned_until

    FROM site_assignments sa

    JOIN sites s
      ON s.id = sa.site_id

    WHERE sa.user_id = ?

    ORDER BY
      sa.assigned_until IS NULL DESC,
      sa.is_primary DESC,
      s.name ASC
  `, [userId]);

  return {
    ...user,
    sites
  };
}


async function getActiveSiteAssignments(userId) {
  return db.many(`
    SELECT
      sa.id AS assignment_id,
      sa.user_id,
      sa.site_id,
      sa.is_primary,

      s.code,
      s.name,
      s.site_type

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


module.exports = {
  createUser,
  authenticate,
  getUserById,
  changePassword,
  listUsers,
  getUserWithSites,
  getActiveSiteAssignments
};