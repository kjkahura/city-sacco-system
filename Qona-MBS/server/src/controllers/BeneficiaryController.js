const { Beneficiary, Member, Account } = require('../models');
const { logAuditEvent } = require('../middleware/auth');
const { normalizePhoneNumber } = require('../utils/auth');

/**
 * List all beneficiaries for member
 * GET /api/beneficiaries
 */
const listBeneficiaries = async (req, res) => {
  try {
    const beneficiaries = await Beneficiary.findAll({
      where: {
        memberId: req.member.id,
        isActive: true,
      },
      attributes: ['id', 'name', 'accountNumber', 'mobilePhone', 'relationship', 'isVerified', 'dailyLimit', 'createdAt'],
      order: [['createdAt', 'DESC']],
    });

    return res.status(200).json({
      message: 'Beneficiaries retrieved successfully',
      beneficiaries,
    });
  } catch (error) {
    console.error('List beneficiaries error:', error);
    return res.status(500).json({ error: 'Failed to retrieve beneficiaries' });
  }
};

/**
 * Add beneficiary
 * POST /api/beneficiaries
 * Body: { name, accountNumber, mobilePhone, relationship, dailyLimit }
 */
const addBeneficiary = async (req, res) => {
  try {
    const { name, accountNumber, mobilePhone, relationship, dailyLimit } = req.body;

    // Validate input
    if (!name) {
      return res.status(400).json({ error: 'Beneficiary name required' });
    }

    if (!accountNumber && !mobilePhone) {
      return res.status(400).json({ error: 'Account number or mobile phone required' });
    }

    // Normalize phone if provided
    let normalizedPhone = null;
    if (mobilePhone) {
      normalizedPhone = normalizePhoneNumber(mobilePhone);
    }

    // Create beneficiary
    const beneficiary = await Beneficiary.create({
      memberId: req.member.id,
      name,
      accountNumber: accountNumber || null,
      mobilePhone: normalizedPhone,
      relationship: relationship || 'Other',
      dailyLimit: dailyLimit || null,
      isVerified: false, // Require OTP verification
      isActive: true,
    });

    await logAuditEvent({
      action: 'ADD_BENEFICIARY',
      entityType: 'BENEFICIARY',
      entityId: beneficiary.id,
      description: `Added beneficiary: ${name}`,
      performedBy: req.member.id,
      performedByRole: 'MEMBER',
      ipAddress: req.ip,
      result: 'SUCCESS',
    });

    return res.status(201).json({
      message: 'Beneficiary added successfully',
      beneficiary: {
        id: beneficiary.id,
        name: beneficiary.name,
        accountNumber: beneficiary.accountNumber,
        mobilePhone: beneficiary.mobilePhone,
        relationship: beneficiary.relationship,
        isVerified: beneficiary.isVerified,
        dailyLimit: beneficiary.dailyLimit,
      },
    });
  } catch (error) {
    console.error('Add beneficiary error:', error);
    return res.status(500).json({ error: 'Failed to add beneficiary' });
  }
};

/**
 * Get single beneficiary
 * GET /api/beneficiaries/:id
 */
const getBeneficiary = async (req, res) => {
  try {
    const { id } = req.params;

    const beneficiary = await Beneficiary.findByPk(id);

    if (!beneficiary) {
      return res.status(404).json({ error: 'Beneficiary not found' });
    }

    // Verify ownership
    if (beneficiary.memberId !== req.member.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    return res.status(200).json({
      message: 'Beneficiary retrieved successfully',
      beneficiary: {
        id: beneficiary.id,
        name: beneficiary.name,
        accountNumber: beneficiary.accountNumber,
        mobilePhone: beneficiary.mobilePhone,
        relationship: beneficiary.relationship,
        isVerified: beneficiary.isVerified,
        dailyLimit: beneficiary.dailyLimit,
        isActive: beneficiary.isActive,
        createdAt: beneficiary.createdAt,
      },
    });
  } catch (error) {
    console.error('Get beneficiary error:', error);
    return res.status(500).json({ error: 'Failed to retrieve beneficiary' });
  }
};

/**
 * Update beneficiary
 * PUT /api/beneficiaries/:id
 * Body: { name, relationship, dailyLimit }
 */
const updateBeneficiary = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, relationship, dailyLimit } = req.body;

    const beneficiary = await Beneficiary.findByPk(id);

    if (!beneficiary) {
      return res.status(404).json({ error: 'Beneficiary not found' });
    }

    // Verify ownership
    if (beneficiary.memberId !== req.member.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Update fields
    if (name) beneficiary.name = name;
    if (relationship) beneficiary.relationship = relationship;
    if (dailyLimit !== undefined) beneficiary.dailyLimit = dailyLimit;

    await beneficiary.save();

    await logAuditEvent({
      action: 'UPDATE_BENEFICIARY',
      entityType: 'BENEFICIARY',
      entityId: beneficiary.id,
      description: `Updated beneficiary: ${beneficiary.name}`,
      performedBy: req.member.id,
      performedByRole: 'MEMBER',
      ipAddress: req.ip,
      result: 'SUCCESS',
    });

    return res.status(200).json({
      message: 'Beneficiary updated successfully',
      beneficiary: {
        id: beneficiary.id,
        name: beneficiary.name,
        accountNumber: beneficiary.accountNumber,
        mobilePhone: beneficiary.mobilePhone,
        relationship: beneficiary.relationship,
        isVerified: beneficiary.isVerified,
        dailyLimit: beneficiary.dailyLimit,
      },
    });
  } catch (error) {
    console.error('Update beneficiary error:', error);
    return res.status(500).json({ error: 'Failed to update beneficiary' });
  }
};

/**
 * Delete beneficiary (soft delete)
 * DELETE /api/beneficiaries/:id
 */
const deleteBeneficiary = async (req, res) => {
  try {
    const { id } = req.params;

    const beneficiary = await Beneficiary.findByPk(id);

    if (!beneficiary) {
      return res.status(404).json({ error: 'Beneficiary not found' });
    }

    // Verify ownership
    if (beneficiary.memberId !== req.member.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Soft delete
    beneficiary.isActive = false;
    await beneficiary.save();

    await logAuditEvent({
      action: 'DELETE_BENEFICIARY',
      entityType: 'BENEFICIARY',
      entityId: beneficiary.id,
      description: `Deleted beneficiary: ${beneficiary.name}`,
      performedBy: req.member.id,
      performedByRole: 'MEMBER',
      ipAddress: req.ip,
      result: 'SUCCESS',
    });

    return res.status(200).json({
      message: 'Beneficiary deleted successfully',
      beneficiary: {
        id: beneficiary.id,
        name: beneficiary.name,
        isActive: beneficiary.isActive,
      },
    });
  } catch (error) {
    console.error('Delete beneficiary error:', error);
    return res.status(500).json({ error: 'Failed to delete beneficiary' });
  }
};

module.exports = {
  listBeneficiaries,
  addBeneficiary,
  getBeneficiary,
  updateBeneficiary,
  deleteBeneficiary,
};
