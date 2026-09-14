const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Account = sequelize.define('Account', {
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
    accountNumber: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: true,
      },
    },
    accountType: {
      type: DataTypes.ENUM(
        'BOSA',         // Basic Operating Savings Account
        'SAVINGS',      // Savings Account
        'SHARE_CAPITAL', // Share Capital Account
        'DIVIDEND',     // Dividend Account
        'LOAN',         // Loan Account
      ),
      allowNull: false,
    },
    balance: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      defaultValue: 0,
      validate: {
        min: 0,
      },
    },
    currency: {
      type: DataTypes.STRING(3),
      defaultValue: 'KES',
      validate: {
        len: [3, 3],
      },
    },
    accountState: {
      type: DataTypes.ENUM('ACTIVE', 'INACTIVE', 'FROZEN', 'CLOSED'),
      defaultValue: 'ACTIVE',
      allowNull: false,
    },
    interestRate: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
      comment: 'Annual interest rate percentage',
    },
    lastDepositDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    lastWithdrawalDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    overdraftLimit: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
      comment: 'Allowed overdraft amount',
    },
    monthlyBudget: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: true,
      comment: 'Optional monthly spending budget',
    },
    isLinked: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Is this account linked for automated transfers',
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
    tableName: 'accounts',
    timestamps: true,
  });

  return Account;
};
