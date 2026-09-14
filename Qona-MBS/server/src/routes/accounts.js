const express = require('express');
const router = express.Router();
const AccountController = require('../controllers/AccountController');
const { verifyJWT, loadMember, isStaff } = require('../middleware/auth');

// List all accounts for member
router.get(
  '/',
  verifyJWT,
  loadMember,
  AccountController.listAccounts
);

// Get account balance only
router.get(
  '/:id/balance',
  verifyJWT,
  loadMember,
  AccountController.getBalance
);

// Get mini-statement (last 10 transactions)
router.get(
  '/:id/statement',
  verifyJWT,
  loadMember,
  AccountController.getMiniStatement
);

// Get paginated transaction history
router.get(
  '/:id/transactions',
  verifyJWT,
  loadMember,
  AccountController.getTransactionHistory
);

// Export statement
router.post(
  '/:id/statement/export',
  verifyJWT,
  loadMember,
  AccountController.exportStatement
);

// Get single account details
router.get(
  '/:id',
  verifyJWT,
  loadMember,
  AccountController.getAccount
);

// Freeze account (staff only)
router.post(
  '/:id/freeze',
  verifyJWT,
  isStaff,
  AccountController.freezeAccount
);

module.exports = router;
