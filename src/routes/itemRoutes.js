const express = require('express');

const itemMasterRepo = require('../repositories/itemMasterRepo');
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
      const items =
        await itemMasterRepo.listItemMasters();

      res.render('items/list', {
        title: 'Items',
        items
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

      const instances =
        await itemMasterRepo.getItemMasterInstances(
          req.session.user,
          req.params.id
        );

      res.render(
        'items/detail',
        {
          title: `Item Master - ${itemMaster.item_code}`,
          itemMaster,
          instances
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


module.exports = router;