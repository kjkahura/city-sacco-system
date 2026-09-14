const express = require('express');
const router = express.Router();
const TransactionController = require('../controllers/TransactionController');
const { verifyJWT, loadMember } = require('../middleware/auth');

// Transaction stats (MUST be before /:id route)
router.get(
  '/stats',
  verifyJWT,
  loadMember,
  TransactionController.getStats
);

// Transaction limits (MUST be before /:id route)
router.get(
  '/limits',
  verifyJWT,
  loadMember,
  TransactionController.getLimits
);

// Get transaction receipt
router.get(
  '/:id/receipt',
  verifyJWT,
  loadMember,
  TransactionController.getReceipt
);

// Dispute transaction
router.post(
  '/:id/dispute',
  verifyJWT,
  loadMember,
  TransactionController.disputeTransaction
);

// Get single transaction
router.get(
  '/:id',
  verifyJWT,
  loadMember,
  TransactionController.getTransaction
);

module.exports = router;
