const express = require('express');
const router = express.Router();

const AuthController = require('../controllers/AuthController');
const { verifyJWT, loginRateLimit, loadMember } = require('../middleware/auth');

/**
 * Public Routes (no authentication required)
 */

/**
 * POST /api/auth/register
 * Register new member
 * Body: { firstName, lastName, dateOfBirth, idNumber, mobilePhone, email, pin }
 */
router.post('/register', AuthController.register);

/**
 * POST /api/auth/login
 * Login with phone and PIN
 * Body: { mobilePhone, pin }
 */
router.post('/login', loginRateLimit, AuthController.login);

/**
 * POST /api/auth/request-otp
 * Request OTP for 2FA or password reset
 * Body: { mobilePhone, purpose }
 */
router.post('/request-otp', AuthController.requestOTP);

/**
 * POST /api/auth/verify-otp
 * Verify OTP and get tokens
 * Body: { mobilePhone, otp }
 */
router.post('/verify-otp', AuthController.verifyOTP);

/**
 * POST /api/auth/reset-pin
 * Reset PIN with OTP
 * Body: { mobilePhone, otp, newPin }
 */
router.post('/reset-pin', AuthController.resetPin);

/**
 * Protected Routes (authentication required)
 */

/**
 * POST /api/auth/refresh-token
 * Refresh access token
 * Headers: Authorization: Bearer <refreshToken>
 * Body: { refreshToken }
 */
router.post('/refresh-token', verifyJWT, AuthController.refreshToken);

/**
 * POST /api/auth/logout
 * Logout and invalidate tokens
 * Headers: Authorization: Bearer <accessToken>
 */
router.post('/logout', verifyJWT, AuthController.logout);

/**
 * GET /api/auth/me
 * Get current user profile
 * Headers: Authorization: Bearer <accessToken>
 */
router.get('/me', verifyJWT, loadMember, AuthController.getCurrentUser);

module.exports = router;
