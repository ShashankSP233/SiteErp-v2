const db = require('../config/db');

async function listKits() {
  const kits = await db.many(`SELECT k.*, COUNT(l.id) AS instance_count FROM item_kits k LEFT JOIN item_kit_lines l ON l.kit_id=k.id GROUP BY k.id ORDER BY k.name`);
  return Promise.all(kits.map(async kit => ({ ...kit, items: await db.many(`SELECT ii.id AS instance_id, ii.instance_code, ii.item_master_id, im.item_code, im.name AS item_name, ii.site_id, ii.lifecycle_status FROM item_kit_lines l JOIN item_instances ii ON ii.id=l.item_instance_id JOIN item_masters im ON im.id=ii.item_master_id WHERE l.kit_id=? ORDER BY im.name, ii.instance_code`, [kit.id]) })));
}

async function getKitById(id) {
  const kit = await db.one(`SELECT * FROM item_kits WHERE id=?`, [id]);
  if (!kit) return null;
  kit.items = await db.many(`SELECT ii.id AS instance_id, ii.item_master_id, ii.instance_code, ii.barcode, ii.original_quantity, ii.current_quantity, ii.unit, ii.site_id, ii.lifecycle_status, ii.condition, im.item_code, im.name AS item_name, s.code AS site_code, s.name AS site_name FROM item_kit_lines l JOIN item_instances ii ON ii.id=l.item_instance_id JOIN item_masters im ON im.id=ii.item_master_id LEFT JOIN sites s ON s.id=ii.site_id WHERE l.kit_id=? ORDER BY im.item_code, ii.instance_code`, [id]);
  return kit;
}

async function dismantleKit(id) {
  return db.tx(async tx => {
    const kit = await tx.one(`SELECT id, kit_code FROM item_kits WHERE id=?${db.rowLock}`, [id]);
    if (!kit) throw new Error('Kit not found.');
    const instances = await tx.many(`SELECT ii.id, ii.instance_code, ii.site_id, ii.lifecycle_status FROM item_kit_lines l JOIN item_instances ii ON ii.id=l.item_instance_id WHERE l.kit_id=?${db.rowLock}`, [id]);
    if (!instances.length) throw new Error('This kit has no instances to return.');
    const notReturned = instances.filter(instance => !instance.site_id || instance.lifecycle_status !== 'ACTIVE');
    if (notReturned.length) throw new Error(`Cannot dismantle: these instances are not back at a site: ${notReturned.map(item => item.instance_code).join(', ')}.`);
    const ids = instances.map(item => item.id);
    const placeholders = ids.map(() => '?').join(',');
    const openIssues = await tx.many(`SELECT ii.instance_code FROM inventory_issues inv JOIN item_instances ii ON ii.id=inv.instance_id WHERE inv.instance_id IN (${placeholders}) AND inv.status IN ('OPEN','PARTIALLY_CONSUMED')`, ids);
    if (openIssues.length) throw new Error(`Cannot dismantle: these instances still have open assignments: ${openIssues.map(item => item.instance_code).join(', ')}.`);
    await tx.query(`DELETE FROM item_kit_lines WHERE kit_id=?`, [id]);
    await tx.query(`DELETE FROM item_kits WHERE id=?`, [id]);
    return { kitCode: kit.kit_code, instanceCodes: instances.map(item => item.instance_code) };
  });
}

async function listInstances() {
  return db.many(`SELECT ii.id, ii.instance_code, ii.item_master_id, ii.site_id, ii.lifecycle_status, im.item_code, im.name AS item_name FROM item_instances ii JOIN item_masters im ON im.id=ii.item_master_id WHERE ii.lifecycle_status='ACTIVE' AND im.status='ACTIVE' ORDER BY im.item_code, im.name, ii.instance_code`);
}

async function listKitMemberships() {
  return db.many(`SELECT l.item_instance_id, ii.item_master_id, ii.instance_code, k.id AS kit_id, k.kit_code, k.name AS kit_name FROM item_kit_lines l JOIN item_instances ii ON ii.id=l.item_instance_id JOIN item_kits k ON k.id=l.kit_id WHERE k.status='ACTIVE' ORDER BY k.name`);
}

async function saveKit({ id, code, name, description, instanceIds, userId }) {
  const kitCode = String(code || '').trim().toUpperCase();
  const kitName = String(name || '').trim();
  const ids = (Array.isArray(instanceIds) ? instanceIds : [instanceIds]).map(Number).filter(Number.isInteger);
  if (!kitCode || !kitName) throw new Error('Kit code and name are required.');
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Choose at least one unique physical instance.');
  await db.tx(async tx => {
    const available = await tx.many(`SELECT id FROM item_instances WHERE id IN (${ids.map(() => '?').join(',')}) AND lifecycle_status='ACTIVE'`, ids);
    if (available.length !== ids.length) throw new Error('Choose active physical instances only.');
    let kitId = Number(id);
    if (kitId) {
      await tx.query(`UPDATE item_kits SET kit_code=?, name=?, description=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [kitCode, kitName, description || null, kitId]);
      await tx.query(`DELETE FROM item_kit_lines WHERE kit_id=?`, [kitId]);
    } else {
      const result = await tx.query(`INSERT INTO item_kits(kit_code,name,description,created_by) VALUES (?,?,?,?) RETURNING id`, [kitCode, kitName, description || null, userId]);
      kitId = result.rows[0].id;
    }
    for (const instanceId of ids) await tx.query(`INSERT INTO item_kit_lines(kit_id,item_instance_id) VALUES (?,?)`, [kitId, instanceId]);
  });
}

module.exports = { listKits, getKitById, dismantleKit, listInstances, listKitMemberships, saveKit };
