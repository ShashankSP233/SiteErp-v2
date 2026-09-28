const express = require('express');

const {
  MOVEMENT_TYPES,
  listAccessibleSites,
  listMovementsForUser
} = require('../repositories/inventoryMovementRepo');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }

  next();
}

router.get(
  '/inventory/movements',
  requireAuth,
  async (req, res, next) => {
    try {
      const filters = {
        instanceCode: req.query.instanceCode || '',
        movementType: req.query.movementType || '',
        siteId: req.query.siteId || '',
        dateFrom: req.query.dateFrom || '',
        dateTo: req.query.dateTo || ''
      };

      const [
        movements,
        sites
      ] = await Promise.all([
        listMovementsForUser(
          req.session.user,
          filters
        ),

        listAccessibleSites(
          req.session.user
        )
      ]);

      res.render(
        'inventory/movements',
        {
          title: 'Inventory Movement Ledger',

          currentUser:
            req.session.user,

          movements,
          sites,
          movementTypes:
            MOVEMENT_TYPES,

          filters,

          error: null
        }
      );

    } catch (error) {

      console.error(
        'Failed to load inventory movement ledger:',
        error
      );

      try {
        const sites =
          await listAccessibleSites(
            req.session.user
          );

        return res.status(500).render(
          'inventory/movements',
          {
            title:
              'Inventory Movement Ledger',

            currentUser:
              req.session.user,

            movements: [],
            sites,

            movementTypes:
              MOVEMENT_TYPES,

            filters:
              req.query,

            error:
              error.message ||
              'Failed to load inventory movements.'
          }
        );

      } catch (renderError) {
        return next(renderError);
      }
    }
  }
);

module.exports = router;