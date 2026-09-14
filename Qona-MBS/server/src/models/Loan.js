const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Loan = sequelize.define('Loan', {
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
      comment: 'Loan account',
    },
    loanApplicationId: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'Reference to loan application',
    },
    principal: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      validate: {
        min: 0.01,
      },
    },
    disbursedAmount: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      validate: {
        min: 0,
      },
    },
    outstandingBalance: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      validate: {
        min: 0,
      },
    },
    interestRate: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      comment: 'Annual interest rate',
    },
    duration: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        min: 1,
        max: 120, // Max 10 years
      },
      comment: 'Loan duration in months',
    },
    disbursementDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    maturityDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    originalMaturityDate: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Original maturity before restructuring',
    },
    status: {
      type: DataTypes.ENUM(
        'PENDING',
        'APPROVED',
        'ACTIVE',
        'ARREARS',
        'SETTLED',
        'DEFAULTED',
        'REJECTED',
        'CANCELLED',
      ),
      defaultValue: 'PENDING',
    },
    productType: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: 'E.g., Personal Loan, Emergency Loan, Business Loan',
    },
    paidAmount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
      comment: 'Total amount paid so far',
    },
    interestPaid: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
      comment: 'Total interest paid',
    },
    lastPaymentDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    nextPaymentDueDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    isTopUpEligible: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    amortizationSchedule: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Cached amortization schedule',
    },
    approvedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'Staff member who approved',
    },
    approvalDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    rejectionReason: {
      type: DataTypes.TEXT,
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
    tableName: 'loans',
    timestamps: true,
  });

  return Loan;
};
