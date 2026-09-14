const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Beneficiary = sequelize.define('Beneficiary', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    memberId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'members',
        key: 'id',
      },
    },
    name: {
      type: DataTypes.STRING(150),
      allowNull: false,
      validate: {
        notEmpty: true,
      },
    },
    beneficiaryType: {
      type: DataTypes.ENUM(
        'INTERNAL_MEMBER',  // Another SACCO member
        'EXTERNAL_BANK',    // Bank account
        'MOBILE_MONEY',     // M-Pesa, Airtel Money
      ),
      allowNull: false,
    },
    // For internal members
    beneficiaryMemberId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'members',
        key: 'id',
      },
    },
    // For bank accounts
    bankName: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    bankCode: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },
    accountNumber: {
      type: DataTypes.STRING(50),
      allowNull: true,
      validate: {
        isNumeric: true,
      },
    },
    accountHolderName: {
      type: DataTypes.STRING(150),
      allowNull: true,
    },
    // For mobile money
    mobileNetwork: {
      type: DataTypes.ENUM(
        'SAFARICOM',
        'AIRTEL',
        'TELKOM',
      ),
      allowNull: true,
    },
    mobilePhoneNumber: {
      type: DataTypes.STRING(20),
      allowNull: true,
      validate: {
        isNumeric: true,
      },
    },
    relationship: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'E.g., spouse, child, parent, employer',
    },
    dailyLimit: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: true,
      comment: 'Optional daily transfer limit',
    },
    totalDailyAmount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
      comment: 'Total transferred today',
    },
    lastTransferDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    isVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    verificationDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    verificationMethod: {
      type: DataTypes.ENUM('OTP', 'MANUAL', 'THIRD_PARTY'),
      allowNull: true,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
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
    tableName: 'beneficiaries',
    timestamps: true,
  });

  return Beneficiary;
};
