const express = require('express');
const label = require('../repositories/labelRepo');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

/**
 * Barcode / Label management
 *
 * V2 does not create a separate "labels" record.
 * Each physical item instance already has:
 *
 *   instance_code
 *   barcode
 *
 * The label system only retrieves those permanent identities
 * and renders them for printing.
 */

/**
 * Barcode label listing page.
 *
 * GET /inventory/labels
 *
 * Optional:
 *   ?itemMasterId=123
 *   ?unprinted=1
 */
router.get(
  '/inventory/labels',
  requireAuth,
  async (req, res, next) => {
    try {
      const itemMasterId = req.query.itemMasterId
        ? Number(req.query.itemMasterId)
        : null;

      if (
        itemMasterId !== null &&
        (!Number.isInteger(itemMasterId) || itemMasterId <= 0)
      ) {
        return res.status(400).render('errors/400', {
          title: 'Invalid item master',
          message: 'Invalid item master ID.',
        });
      }

      const labels = await label.listLabels({
        user: req.session.user,
        itemMasterId,
        onlyActive: req.query.active === '1',
        limit: 500,
      });

      res.render('barcodes/index', {
        title: 'Barcode Labels',
        labels,
        itemMasterId,
        activeOnly: req.query.active === '1',
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Printable labels for selected physical instances.
 *
 * POST /inventory/labels/print
 *
 * The selected values are instance IDs.
 * Access is checked again in the repository, so manually
 * submitting another user's instance ID cannot bypass site access.
 */
router.post(
  '/inventory/labels/print',
  requireAuth,
  requireRole('admin', 'manager', 'operator'),
  async (req, res, next) => {
    try {
      let instanceIds = req.body.instanceIds || [];

      if (!Array.isArray(instanceIds)) {
        instanceIds = [instanceIds];
      }

      instanceIds = [
        ...new Set(
          instanceIds
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value > 0)
        ),
      ];

      if (!instanceIds.length) {
        req.session.error = 'Select at least one inventory instance to print.';
        return res.redirect('/inventory/labels');
      }

      const labels = [];

      for (const instanceId of instanceIds) {
        const instance = await label.getByInstanceId(
          instanceId,
          req.session.user
        );

        if (instance) {
          labels.push(instance);
        }
      }

      if (!labels.length) {
        req.session.error =
          'No accessible inventory instances were selected.';
        return res.redirect('/inventory/labels');
      }

      res.render('barcodes/print', {
        title: 'Barcode Labels',
        labels,
        layout: false,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Print one physical instance directly.
 *
 * GET /inventory/labels/print/:instanceId
 *
 * Useful from the Inventory Instances page.
 */
router.get(
  '/inventory/labels/print/:instanceId',
  requireAuth,
  requireRole('admin', 'manager', 'operator'),
  async (req, res, next) => {
    try {
      const instanceId = Number(req.params.instanceId);

      if (!Number.isInteger(instanceId) || instanceId <= 0) {
        return res.status(400).render('errors/400', {
          title: 'Invalid inventory instance',
          message: 'Invalid inventory instance ID.',
        });
      }

      const instance = await label.getByInstanceId(
        instanceId,
        req.session.user
      );

      if (!instance) {
        return res.status(404).render('errors/404', {
          title: 'Inventory instance not found',
          message: 'The inventory instance was not found or is not accessible.',
        });
      }

      res.render('barcodes/print', {
        title: 'Barcode Label',
        labels: [instance],
        layout: false,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Resolve an instance by scanner/manual barcode input.
 *
 * GET /inventory/labels/resolve?code=...
 *
 * This is intentionally small for now.
 * Later Phase 5 scanning will use the same repository resolver
 * as the common scanning subsystem.
 */
router.get(
  '/inventory/labels/resolve',
  requireAuth,
  async (req, res, next) => {
    try {
      const code = String(req.query.code || '').trim();

      if (!code) {
        return res.status(400).json({
          ok: false,
          error: 'Barcode or instance code is required.',
        });
      }

      const instance = await label.getByCodeOrBarcode(
        code,
        req.session.user
      );

      if (!instance) {
        return res.status(404).json({
          ok: false,
          error: 'Inventory instance not found.',
        });
      }

      return res.json({
        ok: true,
        instance: {
          id: instance.instance_id,
          instance_code: instance.instance_code,
          barcode: instance.barcode,
          item_code: instance.item_code,
          item_name: instance.item_name,
          current_quantity: instance.current_quantity,
          unit: instance.unit,
          lifecycle_status: instance.lifecycle_status,
          site_id: instance.site_id,
          site_code: instance.site_code,
          site_name: instance.site_name,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;