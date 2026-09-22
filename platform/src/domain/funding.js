'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const { err, round2 } = acct;

/**
 * Funding sources, after Mambu's "Funding Sources - P2P Lending" (loan
 * fractionalisation): a member's loan financed from other members' funding
 * accounts. Mambu withdrew the feature from sale in 2022; the mechanics are
 * documented and are what this reproduces.
 *
 * A funding account is a savings account under a product flagged
 * is_funding_account. A funded loan's principal is not the SACCO's asset:
 * at disbursement the money moves from the funders' accounts to the
 * channel, and each principal repayment moves back to them in proportion
 * to their share. Interest is split: the organisation's commission is its
 * own income and is accrued as such; the funders' share reaches their
 * accounts as the member pays. Fees and penalties are the organisation's.
 *
 *   PERCENT_OF_FUNDING   the loan's rate is set; funders split (rate −
 *                        commission) by their share of the funding
 *   FIXED_COMMISSIONS    each funder names a rate; the loan's rate is the
 *                        commission plus each funder's rate weighted by share
 */

const L = () => require('./loans');

async function fundingOf(c, loanId) {
  const { rows } = await c.query(
    `SELECT f.*, a.account_no, a.balance, p.gl_liability, m.member_no, m.first_name, m.last_name
     FROM loan_funding_sources f
     JOIN savings_accounts a ON a.id = f.savings_account_id
     JOIN savings_products p ON p.id = a.product_id
     JOIN members m ON m.id = f.member_id
     WHERE f.loan_id = $1 AND f.status <> 'RELEASED' ORDER BY f.created_at`, [loanId]);
  return rows;
}

const isFunded = async (c, loanId) => (await fundingOf(c, loanId)).length > 0;

async function addFundingSource(c, loanId, { savingsAccountId, amount, funderRate = null, createdBy }) {
  const l = await L().lock(c, loanId);
  if (!l.funding_enabled) throw err('PRODUCT_HAS_NO_FUNDING_SOURCES', 409);
  if (!['PARTIAL_APPLICATION', 'PENDING_APPROVAL'].includes(l.status)) throw err(`CANNOT_ADD_FUNDING_IN_STATE: ${l.status}`, 409);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_FUNDING_AMOUNT', 400);
  const { rows: [a] } = await c.query(
    `SELECT a.*, p.is_funding_account FROM savings_accounts a JOIN savings_products p ON p.id = a.product_id
     WHERE (a.id::text = $1 OR a.account_no = $1) AND a.status = 'ACTIVE'`, [String(savingsAccountId)]);
  if (!a) throw err('FUNDING_ACCOUNT_NOT_FOUND', 404);
  if (!a.is_funding_account) throw err('NOT_A_FUNDING_ACCOUNT', 409);
  if (a.member_id === l.member_id) throw err('MEMBER_CANNOT_FUND_OWN_LOAN', 409);
  const existing = await fundingOf(c, l.id);
  if (existing.some((f) => f.savings_account_id === a.id)) throw err('ACCOUNT_ALREADY_FUNDS_THIS_LOAN', 409);
  const total = round2(existing.reduce((s, f) => s + Number(f.amount), 0) + amt);
  if (total > Number(l.principal)) throw err(`FUNDING_EXCEEDS_PRINCIPAL: ${total} of ${l.principal}`, 409);
  let rate = null;
  if (l.funder_allocation === 'FIXED_COMMISSIONS') {
    rate = Number(funderRate ?? l.funder_rate_default);
    if (!(rate >= 0)) throw err('FUNDER_RATE_REQUIRED', 400);
    if (l.funder_rate_min !== null && rate < Number(l.funder_rate_min)) throw err(`FUNDER_RATE_BELOW_PRODUCT_MINIMUM: ${l.funder_rate_min}`, 400);
    if (l.funder_rate_max !== null && rate > Number(l.funder_rate_max)) throw err(`FUNDER_RATE_ABOVE_PRODUCT_MAXIMUM: ${l.funder_rate_max}`, 400);
  }
  const { rows } = await c.query(
    `INSERT INTO loan_funding_sources (loan_id, savings_account_id, member_id, amount, funder_rate)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`, [l.id, a.id, a.member_id, amt, rate]);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'FUNDING_SOURCE_ADDED','loan_funding_source',$2,$3)`,
    [createdBy || 'SYSTEM', rows[0].id, JSON.stringify(rows[0])]);
  return rows[0];
}

async function removeFundingSource(c, fundingId, { createdBy } = {}) {
  const { rows: [f] } = await c.query('SELECT * FROM loan_funding_sources WHERE id = $1 FOR UPDATE', [fundingId]);
  if (!f) throw err('FUNDING_SOURCE_NOT_FOUND', 404);
  const l = await L().lock(c, f.loan_id);
  if (!['PARTIAL_APPLICATION', 'PENDING_APPROVAL'].includes(l.status)) throw err(`CANNOT_REMOVE_FUNDING_IN_STATE: ${l.status}`, 409);
  await c.query("UPDATE loan_funding_sources SET status = 'RELEASED' WHERE id = $1", [fundingId]);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before) VALUES ($1,'FUNDING_SOURCE_REMOVED','loan_funding_source',$2,$3)`,
    [createdBy || 'SYSTEM', fundingId, JSON.stringify(f)]);
  return { removed: true };
}

/**
 * Funding pledged by a member's accounts on loans that are approved but not
 * yet disbursed: locked, so the money cannot be withdrawn or promised twice
 * (lock_funds_at_approval).
 */
async function lockedFunding(c, memberId) {
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(SUM(f.amount), 0) AS t
     FROM loan_funding_sources f
     JOIN loan_accounts l ON l.id = f.loan_id
     JOIN loan_products p ON p.id = l.product_id
     WHERE f.member_id = $1 AND f.status = 'PLEDGED' AND l.status = 'APPROVED' AND p.lock_funds_at_approval`, [memberId]);
  return round2(r.t);
}

/**
 * At approval: the loan must be fully funded and every funder must hold the
 * money. Under FIXED_COMMISSIONS the loan's rate is worked out here.
 */
async function assertFundedForApproval(c, l) {
  if (!l.funding_enabled) return null;
  const funders = await fundingOf(c, l.id);
  const total = round2(funders.reduce((s, f) => s + Number(f.amount), 0));
  if (total !== round2(l.principal)) throw err(`LOAN_NOT_FULLY_FUNDED: ${total} of ${l.principal}`, 409);
  for (const f of funders) {
    const pledged = await savings.pledgedAmount(c, f.member_id);
    if (Number(f.balance) - pledged < Number(f.amount)) {
      throw err(`FUNDER_${f.account_no}_HAS_INSUFFICIENT_BALANCE: ${round2(f.balance - pledged)} free, ${f.amount} pledged`, 409);
    }
  }
  const orgCommission = Number(l.org_commission ?? l.product_org_commission ?? 0);
  if (l.org_commission_min !== null && orgCommission < Number(l.org_commission_min)) throw err('ORG_COMMISSION_BELOW_PRODUCT_MINIMUM', 400);
  if (l.org_commission_max !== null && orgCommission > Number(l.org_commission_max)) throw err('ORG_COMMISSION_ABOVE_PRODUCT_MAXIMUM', 400);
  let rate = Number(l.monthly_rate);
  if (l.funder_allocation === 'FIXED_COMMISSIONS') {
    rate = round4(orgCommission + funders.reduce((s, f) => s + Number(f.funder_rate) * Number(f.amount) / Number(l.principal), 0));
  } else if (orgCommission > rate) {
    throw err(`ORG_COMMISSION_EXCEEDS_LOAN_RATE: ${orgCommission} > ${rate}`, 400);
  }
  await c.query('UPDATE loan_accounts SET monthly_rate = $2, org_commission = $3 WHERE id = $1', [l.id, rate, orgCommission]);
  return { total, rate, orgCommission, funders: funders.length };
}
const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * At disbursement of `amount`: the money leaves the funders' accounts, in
 * their shares, for the channel. Returns the debit lines and the shares.
 */
async function fund(c, l, { amount, date, createdBy }) {
  const funders = await fundingOf(c, l.id);
  if (!funders.length) return null;
  const principal = Number(l.principal);
  const debits = [];
  let allocated = 0;
  for (let i = 0; i < funders.length; i += 1) {
    const f = funders[i];
    const share = Number(f.amount) / principal;
    const part = i === funders.length - 1 ? round2(amount - allocated) : round2(amount * share);
    allocated = round2(allocated + part);
    const a = await savings.lock(c, f.savings_account_id);
    if (Number(a.balance) < part) throw err(`FUNDER_${f.account_no}_HAS_INSUFFICIENT_BALANCE`, 409);
    await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2', [part, f.savings_account_id]);
    await c.query("UPDATE loan_funding_sources SET status = 'FUNDED', funded_at = now() WHERE id = $1", [f.id]);
    debits.push({ glCode: f.gl_liability, amount: part, memberId: f.member_id });
    await savings.record(c, {
      reference: savings.ref('LFD'), kind: 'LOAN_FUNDED', memberId: f.member_id, savingsAccountId: f.savings_account_id,
      loanAccountId: l.id, amount: -part, valueDate: date, allocation: { fundingId: f.id, share: round4(share) }, createdBy,
    });
  }
  return { debits, funders };
}

/** The organisation's share of an interest amount, and the funders'. */
function interestShares(l, interest) {
  const rate = Number(l.monthly_rate);
  const org = Number(l.org_commission || 0);
  if (!(rate > 0)) return { org: round2(interest), funders: 0 };
  const orgPart = round2(interest * org / rate);
  return { org: orgPart, funders: round2(interest - orgPart) };
}

/**
 * At repayment: principal goes back to the funders by share, and so does
 * their part of the interest (by share under PERCENT_OF_FUNDING, by their own
 * rate weighted by share under FIXED_COMMISSIONS). Returns the credit lines
 * for the repayment entry and the per-funder allocation for the record.
 * Rounding remainders are settled with the final payment.
 */
async function distribute(c, l, { principal, interest, date, createdBy, finalPayment }) {
  const funders = await fundingOf(c, l.id);
  if (!funders.length) return null;
  const total = Number(l.principal);
  const rate = Number(l.monthly_rate);
  const org = Number(l.org_commission || 0);
  const funderInterest = interestShares(l, interest).funders;
  const credits = [];
  const allocation = [];
  let pAlloc = 0; let iAlloc = 0;
  for (let i = 0; i < funders.length; i += 1) {
    const f = funders[i];
    const share = Number(f.amount) / total;
    let p; let iAmt;
    if (finalPayment) {
      // Whatever principal is still owed to this funder, and the last of the interest.
      p = round2(Math.min(round2(f.amount - f.principal_returned), round2(principal - pAlloc)));
      if (i === funders.length - 1) p = round2(principal - pAlloc);
      iAmt = i === funders.length - 1 ? round2(funderInterest - iAlloc) : round2(funderInterest * share);
    } else {
      p = i === funders.length - 1 ? round2(principal - pAlloc) : round2(principal * share);
      iAmt = l.funder_allocation === 'FIXED_COMMISSIONS' && rate > 0
        ? round2(interest * share * Number(f.funder_rate) / rate)
        : round2(funderInterest * share);
      if (i === funders.length - 1 && l.funder_allocation !== 'FIXED_COMMISSIONS') iAmt = round2(funderInterest - iAlloc);
    }
    pAlloc = round2(pAlloc + p); iAlloc = round2(iAlloc + iAmt);
    const back = round2(p + iAmt);
    if (back > 0) {
      await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [back, f.savings_account_id]);
      await c.query(
        `UPDATE loan_funding_sources SET principal_returned = principal_returned + $1, interest_returned = interest_returned + $2,
           status = CASE WHEN principal_returned + $1 >= amount THEN 'REPAID' ELSE status END WHERE id = $3`, [p, iAmt, f.id]);
      credits.push({ glCode: f.gl_liability, amount: back, memberId: f.member_id });
      await savings.record(c, {
        reference: savings.ref('LRF'), kind: 'LOAN_REPAID_TO_FUNDER', memberId: f.member_id, savingsAccountId: f.savings_account_id,
        loanAccountId: l.id, amount: back, valueDate: date, allocation: { fundingId: f.id, principal: p, interest: iAmt }, createdBy,
      });
    }
    allocation.push({ fundingId: f.id, accountNo: f.account_no, principal: p, interest: iAmt });
  }
  // Interest the funders' rounding could not place is the organisation's.
  const orgInterest = round2(interest - iAlloc);
  return { credits, allocation, orgInterest, funderInterest: iAlloc };
}

/** Undo a distribution when the repayment it came from is reversed. */
async function undistribute(c, l, allocation, { date, createdBy }) {
  for (const a of allocation || []) {
    const back = round2(Number(a.principal) + Number(a.interest));
    const { rows: [f] } = await c.query('SELECT * FROM loan_funding_sources WHERE id = $1', [a.fundingId]);
    if (!f) continue;
    await c.query('UPDATE savings_accounts SET balance = balance - $1 WHERE id = $2', [back, f.savings_account_id]);
    await c.query(
      `UPDATE loan_funding_sources SET principal_returned = principal_returned - $1, interest_returned = interest_returned - $2,
         status = 'FUNDED' WHERE id = $3`, [a.principal, a.interest, f.id]);
    await savings.record(c, {
      reference: savings.ref('LRFA'), kind: 'LOAN_REPAID_TO_FUNDER', memberId: f.member_id, savingsAccountId: f.savings_account_id,
      loanAccountId: l.id, amount: -back, valueDate: date, allocation: { fundingId: f.id, adjustment: true }, createdBy,
    });
  }
}

module.exports = {
  fundingOf, isFunded, addFundingSource, removeFundingSource, lockedFunding,
  assertFundedForApproval, fund, interestShares, distribute, undistribute,
};
