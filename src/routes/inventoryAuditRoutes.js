const express = require('express');

const auditRepo = require('../repositories/inventoryAuditRepo');
const { logAudit } = require('../repositories/auditRepo');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get(
  '/inventory/audits',
  requireAuth,
  async (req, res, next) => {
    try {
      const [audits, sites] = await Promise.all([
        auditRepo.listAuditsForUser(req.session.user),
        auditRepo.getAccessibleSites(req.session.user)
      ]);

      res.render('inventory/audits', {
        title: 'Inventory Audits',
        audits,
        sites,
        auditTypes: auditRepo.AUDIT_TYPES
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/inventory/audits',
  requireAuth,
  requireRole('admin', 'manager'),
  async (req, res) => {
    try {
      const result = await auditRepo.createAudit({
        name: req.body.name,
        siteId: req.body.siteId,
        auditType: req.body.auditType,
        notes: req.body.notes,
        user: req.session.user
      });

      await logAudit({
        userId: req.session.user.id,
        action: 'INVENTORY_AUDIT_START',
        entity: 'inventory_audits',
        entityId: result.audit.id,
        details: {
          name: result.audit.name,
          siteId: result.site.id,
          siteCode: result.site.code,
          auditType: result.audit.audit_type,
          expectedCount: result.expectedCount
        },
        ip: req.ip,
        userAgent: req.get('user-agent')
      });

      req.session.success =
        `Audit started. ${result.expectedCount} inventory instance(s) are in scope.`;

      res.redirect(`/inventory/audits/${result.audit.id}`);
    } catch (err) {
      req.session.error = err.message;
      res.redirect('/inventory/audits');
    }
  }
);

router.get(
  '/inventory/audits/:id',
  requireAuth,
  async (req, res, next) => {
    try {
      const result = await auditRepo.getAuditForUser(
        req.session.user,
        req.params.id
      );

      if (!result) {
        return res.status(404).render('errors/404', {
          title: 'Audit not found'
        });
      }

      res.render('inventory/audit', {
        title: `Inventory Audit — ${result.audit.name}`,
        audit: result.audit,
        items: result.items
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/inventory/audits/:id/count',
  requireAuth,
  async (req, res) => {
    try {
      const result = await auditRepo.recordCount({
        auditId: req.params.id,
        scannedCode: req.body.scannedCode,
        countedQuantity: req.body.countedQuantity,
        notes: req.body.notes,
        user: req.session.user
      });

      req.session.success =
        result.result === 'MATCHED'
          ? `${result.instanceCode} counted successfully.`
          : `${result.result}: ${result.code}`;

      res.redirect(`/inventory/audits/${req.params.id}`);
    } catch (err) {
      req.session.error = err.message;
      res.redirect(`/inventory/audits/${req.params.id}`);
    }
  }
);

router.post(
  '/inventory/audits/:id/complete',
  requireAuth,
  requireRole('admin', 'manager'),
  async (req, res) => {
    try {
      const completed = await auditRepo.completeAudit({
        auditId: req.params.id,
        user: req.session.user
      });

      await logAudit({
        userId: req.session.user.id,
        action: 'INVENTORY_AUDIT_COMPLETE',
        entity: 'inventory_audits',
        entityId: completed.id,
        details: {
          status: completed.status
        },
        ip: req.ip,
        userAgent: req.get('user-agent')
      });

      req.session.success =
        'Inventory audit completed. No inventory quantity was changed.';
    } catch (err) {
      req.session.error = err.message;
    }

    res.redirect(`/inventory/audits/${req.params.id}`);
  }
);

module.exports = router;
