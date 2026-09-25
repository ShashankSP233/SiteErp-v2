const express = require('express');

const {
  issueInstance,
  listOpenIssuesForUser,
  consumeIssue,
  returnIssue
} = require('../repositories/inventoryIssueRepo');

const { logAudit } = require('../repositories/auditRepo');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }

  next();
}

function requireInventoryManager(req, res, next) {
  const allowedRoles = ['admin', 'manager', 'operator'];

  if (!allowedRoles.includes(req.session.user.role)) {
    return res.status(403).send('Forbidden');
  }

  next();
}

/*
 * GET /inventory/issues
 *
 * Displays currently open inventory issues.
 */
router.get(
  '/inventory/issues',
  requireAuth,
  requireInventoryManager,
  async (req, res) => {
    try {
      const issues = await listOpenIssuesForUser(req.session.user);

      res.render('inventory/issues', {
        currentUser: req.session.user,
        issues,
        error: req.query.error || null,
        success: req.query.success || null
      });
    } catch (error) {
      console.error('Failed to load inventory issues:', error);

      res.status(500).render('inventory/issues', {
        currentUser: req.session.user,
        issues: [],
        error: 'Failed to load inventory issues.',
        success: null
      });
    }
  }
);

/*
 * POST /inventory/issues
 *
 * Issues an allocation from one physical inventory instance.
 */
router.post(
  '/inventory/issues',
  requireAuth,
  requireInventoryManager,
  async (req, res) => {
  const {
    instanceCode,
    quantity,
    recipientType,
    recipientReference,
    reason
  } = req.body;

    try {
      const normalizedInstanceCode =
        String(instanceCode || '').trim();

      if (!normalizedInstanceCode) {
        throw new Error('Inventory instance code is required.');
      }

      const issueQuantity =
        quantity === undefined || quantity === null
          ? ''
          : String(quantity).trim();

      if (!recipientType) {
        throw new Error('Recipient type is required.');
      }

      const allowedRecipientTypes = [
        'PROJECT',
        'EMPLOYEE',
        'DEPARTMENT',
        'OTHER'
      ];

      if (!allowedRecipientTypes.includes(recipientType)) {
        throw new Error('Invalid recipient type.');
      }

      const result = await issueInstance({
        instanceCode: normalizedInstanceCode,
        quantity: issueQuantity,
        recipientType,
        recipientReference,
        reason,
        issuedBy: req.session.user.id,
        userRole: req.session.user.role
      });

      await logAudit({
        userId: req.session.user.id,
        action: 'INVENTORY_ISSUE',
        entity: 'inventory_issue',
        entityId: result.issue.id,
        details: {
          issueNumber: result.issue.issue_number,
          instanceCode: result.instance.instance_code,
          siteId: result.instance.site_id,
          recipientType,
          recipientReference: recipientReference || null,
          quantity: result.issue.issued_quantity,
          unit: result.instance.unit,
          reason: reason || null
        },
        ip: req.ip,
        userAgent: req.get('user-agent')
      });

      if (result.automaticConsumption) {
        await logAudit({
          userId: req.session.user.id,
          action: 'INVENTORY_CONSUME',
          entity: 'inventory_issue',
          entityId: result.issue.id,
          details: {
            issueNumber: result.issue.issue_number,
            instanceCode: result.instance.instance_code,
            consumedQuantity:
              result.automaticConsumption.consumedQuantity,
            remainingQuantity:
              result.automaticConsumption.remainingQuantity,
            unit: result.automaticConsumption.unit,
            status: result.automaticConsumption.status,
            reason: reason || null,
            automatic: true
          },
          ip: req.ip,
          userAgent: req.get('user-agent')
        });
      }

      return res.redirect(
        `/inventory/issues?success=${encodeURIComponent(
          `Inventory issued successfully: ${result.issue.issue_number}`
        )}`
      );
    } catch (error) {
      console.error('Failed to issue inventory:', error);

      return res.redirect(
        `/inventory/issues?error=${encodeURIComponent(
          error.message || 'Failed to issue inventory.'
        )}`
      );
    }
  }
);

router.post(
  '/inventory/issues/:id/consume',
  requireAuth,
  requireInventoryManager,
  async (req, res) => {
    const issueId = Number(req.params.id);
    const { quantity, reason } = req.body;

    try {
      if (!Number.isInteger(issueId) || issueId <= 0) {
        throw new Error('Invalid inventory issue.');
      }

      if (!quantity) {
        throw new Error('Consume quantity is required.');
      }

      const result = await consumeIssue({
        issueId,
        quantity: Number(quantity),
        consumedBy: req.session.user.id,
        reason
      });

      await logAudit({
        userId: req.session.user.id,
        action: 'INVENTORY_CONSUME',
        entity: 'inventory_issue',
        entityId: issueId,
        details: {
          issueNumber: result.issueNumber,
          instanceCode: result.instanceCode,
          consumedQuantity: result.consumedQuantity,
          remainingQuantity: result.remainingQuantity,
          unit: result.unit,
          status: result.status,
          reason: reason || null
        },
        ip: req.ip,
        userAgent: req.get('user-agent')
      });

      return res.redirect(
        `/inventory/issues?success=${encodeURIComponent(
          `Consumed ${result.consumedQuantity} ${result.unit} from ${result.issueNumber}.`
        )}`
      );
    } catch (error) {
      console.error('Failed to consume inventory:', error);

      return res.redirect(
        `/inventory/issues?error=${encodeURIComponent(
          error.message || 'Failed to consume inventory.'
        )}`
      );
    }
  }
);

router.post(
  '/inventory/issues/:id/return',
  requireAuth,
  requireInventoryManager,
  async (req, res) => {
    const issueId = Number(req.params.id);
    const { reason } = req.body;

    try {
      if (!Number.isInteger(issueId) || issueId <= 0) {
        throw new Error('Invalid inventory issue.');
      }

      const result = await returnIssue({
        issueId,
        returnedBy: req.session.user.id,
        reason
      });

      await logAudit({
        userId: req.session.user.id,
        action: 'INVENTORY_RETURN',
        entity: 'inventory_issue',
        entityId: issueId,
        details: {
          issueNumber: result.issueNumber,
          instanceCode: result.instanceCode,
          returnedQuantity: result.returnedQuantity,
          unit: result.unit,
          siteId: result.siteId,
          reason: reason || null
        },
        ip: req.ip,
        userAgent: req.get('user-agent')
      });

      return res.redirect(
        `/inventory/issues?success=${encodeURIComponent(
          `Returned ${result.returnedQuantity} ${result.unit} from ${result.issueNumber}.`
        )}`
      );
    } catch (error) {
      console.error('Failed to return inventory:', error);

      return res.redirect(
        `/inventory/issues?error=${encodeURIComponent(
          error.message || 'Failed to return inventory.'
        )}`
      );
    }
  }
);



module.exports = router;