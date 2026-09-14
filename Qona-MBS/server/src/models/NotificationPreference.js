const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const NotificationPreference = sequelize.define('NotificationPreference', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    memberId: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
      references: {
        model: 'members',
        key: 'id',
      },
    },
    // Channel preferences
    smsEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    emailEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    pushEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    inAppEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    whatsappEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },

    // Category preferences
    transactionAlerts: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      comment: 'Notify on deposits, withdrawals, transfers',
    },
    loanUpdates: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      comment: 'Notify on loan approval, repayment, arrears',
    },
    shareMarketUpdates: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      comment: 'Notify on share price changes, trading',
    },
    dividendNotices: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      comment: 'Notify on dividend declarations, payments',
    },
    accountAlerts: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      comment: 'Low balance, account freezing, etc.',
    },
    securityAlerts: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      comment: 'Login from new device, failed auth, etc.',
    },
    promotions: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Marketing and promotional messages',
    },
    weeklyDigest: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      comment: 'Weekly activity summary',
    },

    // Quiet hours
    quietHoursEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    quietHoursStart: {
      type: DataTypes.STRING(5),
      allowNull: true,
      comment: 'HH:MM format, e.g., 21:00',
    },
    quietHoursEnd: {
      type: DataTypes.STRING(5),
      allowNull: true,
      comment: 'HH:MM format, e.g., 08:00',
    },

    // Contact preferences
    preferredPhoneNumber: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    preferredEmail: {
      type: DataTypes.STRING(150),
      allowNull: true,
    },

    lastModifiedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'notification_preferences',
    timestamps: true,
  });

  return NotificationPreference;
};
