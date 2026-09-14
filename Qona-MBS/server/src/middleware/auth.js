const { verifyToken } = require('../utils/auth');
const { Member } = require('../models');

/**
 * Verify JWT token in Authorization header
 * Sets req.user if valid
 */
const verifyJWT = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    const decoded = verifyToken(token, 'access');

    if (!decoded) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token verification failed' });
  }
};

/**
 * Verify refresh token
 */
const verifyRefreshToken = (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    const decoded = verifyToken(refreshToken, 'refresh');

    if (!decoded) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token verification failed' });
  }
};

/**
 * Check if user is a member (not staff/admin)
 */
const isMember = (req, res, next) => {
  if (!req.user || req.user.role !== 'MEMBER') {
    return res.status(403).json({ error: 'Only members can access this' });
  }
  next();
};

/**
 * Check if user is staff or admin
 */
const isStaff = (req, res, next) => {
  if (!req.user || !['STAFF', 'ADMIN'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Staff access required' });
  }
  next();
};

/**
 * Check if user is admin
 */
const isAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

/**
 * Load full member data into req.member
 */
const loadMember = async (req, res, next) => {
  try {
    if (!req.user || !req.user.memberId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const member = await Member.findByPk(req.user.memberId);

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    if (member.status === 'CLOSED' || member.status === 'SUSPENDED') {
      return res.status(403).json({ error: 'Account is not active' });
    }

    req.member = member;
    next();
  } catch (error) {
    console.error('Error loading member:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Rate limiting middleware (basic in-memory)
 * Limits login attempts: 5 per 15 minutes
 */
const loginRateLimit = (() => {
  const attempts = {};

  return (req, res, next) => {
    const identifier = req.body.mobilePhone || req.ip;
    const now = Date.now();
    const windowMs = 15 * 60 * 1000; // 15 minutes

    if (!attempts[identifier]) {
      attempts[identifier] = [];
    }

    // Remove old attempts outside window
    attempts[identifier] = attempts[identifier].filter(
      (timestamp) => now - timestamp < windowMs
    );

    if (attempts[identifier].length >= 5) {
      return res.status(429).json({
        error: 'Too many login attempts. Try again later.',
      });
    }

    attempts[identifier].push(now);
    next();
  };
})();

/**
 * Validate request body schema
 */
const validateRequest = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const messages = error.details.map((d) => d.message).join(', ');
      return res.status(400).json({ error: messages });
    }

    req.body = value;
    next();
  };
};

/**
 * Audit log middleware
 * Logs all requests for compliance
 */
const auditLog = async (req, res, next) => {
  // Capture original send function
  const originalSend = res.send;

  res.send = function (data) {
    // Log after response is sent
    setImmediate(() => {
      logAuditEvent({
        action: req.method,
        entityType: 'API_REQUEST',
        description: `${req.method} ${req.path}`,
        performedBy: req.user?.memberId,
        performedByRole: req.user?.role || 'ANONYMOUS',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        channel: req.headers['x-channel'] || 'API',
        result: res.statusCode < 400 ? 'SUCCESS' : 'FAILURE',
        errorMessage: res.statusCode >= 400 ? data : null,
      });
    });

    return originalSend.call(this, data);
  };

  next();
};

/**
 * Helper to log audit events
 */
const logAuditEvent = async (eventData) => {
  try {
    const { AuditLog } = require('../models');

    await AuditLog.create({
      action: eventData.action,
      entityType: eventData.entityType,
      entityId: eventData.entityId,
      performedBy: eventData.performedBy,
      performedByRole: eventData.performedByRole,
      description: eventData.description,
      ipAddress: eventData.ipAddress,
      userAgent: eventData.userAgent,
      channel: eventData.channel,
      result: eventData.result,
      errorMessage: eventData.errorMessage,
    });
  } catch (error) {
    console.error('Failed to log audit event:', error);
  }
};

/**
 * Error handling middleware
 */
const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);

  // Sequelize validation error
  if (err.name === 'SequelizeValidationError') {
    return res.status(400).json({
      error: 'Validation error',
      details: err.errors.map((e) => e.message),
    });
  }

  // Sequelize unique constraint error
  if (err.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({
      error: 'Record already exists',
    });
  }

  // Default error
  return res.status(err.statusCode || 500).json({
    error: err.message || 'Internal server error',
  });
};

module.exports = {
  verifyJWT,
  verifyRefreshToken,
  isMember,
  isStaff,
  isAdmin,
  loadMember,
  loginRateLimit,
  validateRequest,
  auditLog,
  logAuditEvent,
  errorHandler,
};
