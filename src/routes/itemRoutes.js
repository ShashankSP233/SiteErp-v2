const express = require('express');

const itemMasterRepo = require('../repositories/itemMasterRepo');
const { listKits } = require('../repositories/itemKitRepo');

const {
  receiveInstances,
  listInstancesForUser,
  findInstanceForUser,
  updateInstanceDetails
} = require('../repositories/itemInstanceRepo');

const { getInstanceMovementSummary } = require('../repositories/inventoryMovementRepo');

const { logAudit } = require('../repositories/auditRepo');
const {
  requireAuth,
  requireRole
} = require('../middleware/auth');
const session = require('express-session');

const router = express.Router();


// ============================================================
// ITEM MASTER LIST
// ============================================================

router.get(
  '/items',
  requireAuth,
  async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim();
      const allItems = await itemMasterRepo.listItemMasters();
      const allKits = await listKits();
      const searchTerm = q.toLocaleLowerCase();

      const items = searchTerm
        ? allItems.filter(item => {
            const searchableText = [
              item.item_code,
              item.name,
              item.description
            ]
              .filter(Boolean)
              .join(' ')
              .toLocaleLowerCase();

            return searchableText.includes(searchTerm);
          })
        : allItems;

      const kits = searchTerm
        ? allKits.filter(kit => [kit.kit_code, kit.name, kit.description, ...kit.items.flatMap(instance => [instance.instance_code, instance.item_code, instance.item_name])].filter(Boolean).join(' ').toLocaleLowerCase().includes(searchTerm))
        : allKits;

      res.render('items/list', {
        title: 'Items',
        items,
        kits,
        q
      });
    } catch (err) {
      next(err);
    }
  }
);



// ============================================================
// ITEM MASTER DETAIL
// ============================================================
//
// Shows:
//   - Item Master information
//   - All physical instances
//   - Current quantity
//   - Location
//   - Lifecycle status
//
// This includes inactive/consumed/MIA/lost/disposed
// instances as well as active inventory.
// ============================================================

router.get(
  '/items/:id/ledger',
  requireAuth,
  async (req, res, next) => {
    try {
      const itemMaster =
        await itemMasterRepo.getItemMasterById(
          req.params.id
        );

      if (!itemMaster) {
        return res.status(404).render(
          'errors/404',
          {
            title: 'Item Master Not Found'
          }
        );
      }

      const allInstances =
        await itemMasterRepo.getItemMasterInstances(
          req.session.user,
          req.params.id
        );

      const filters = {
        site: String(req.query.site || '').trim(),
        status: String(req.query.status || '').trim().toUpperCase(),
        condition: String(req.query.condition || '').trim()
      };
      const sites = [...new Map(allInstances
        .filter(instance => instance.site_id)
        .map(instance => [String(instance.site_id), {
          id: String(instance.site_id),
          label: `${instance.site_code || ''}${instance.site_code && instance.site_name ? ' — ' : ''}${instance.site_name || ''}`
        }])).values()].sort((a, b) => a.label.localeCompare(b.label));
      const statuses = [...new Set(allInstances.map(instance => String(instance.lifecycle_status || '').toUpperCase()).filter(Boolean))].sort();
      const conditions = [...new Set(allInstances.map(instance => String(instance.condition || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      const instances = allInstances.filter(instance =>
        (!filters.site || String(instance.site_id || '') === filters.site) &&
        (!filters.status || String(instance.lifecycle_status || '').toUpperCase() === filters.status) &&
        (!filters.condition || String(instance.condition || '') === filters.condition)
      );
      const damagedCount = allInstances.filter(instance => /damag/i.test(String(instance.condition || ''))).length;
      const inTransitCount = allInstances.filter(instance => String(instance.lifecycle_status || '').toUpperCase() === 'IN_TRANSIT').length;

      res.render(
        'items/detail',
        {
          title: `Item Master - ${itemMaster.item_code}`,
          itemMaster,
          instances,
          totalInstances: allInstances.length,
          totalQuantity: allInstances.reduce((total, instance) => total + Number(instance.current_quantity || 0), 0),
          sites,
          statuses,
          conditions,
          filters,
          damagedCount,
          inTransitCount
        }
      );

    } catch (err) {
      next(err);
    }
  }
);


// ============================================================
// CREATE ITEM MASTER FORM
// ============================================================

router.get(
  '/items/new',
  requireAuth,
  requireRole('admin', 'manager'),
  (req, res) => {
    res.render('items/form', {
      title: 'Create Item',
      item: {}
    });
  }
);


// ============================================================
// CREATE ITEM MASTER
// ============================================================

router.post(
  '/items',
  requireAuth,
  requireRole('admin', 'manager'),
  async (req, res) => {
    try {

      const item =
        await itemMasterRepo.createItemMaster(
          {
            itemCode: req.body.itemCode,
            name: req.body.name,
            description: req.body.description,
            category: req.body.category,
            unit: req.body.unit,

            instanceQuantity:
              req.body.instanceQuantity,

            instanceQuantityUnit:
              req.body.instanceQuantityUnit,

            isConsumable:
              req.body.isConsumable === 'on',

            allowsPartialConsumption:
              req.body.allowsPartialConsumption === 'on',

            requiresInstanceTracking:
              req.body.requiresInstanceTracking !== 'off',

            reorderLevel:
              req.body.reorderLevel
          },
          req.session.user.id
        );


      await logAudit({
        userId: req.session.user.id,
        action: 'CREATE_ITEM_MASTER',
        entity: 'item_masters',
        entityId: item.id,
        details: {
          itemCode: item.item_code,
          name: item.name
        },
        ip: req.ip,
        userAgent: req.get('user-agent')
      });


      req.session.success =
        'Item master created successfully.';

      res.redirect('/items');

    } catch (err) {

      req.session.error =
        err.message;

      res.redirect('/items/new');
    }
  }
);


// ============================================================
// EDIT ITEM MASTER
// ============================================================

router.get(
  '/items/:id/edit',
  requireAuth,
  requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {

      const item =
        await itemMasterRepo.getItemMasterById(
          req.params.id
        );

      if (!item) {
        return res.status(404).render(
          'errors/404',
          {
            title: 'Item not found'
          }
        );
      }

      res.render('items/form', {
        title: 'Edit Item',
        item
      });

    } catch (err) {
      next(err);
    }
  }
);


// ============================================================
// UPDATE ITEM MASTER
// ============================================================

router.post(
  '/items/:id',
  requireAuth,
  requireRole('admin', 'manager'),
  async (req, res) => {
    try {

      const item =
        await itemMasterRepo.updateItemMaster(
          req.params.id,
          {
            name:
              req.body.name,

            description:
              req.body.description,

            category:
              req.body.category,

            unit:
              req.body.unit,

            instanceQuantity:
              req.body.instanceQuantity,

            instanceQuantityUnit:
              req.body.instanceQuantityUnit,

            isConsumable:
              req.body.isConsumable === 'on',

            allowsPartialConsumption:
              req.body.allowsPartialConsumption === 'on',

            requiresInstanceTracking:
              req.body.requiresInstanceTracking !== 'off',

            reorderLevel:
              req.body.reorderLevel,

            status:
              req.body.status
          }
        );


      await logAudit({
        userId: req.session.user.id,
        action: 'UPDATE_ITEM_MASTER',
        entity: 'item_masters',
        entityId: req.params.id,
        details: {
          name: item.name,
          status: item.status
        },
        ip: req.ip,
        userAgent: req.get('user-agent')
      });


      req.session.success =
        'Item master updated successfully.';

      res.redirect('/items');

    } catch (err) {

      req.session.error =
        err.message;

      res.redirect(
        `/items/${req.params.id}/edit`
      );
    }
  }
);


router.get(
  '/items',
  requireAuth,
  async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim();
      const allItems = await itemMasterRepo.listItemMasters();

      const searchTerm = q.toLocaleLowerCase();

      const items = searchTerm
        ? allItems.filter(item => {
            const searchableText = [
              item.item_code,
              item.name,
              item.description
            ]
              .filter(Boolean)
              .join(' ')
              .toLocaleLowerCase();

            return searchableText.includes(searchTerm);
          })
        : allItems;

      res.render('items/list', {
        title: 'Items',
        items,
        q
      });
    } catch (err) {
      next(err);
    }
  }
);


// Single Item Views for Item Instance

router.get(
  '/inventory/instances/lookup',
  requireAuth,
  async (req, res, next) => {
    try{
      const code = String(req.query.code || '').trim();

      let instance = null;
      let error = null;

      if (code){
        instance = await findInstanceForUser(
          req.session.user,
          code
        );
        if (!instance){
          error = `Not accessible instance found for "${code}"`;
        } else {
          instance.movements = await getInstanceMovementSummary(
            req.session.user,
            instance.instance_code
          );
        }
      }

      res.render('inventory/instance-detail',{
        title: instance ? `Instance — ${instance.instance_code}` : 'Find Inventory Instance',
        code,
        instance,
        error
      });
    }catch (err){
      next(err);
    }
  }
);

router.post(
  '/inventory/instances/:id/details',
  requireAuth,
  requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const instanceId = Number(req.params.id);
      const current = await findInstanceForUser(req.session.user, req.body.instanceCode || '');
      if (!Number.isInteger(instanceId) || !current || Number(current.id) !== instanceId) {
        return res.status(404).render('errors/404', { title: 'Inventory instance not found' });
      }
      await updateInstanceDetails({
        user: req.session.user,
        instanceId,
        condition: req.body.condition,
        lifecycleStatus: req.body.lifecycleStatus,
        brand: req.body.brand,
        batchNumber: req.body.batchNumber,
        serialNumber: req.body.serialNumber,
        manufactureDate: req.body.manufactureDate || null,
        expiryDate: req.body.expiryDate || null
      });
      await logAudit({
        userId: req.session.user.id,
        action: 'UPDATE_INSTANCE_DETAILS',
        entity: 'item_instances',
        entityId: instanceId,
        details: {
          condition: req.body.condition,
          lifecycleStatus: req.body.condition === 'DAMAGED' ? 'QUARANTINED' : req.body.lifecycleStatus,
          brand: req.body.brand,
          batchNumber: req.body.batchNumber,
          serialNumber: req.body.serialNumber,
          manufactureDate: req.body.manufactureDate,
          expiryDate: req.body.expiryDate
        },
        ip: req.ip,
        userAgent: req.get('user-agent')
      });
      req.session.success = 'Instance details updated.';
      return res.redirect(`/inventory/instances/lookup?code=${encodeURIComponent(current.instance_code)}`);
    } catch (err) {
      req.session.error = err.message;
      return res.redirect(`/inventory/instances/lookup?code=${encodeURIComponent(req.body.instanceCode || '')}`);
    }
  }
);

module.exports = router;
