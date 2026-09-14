const { Account, Transaction, Member } = require('../models');
const { logAuditEvent } = require('../middleware/auth');
const { Op } = require('sequelize');

/**
 * List all accounts for member
 * GET /api/accounts
 */
const listAccounts = async (req, res) => {
  try {
    const accounts = await Account.findAll({
      where: {
        memberId: req.member.id,
        accountState: ['ACTIVE', 'INACTIVE'],
      },
      attributes: ['id', 'accountNumber', 'accountType', 'balance', 'currency', 'accountState', 'createdAt'],
      order: [['accountType', 'ASC']],
    });

    return res.status(200).json({
      message: 'Accounts retrieved successfully',
      accounts,
    });
  } catch (error) {
    console.error('List accounts error:', error);
    return res.status(500).json({ error: 'Failed to retrieve accounts' });
  }
};

/**
 * Get single account details
 * GET /api/accounts/:id
 */
const getAccount = async (req, res) => {
  try {
    const { id } = req.params;

    const account = await Account.findByPk(id, {
      attributes: ['id', 'accountNumber', 'accountType', 'balance', 'currency', 'accountState', 'interestRate', 'overdraftLimit', 'lastDepositDate', 'lastWithdrawalDate', 'createdAt'],
    });

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Verify ownership
    if (account.memberId !== req.member.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    return res.status(200).json({
      message: 'Account retrieved successfully',
      account,
    });
  } catch (error) {
    console.error('Get account error:', error);
    return res.status(500).json({ error: 'Failed to retrieve account' });
  }
};

/**
 * Get account balance only
 * GET /api/accounts/:id/balance
 */
const getBalance = async (req, res) => {
  try {
    const { id } = req.params;

    const account = await Account.findByPk(id, {
      attributes: ['id', 'balance', 'currency', 'accountType', 'accountState'],
    });

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Verify ownership
    if (account.memberId !== req.member.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    return res.status(200).json({
      message: 'Balance retrieved successfully',
      balance: account.balance,
      currency: account.currency,
      accountType: account.accountType,
      accountState: account.accountState,
    });
  } catch (error) {
    console.error('Get balance error:', error);
    return res.status(500).json({ error: 'Failed to retrieve balance' });
  }
};

/**
 * Get mini-statement (last 10 transactions)
 * GET /api/accounts/:id/statement
 */
const getMiniStatement = async (req, res) => {
  try {
    const { id } = req.params;

    const account = await Account.findByPk(id);

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Verify ownership
    if (account.memberId !== req.member.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get transactions (both incoming and outgoing)
    const transactions = await Transaction.findAll({
      where: {
        [Op.or]: [{ fromAccountId: id }, { toAccountId: id }],
        status: 'SUCCESS',
      },
      attributes: ['id', 'fromAccountId', 'toAccountId', 'transactionType', 'amount', 'description', 'referenceNumber', 'status', 'createdAt'],
      order: [['createdAt', 'DESC']],
      limit: 10,
    });

    return res.status(200).json({
      message: 'Mini-statement retrieved successfully',
      accountNumber: account.accountNumber,
      balance: account.balance,
      transactions,
    });
  } catch (error) {
    console.error('Get mini-statement error:', error);
    return res.status(500).json({ error: 'Failed to retrieve statement' });
  }
};

/**
 * Get transaction history (paginated)
 * GET /api/accounts/:id/transactions?limit=20&offset=0&type=TRANSFER&status=SUCCESS&dateFrom=2026-01-01&dateTo=2026-12-31
 */
const getTransactionHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 20, offset = 0, type, status, dateFrom, dateTo, search } = req.query;

    const account = await Account.findByPk(id);

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Verify ownership
    if (account.memberId !== req.member.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Build query conditions
    const where = {
      [Op.or]: [{ fromAccountId: id }, { toAccountId: id }],
    };

    if (type) {
      where.transactionType = type;
    }

    if (status) {
      where.status = status;
    }

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) {
        where.createdAt[Op.gte] = new Date(dateFrom);
      }
      if (dateTo) {
        where.createdAt[Op.lte] = new Date(dateTo);
      }
    }

    // Execute query
    const transactions = await Transaction.findAndCountAll({
      where,
      attributes: ['id', 'fromAccountId', 'toAccountId', 'transactionType', 'amount', 'description', 'referenceNumber', 'status', 'createdAt'],
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    return res.status(200).json({
      message: 'Transaction history retrieved successfully',
      total: transactions.count,
      transactions: transactions.rows,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: offset + parseInt(limit) < transactions.count,
      },
    });
  } catch (error) {
    console.error('Get transaction history error:', error);
    return res.status(500).json({ error: 'Failed to retrieve transaction history' });
  }
};

/**
 * Export statement (JSON format, ready for PDF conversion)
 * POST /api/accounts/:id/statement/export
 */
const exportStatement = async (req, res) => {
  try {
    const { id } = req.params;

    const account = await Account.findByPk(id);

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Verify ownership
    if (account.memberId !== req.member.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get full transaction history
    const transactions = await Transaction.findAll({
      where: {
        [Op.or]: [{ fromAccountId: id }, { toAccountId: id }],
      },
      order: [['createdAt', 'DESC']],
    });

    // Build statement object
    const statement = {
      generatedAt: new Date(),
      member: {
        name: `${req.member.firstName} ${req.member.lastName}`,
        id: req.member.id,
        phone: req.member.mobilePhone,
      },
      account: {
        accountNumber: account.accountNumber,
        accountType: account.accountType,
        balance: account.balance,
        currency: account.currency,
        createdAt: account.createdAt,
      },
      transactions,
      summary: {
        totalTransactions: transactions.length,
        totalDeposits: transactions.filter(t => t.transactionType === 'DEPOSIT').reduce((sum, t) => sum + parseFloat(t.amount), 0),
        totalWithdrawals: transactions.filter(t => t.transactionType === 'WITHDRAWAL').reduce((sum, t) => sum + parseFloat(t.amount), 0),
        totalTransfers: transactions.filter(t => t.transactionType === 'TRANSFER').reduce((sum, t) => sum + parseFloat(t.amount), 0),
      },
    };

    await logAuditEvent({
      action: 'EXPORT_STATEMENT',
      entityType: 'ACCOUNT',
      entityId: account.id,
      description: `Member exported statement for account ${account.accountNumber}`,
      performedBy: req.member.id,
      performedByRole: 'MEMBER',
      ipAddress: req.ip,
      result: 'SUCCESS',
    });

    return res.status(200).json({
      message: 'Statement exported successfully',
      statement,
    });
  } catch (error) {
    console.error('Export statement error:', error);
    return res.status(500).json({ error: 'Failed to export statement' });
  }
};

/**
 * Freeze account (staff only)
 * POST /api/accounts/:id/freeze
 */
const freezeAccount = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const account = await Account.findByPk(id);

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Update account state
    account.accountState = 'FROZEN';
    await account.save();

    await logAuditEvent({
      action: 'FREEZE_ACCOUNT',
      entityType: 'ACCOUNT',
      entityId: account.id,
      description: `Account frozen by staff. Reason: ${reason || 'Not specified'}`,
      performedBy: req.user.memberId, // Staff member ID (assuming staff also have memberId)
      performedByRole: req.user.role,
      ipAddress: req.ip,
      result: 'SUCCESS',
    });

    return res.status(200).json({
      message: 'Account frozen successfully',
      account: {
        id: account.id,
        accountNumber: account.accountNumber,
        accountState: account.accountState,
      },
    });
  } catch (error) {
    console.error('Freeze account error:', error);
    return res.status(500).json({ error: 'Failed to freeze account' });
  }
};

module.exports = {
  listAccounts,
  getAccount,
  getBalance,
  getMiniStatement,
  getTransactionHistory,
  exportStatement,
  freezeAccount,
};
