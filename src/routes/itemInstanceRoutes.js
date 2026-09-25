const express = require('express');
const router = express.Router();
const siteRepo = require('../repositories/siteRepo');

const {
  receiveInstance,
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
  const allowed = new Set(['admin', 'manager', 'operator']);

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

  const assignments = await getActiveSiteAssignments(user.id);

  return assignments.some(
    assignment => Number(assignment.site_id) === Number(siteId)
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
      const instances = await listInstancesForUser(req.session.user);

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
 */
router.get(
  '/inventory/receive',
  requireAuth,
  requireInventoryManager,
  async (req, res, next) => {
    try {
      const [itemMasters, assignments] = await Promise.all([
        listItemMasters(),
        getReceiveSites(req.session.user)
      ]);

      res.render('inventory/receive', {
        title: 'Receive Inventory',
        itemMasters: itemMasters.filter(
          item => item.status === 'ACTIVE' &&
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
 * Receive one physical instance.
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
      if (!itemMasterId || !siteId || !quantity) {
        throw new Error(
          'Item, site and quantity are required.'
        );
      }

      const user = req.session.user;

      if (!await userCanAccessSite(user, siteId)) {
        return res.status(403).render('errors/403', {
          title: 'Access denied'
        });
      }

      const result = await receiveInstance({
        itemMasterId: Number(itemMasterId),
        quantity: Number(quantity),
        siteId: Number(siteId),
        performedBy: user.id,
        batchNumber: batchNumber || null,
        serialNumber: serialNumber || null,
        manufactureDate: manufactureDate || null,
        expiryDate: expiryDate || null,
        reason: reason || null
      });

      await logAudit({
        userId: user.id,
        action: 'RECEIVE_INVENTORY',
        entity: 'item_instance',
        entityId: result.instance.id,
        details: {
          instanceCode: result.instance.instance_code,
          barcode: result.instance.barcode,
          itemMasterId: result.itemMaster.id,
          itemCode: result.itemMaster.item_code,
          quantity: result.instance.original_quantity,
          unit: result.instance.unit,
          siteId: result.site.id,
          siteCode: result.site.code
        },
        ip: req.ip,
        userAgent: req.get('user-agent')
      });

      return res.redirect(
        `/inventory/instances?received=${encodeURIComponent(
          result.instance.instance_code
        )}`
      );
    } catch (err) {
      try {
        const [itemMasters, assignments] = await Promise.all([
          listItemMasters(),
          getReceiveSites(req.session.user)
        ]);

        return res.status(400).render('inventory/receive', {
          title: 'Receive Inventory',
          itemMasters: itemMasters.filter(
            item => item.status === 'ACTIVE' &&
                    item.requires_instance_tracking
          ),
          sites: assignments,
          error: err.message,
          form: req.body
        });
      } catch (renderError) {
        next(renderError);
      }
    }
  }
);

module.exports = router;