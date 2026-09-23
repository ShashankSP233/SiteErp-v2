const { hashPassword, verifyPassword } = require('../utils/password');
const db = require('../config/db');

async function createUser({ username, password, fullName, role = 'operator' }) {
  const hash = hashPassword(password);
  const row = await db.one(
    `INSERT INTO users(username, password_hash, full_name, role, must_change_password)
     VALUES (?,?,?,?,true) RETURNING id`,
    [username.trim().toLowerCase(), hash, fullName || username, role]
  );
  return getUserById(row.id);
}

async function authenticate(username, password) {
  const user = await db.one('SELECT * FROM users WHERE username=? AND is_active', [username.trim().toLowerCase()]);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  delete user.password_hash;
  return user;
}

async function getUserById(id) {
  return db.one('SELECT id, username, full_name, role, is_active, must_change_password, created_at FROM users WHERE id=?', [id]);
}

async function changePassword(userId, newPassword) {
  if (!newPassword || String(newPassword).length < 8) throw new Error('New password must be at least 8 characters long.');
  await db.query('UPDATE users SET password_hash=?, must_change_password=false, updated_at=CURRENT_TIMESTAMP WHERE id=?', [hashPassword(newPassword), userId]);
}

async function listUsers() {
  return db.many('SELECT id, username, full_name, role, is_active, created_at FROM users ORDER BY username');
}

module.exports = { createUser, authenticate, getUserById, changePassword, listUsers };
