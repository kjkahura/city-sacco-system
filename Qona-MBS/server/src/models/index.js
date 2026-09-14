const { Sequelize } = require('sequelize');
const path = require('path');
require('dotenv').config();

const config = require('../config/database');

const env = process.env.NODE_ENV || 'development';
const dbConfig = config[env];

const sequelize = new Sequelize(
  dbConfig.database,
  dbConfig.username,
  dbConfig.password,
  dbConfig
);

// Import all models
const Member = require('./Member')(sequelize);
const Account = require('./Account')(sequelize);
const Transaction = require('./Transaction')(sequelize);
const Loan = require('./Loan')(sequelize);
const Beneficiary = require('./Beneficiary')(sequelize);
const Share = require('./Share')(sequelize);
const Dividend = require('./Dividend')(sequelize);
const NotificationPreference = require('./NotificationPreference')(sequelize);
const AuditLog = require('./AuditLog')(sequelize);

// Define associations
// Member associations
Member.hasMany(Account, { foreignKey: 'memberId', as: 'accounts' });
Member.hasMany(Loan, { foreignKey: 'memberId', as: 'loans' });
Member.hasMany(Beneficiary, { foreignKey: 'memberId', as: 'beneficiaries' });
Member.hasMany(Share, { foreignKey: 'memberId', as: 'shares' });
Member.hasMany(Dividend, { foreignKey: 'memberId', as: 'dividends' });
Member.hasOne(NotificationPreference, { foreignKey: 'memberId', as: 'notificationPreference' });
Member.hasMany(AuditLog, { foreignKey: 'performedBy', as: 'auditLogs' });

// Account associations
Account.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });
Account.hasMany(Transaction, { foreignKey: 'fromAccountId', as: 'outgoingTransactions' });
Account.hasMany(Transaction, { foreignKey: 'toAccountId', as: 'incomingTransactions' });
Account.hasMany(Loan, { foreignKey: 'accountId', as: 'loans' });
Account.hasMany(Share, { foreignKey: 'accountId', as: 'shares' });
Account.hasMany(Dividend, { foreignKey: 'accountId', as: 'dividends' });

// Transaction associations
Transaction.belongsTo(Account, { foreignKey: 'fromAccountId', as: 'fromAccount' });
Transaction.belongsTo(Account, { foreignKey: 'toAccountId', as: 'toAccount' });

// Loan associations
Loan.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });
Loan.belongsTo(Account, { foreignKey: 'accountId', as: 'account' });
Loan.hasMany(Transaction, { foreignKey: 'entityId', as: 'transactions' });

// Beneficiary associations
Beneficiary.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });
Beneficiary.belongsTo(Member, { foreignKey: 'beneficiaryMemberId', as: 'beneficiaryMember' });

// Share associations
Share.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });
Share.belongsTo(Account, { foreignKey: 'accountId', as: 'account' });
Share.belongsTo(Transaction, { foreignKey: 'transactionId', as: 'transaction' });

// Dividend associations
Dividend.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });
Dividend.belongsTo(Account, { foreignKey: 'accountId', as: 'account' });
Dividend.belongsTo(Transaction, { foreignKey: 'transactionId', as: 'transaction' });

// NotificationPreference associations
NotificationPreference.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });

// AuditLog associations
AuditLog.belongsTo(Member, { foreignKey: 'performedBy', as: 'performer' });

module.exports = {
  sequelize,
  Sequelize,
  Member,
  Account,
  Transaction,
  Loan,
  Beneficiary,
  Share,
  Dividend,
  NotificationPreference,
  AuditLog,
};
