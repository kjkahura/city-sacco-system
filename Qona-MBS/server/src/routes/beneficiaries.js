const express = require('express');
const router = express.Router();
const BeneficiaryController = require('../controllers/BeneficiaryController');
const { verifyJWT, loadMember } = require('../middleware/auth');

// List all beneficiaries
router.get(
  '/',
  verifyJWT,
  loadMember,
  BeneficiaryController.listBeneficiaries
);

// Add beneficiary
router.post(
  '/',
  verifyJWT,
  loadMember,
  BeneficiaryController.addBeneficiary
);

// Get single beneficiary
router.get(
  '/:id',
  verifyJWT,
  loadMember,
  BeneficiaryController.getBeneficiary
);

// Update beneficiary
router.put(
  '/:id',
  verifyJWT,
  loadMember,
  BeneficiaryController.updateBeneficiary
);

// Delete beneficiary
router.delete(
  '/:id',
  verifyJWT,
  loadMember,
  BeneficiaryController.deleteBeneficiary
);

module.exports = router;
