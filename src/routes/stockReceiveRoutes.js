const express = require('express');

const {
  listIncomingTransfersForUser
} = require('../repositories/stockTransferRepo');

const {
  requireAuth
} = require('../middleware/auth');

const router = express.Router();


router.get(
  '/inventory/stock-receive',
  requireAuth,
  async (req, res, next) => {

    try {

      const transfers =
        await listIncomingTransfersForUser(
          req.session.user
        );

      res.render(
        'inventory/stock-receive',
        {
          title: 'Stock Receive',
          transfers
        }
      );

    } catch (error) {
      next(error);
    }

  }
);


module.exports = router;