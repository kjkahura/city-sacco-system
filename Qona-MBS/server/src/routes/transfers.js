const express = require('express');
const router = express.Router();
const TransferController = require('../controllers/TransferController');
const { verifyJWT, loadMember } = require('../middleware/auth');

// Lookup beneficiary for transfer
router.get(
  '/lookup',
  verifyJWT,
  loadMember,
  TransferController.getBeneficiaryForTransfer
);

// Transfer between own accounts
router.post(
  '/own',
  verifyJWT,
  loadMember,
  TransferController.ownAccountTransfer
);

// Transfer to another member
router.post(
  '/internal',
  verifyJWT,
  loadMember,
  TransferController.internalTransfer
);

module.exports = router;
