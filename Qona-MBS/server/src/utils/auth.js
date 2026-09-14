const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// ===== JWT Token Management =====

/**
 * Generate JWT access token (expires in 24 hours)
 */
const generateAccessToken = (memberId, role = 'MEMBER') => {
  return jwt.sign(
    {
      memberId,
      role,
      type: 'access',
    },
    process.env.JWT_SECRET || 'your-secret-key-change-in-production',
    {
      expiresIn: process.env.JWT_EXPIRE || '24h',
    }
  );
};

/**
 * Generate JWT refresh token (expires in 7 days)
 */
const generateRefreshToken = (memberId) => {
  return jwt.sign(
    {
      memberId,
      type: 'refresh',
    },
    process.env.JWT_REFRESH_SECRET || 'your-refresh-secret-key-change-in-production',
    {
      expiresIn: process.env.JWT_REFRESH_EXPIRE || '7d',
    }
  );
};

/**
 * Verify JWT token
 */
const verifyToken = (token, type = 'access') => {
  try {
    const secret =
      type === 'access'
        ? process.env.JWT_SECRET || 'your-secret-key-change-in-production'
        : process.env.JWT_REFRESH_SECRET || 'your-refresh-secret-key-change-in-production';

    return jwt.verify(token, secret);
  } catch (error) {
    return null;
  }
};

/**
 * Decode token without verification (for debugging)
 */
const decodeToken = (token) => {
  try {
    return jwt.decode(token);
  } catch (error) {
    return null;
  }
};

// ===== PIN/Password Management =====

/**
 * Hash PIN (bcrypt)
 */
const hashPin = async (pin) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(pin, salt);
};

/**
 * Compare PIN with hash
 */
const comparePin = async (pin, hash) => {
  return bcrypt.compare(pin, hash);
};

// ===== OTP Management =====

/**
 * Generate OTP (6-digit code)
 */
const generateOTP = () => {
  const length = parseInt(process.env.OTP_LENGTH || 6);
  return Math.floor(Math.random() * Math.pow(10, length))
    .toString()
    .padStart(length, '0');
};

/**
 * Generate OTP with expiry metadata
 */
const generateOTPWithMetadata = () => {
  const otp = generateOTP();
  const expiryMs = parseInt(process.env.OTP_EXPIRE || 300000); // 5 minutes
  const expiresAt = new Date(Date.now() + expiryMs);

  return {
    otp,
    expiresAt,
    attempts: 0,
    maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS || 3),
  };
};

/**
 * Validate OTP
 */
const validateOTP = (storedOtpData, providedOtp) => {
  if (!storedOtpData) {
    return { valid: false, reason: 'OTP_NOT_FOUND' };
  }

  if (new Date() > storedOtpData.expiresAt) {
    return { valid: false, reason: 'OTP_EXPIRED' };
  }

  if (storedOtpData.attempts >= storedOtpData.maxAttempts) {
    return { valid: false, reason: 'MAX_ATTEMPTS_EXCEEDED' };
  }

  if (storedOtpData.otp !== providedOtp) {
    return { valid: false, reason: 'INVALID_OTP' };
  }

  return { valid: true };
};

// ===== Device Binding & Security =====

/**
 * Generate device identifier from IMEI/IMSI
 */
const generateDeviceId = (imei, imsi) => {
  if (!imei && !imsi) {
    return crypto.randomBytes(32).toString('hex');
  }

  const combined = `${imei || ''}-${imsi || ''}`;
  return crypto.createHash('sha256').update(combined).digest('hex');
};

/**
 * Generate session token (different from JWT)
 */
const generateSessionToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

// ===== Reference Numbers =====

/**
 * Generate unique transaction reference number
 * Format: TXN-YYYYMMDD-XXXXXX (TXN-20260512-A1B2C3)
 */
const generateTransactionReference = () => {
  const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const randomPart = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `TXN-${date}-${randomPart}`;
};

/**
 * Generate unique OTP reference
 */
const generateOTPReference = () => {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
};

// ===== Validation Helpers =====

/**
 * Validate PIN format (4-6 digits)
 */
const isValidPinFormat = (pin) => {
  return /^\d{4,6}$/.test(pin);
};

/**
 * Validate phone number (Kenya format)
 * Accepts: 254712345678, 0712345678, +254712345678
 */
const isValidPhoneNumber = (phone) => {
  // Remove non-digit characters except +
  const cleaned = phone.replace(/[^\d+]/g, '');

  // Should be 10-13 digits
  return /^\+?254\d{9}$|^0\d{9}$/.test(cleaned);
};

/**
 * Normalize phone number to internal format (254712345678)
 */
const normalizePhoneNumber = (phone) => {
  let normalized = phone.replace(/[^\d+]/g, '');

  if (normalized.startsWith('+254')) {
    return normalized.substring(1); // Remove +
  }

  if (normalized.startsWith('254')) {
    return normalized;
  }

  if (normalized.startsWith('0')) {
    return '254' + normalized.substring(1);
  }

  return null;
};

/**
 * Validate email format
 */
const isValidEmail = (email) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

/**
 * Validate ID number format (Kenya)
 * 6-8 digits
 */
const isValidIdNumber = (idNumber) => {
  return /^\d{6,8}$/.test(idNumber);
};

/**
 * Generate random password (for temporary use)
 */
const generateTemporaryPassword = (length = 12) => {
  const charset =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return password;
};

module.exports = {
  // JWT
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
  decodeToken,
  // PIN
  hashPin,
  comparePin,
  // OTP
  generateOTP,
  generateOTPWithMetadata,
  validateOTP,
  generateOTPReference,
  // Device & Security
  generateDeviceId,
  generateSessionToken,
  // References
  generateTransactionReference,
  // Validation
  isValidPinFormat,
  isValidPhoneNumber,
  normalizePhoneNumber,
  isValidEmail,
  isValidIdNumber,
  generateTemporaryPassword,
};
