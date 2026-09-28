const express = require('express');
const router = express.Router();

const siteRepo = require('../repositories/siteRepo');

const {
  receiveInstances,
  listInstancesForUser
} = require('../repositories/itemInstanceRepo');

const {
  getActiveSiteAssignments
} = require('../repositories/userRepo');

const {
  listItemMasters
} = require('../repositories/itemMasterRepo');

const { logAudit } = require('../repositories/auditRepo');


function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }

  next();
}


function requireInventoryManager(req, res, next) {
  const allowed = new Set([
    'admin',
    'manager',
    'operator'
  ]);

  if (!allowed.has(req.session.user.role)) {
    return res.status(403).render('errors/403', {
      title: 'Access denied'
    });
  }

  next();
}


/**
 * Check whether a user can access a particular site.
 *
 * Admins can access every site.
 * Other users must have an active assignment.
 */
async function userCanAccessSite(user, siteId) {
  if (user.role === 'admin') {
    return true;
  }

  const assignments =
    await getActiveSiteAssignments(user.id);

  return assignments.some(
    assignment =>
      Number(assignment.site_id) === Number(siteId)
  );
}


async function getReceiveSites(user) {
  if (user.role === 'admin') {
    const sites = await siteRepo.listSites();

    return sites
      .filter(site => site.status === 'ACTIVE')
      .map(site => ({
        site_id: site.id,
        code: site.code,
        name: site.name,
        site_type: site.site_type
      }));
  }

  return getActiveSiteAssignments(user.id);
}


/**
 * Inventory instance list.
 */
router.get(
  '/inventory/instances',
  requireAuth,
  async (req, res, next) => {
    try {
      const instances =
        await listInstancesForUser(
          req.session.user
        );

      res.render('inventory/instances', {
        title: 'Inventory Instances',
        instances,
        query: req.query
      });
    } catch (err) {
      next(err);
    }
  }
);


/**
 * Receive inventory form.
 *
 * Manual Receive creates physical instances.
 * The entered quantity represents the NUMBER
 * OF PHYSICAL INSTANCES, not their contents quantity.
 */
router.get(
  '/inventory/receive',
  requireAuth,
  requireInventoryManager,
  async (req, res, next) => {
    try {
      const [
        itemMasters,
        assignments
      ] = await Promise.all([
        listItemMasters(),
        getReceiveSites(req.session.user)
      ]);

      res.render('inventory/receive', {
        title: 'Receive Inventory',

        itemMasters: itemMasters.filter(
          item =>
            item.status === 'ACTIVE' &&
            item.requires_instance_tracking
        ),

        sites: assignments,

        error: null,

        form: {}
      });
    } catch (err) {
      next(err);
    }
  }
);


/**
 * Receive physical inventory instances.
 *
 * quantity = number of physical instances.
 *
 * Example:
 *
 * OIL-20L
 * Quantity per instance = 20 L
 * Quantity entered = 3
 *
 * Creates:
 * OIL-20L-0001 -> 20 L
 * OIL-20L-0002 -> 20 L
 * OIL-20L-0003 -> 20 L
 */
router.post(
  '/inventory/receive',
  requireAuth,
  requireInventoryManager,
  async (req, res, next) => {

    const {
      itemMasterId,
      quantity,
      siteId,
      batchNumber,
      serialNumber,
      manufactureDate,
      expiryDate,
      reason
    } = req.body;

    try {

      /*
       * ---------------------------------------------------------
       * 1. Required fields
       * ---------------------------------------------------------
       */

      if (
        !itemMasterId ||
        !siteId ||
        quantity === undefined ||
        quantity === null ||
        quantity === ''
      ) {
        throw new Error(
          'Item, site and number of physical instances are required.'
        );
      }


      /*
       * ---------------------------------------------------------
       * 2. Validate physical instance count
       * ---------------------------------------------------------
       */

      const instanceCount = Number(quantity);

      if (
        !Number.isInteger(instanceCount) ||
        instanceCount <= 0
      ) {
        throw new Error(
          'Number of physical instances must be a positive whole number.'
        );
      }


      /*
       * A serial number identifies one physical instance.
       *
       * If multiple physical instances are received,
       * one single serial number cannot identify all of them.
       */
      if (
        serialNumber &&
        instanceCount !== 1
      ) {
        throw new Error(
          'Enter a serial number only when receiving exactly one physical instance.'
        );
      }


      /*
       * ---------------------------------------------------------
       * 3. Site authorization
       * ---------------------------------------------------------
       */

      const user = req.session.user;

      if (
        !await userCanAccessSite(
          user,
          siteId
        )
      ) {
        return res.status(403).render(
          'errors/403',
          {
            title: 'Access denied'
          }
        );
      }


      /*
       * ---------------------------------------------------------
       * 4. Create physical instances
       * ---------------------------------------------------------
       */

      const result =
        await receiveInstances({
          itemMasterId: Number(itemMasterId),

          instanceCount,

          siteId: Number(siteId),

          performedBy: user.id,

          batchNumber:
            batchNumber || null,

          serialNumber:
            serialNumber || null,

          manufactureDate:
            manufactureDate || null,

          expiryDate:
            expiryDate || null,

          reason:
            reason || null
        });


      /*
       * ---------------------------------------------------------
       * 5. Audit every created instance
       * ---------------------------------------------------------
       */

      for (
        const instance of result.instances
      ) {

        await logAudit({
          userId: user.id,

          action: 'RECEIVE_INVENTORY',

          entity: 'item_instance',

          entityId: instance.id,

          details: {
            instanceCode:
              instance.instance_code,

            barcode:
              instance.barcode,

            itemMasterId:
              result.itemMaster.id,

            itemCode:
              result.itemMaster.item_code,

            quantity:
              instance.original_quantity,

            unit:
              instance.unit,

            siteId:
              result.site.id,

            siteCode:
              result.site.code
          },

          ip: req.ip,

          userAgent:
            req.get('user-agent')
        });
      }


      /*
       * ---------------------------------------------------------
       * 6. Redirect to inventory list
       * ---------------------------------------------------------
       */

      const firstInstance =
        result.instances[0];

      const lastInstance =
        result.instances[
          result.instances.length - 1
        ];


      let receivedReference;

      if (
        firstInstance.instance_code ===
        lastInstance.instance_code
      ) {

        receivedReference =
          firstInstance.instance_code;

      } else {

        receivedReference =
          `${firstInstance.instance_code} to ${lastInstance.instance_code}`;
      }


      return res.redirect(
        `/inventory/instances?received=${encodeURIComponent(
          receivedReference
        )}`
      );

    } catch (err) {

      /*
       * ---------------------------------------------------------
       * Re-render form with validation/database error
       * ---------------------------------------------------------
       */

      try {

        const [
          itemMasters,
          assignments
        ] = await Promise.all([
          listItemMasters(),
          getReceiveSites(
            req.session.user
          )
        ]);


        return res.status(400).render(
          'inventory/receive',
          {
            title: 'Receive Inventory',

            itemMasters:
              itemMasters.filter(
                item =>
                  item.status === 'ACTIVE' &&
                  item.requires_instance_tracking
              ),

            sites: assignments,

            error: err.message,

            form: req.body
          }
        );

      } catch (renderError) {

        next(renderError);

      }
    }
  }
);


module.exports = router;