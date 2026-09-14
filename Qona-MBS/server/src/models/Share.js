const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Share = sequelize.define('Share', {
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
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        min: 1,
      },
    },
    purchasePrice: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      comment: 'Price per share at time of purchase',
    },
    totalCost: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      comment: 'Quantity × Purchase Price',
    },
    currentSharePrice: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      comment: 'Current market value per share',
    },
    totalValue: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      comment: 'Quantity × Current Share Price',
    },
    gainLoss: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      comment: 'Total Value - Total Cost',
    },
    gainLossPercent: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      comment: 'Percentage gain/loss',
    },
    purchaseDate: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    purchaseMethod: {
      type: DataTypes.ENUM(
        'CASH_DEPOSIT',
        'MPESA',
        'BANK_TRANSFER',
        'DIVIDEND_CAPITALIZATION',
        'LOAN_DISBURSEMENT',
      ),
      defaultValue: 'CASH_DEPOSIT',
    },
    transactionId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'transactions',
        key: 'id',
      },
    },
    isForSale: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    salePrice: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      comment: 'Price listed for sale',
    },
    quantityForSale: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Quantity offered for sale',
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
    tableName: 'shares',
    timestamps: true,
  });

  return Share;
};
