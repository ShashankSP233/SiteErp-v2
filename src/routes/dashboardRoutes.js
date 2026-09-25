const express = require('express');

const dashboardRepo = require('../repositories/dashboardRepo');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get(
  '/',
  requireAuth,
  async (req, res, next) => {
    try {
      const stats = await dashboardRepo.getDashboardStats();

      res.render('dashboard', {
        title: 'Dashboard',
        stats
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;