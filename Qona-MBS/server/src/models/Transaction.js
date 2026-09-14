const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Transaction = sequelize.define('Transaction', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    fromAccountId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'accounts',
        key: 'id',
      },
    },
    toAccountId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'accounts',
        key: 'id',
      },
      comment: 'Null for external withdrawals',
    },
    transactionType: {
      type: DataTypes.ENUM(
        'DEPOSIT',
        'WITHDRAWAL',
        'TRANSFER',
        'LOAN_DISBURSEMENT',
        'LOAN_REPAYMENT',
        'BILL_PAYMENT',
        'AIRTIME_PURCHASE',
        'DATA_PURCHASE',
        'DIVIDEND_PAYOUT',
        'INTEREST_ACCRUAL',
        'FEE_DEDUCTION',
        'REVERSAL',
      ),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      validate: {
        min: 0.01,
      },
    },
    currency: {
      type: DataTypes.STRING(3),
      defaultValue: 'KES',
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    referenceNumber: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
      comment: 'Unique transaction reference for tracking',
    },
    externalReference: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'M-Pesa txn ID, bank reference, etc.',
    },
    channel: {
      type: DataTypes.ENUM(
        'MOBILE_APP',
        'USSD',
        'BRANCH',
        'ATM',
        'WHATSAPP',
        'WEB',
      ),
      defaultValue: 'MOBILE_APP',
    },
    status: {
      type: DataTypes.ENUM(
        'PENDING',
        'SUCCESS',
        'FAILED',
        'REVERSED',
        'DISPUTED',
      ),
      defaultValue: 'PENDING',
    },
    balanceAfter: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: true,
      comment: 'Account balance after transaction',
    },
    fee: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Additional transaction data (charges, notes, etc.)',
    },
    failureReason: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Reason if transaction failed',
    },
    reversalTransactionId: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'Links to reversal transaction if applicable',
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
    tableName: 'transactions',
    timestamps: true,
  });

  return Transaction;
};
