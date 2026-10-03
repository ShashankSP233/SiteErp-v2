const express = require('express');

const dashboardRepo = require('../repositories/dashboardRepo');
const { listMovementsForUser } = require('../repositories/inventoryMovementRepo');
const { listTransfersForUser } = require('../repositories/stockTransferRepo');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get(
  '/',
  requireAuth,
  async (req, res, next) => {
    try {
      const user = req.session.user;
      const [stats, siteSummaries, recentMovements, transfers] = await Promise.all([
        dashboardRepo.getDashboardStats(user),
        ['admin', 'manager'].includes(user.role)
          ? dashboardRepo.getSiteInventorySummaries(user)
          : Promise.resolve([]),
        listMovementsForUser(user),
        listTransfersForUser(user)
      ]);

      res.render('dashboard', {
        title: 'Dashboard',
        stats,
        siteSummaries,
        recentMovements: recentMovements.slice(0, 6),
        recentTransfers: transfers.slice(0, 6),
        pendingTransferCount: transfers.filter(transfer => ['IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(transfer.status)).length
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
