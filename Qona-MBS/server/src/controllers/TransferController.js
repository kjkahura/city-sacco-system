const { Account, Transaction, Member } = require('../models');
const { logAuditEvent } = require('../middleware/auth');
const { generateTransactionReference, normalizePhoneNumber } = require('../utils/auth');

/**
 * Lookup member for transfer recipient
 * GET /api/transfers/lookup?phone=0712345678
 */
const getBeneficiaryForTransfer = async (req, res) => {
  try {
    const { phone } = req.query;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number required' });
    }

    const normalizedPhone = normalizePhoneNumber(phone);

    const member = await Member.findOne({
      where: { mobilePhone: normalizedPhone, status: 'ACTIVE' },
      attributes: ['id', 'firstName', 'lastName', 'mobilePhone'],
    });

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Get member's BOSA account (default transfer account)
    const account = await Account.findOne({
      where: {
        memberId: member.id,
        accountType: 'BOSA',
        accountState: 'ACTIVE',
      },
      attributes: ['id', 'accountNumber', 'balance'],
    });

    if (!account) {
      return res.status(404).json({ error: 'Member has no active BOSA account' });
    }

    return res.status(200).json({
      message: 'Beneficiary found',
      beneficiary: {
        memberId: member.id,
        name: `${member.firstName} ${member.lastName}`,
        phone: member.mobilePhone,
        accountId: account.id,
        accountNumber: account.accountNumber,
      },
    });
  } catch (error) {
    console.error('Get beneficiary error:', error);
    return res.status(500).json({ error: 'Failed to lookup beneficiary' });
  }
};

/**
 * Transfer between member's own accounts
 * POST /api/transfers/own
 * Body: { fromAccountId, toAccountId, amount, description, pin }
 */
const ownAccountTransfer = async (req, res) => {
  try {
    const { fromAccountId, toAccountId, amount, description, pin } = req.body;

    // Validate input
    if (!fromAccountId || !toAccountId || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }

    if (fromAccountId === toAccountId) {
      return res.status(400).json({ error: 'Cannot transfer to same account' });
    }

    // Get accounts
    const fromAccount = await Account.findByPk(fromAccountId);
    const toAccount = await Account.findByPk(toAccountId);

    if (!fromAccount || !toAccount) {
      return res.status(404).json({ error: 'One or both accounts not found' });
    }

    // Verify ownership of both accounts
    if (fromAccount.memberId !== req.member.id || toAccount.memberId !== req.member.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Verify accounts are active
    if (fromAccount.accountState !== 'ACTIVE' || toAccount.accountState !== 'ACTIVE') {
      return res.status(409).json({ error: 'One or both accounts are not active' });
    }

    // Check balance
    if (fromAccount.balance < parseFloat(amount)) {
      return res.status(409).json({ error: 'Insufficient balance' });
    }

    // === Atomic Transfer ===
    try {
      // 1. Create transaction record (PENDING)
      const transaction = await Transaction.create({
        fromAccountId,
        toAccountId,
        transactionType: 'TRANSFER',
        amount: parseFloat(amount),
        currency: 'KES',
        description: description || `Transfer to ${toAccount.accountNumber}`,
        referenceNumber: generateTransactionReference(),
        channel: 'MOBILE_APP',
        status: 'PENDING',
      });

      // 2. Debit from account
      fromAccount.balance = parseFloat(fromAccount.balance) - parseFloat(amount);
      fromAccount.lastWithdrawalDate = new Date();
      await fromAccount.save();

      // 3. Credit to account
      toAccount.balance = parseFloat(toAccount.balance) + parseFloat(amount);
      toAccount.lastDepositDate = new Date();
      await toAccount.save();

      // 4. Update transaction to SUCCESS
      transaction.status = 'SUCCESS';
      transaction.balanceAfter = fromAccount.balance;
      await transaction.save();

      // 5. Log audit event
      await logAuditEvent({
        action: 'TRANSFER',
        entityType: 'TRANSACTION',
        entityId: transaction.id,
        description: `Own account transfer: ${fromAccount.accountNumber} → ${toAccount.accountNumber}, amount: ${amount}`,
        performedBy: req.member.id,
        performedByRole: 'MEMBER',
        ipAddress: req.ip,
        result: 'SUCCESS',
      });

      return res.status(200).json({
        message: 'Transfer completed successfully',
        transaction: {
          id: transaction.id,
          referenceNumber: transaction.referenceNumber,
          amount: transaction.amount,
          status: transaction.status,
          fromAccount: fromAccount.accountNumber,
          toAccount: toAccount.accountNumber,
          timestamp: transaction.createdAt,
        },
        newBalance: fromAccount.balance,
      });
    } catch (transferError) {
      // Handle transfer failure
      console.error('Transfer execution error:', transferError);

      // Try to mark transaction as failed
      const failedTransaction = await Transaction.findOne({
        where: { referenceNumber: generateTransactionReference() },
      });
      if (failedTransaction) {
        failedTransaction.status = 'FAILED';
        failedTransaction.failureReason = transferError.message;
        await failedTransaction.save();
      }

      return res.status(500).json({ error: 'Transfer failed: ' + transferError.message });
    }
  } catch (error) {
    console.error('Own account transfer error:', error);
    return res.status(500).json({ error: 'Transfer failed' });
  }
};

/**
 * Transfer to another member
 * POST /api/transfers/internal
 * Body: { recipientPhone, amount, description, pin }
 */
const internalTransfer = async (req, res) => {
  try {
    const { recipientPhone, amount, description, pin } = req.body;

    // Validate input
    if (!recipientPhone || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }

    // Get sender's BOSA account
    const fromAccount = await Account.findOne({
      where: {
        memberId: req.member.id,
        accountType: 'BOSA',
        accountState: 'ACTIVE',
      },
    });

    if (!fromAccount) {
      return res.status(404).json({ error: 'You have no active BOSA account' });
    }

    // Find recipient
    const normalizedPhone = normalizePhoneNumber(recipientPhone);
    const recipient = await Member.findOne({
      where: { mobilePhone: normalizedPhone, status: 'ACTIVE' },
    });

    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    // Get recipient's BOSA account
    const toAccount = await Account.findOne({
      where: {
        memberId: recipient.id,
        accountType: 'BOSA',
        accountState: 'ACTIVE',
      },
    });

    if (!toAccount) {
      return res.status(404).json({ error: 'Recipient has no active BOSA account' });
    }

    // Check balance
    if (fromAccount.balance < parseFloat(amount)) {
      return res.status(409).json({ error: 'Insufficient balance' });
    }

    // === Atomic Transfer ===
    try {
      // 1. Create transaction record (PENDING)
      const transaction = await Transaction.create({
        fromAccountId: fromAccount.id,
        toAccountId: toAccount.id,
        transactionType: 'TRANSFER',
        amount: parseFloat(amount),
        currency: 'KES',
        description: description || `Transfer to ${recipient.firstName} ${recipient.lastName}`,
        referenceNumber: generateTransactionReference(),
        channel: 'MOBILE_APP',
        status: 'PENDING',
      });

      // 2. Debit from account
      fromAccount.balance = parseFloat(fromAccount.balance) - parseFloat(amount);
      fromAccount.lastWithdrawalDate = new Date();
      await fromAccount.save();

      // 3. Credit to account
      toAccount.balance = parseFloat(toAccount.balance) + parseFloat(amount);
      toAccount.lastDepositDate = new Date();
      await toAccount.save();

      // 4. Update transaction to SUCCESS
      transaction.status = 'SUCCESS';
      transaction.balanceAfter = fromAccount.balance;
      await transaction.save();

      // 5. Log audit event
      await logAuditEvent({
        action: 'TRANSFER',
        entityType: 'TRANSACTION',
        entityId: transaction.id,
        description: `Internal transfer: ${req.member.firstName} ${req.member.lastName} → ${recipient.firstName} ${recipient.lastName}, amount: ${amount}`,
        performedBy: req.member.id,
        performedByRole: 'MEMBER',
        ipAddress: req.ip,
        result: 'SUCCESS',
      });

      return res.status(200).json({
        message: 'Transfer completed successfully',
        transaction: {
          id: transaction.id,
          referenceNumber: transaction.referenceNumber,
          amount: transaction.amount,
          status: transaction.status,
          recipient: `${recipient.firstName} ${recipient.lastName}`,
          recipientPhone: recipient.mobilePhone,
          timestamp: transaction.createdAt,
        },
        newBalance: fromAccount.balance,
      });
    } catch (transferError) {
      console.error('Transfer execution error:', transferError);
      return res.status(500).json({ error: 'Transfer failed: ' + transferError.message });
    }
  } catch (error) {
    console.error('Internal transfer error:', error);
    return res.status(500).json({ error: 'Transfer failed' });
  }
};

module.exports = {
  getBeneficiaryForTransfer,
  ownAccountTransfer,
  internalTransfer,
};
