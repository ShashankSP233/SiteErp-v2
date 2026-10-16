const express = require('express');

const {
  issueInstance,
  createIssueBatch,
  getIssueBatch,
  stageIssueBatchInstance,
  removeStagedIssueBatchInstance,
  finalizeIssueBatch,
  canAccessIssueBatch,
  listOpenIssueBatches,
  scanIssueBatchReturn,
  listOpenIssuesForUser,
  consumeIssue,
} = require('../repositories/inventoryIssueRepo');
const { listKits } = require('../repositories/itemKitRepo');

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

router.get('/inventory/returns', requireAuth, requireInventoryManager, async (req, res, next) => {
  try {
    const batches = await listOpenIssueBatches(req.session.user);
    res.render('inventory/returns', {
      currentUser: req.session.user,
      batches,
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (error) { next(error); }
});

router.get('/inventory/returns/:batchId', requireAuth, requireInventoryManager, async (req, res, next) => {
  try {
    const batch = await getIssueBatch(Number(req.params.batchId));
    if (!batch) return res.status(404).render('errors/404', { title: 'Issue batch not found' });
    if (!await canAccessIssueBatch(req.session.user, batch)) return res.status(403).send('Forbidden');
    res.render('inventory/batch-receive', { currentUser: req.session.user, batch, error: req.query.error || null, success: req.query.success || null });
  } catch (error) { next(error); }
});

router.post('/inventory/returns/:batchId/scan', requireAuth, requireInventoryManager, async (req, res) => {
  const batchId = Number(req.params.batchId);
  try {
    const batch = await getIssueBatch(batchId);
    if (!await canAccessIssueBatch(req.session.user, batch)) throw new Error('You do not have access to this issue batch.');
    const result = await scanIssueBatchReturn({
      batchId,
      instanceCode: req.body.instanceCode,
      returnedBy: req.session.user.id,
      userRole: req.session.user.role,
      reason: req.body.reason
    });
    if (result.pending) {
      return res.redirect(`/inventory/returns/${batchId}?success=${encodeURIComponent(`${result.kitCode}: scanned ${result.scannedCount} of ${result.expectedCount}; scan the remaining kit instances to receive the kit.`)}`);
    }
    await logAudit({
      userId: req.session.user.id,
      action: 'INVENTORY_RETURN',
      entity: 'inventory_issue_batch',
      entityId: batchId,
      details: { kitCode: result.kitCode || null, instanceCode: result.instanceCode || null, instanceCodes: result.returned?.map(item => item.instanceCode) || null, scanned: true },
      ip: req.ip,
      userAgent: req.get('user-agent')
    });
    const message = result.kitCode ? `Kit ${result.kitCode} and all its instances received.` : `Received ${result.instanceCode}.`;
    return res.redirect(`/inventory/returns/${batchId}?success=${encodeURIComponent(message)}`);
  } catch (error) {
    return res.redirect(`/inventory/returns/${batchId}?error=${encodeURIComponent(error.message || 'Failed to receive inventory.')}`);
  }
});

router.get('/inventory/issue-batches/new', requireAuth, requireInventoryManager, async (req, res, next) => {
  try {
    const kits = await listKits();
    res.render('inventory/batch-new', { currentUser: req.session.user, kits, error: req.query.error || null });
  } catch (error) { next(error); }
});

router.post('/inventory/issue-batches', requireAuth, requireInventoryManager, async (req, res) => {
  try {
    const allowed = ['PROJECT','EMPLOYEE','DEPARTMENT','OTHER'];
    if (!allowed.includes(req.body.recipientType)) throw new Error('Choose a valid recipient type.');
    if (!String(req.body.recipientReference || '').trim()) throw new Error('Enter the recipient name or reference.');
    const batchId = await createIssueBatch({
      recipientType: req.body.recipientType,
      recipientReference: req.body.recipientReference,
      reason: req.body.reason,
      issuedBy: req.session.user.id,
      kitIds: req.body.kitIds || []
    });
    res.redirect(`/inventory/issue-batches/${batchId}`);
  } catch (error) { res.redirect('/inventory/issue-batches/new?error=' + encodeURIComponent(error.message)); }
});

router.get('/inventory/issue-batches/:batchId', requireAuth, requireInventoryManager, async (req, res, next) => {
  try {
    const batch = await getIssueBatch(Number(req.params.batchId));
    if (!batch) return res.status(404).render('errors/404', { title: 'Issue batch not found' });
    if (!await canAccessIssueBatch(req.session.user, batch)) return res.status(403).send('Forbidden');
    res.render('inventory/batch-issue', { currentUser: req.session.user, batch, error: req.query.error || null, success: req.query.success || null });
  } catch (error) { next(error); }
});

router.post('/inventory/issue-batches/:batchId/scan', requireAuth, requireInventoryManager, async (req, res) => {
  const batchId = Number(req.params.batchId);
  try {
    const batch = await getIssueBatch(batchId);
    if (!await canAccessIssueBatch(req.session.user, batch)) throw new Error('You do not have access to this issue batch.');
    const instance = await stageIssueBatchInstance({ batchId, instanceCode: req.body.instanceCode, scannedBy: req.session.user.id });
    res.redirect(`/inventory/issue-batches/${batchId}?success=` + encodeURIComponent(`Added ${instance.instance_code} to the pending issue list.`));
  } catch (error) { res.redirect(`/inventory/issue-batches/${batchId}?error=` + encodeURIComponent(error.message)); }
});

router.post('/inventory/issue-batches/:batchId/remove', requireAuth, requireInventoryManager, async (req, res) => {
  const batchId = Number(req.params.batchId);
  try {
    const batch = await getIssueBatch(batchId);
    if (!await canAccessIssueBatch(req.session.user, batch)) throw new Error('You do not have access to this issue batch.');
    await removeStagedIssueBatchInstance({ batchId, instanceId: Number(req.body.instanceId) });
    res.redirect(`/inventory/issue-batches/${batchId}?success=` + encodeURIComponent('Removed the instance from the pending list.'));
  } catch (error) { res.redirect(`/inventory/issue-batches/${batchId}?error=${encodeURIComponent(error.message)}`); }
});

router.post('/inventory/issue-batches/:batchId/finalize', requireAuth, requireInventoryManager, async (req, res) => {
  const batchId = Number(req.params.batchId);
  try {
    const batch = await getIssueBatch(batchId);
    if (!await canAccessIssueBatch(req.session.user, batch)) throw new Error('You do not have access to this issue batch.');
    const count = await finalizeIssueBatch({ batchId, issuedBy: req.session.user.id, userRole: req.session.user.role });
    const issued = await getIssueBatch(batchId);
    await logAudit({ userId: req.session.user.id, action: 'INVENTORY_ISSUE_BATCH', entity: 'inventory_issue_batch', entityId: batchId,
      details: { count, instanceCodes: issued.issues.map(item => item.instance_code), recipientType: issued.recipient_type, recipientReference: issued.recipient_reference },
      ip: req.ip, userAgent: req.get('user-agent') });
    res.redirect(`/inventory/issue-batches/${batchId}?success=` + encodeURIComponent(`Issued ${count} item(s) to ${issued.recipient_reference}.`));
  } catch (error) { res.redirect(`/inventory/issue-batches/${batchId}?error=${encodeURIComponent(error.message)}`); }
});

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

module.exports = router;
