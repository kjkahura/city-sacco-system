const { Transaction, Account } = require('../models');
const { logAuditEvent } = require('../middleware/auth');
const { Op } = require('sequelize');

/**
 * Get single transaction details
 * GET /api/transactions/:id
 */
const getTransaction = async (req, res) => {
  try {
    const { id } = req.params;

    const transaction = await Transaction.findByPk(id, {
      include: [
        { association: 'fromAccount', attributes: ['id', 'accountNumber', 'memberId'] },
        { association: 'toAccount', attributes: ['id', 'accountNumber', 'memberId'] },
      ],
    });

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // Verify ownership (either from or to account)
    const fromAccountOwner = transaction.fromAccount?.memberId;
    const toAccountOwner = transaction.toAccount?.memberId;

    if (fromAccountOwner !== req.member.id && toAccountOwner !== req.member.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    return res.status(200).json({
      message: 'Transaction retrieved successfully',
      transaction: {
        id: transaction.id,
        fromAccount: transaction.fromAccount?.accountNumber,
        toAccount: transaction.toAccount?.accountNumber,
        transactionType: transaction.transactionType,
        amount: transaction.amount,
        currency: transaction.currency,
        description: transaction.description,
        referenceNumber: transaction.referenceNumber,
        externalReference: transaction.externalReference,
        status: transaction.status,
        fee: transaction.fee,
        balanceAfter: transaction.balanceAfter,
        createdAt: transaction.createdAt,
      },
    });
  } catch (error) {
    console.error('Get transaction error:', error);
    return res.status(500).json({ error: 'Failed to retrieve transaction' });
  }
};

/**
 * Get transaction receipt
 * GET /api/transactions/:id/receipt
 */
const getReceipt = async (req, res) => {
  try {
    const { id } = req.params;

    const transaction = await Transaction.findByPk(id, {
      include: [
        { association: 'fromAccount', attributes: ['accountNumber', 'memberId'] },
        { association: 'toAccount', attributes: ['accountNumber', 'memberId'] },
      ],
    });

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // Verify ownership
    const fromAccountOwner = transaction.fromAccount?.memberId;
    const toAccountOwner = transaction.toAccount?.memberId;

    if (fromAccountOwner !== req.member.id && toAccountOwner !== req.member.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Format receipt
    const receipt = {
      receiptNumber: transaction.referenceNumber,
      transactionType: transaction.transactionType,
      date: transaction.createdAt,
      time: transaction.createdAt.toLocaleTimeString(),
      status: transaction.status,
      fromAccount: transaction.fromAccount?.accountNumber,
      toAccount: transaction.toAccount?.accountNumber,
      amount: transaction.amount,
      currency: transaction.currency,
      fee: transaction.fee,
      totalDebit: parseFloat(transaction.amount) + parseFloat(transaction.fee),
      description: transaction.description,
      externalReference: transaction.externalReference,
      balanceAfter: transaction.balanceAfter,
    };

    return res.status(200).json({
      message: 'Receipt retrieved successfully',
      receipt,
    });
  } catch (error) {
    console.error('Get receipt error:', error);
    return res.status(500).json({ error: 'Failed to retrieve receipt' });
  }
};

/**
 * Dispute transaction
 * POST /api/transactions/:id/dispute
 */
const disputeTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Dispute reason required' });
    }

    const transaction = await Transaction.findByPk(id, {
      include: [
        { association: 'fromAccount', attributes: ['memberId'] },
      ],
    });

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // Verify ownership (only from account owner can dispute)
    if (transaction.fromAccount?.memberId !== req.member.id) {
      return res.status(403).json({ error: 'Only transaction originator can dispute' });
    }

    // Only PENDING or SUCCESS can be disputed
    if (!['PENDING', 'SUCCESS'].includes(transaction.status)) {
      return res.status(409).json({ error: `Cannot dispute ${transaction.status} transaction` });
    }

    // Update transaction
    transaction.status = 'DISPUTED';
    transaction.metadata = { ...transaction.metadata, disputeReason: reason, disputedAt: new Date() };
    await transaction.save();

    await logAuditEvent({
      action: 'DISPUTE_TRANSACTION',
      entityType: 'TRANSACTION',
      entityId: transaction.id,
      description: `Transaction disputed. Reason: ${reason}`,
      performedBy: req.member.id,
      performedByRole: 'MEMBER',
      ipAddress: req.ip,
      result: 'SUCCESS',
    });

    return res.status(200).json({
      message: 'Transaction disputed successfully',
      transaction: {
        id: transaction.id,
        status: transaction.status,
        referenceNumber: transaction.referenceNumber,
      },
    });
  } catch (error) {
    console.error('Dispute transaction error:', error);
    return res.status(500).json({ error: 'Failed to dispute transaction' });
  }
};

/**
 * Get transaction limits
 * GET /api/transactions/limits
 */
const getLimits = async (req, res) => {
  try {
    return res.status(200).json({
      message: 'Transaction limits retrieved successfully',
      limits: {
        dailyTransactionLimit: req.member.dailyTransactionLimit,
        currency: 'KES',
        description: 'Maximum transaction amount per day',
      },
    });
  } catch (error) {
    console.error('Get limits error:', error);
    return res.status(500).json({ error: 'Failed to retrieve limits' });
  }
};

/**
 * Get transaction statistics (current month)
 * GET /api/transactions/stats
 */
const getStats = async (req, res) => {
  try {
    // Get member's accounts
    const accounts = await Account.findAll({
      where: { memberId: req.member.id },
      attributes: ['id'],
    });

    const accountIds = accounts.map(a => a.id);

    if (accountIds.length === 0) {
      return res.status(200).json({
        message: 'Transaction statistics retrieved',
        stats: {
          totalDeposits: 0,
          totalWithdrawals: 0,
          totalTransfers: 0,
          totalTransactionsFee: 0,
          transactionCount: 0,
          period: 'Current Month',
        },
      });
    }

    // Get start of current month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Get transactions from current month
    const transactions = await Transaction.findAll({
      where: {
        [Op.or]: [
          { fromAccountId: { [Op.in]: accountIds } },
          { toAccountId: { [Op.in]: accountIds } },
        ],
        status: 'SUCCESS',
        createdAt: { [Op.gte]: monthStart },
      },
      attributes: ['transactionType', 'amount', 'fee'],
    });

    // Calculate stats
    const stats = {
      totalDeposits: transactions
        .filter(t => t.transactionType === 'DEPOSIT')
        .reduce((sum, t) => sum + parseFloat(t.amount), 0),
      totalWithdrawals: transactions
        .filter(t => t.transactionType === 'WITHDRAWAL')
        .reduce((sum, t) => sum + parseFloat(t.amount), 0),
      totalTransfers: transactions
        .filter(t => t.transactionType === 'TRANSFER')
        .reduce((sum, t) => sum + parseFloat(t.amount), 0),
      totalTransactionsFee: transactions.reduce((sum, t) => sum + parseFloat(t.fee || 0), 0),
      transactionCount: transactions.length,
      period: `${monthStart.toLocaleDateString()} - ${now.toLocaleDateString()}`,
    };

    return res.status(200).json({
      message: 'Transaction statistics retrieved successfully',
      stats,
    });
  } catch (error) {
    console.error('Get stats error:', error);
    return res.status(500).json({ error: 'Failed to retrieve statistics' });
  }
};

module.exports = {
  getTransaction,
  getReceipt,
  disputeTransaction,
  getLimits,
  getStats,
};
