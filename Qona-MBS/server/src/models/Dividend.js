const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Dividend = sequelize.define('Dividend', {
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
    accountId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'accounts',
        key: 'id',
      },
    },
    dividendYear: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    dividendPeriod: {
      type: DataTypes.STRING(20),
      allowNull: false,
      comment: 'E.g., Q1, Q2, H1, Annual',
    },
    declaredDate: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    paymentDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    amount: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      validate: {
        min: 0.01,
      },
    },
    status: {
      type: DataTypes.ENUM(
        'DECLARED',
        'APPROVED',
        'PAID_TO_ACCOUNT',
        'WITHDRAWN',
        'CAPITALIZED_TO_SHARES',
      ),
      defaultValue: 'DECLARED',
    },
    disbursementMethod: {
      type: DataTypes.ENUM(
        'ACCOUNT',           // To BOSA/Savings account
        'WITHDRAWAL',        // Cash withdrawal
        'SHARES',            // Capitalized to shares
        'DIVIDEND',          // To dividend account
      ),
      allowNull: true,
    },
    transactionId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'transactions',
        key: 'id',
      },
    },
    sharesCreditedQuantity: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Number of shares created if capitalized',
    },
    sharesPurchasePrice: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      comment: 'Price per share if capitalized',
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    processedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'Staff member who processed',
    },
    processedDate: {
      type: DataTypes.DATE,
      allowNull: true,
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
    tableName: 'dividends',
    timestamps: true,
  });

  return Dividend;
};
