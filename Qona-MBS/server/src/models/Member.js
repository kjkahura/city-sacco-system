const { DataTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize) => {
  const Member = sequelize.define('Member', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    firstName: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: {
        notEmpty: true,
        len: [2, 100],
      },
    },
    lastName: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: {
        notEmpty: true,
        len: [2, 100],
      },
    },
    dateOfBirth: {
      type: DataTypes.DATE,
      allowNull: false,
      validate: {
        isDate: true,
        isBefore: new Date().toISOString(),
      },
    },
    idNumber: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: true,
      },
    },
    mobilePhone: {
      type: DataTypes.STRING(20),
      allowNull: false,
      unique: true,
      validate: {
        isNumeric: true,
        len: [10, 20],
      },
    },
    email: {
      type: DataTypes.STRING(150),
      allowNull: true,
      validate: {
        isEmail: true,
      },
    },
    nextOfKin: {
      type: DataTypes.STRING(150),
      allowNull: true,
    },
    address: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    pin: {
      type: DataTypes.STRING(255),
      allowNull: false,
      validate: {
        len: [60], // bcrypt hash length
      },
    },
    status: {
      type: DataTypes.ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED', 'CLOSED'),
      defaultValue: 'ACTIVE',
      allowNull: false,
    },
    kycStatus: {
      type: DataTypes.ENUM('PENDING', 'VERIFIED', 'REJECTED'),
      defaultValue: 'PENDING',
      allowNull: false,
    },
    joinDate: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    lastLoginDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    deviceId: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Device IMEI/IMSI for device binding',
    },
    imsi: {
      type: DataTypes.STRING(20),
      allowNull: true,
      comment: 'SIM IMSI for SIM-swap detection',
    },
    imei: {
      type: DataTypes.STRING(20),
      allowNull: true,
      comment: 'Device IMEI',
    },
    twoFactorEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    biometricEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    dailyTransactionLimit: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 500000, // KES
      comment: 'Daily transaction limit in local currency',
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    deletedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Soft delete timestamp',
    },
  }, {
    tableName: 'members',
    timestamps: true,
    paranoid: true, // Soft delete
  });

  return Member;
};
