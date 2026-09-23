const db = require('../config/db');
async function logAudit({ userId, action, entity, entityId, details, ip, userAgent }) {
  try {
    await db.query(
      `INSERT INTO audit_logs(user_id, action, entity, entity_id, details, ip, user_agent)
       VALUES (?,?,?,?,?,?,?)`,
      [userId || null, action, entity || null, entityId ? String(entityId) : null,
       details ? JSON.stringify(details) : null, ip || null, userAgent || null]
    );
  } catch (e) { console.error('[audit] failed:', e.message); }
}
async function listAuditLogs(limit = 300) {
  return db.many(
    `SELECT a.*, u.username FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
     ORDER BY a.created_at DESC LIMIT ?`, [limit]);
}
module.exports = { logAudit, listAuditLogs };
