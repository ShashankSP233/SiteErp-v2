const express = require('express');
const router = express.Router();

const siteRepo = require('../repositories/siteRepo');

const {
  prepareDirectReceiptBatch,
  getDirectReceiptBatch,
  listPendingDirectReceiptBatches,
  markDirectReceiptLabelsPrinted,
  scanDirectReceiptBarcode,
  deleteDirectReceiptLabel,
  discardDirectReceiptBatch,
  completeDirectReceiptBatch,
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

      const filters = {
        search: String(req.query.search || '').trim(),
        item: String(req.query.item || ''),
        site: String(req.query.site || ''),
        status: String(req.query.status || '').toUpperCase(),
        condition: String(req.query.condition || '').toUpperCase(),
        sort: String(req.query.sort || 'newest')
      };
      const items = [...new Map(instances.map(instance => [
        String(instance.item_master_id),
        { id: instance.item_master_id, code: instance.item_code, name: instance.item_name }
      ])).values()].sort((a, b) => a.code.localeCompare(b.code));
      const sites = [...new Map(instances.filter(instance => instance.site_id).map(instance => [
        String(instance.site_id), { id: instance.site_id, code: instance.site_code, name: instance.site_name }
      ])).values()].sort((a, b) => a.code.localeCompare(b.code));
      const filteredInstances = instances.filter(instance => {
        const searchable = [instance.instance_code, instance.barcode, instance.item_code, instance.item_name, instance.site_code, instance.site_name, instance.brand, instance.batch_number, instance.serial_number]
          .filter(Boolean).join(' ').toLowerCase();
        return (!filters.search || searchable.includes(filters.search.toLowerCase())) &&
          (!filters.item || String(instance.item_master_id) === filters.item) &&
          (!filters.site || (filters.site === 'none' ? !instance.site_id : String(instance.site_id || '') === filters.site)) &&
          (!filters.status || String(instance.lifecycle_status || '').toUpperCase() === filters.status) &&
          (!filters.condition || String(instance.condition || '').toUpperCase() === filters.condition);
      });
      const sorters = {
        newest: (a, b) => new Date(b.created_at) - new Date(a.created_at),
        oldest: (a, b) => new Date(a.created_at) - new Date(b.created_at),
        instance_asc: (a, b) => String(a.instance_code).localeCompare(String(b.instance_code)),
        instance_desc: (a, b) => String(b.instance_code).localeCompare(String(a.instance_code)),
        item_asc: (a, b) => String(a.item_code).localeCompare(String(b.item_code)),
        available_desc: (a, b) => Number(b.available_quantity ?? b.current_quantity) - Number(a.available_quantity ?? a.current_quantity)
      };
      if (!sorters[filters.sort]) filters.sort = 'newest';
      filteredInstances.sort(sorters[filters.sort]);

      res.render('inventory/instances', {
        title: 'Inventory Instances',
        instances: filteredInstances,
        totalInstances: instances.length,
        items,
        sites,
        filters,
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
      const [itemMasters, assignments, pendingReceipts] = await Promise.all([
        listItemMasters(),
        getReceiveSites(req.session.user),
        listPendingDirectReceiptBatches(req.session.user)
      ]);

      res.render('inventory/receive', {
        title: 'Add Stock',

        itemMasters: itemMasters.filter(
          item =>
            item.status === 'ACTIVE' &&
            item.requires_instance_tracking
        ),

        sites: assignments,
        pendingReceipts,

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

    const { siteId, reason } = req.body;

    try {
      if (!siteId) throw new Error('Select the receiving site.');
      if (!await userCanAccessSite(req.session.user, siteId)) {
        return res.status(403).render('errors/403', { title: 'Access denied' });
      }

      const submittedLines = Array.isArray(req.body.lines) ? req.body.lines : [];
      const lines = submittedLines
        .filter(line => line && (line.itemMasterId || line.quantity))
        .map((line, index) => {
          const itemMasterId = Number(line.itemMasterId);
          const instanceCount = Number(line.quantity);
          if (!Number.isInteger(itemMasterId) || itemMasterId <= 0) {
            throw new Error(`Select an item for row ${index + 1}.`);
          }
          if (!Number.isInteger(instanceCount) || instanceCount <= 0) {
            throw new Error(`Enter a whole number of physical instances for row ${index + 1}.`);
          }
          if (line.serialNumber && instanceCount !== 1) {
            throw new Error(`Row ${index + 1}: enter a serial number only when adding exactly one physical instance.`);
          }
          return {
            itemMasterId,
            instanceCount,
            brand: line.brand || null,
            batchNumber: line.batchNumber || null,
            serialNumber: line.serialNumber || null,
            manufactureDate: line.manufactureDate || null,
            expiryDate: line.expiryDate || null
          };
        });

      if (!lines.length) throw new Error('Add at least one item and quantity.');

      const user = req.session.user;
      const pendingReceipt = (await listPendingDirectReceiptBatches(user))
        .find(receipt => Number(receipt.site_id) === Number(siteId));
      if (pendingReceipt) {
        req.session.error = `Receipt #${pendingReceipt.id} for this site is still waiting for barcode scans. Resume it before starting another receipt; its barcode numbers are already reserved.`;
        return res.redirect(`/inventory/receive/${pendingReceipt.id}/labels#scanner`);
      }

      const batch = await prepareDirectReceiptBatch({
        lines,
        siteId: Number(siteId),
        performedBy: user.id,
        reason: reason || null
      });

      return res.redirect(`/inventory/receive/${batch.batchId}/labels`);

    } catch (err) {

      /*
       * ---------------------------------------------------------
       * Re-render form with validation/database error
       * ---------------------------------------------------------
       */

      try {

        const [itemMasters, assignments, pendingReceipts] = await Promise.all([
          listItemMasters(),
          getReceiveSites(
            req.session.user
          ),
          listPendingDirectReceiptBatches(req.session.user)
        ]);


        return res.status(400).render(
          'inventory/receive',
          {
            title: 'Add Stock',

            itemMasters:
              itemMasters.filter(
                item =>
                  item.status === 'ACTIVE' &&
                  item.requires_instance_tracking
              ),

            sites: assignments,
            pendingReceipts,

            error: err.message,

            form: {
              ...req.body,
              lines: Array.isArray(req.body.lines) ? req.body.lines.map(line => line || {}) : [{}]
            }
          }
        );

      } catch (renderError) {

        next(renderError);

      }
    }
  }
);

router.get(
  '/inventory/receive/:batchId/labels',
  requireAuth,
  requireInventoryManager,
  async (req, res, next) => {
    try {
      const batch = await getDirectReceiptBatch(req.params.batchId);
      if (!await userCanAccessSite(req.session.user, batch.site_id)) {
        return res.status(403).render('errors/403', { title: 'Access denied' });
      }
      return res.render('barcodes/print', {
        layout: false,
        title: `${batch.reference_number} Barcodes`,
        batch,
        labels: batch.labels.map(label => ({
          ...label,
          site_name: batch.site_name,
          site_code: batch.site_code,
          current_quantity: label.instance_quantity,
          unit: label.instance_quantity_unit,
          lifecycle_status: label.item_condition === 'DAMAGED' ? 'QUARANTINED' : 'ACTIVE'
        })),
        receiptFlow: true,
        csrfToken: res.locals.csrfToken,
        backUrl: '/inventory/receive',
        printAction: `/inventory/receive/${batch.id}/print-labels`,
        scanAction: `/inventory/receive/${batch.id}/scan`,
        finishAction: `/inventory/receive/${batch.id}/complete`,
        finishText: 'Add to Inventory'
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/inventory/receive/:batchId/print-labels',
  requireAuth,
  requireInventoryManager,
  async (req, res) => {
    try {
      const batch = await getDirectReceiptBatch(req.params.batchId);
      if (!await userCanAccessSite(req.session.user, batch.site_id)) {
        return res.status(403).render('errors/403', { title: 'Access denied' });
      }
      await markDirectReceiptLabelsPrinted({
        batchId: req.params.batchId,
        performedBy: req.session.user.id
      });
      return res.redirect(`/inventory/receive/${req.params.batchId}/labels?print=1`);
    } catch (err) {
      req.session.error = err.message;
      return res.redirect(`/inventory/receive/${req.params.batchId}/labels`);
    }
  }
);

router.post(
  '/inventory/receive/:batchId/scan',
  requireAuth,
  requireInventoryManager,
  async (req, res) => {
    try {
      const batch = await getDirectReceiptBatch(req.params.batchId);
      if (!await userCanAccessSite(req.session.user, batch.site_id)) {
        return res.status(403).render('errors/403', { title: 'Access denied' });
      }
      const label = await scanDirectReceiptBarcode({
        batchId: req.params.batchId,
        barcode: req.body.barcode,
        performedBy: req.session.user.id
      });
      req.session.success = `${label.instance_code} scanned.`;
    } catch (err) {
      req.session.error = err.message;
    }
    return res.redirect(`/inventory/receive/${req.params.batchId}/labels#scanner`);
  }
);

router.post(
  '/inventory/receive/:batchId/labels/:labelId/delete',
  requireAuth,
  requireInventoryManager,
  async (req, res) => {
    try {
      const batch = await getDirectReceiptBatch(req.params.batchId);
      if (!await userCanAccessSite(req.session.user, batch.site_id)) {
        return res.status(403).render('errors/403', { title: 'Access denied' });
      }
      await deleteDirectReceiptLabel({ batchId: req.params.batchId, labelId: req.params.labelId });
      req.session.success = 'Receipt item removed.';
    } catch (err) {
      req.session.error = err.message;
    }
    return res.redirect(`/inventory/receive/${req.params.batchId}/labels#scanner`);
  }
);

router.post(
  '/inventory/receive/:batchId/discard',
  requireAuth,
  requireInventoryManager,
  async (req, res) => {
    try {
      const batch = await getDirectReceiptBatch(req.params.batchId);
      if (!await userCanAccessSite(req.session.user, batch.site_id)) {
        return res.status(403).render('errors/403', { title: 'Access denied' });
      }
      await discardDirectReceiptBatch(req.params.batchId);
      req.session.success = 'Unfinished receipt discarded.';
    } catch (err) {
      req.session.error = err.message;
    }
    return res.redirect('/inventory/receive');
  }
);

router.post(
  '/inventory/receive/:batchId/complete',
  requireAuth,
  requireInventoryManager,
  async (req, res) => {
    try {
      const batch = await getDirectReceiptBatch(req.params.batchId);
      if (!await userCanAccessSite(req.session.user, batch.site_id)) {
        return res.status(403).render('errors/403', { title: 'Access denied' });
      }
      const instances = await completeDirectReceiptBatch({
        batchId: req.params.batchId,
        performedBy: req.session.user.id
      });
      for (const instance of instances) {
        await logAudit({
          userId: req.session.user.id,
          action: 'RECEIVE_INVENTORY',
          entity: 'item_instance',
          entityId: instance.id,
          details: {
            instanceCode: instance.instance_code,
            barcode: instance.barcode,
            itemMasterId: instance.item_master_id,
            quantity: instance.original_quantity,
            unit: instance.unit,
            siteId: instance.site_id,
            receiptBatchId: req.params.batchId
          },
          ip: req.ip,
          userAgent: req.get('user-agent')
        });
      }
      const first = instances[0]?.instance_code;
      const last = instances[instances.length - 1]?.instance_code;
      const received = first === last ? first : `${first} to ${last}`;
      return res.redirect(`/inventory/instances?received=${encodeURIComponent(received || '')}`);
    } catch (err) {
      req.session.error = err.message;
      return res.redirect(`/inventory/receive/${req.params.batchId}/labels`);
    }
  }
);


module.exports = router;
