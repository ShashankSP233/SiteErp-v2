const express = require('express');
const db = require('../config/db');
const { listKits, getKitById, dismantleKit, listInstances, saveKit } = require('../repositories/itemKitRepo');
const { getInstanceMovementSummary } = require('../repositories/inventoryMovementRepo');
const { logAudit } = require('../repositories/auditRepo');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();

router.get('/kits', requireAuth, async (req, res) => {
  try {
    const [kits, instances] = await Promise.all([
      listKits(),
      listInstances()
    ]);
    const assignedIds = new Set((await db.many('SELECT item_instance_id FROM item_kit_lines')).map(x => Number(x.item_instance_id)));
    const availableInstances = instances.filter(instance => !assignedIds.has(Number(instance.id)));
    const instanceGroups = [];
    for (const instance of availableInstances) {
      let group = instanceGroups.find(item => item.itemMasterId === Number(instance.item_master_id));
      if (!group) {
        group = { itemMasterId: Number(instance.item_master_id), label: `${instance.item_code} — ${instance.item_name}`, instances: [] };
        instanceGroups.push(group);
      }
      group.instances.push(instance);
    }
    res.render('items/kits', { title: 'Kits', kits, instanceGroups, error: req.query.error || null, success: req.query.success || null });
  } catch (error) { res.status(500).send(error.message); }
});

router.post('/kits', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try {
    await saveKit({ ...req.body, userId: req.session.user.id });
    res.redirect('/kits?success=' + encodeURIComponent('Kit saved.'));
  } catch (error) { res.redirect('/kits?error=' + encodeURIComponent(error.message)); }
});

router.get('/kits/:id', requireAuth, async (req, res, next) => {
  try {
    const kit = await getKitById(Number(req.params.id));
    if (!kit) return res.status(404).render('errors/404', { title: 'Kit not found' });
    for (const instance of kit.items) {
      instance.movements = await getInstanceMovementSummary(req.session.user, instance.instance_code);
    }
    res.render('items/kit-detail', { title: `Kit — ${kit.kit_code}`, kit });
  } catch (error) { next(error); }
});

router.post('/kits/:id/dismantle', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try {
    const result = await dismantleKit(Number(req.params.id));
    await logAudit({
      userId: req.session.user.id,
      action: 'DISMANTLE_KIT',
      entity: 'item_kits',
      entityId: req.params.id,
      details: result,
      ip: req.ip,
      userAgent: req.get('user-agent')
    });
    res.redirect('/kits?success=' + encodeURIComponent(`Kit ${result.kitCode} dismantled; its instances are available under their item masters.`));
  } catch (error) { res.redirect('/kits?error=' + encodeURIComponent(error.message)); }
});

module.exports = router;
