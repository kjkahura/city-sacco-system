'use strict';

const acct = require('./accounting');
const ledger = require('./ledger');
const savings = require('./savings');
const branches = require('./branches');
const { err } = acct;

/**
 * Settlement deposit accounts, after Mambu's "Linking Deposit and Loan
 * Accounts": a loan linked to one of its member's deposit accounts has its
 * dues taken from there on their due dates (./settlement, the end of day).
 *
 * The loan product turns linking on (settlement_enabled) for any deposit
 * product or one (settlement_product_id). For one product it may link a new
 * loan to the member's account of that product when there is exactly one
 * (settlement_auto_set), or open one when there is none
 * (settlement_auto_create). The settlement option is FULL_DUES (transfer
 * only when the whole amount due is there), PARTIAL (whatever is there) or
 * NONE (linked, no automated transfers).
 *
 * A loan has one settlement account; a deposit account may settle several
 * loans, in the order they were linked. Both products must be linked to
 * the ledger, or neither. The two accounts are in the same branch: moving
 * the loan moves the deposit account too unless it settles other loans, and
 * unlinking returns the deposit account to its member's branch. A deposit
 * account with an overdraft is only ever linked by hand.
 */

const CLOSED = ['CLOSED_REPAID', 'CLOSED_WRITTEN_OFF', 'CLOSED_REJECTED', 'CLOSED_WITHDRAWN', 'CLOSED_RESCHEDULED', 'CLOSED_REFINANCED'];
const LIVE = ['PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'IN_ARREARS', 'LOCKED'];
const hasOverdraft = (a) => Number(a.overdraft_limit || 0) > 0 || Boolean(a.allow_overdraft) || Boolean(a.allow_technical_overdraft);

/** Other live loans this deposit account settles. */
async function otherLoans(c, savingsAccountId, loanId) {
  const { rows } = await c.query(
    `SELECT id, account_no FROM loan_accounts WHERE settlement_account_id = $1 AND id <> $2 AND status = ANY($3)`,
    [savingsAccountId, loanId, LIVE]);
  return rows;
}

async function check(c, l, a) {
  if (CLOSED.includes(l.status)) throw err(`LOAN_IS_CLOSED: ${l.status}`, 409);
  if (!l.settlement_enabled) throw err('PRODUCT_DOES_NOT_LINK_SETTLEMENT_ACCOUNTS', 409);
  if (a.status !== 'ACTIVE') throw err(`SETTLEMENT_ACCOUNT_NOT_ACTIVE: ${a.status}`, 409);
  if (a.member_id !== l.member_id) throw err('SETTLEMENT_ACCOUNT_BELONGS_TO_ANOTHER_MEMBER', 409);
  if (a.is_funding_account) throw err('A_FUNDING_ACCOUNT_CANNOT_SETTLE_A_LOAN', 409);
  if (l.settlement_product_id && a.product_id !== l.settlement_product_id) {
    throw err(`SETTLEMENT_ACCOUNT_MUST_BE_UNDER_${l.settlement_product_id}`, 409);
  }
  if ((l.accounting_method === 'NONE') !== (a.accounting_method === 'NONE')) {
    throw err('SETTLEMENT_ACCOUNT_ACCOUNTING_DIFFERS: both products must be linked to the ledger, or neither', 409);
  }
  if ((l.branch_id || null) !== (a.branch_id || null)) {
    throw err('SETTLEMENT_ACCOUNT_IN_ANOTHER_BRANCH: the loan and its settlement account must be in the same branch', 409);
  }
}

/** Link a loan to a deposit account of its member (by id or account number). */
async function link(c, loanId, { savingsAccountId, createdBy, note = null } = {}) {
  const l = await ledger.lock(c, loanId);
  if (!savingsAccountId) throw err('SAVINGS_ACCOUNT_REQUIRED', 400);
  const a = await savings.lock(c, String(savingsAccountId));
  await check(c, l, a);
  if (l.settlement_account_id === a.id) throw err('ALREADY_LINKED_TO_THAT_ACCOUNT', 409);
  const before = l.settlement_account_id;
  await c.query('UPDATE loan_accounts SET settlement_account_id = $1, settlement_linked_at = now(), updated_at = now() WHERE id = $2', [a.id, l.id]);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'LOAN_SETTLEMENT_LINKED','loan_account',$2,$3,$4)`,
    [createdBy || 'SYSTEM', l.id, JSON.stringify({ settlementAccountId: before }), JSON.stringify({ settlementAccountId: a.id, accountNo: a.account_no, note })]);
  return { loanId: l.id, accountNo: l.account_no, settlementAccountId: a.id, settlementAccountNo: a.account_no, option: l.settlement_option };
}

/**
 * Remove the link. The deposit account goes back to its member's branch
 * if it has moved away from it and settles no other loan.
 */
async function unlink(c, loanId, { createdBy, note = null } = {}) {
  const l = await ledger.lock(c, loanId);
  if (!l.settlement_account_id) throw err('NO_SETTLEMENT_ACCOUNT_LINKED', 409);
  const a = await savings.lock(c, l.settlement_account_id);
  await c.query('UPDATE loan_accounts SET settlement_account_id = NULL, settlement_linked_at = NULL, updated_at = now() WHERE id = $1', [l.id]);
  let moved = null;
  const { rows: [m] } = await c.query('SELECT branch_id FROM members WHERE id = $1', [a.member_id]);
  if (m?.branch_id && m.branch_id !== a.branch_id && !(await otherLoans(c, a.id, l.id)).length) {
    moved = await branches.moveAccount(c, { kind: 'SAVINGS', accountId: a.id, branchId: m.branch_id, createdBy });
  }
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'LOAN_SETTLEMENT_UNLINKED','loan_account',$2,$3,$4)`,
    [createdBy || 'SYSTEM', l.id, JSON.stringify({ settlementAccountId: a.id }), JSON.stringify({ note, movedTo: moved?.to || null })]);
  return { loanId: l.id, unlinked: a.account_no, movedToMemberBranch: Boolean(moved) };
}

/**
 * When a loan is opened under a product that links to one deposit product:
 * link it to the member's account of that product if there is exactly one
 * (auto-set), or open one if there is none (auto-create). Several accounts,
 * one with an overdraft, or one in another branch: left for a person.
 */
async function autoLink(c, loan, { createdBy } = {}) {
  const l = await ledger.lock(c, loan.id);
  if (!l.settlement_enabled || !l.settlement_product_id || (!l.settlement_auto_set && !l.settlement_auto_create)) return null;
  const { rows } = await c.query(
    `SELECT a.id FROM savings_accounts a WHERE a.member_id = $1 AND a.product_id = $2 AND a.status = 'ACTIVE' ORDER BY a.opened_on, a.account_no`,
    [l.member_id, l.settlement_product_id]);
  if (rows.length > 1) return null;
  if (rows.length === 1) {
    if (!l.settlement_auto_set) return null;
    const a = await savings.lock(c, rows[0].id);
    if (hasOverdraft(a) || (a.branch_id || null) !== (l.branch_id || null)) return null;
    return link(c, l.id, { savingsAccountId: a.id, createdBy, note: 'auto-set at creation' });
  }
  if (!l.settlement_auto_create) return null;
  const opened = await savings.open(c, { memberId: l.member_id, productId: l.settlement_product_id, branchId: l.branch_id ?? undefined });
  return link(c, l.id, { savingsAccountId: opened.id, createdBy, note: 'auto-created at creation' });
}

/**
 * Move a loan to another branch, and its settlement account with it unless
 * that account settles other loans too, in which case it stays where it is
 * (Mambu's rule).
 */
async function moveLoan(c, loanId, { branchId, createdBy } = {}) {
  const l = await ledger.lock(c, loanId);
  const out = await branches.moveAccount(c, { kind: 'LOAN', accountId: l.id, branchId, createdBy });
  if (l.settlement_account_id && (await otherLoans(c, l.settlement_account_id, l.id)).length) {
    out.settlementAccountStays = true;
  } else if (l.settlement_account_id) {
    const a = await savings.lock(c, l.settlement_account_id);
    if (a.branch_id !== out.to) out.settlementAccount = await branches.moveAccount(c, { kind: 'SAVINGS', accountId: a.id, branchId: out.to, createdBy });
  }
  return out;
}

/** The loan's settlement account, and the loans a deposit account settles. */
async function forLoan(c, loanId) {
  const l = await ledger.read(c, loanId);
  if (!l.settlement_account_id) return { loanId: l.id, linked: false, option: l.settlement_option, enabled: l.settlement_enabled };
  const { rows: [a] } = await c.query('SELECT id, account_no, product_id, balance, branch_id FROM savings_accounts WHERE id = $1', [l.settlement_account_id]);
  const { rows: loans } = await c.query(
    `SELECT id, account_no, settlement_linked_at FROM loan_accounts WHERE settlement_account_id = $1 AND status = ANY($2) ORDER BY settlement_linked_at, id`,
    [a.id, LIVE]);
  return { loanId: l.id, linked: true, option: l.settlement_option, enabled: l.settlement_enabled, account: a, linkedAt: l.settlement_linked_at, settles: loans };
}

module.exports = { link, unlink, autoLink, moveLoan, forLoan, hasOverdraft, LIVE };
