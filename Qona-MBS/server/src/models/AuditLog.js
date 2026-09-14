const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const AuditLog = sequelize.define('AuditLog', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    action: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: 'CREATE, UPDATE, DELETE, LOGIN, APPROVE, REJECT, TRANSFER, etc.',
    },
    entityType: {
      type: DataTypes.STRING(50),
      allowNull: false,
      comment: 'LOAN, ACCOUNT, BENEFICIARY, TRANSACTION, MEMBER, etc.',
    },
    entityId: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'ID of the affected entity',
    },
    performedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'Member or staff member who performed action',
    },
    performedByRole: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'MEMBER, STAFF, ADMIN, SYSTEM',
    },
    changesJson: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Object tracking: {field: {oldValue, newValue}}',
    },
    statusBefore: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'Status before change',
    },
    statusAfter: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'Status after change',
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Human-readable description of action',
    },
    ipAddress: {
      type: DataTypes.STRING(45),
      allowNull: true,
      comment: 'IPv4 or IPv6 address',
    },
    userAgent: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Browser/app user agent',
    },
    deviceInfo: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Device identifier (IMEI, user agent hash)',
    },
    channel: {
      type: DataTypes.ENUM(
        'MOBILE_APP',
        'WEB',
        'USSD',
        'WHATSAPP',
        'BRANCH',
        'API',
        'SYSTEM',
      ),
      defaultValue: 'API',
    },
    result: {
      type: DataTypes.ENUM('SUCCESS', 'FAILURE'),
      defaultValue: 'SUCCESS',
    },
    errorMessage: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'If result is FAILURE',
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Additional context data',
    },
    timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When action occurred (immutable)',
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'audit_logs',
    timestamps: false, // Immutable, no updates
  });

  return AuditLog;
};
