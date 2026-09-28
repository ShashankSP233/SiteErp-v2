const express = require('express');

const {
  adjustInstance
} = require('../repositories/inventoryAdjustmentRepo');

const {
  listInstancesForUser
} = require('../repositories/itemInstanceRepo');

const {
  logAudit
} = require('../repositories/auditRepo');

const router = express.Router();


function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }

  next();
}


/*
 * Adjustments are intentionally restricted to
 * administrators and managers.
 *
 * Operators can receive/issue inventory, but an adjustment
 * changes the official quantity and therefore requires
 * management-level access.
 */
function requireAdjustmentManager(req, res, next) {
  const allowedRoles = [
    'admin',
    'manager'
  ];

  if (
    !allowedRoles.includes(
      req.session.user.role
    )
  ) {
    return res.status(403).render(
      'errors/403',
      {
        title: 'Access denied'
      }
    );
  }

  next();
}


/**
 * GET /inventory/adjustment
 *
 * Manual adjustment screen.
 *
 * instanceCode can optionally be supplied in the query:
 *
 * /inventory/adjustment?instanceCode=OIL-20L-0001
 */
router.get(
  '/inventory/adjustment',
  requireAuth,
  requireAdjustmentManager,
  async (req, res, next) => {
    try {

      const instances =
        await listInstancesForUser(
          req.session.user
        );

      const activeInstances =
        instances.filter(
          instance =>
            instance.lifecycle_status === 'ACTIVE' &&
            Number(instance.current_quantity) > 0
        );

      res.render(
        'inventory/adjustment',
        {
          title: 'Adjust Inventory',

          instances:
            activeInstances,

          form: {
            instanceCode:
              req.query.instanceCode || '',

            adjustmentType:
              'ADJUSTMENT_OUT',

            quantity:
              '',

            reason:
              ''
          },

          error:
            req.query.error || null,

          success:
            req.query.success || null
        }
      );

    } catch (error) {
      next(error);
    }
  }
);


/**
 * POST /inventory/adjustment
 *
 * Creates an ADJUSTMENT_IN or ADJUSTMENT_OUT movement.
 */
router.post(
  '/inventory/adjustment',
  requireAuth,
  requireAdjustmentManager,
  async (req, res) => {

    const {
      instanceCode,
      adjustmentType,
      quantity,
      reason
    } = req.body;

    const form = {
      instanceCode:
        String(instanceCode || '').trim(),

      adjustmentType:
        String(
          adjustmentType || 'ADJUSTMENT_OUT'
        ).trim(),

      quantity:
        quantity || '',

      reason:
        reason || ''
    };

    try {

      const result =
        await adjustInstance({
          instanceCode:
            form.instanceCode,

          adjustmentType:
            form.adjustmentType,

          quantity:
            form.quantity,

          reason:
            form.reason,

          performedBy:
            req.session.user.id
        });


      /*
       * Audit trail.
       */
      await logAudit({
        userId:
          req.session.user.id,

        action:
          'INVENTORY_ADJUSTMENT',

        entity:
          'item_instance',

        entityId:
          result.instanceId,

        details: {
          instanceCode:
            result.instanceCode,

          barcode:
            result.barcode,

          itemCode:
            result.itemCode,

          siteId:
            result.siteId,

          siteCode:
            result.siteCode,

          adjustmentType:
            result.adjustmentType,

          adjustmentQuantity:
            result.adjustmentQuantity,

          previousQuantity:
            result.previousQuantity,

          newQuantity:
            result.newQuantity,

          unit:
            result.unit,

          reason:
            result.reason,

          movementReference:
            result.movementReference
        },

        ip:
          req.ip,

        userAgent:
          req.get('user-agent')
      });


      const message =
        `${result.adjustmentType === 'ADJUSTMENT_IN' ? 'Added' : 'Removed'} ` +
        `${result.adjustmentQuantity} ${result.unit} ` +
        `${result.instanceCode}. ` +
        `New quantity: ${result.newQuantity} ${result.unit}.`;


      return res.redirect(
        `/inventory/adjustment?success=${encodeURIComponent(
          message
        )}&instanceCode=${encodeURIComponent(
          result.instanceCode
        )}`
      );

    } catch (error) {

      console.error(
        'Failed to adjust inventory:',
        error
      );

      return res.redirect(
        `/inventory/adjustment?error=${encodeURIComponent(
          error.message ||
          'Failed to adjust inventory.'
        )}&instanceCode=${encodeURIComponent(
          form.instanceCode
        )}`
      );
    }
  }
);


module.exports = router;