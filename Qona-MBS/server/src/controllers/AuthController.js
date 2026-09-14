const { Member, NotificationPreference, Account, AuditLog } = require('../models');
const { Op } = require('sequelize');
const {
  generateAccessToken,
  generateRefreshToken,
  hashPin,
  comparePin,
  generateOTPWithMetadata,
  validateOTP,
  normalizePhoneNumber,
  isValidPhoneNumber,
  isValidPinFormat,
  isValidEmail,
  isValidIdNumber,
} = require('../utils/auth');
const { logAuditEvent } = require('../middleware/auth');

/**
 * Register new member
 * POST /api/auth/register
 */
const register = async (req, res) => {
  try {
    const { firstName, lastName, dateOfBirth, idNumber, mobilePhone, email, pin } = req.body;

    // Validate inputs
    if (!isValidIdNumber(idNumber)) {
      return res.status(400).json({ error: 'Invalid ID number format' });
    }

    if (!isValidPhoneNumber(mobilePhone)) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    if (!isValidPinFormat(pin)) {
      return res.status(400).json({
        error: 'PIN must be 4-6 digits',
      });
    }

    if (email && !isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Normalize phone number
    const normalizedPhone = normalizePhoneNumber(mobilePhone);

    // Check if member already exists
    const existingMember = await Member.findOne({
      where: {
        [Op.or]: [
          { mobilePhone: normalizedPhone },
          { idNumber },
        ],
      },
    });

    if (existingMember) {
      return res.status(409).json({
        error: 'Member with this phone or ID already exists',
      });
    }

    // Hash PIN
    const hashedPin = await hashPin(pin);

    // Create member
    const member = await Member.create({
      firstName,
      lastName,
      dateOfBirth,
      idNumber,
      mobilePhone: normalizedPhone,
      email: email || null,
      pin: hashedPin,
      status: 'ACTIVE',
      kycStatus: 'PENDING',
    });

    // Create default notification preferences
    await NotificationPreference.create({
      memberId: member.id,
    });

    // Create default BOSA account
    await Account.create({
      memberId: member.id,
      accountNumber: `BOSA-${member.id.substring(0, 8)}`,
      accountType: 'BOSA',
      balance: 0,
      accountState: 'ACTIVE',
    });

    // Log audit event
    await logAuditEvent({
      action: 'REGISTER',
      entityType: 'MEMBER',
      entityId: member.id,
      description: `New member registered: ${firstName} ${lastName}`,
      performedBy: member.id,
      performedByRole: 'MEMBER',
      ipAddress: req.ip,
      result: 'SUCCESS',
    });

    return res.status(201).json({
      message: 'Registration successful',
      memberId: member.id,
      member: {
        id: member.id,
        firstName: member.firstName,
        lastName: member.lastName,
        mobilePhone: member.mobilePhone,
        email: member.email,
        joinDate: member.joinDate,
      },
    });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ error: 'Registration failed' });
  }
};

/**
 * Login with phone and PIN
 * POST /api/auth/login
 */
const login = async (req, res) => {
  try {
    const { mobilePhone, pin } = req.body;

    if (!isValidPhoneNumber(mobilePhone)) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    if (!isValidPinFormat(pin)) {
      return res.status(400).json({ error: 'Invalid PIN format' });
    }

    // Normalize phone
    const normalizedPhone = normalizePhoneNumber(mobilePhone);

    // Find member
    const member = await Member.findOne({
      where: { mobilePhone: normalizedPhone },
    });

    if (!member) {
      await logAuditEvent({
        action: 'LOGIN',
        entityType: 'MEMBER',
        description: `Failed login attempt with phone ${normalizedPhone}`,
        ipAddress: req.ip,
        result: 'FAILURE',
        errorMessage: 'Member not found',
      });

      return res.status(401).json({ error: 'Invalid phone or PIN' });
    }

    // Check account status
    if (member.status !== 'ACTIVE') {
      return res.status(403).json({
        error: `Account is ${member.status.toLowerCase()}`,
      });
    }

    // Verify PIN
    const pinValid = await comparePin(pin, member.pin);

    if (!pinValid) {
      await logAuditEvent({
        action: 'LOGIN',
        entityType: 'MEMBER',
        entityId: member.id,
        description: `Failed login attempt`,
        performedBy: member.id,
        ipAddress: req.ip,
        result: 'FAILURE',
        errorMessage: 'Invalid PIN',
      });

      return res.status(401).json({ error: 'Invalid phone or PIN' });
    }

    // Check if 2FA is enabled
    if (member.twoFactorEnabled) {
      // Send OTP instead of returning tokens
      const otpData = generateOTPWithMetadata();

      // TODO: Store OTP in Redis with expiry
      // For now, return message to request OTP verification

      return res.status(200).json({
        message: 'OTP sent to your phone',
        requiresOTP: true,
        sessionToken: null, // Would be temporary session for OTP verification
      });
    }

    // Generate tokens
    const accessToken = generateAccessToken(member.id, 'MEMBER');
    const refreshToken = generateRefreshToken(member.id);

    // Update last login
    member.lastLoginDate = new Date();
    await member.save();

    await logAuditEvent({
      action: 'LOGIN',
      entityType: 'MEMBER',
      entityId: member.id,
      description: `Member logged in`,
      performedBy: member.id,
      ipAddress: req.ip,
      result: 'SUCCESS',
    });

    return res.status(200).json({
      message: 'Login successful',
      accessToken,
      refreshToken,
      member: {
        id: member.id,
        firstName: member.firstName,
        lastName: member.lastName,
        mobilePhone: member.mobilePhone,
        kycStatus: member.kycStatus,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Login failed' });
  }
};

/**
 * Request OTP for verification
 * POST /api/auth/request-otp
 */
const requestOTP = async (req, res) => {
  try {
    const { mobilePhone, purpose } = req.body;

    if (!isValidPhoneNumber(mobilePhone)) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    const normalizedPhone = normalizePhoneNumber(mobilePhone);

    const member = await Member.findOne({
      where: { mobilePhone: normalizedPhone },
    });

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Generate OTP
    const otpData = generateOTPWithMetadata();

    // TODO: Store OTP in Redis
    // For now, return OTP (in production, send via SMS)

    console.log(`OTP for ${normalizedPhone}: ${otpData.otp}`);

    return res.status(200).json({
      message: 'OTP sent to your phone',
      expiresIn: '5 minutes',
      // In production, don't return OTP in response
      otp: process.env.NODE_ENV === 'development' ? otpData.otp : undefined,
    });
  } catch (error) {
    console.error('OTP request error:', error);
    return res.status(500).json({ error: 'Failed to send OTP' });
  }
};

/**
 * Verify OTP
 * POST /api/auth/verify-otp
 */
const verifyOTP = async (req, res) => {
  try {
    const { mobilePhone, otp } = req.body;

    if (!isValidPhoneNumber(mobilePhone)) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    if (!otp || otp.length !== 6) {
      return res.status(400).json({ error: 'Invalid OTP format' });
    }

    const normalizedPhone = normalizePhoneNumber(mobilePhone);

    // TODO: Retrieve OTP from Redis
    // For now, mock validation
    const storedOtpData = {
      otp: '123456',
      expiresAt: new Date(Date.now() + 300000),
      attempts: 0,
      maxAttempts: 3,
    };

    const validation = validateOTP(storedOtpData, otp);

    if (!validation.valid) {
      return res.status(400).json({ error: validation.reason });
    }

    const member = await Member.findOne({
      where: { mobilePhone: normalizedPhone },
    });

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Generate tokens
    const accessToken = generateAccessToken(member.id, 'MEMBER');
    const refreshToken = generateRefreshToken(member.id);

    return res.status(200).json({
      message: 'OTP verified',
      accessToken,
      refreshToken,
      member: {
        id: member.id,
        firstName: member.firstName,
        lastName: member.lastName,
      },
    });
  } catch (error) {
    console.error('OTP verification error:', error);
    return res.status(500).json({ error: 'OTP verification failed' });
  }
};

/**
 * Refresh access token
 * POST /api/auth/refresh-token
 */
const refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    // In production, verify the refresh token and check if it's blacklisted

    // For now, just generate new access token
    // In real implementation, decode refreshToken first
    const newAccessToken = generateAccessToken(req.user.memberId, 'MEMBER');

    return res.status(200).json({
      accessToken: newAccessToken,
    });
  } catch (error) {
    console.error('Token refresh error:', error);
    return res.status(500).json({ error: 'Token refresh failed' });
  }
};

/**
 * Logout (invalidate tokens)
 * POST /api/auth/logout
 */
const logout = async (req, res) => {
  try {
    if (!req.user || !req.user.memberId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // TODO: Blacklist token in Redis

    await logAuditEvent({
      action: 'LOGOUT',
      entityType: 'MEMBER',
      entityId: req.user.memberId,
      description: 'Member logged out',
      performedBy: req.user.memberId,
      ipAddress: req.ip,
      result: 'SUCCESS',
    });

    return res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    return res.status(500).json({ error: 'Logout failed' });
  }
};

/**
 * Get current user profile
 * GET /api/auth/me
 */
const getCurrentUser = async (req, res) => {
  try {
    if (!req.user || !req.user.memberId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const member = await Member.findByPk(req.user.memberId, {
      attributes: [
        'id',
        'firstName',
        'lastName',
        'dateOfBirth',
        'mobilePhone',
        'email',
        'status',
        'kycStatus',
        'joinDate',
        'lastLoginDate',
        'twoFactorEnabled',
        'biometricEnabled',
      ],
    });

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    return res.status(200).json({
      member,
    });
  } catch (error) {
    console.error('Get current user error:', error);
    return res.status(500).json({ error: 'Failed to get user profile' });
  }
};

/**
 * Reset PIN
 * POST /api/auth/reset-pin
 */
const resetPin = async (req, res) => {
  try {
    const { mobilePhone, otp, newPin } = req.body;

    // Validate inputs
    if (!isValidPhoneNumber(mobilePhone)) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    if (!otp || otp.length !== 6) {
      return res.status(400).json({ error: 'Invalid OTP format' });
    }

    if (!isValidPinFormat(newPin)) {
      return res.status(400).json({ error: 'PIN must be 4-6 digits' });
    }

    const normalizedPhone = normalizePhoneNumber(mobilePhone);

    // TODO: Verify OTP from Redis

    const member = await Member.findOne({
      where: { mobilePhone: normalizedPhone },
    });

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Hash new PIN
    const hashedPin = await hashPin(newPin);

    member.pin = hashedPin;
    await member.save();

    await logAuditEvent({
      action: 'RESET_PIN',
      entityType: 'MEMBER',
      entityId: member.id,
      description: 'Member reset PIN',
      performedBy: member.id,
      ipAddress: req.ip,
      result: 'SUCCESS',
    });

    return res.status(200).json({ message: 'PIN reset successfully' });
  } catch (error) {
    console.error('PIN reset error:', error);
    return res.status(500).json({ error: 'PIN reset failed' });
  }
};

module.exports = {
  register,
  login,
  requestOTP,
  verifyOTP,
  refreshToken,
  logout,
  getCurrentUser,
  resetPin,
};
