'use strict';

/**
 * Deposit accounts: an account's own terms checked against its product, the interest rate, the terms editable before activation, and overdrafts.
 */

const CA = require('../creditArrangements');
const DR = require('../depositRules');
const { orgToday } = require('../../lib/orgDate');
const acct = require('../accounting');
const S = require('../schedule');
const accruals = require('../accruals');
const customFields = require('../customFields');
const { recordAudit } = require('../../lib/auditLog');
const { err, round2 } = acct;
const core = require('./core');
const interest = require('./interest');

// --------------------------------------------------------------------------
// The interest rate of an account (the reference platform's changeInterestRate)
// --------------------------------------------------------------------------

/**
 * Change a fixed-rate account's credit rate from a value date: today, or
 * back to the day after the last interest application (not forward).
 * What accrued from the value date is priced again at the new rate, and
 * the change is booked as accruals are.
 */
async function changeInterestRate(c, accountId, { interestRate, valueDate = null, notes = null, createdBy } = {}) {
  const a = await core.lock(c, accountId);
  if ((a.interest_rate_terms || 'FIXED') !== 'FIXED') throw err(`THE_RATE_OF_A_${a.interest_rate_terms}_PRODUCT_CHANGES_ON_THE_PRODUCT`, 409);
  if (!core.OPEN.includes(a.status)) throw err(`ACCOUNT_NOT_OPEN: ${a.status}`, 409);
  const rate = Number(interestRate);
  if (!Number.isFinite(rate)) throw err('INTEREST_RATE_IS_A_NUMBER', 400);
  if (rate < 0 && !a.allow_negative_rate) throw err('A_NEGATIVE_RATE_NEEDS_ALLOW_NEGATIVE_RATE', 400);
  if (a.interest_rate_min !== null && rate < Number(a.interest_rate_min)) throw err(`RATE_BELOW_THE_PRODUCT_MINIMUM: ${a.interest_rate_min}`, 400);
  if (a.interest_rate_max !== null && rate > Number(a.interest_rate_max)) throw err(`RATE_ABOVE_THE_PRODUCT_MAXIMUM: ${a.interest_rate_max}`, 400);
  const today = await orgToday(c);
  const from = valueDate ? S.ymd(valueDate) : today;
  if (from > today) throw err('VALUE_DATE_CANNOT_BE_IN_THE_FUTURE', 400);
  const floor = a.last_interest_applied_on ? core.addDays(S.ymd(a.last_interest_applied_on), 1) : S.ymd(a.opened_on);
  if (from < floor) throw err(`VALUE_DATE_BEFORE_THE_LAST_INTEREST_APPLICATION: from ${floor}`, 400);
  const old = Number(a.interest_rate ?? a.annual_rate);
  // Days already accrued from the value date are priced again.
  let delta = 0;
  const through = a.accrued_through ? S.ymd(a.accrued_through) : null;
  if (through && from <= through && (a.interest_calc_balance || 'END_OF_DAY') !== 'MINIMUM' && a.interest_paid_into_account) {
    const conv = a.interest_day_count || 'ACTUAL_365';
    const { rows: days } = await c.query(
      `SELECT d.day::text AS d, d.balance, x.open_balance, x.min_balance, x.sum_after, x.movements FROM savings_daily_balances d
         LEFT JOIN savings_intraday_balances x ON x.account_id = d.account_id AND x.day = d.day
        WHERE d.account_id = $1 AND d.day BETWEEN $2 AND $3`, [a.id, from, through]);
    const threshold = a.min_balance_for_interest === null ? null : Number(a.min_balance_for_interest);
    for (const r of days) {
      const bal = Number(r.balance);
      let b = a.interest_calc_balance === 'MINIMUM_DAILY' ? (r.movements ? Math.min(Number(r.open_balance), Number(r.min_balance)) : bal)
        : a.interest_calc_balance === 'AVERAGE_DAILY' ? (r.movements ? Number(r.sum_after) / Number(r.movements) : bal) : bal;
      if (a.interest_calc_balance === 'END_OF_DAY' && a.interest_max_balance !== null) b = Math.min(b, Number(a.interest_max_balance));
      if (!(b > 0) || (threshold !== null && b < threshold)) continue;
      const Y = DR.yearDays(conv, r.d);
      delta += b * (rate - old) * DR.annualFactor(a, Y) / 100 * interest.weight(core.addDays(r.d, -1), r.d, conv) / Y;
    }
  }
  await c.query('UPDATE savings_accounts SET interest_rate = $2 WHERE id = $1', [a.id, rate]);
  if (delta !== 0) {
    await c.query('UPDATE savings_accounts SET interest_accrued = GREATEST(0, interest_accrued + $2) WHERE id = $1', [a.id, delta]);
    if (core.books(a) && core.accrues(a)) {
      const u = await core.lock(c, a.id);
      const change = round2(round2(u.interest_accrued) - Number(u.interest_booked));
      if (change !== 0) {
        await accruals.record(c, {
          kind: 'SAVINGS', product: { ...u, id: u.product_id }, accountId: u.id, memberId: u.member_id, branchId: u.branch_id, date: today,
          lines: [{ component: 'INTEREST', debitGl: u.gl_interest_exp, creditGl: u.gl_interest_payable, amount: change }],
          narration: `Interest rate change ${u.account_no} from ${from}`, createdBy,
        });
        await c.query('UPDATE savings_accounts SET interest_booked = interest_booked + $2 WHERE id = $1', [a.id, change]);
      }
    }
  }
  await c.query(`INSERT INTO savings_interest_rate_changes (product_id, account_id, kind, scope, value_date, old_rate, new_rate, notes, created_by)
    VALUES ($1,$2,'CREDIT','ACCOUNT',$3,$4,$5,$6,$7)`, [a.product_id, a.id, from, old, rate, notes, createdBy || 'SYSTEM']);
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_INTEREST_RATE_CHANGED', entity: 'savings_account', entityId: a.id, before: JSON.stringify({ interestRate: old }), after: JSON.stringify({ interestRate: rate, valueDate: from, repriced: round2(delta) }) });
  return { accountId: a.id, interestRate: rate, previousRate: old, valueDate: from, accruedChange: round2(delta) };
}

/**
 * The account's own maximum withdrawal and recommended deposit (the reference platform's
 * account-level amounts). The maximum may not exceed the product's.
 */
function ownLimits(p, x) {
  const out = {};
  if (x.maxWithdrawalAmount !== undefined) {
    const v = x.maxWithdrawalAmount === null || x.maxWithdrawalAmount === '' ? null : round2(x.maxWithdrawalAmount);
    if (v !== null && !(v > 0)) throw err('MAX_WITHDRAWAL_AMOUNT_IS_MORE_THAN_ZERO', 400);
    if (v !== null && p.max_withdrawal_amount !== null && p.max_withdrawal_amount !== undefined && v > Number(p.max_withdrawal_amount)) {
      throw err(`MAX_WITHDRAWAL_AMOUNT_ABOVE_THE_PRODUCT_MAXIMUM: ${p.max_withdrawal_amount}`, 400);
    }
    out.own_max_withdrawal = v;
  }
  if (x.recommendedDepositAmount !== undefined) {
    const v = x.recommendedDepositAmount === null || x.recommendedDepositAmount === '' ? null : round2(x.recommendedDepositAmount);
    if (v !== null && !(v > 0)) throw err('RECOMMENDED_DEPOSIT_AMOUNT_IS_MORE_THAN_ZERO', 400);
    out.own_recommended_deposit = v;
  }
  return out;
}

// The account's terms, which the reference platform lets be edited only before activation.
const TERM_FIELDS = { interestRate: 'interest_rate', interestSpread: 'interest_spread', overdraftRate: 'overdraft_rate',
  overdraftSpread: 'overdraft_spread', termLength: 'term_length' };

/**
 * Edit an account (the reference platform's Editing Accounts). The name, notes and custom
 * field values change at any time, and the maximum balance (the reference platform's
 * maximum deposit balance) too. The terms (the account's interest rate or
 * spread, its overdraft rate or spread, and the term of a fixed deposit or
 * savings plan) change only before activation, within the product's
 * ranges; after it the rate changes through :changeInterestRate and the
 * overdraft through PUT /overdraft.
 */
async function updateAccount(c, accountId, patch = {}, { createdBy, user = null } = {}) {
  const a = await core.lock(c, accountId);
  const sets = {};
  if (patch.maxBalance !== undefined) {
    const v = patch.maxBalance === null || patch.maxBalance === '' ? null : round2(patch.maxBalance);
    if (v !== null && !(v >= 0)) throw err('MAX_BALANCE_IS_ZERO_OR_MORE', 400);
    sets.max_balance = v;
  }
  if (patch.notes !== undefined) sets.notes = patch.notes || null;
  Object.assign(sets, ownLimits(a, patch));
  if (patch.name !== undefined) {
    const n = patch.name === null ? null : String(patch.name).trim();
    if (n !== null && n.length > 255) throw err('NAME_IS_AT_MOST_255_CHARACTERS', 400);
    sets.name = n || null;
  }
  const terms = Object.keys(TERM_FIELDS).filter((k) => patch[k] !== undefined);
  if (terms.length) {
    if (!['PENDING_APPROVAL', 'APPROVED'].includes(a.status)) {
      throw err(`TERMS_ARE_EDITED_BEFORE_ACTIVATION: ${terms.join(', ')} on a ${a.status} account; change the rate with :changeInterestRate and the overdraft with PUT /overdraft`, 409);
    }
    const own = accountTerms(a, Object.fromEntries(terms.map((k) => [k, patch[k] === '' ? null : patch[k]])));
    for (const k of terms) sets[TERM_FIELDS[k]] = patch[k] === null || patch[k] === '' ? null : own[k];
  }
  const hasFields = patch.customFields !== undefined && patch.customFields !== null;
  const keys = Object.keys(sets);
  if (!keys.length && !hasFields) throw err(`NO_UPDATABLE_FIELDS: name, notes, maxBalance, maxWithdrawalAmount, recommendedDepositAmount, customFields, and before activation ${Object.keys(TERM_FIELDS).join(', ')}`, 400);
  let r = a;
  if (keys.length) {
    r = (await c.query(`UPDATE savings_accounts SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      [a.id, ...keys.map((k) => sets[k])])).rows[0];
    await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'SAVINGS_ACCOUNT_EDITED', entity: 'savings_account', entityId: a.id, before: JSON.stringify(Object.fromEntries(keys.map((k) => [k, a[k] ?? null]))), after: JSON.stringify(sets) });
  }
  if (hasFields) {
    await customFields.setValues(c, 'SAVINGS_ACCOUNT', a.id, patch.customFields, { user, createdBy });
    r = (await c.query('SELECT * FROM savings_accounts WHERE id = $1', [a.id])).rows[0];
  }
  return r;
}

// --------------------------------------------------------------------------
// Overdrafts
// --------------------------------------------------------------------------

async function setOverdraftLimit(c, accountId, { limit, expiryDate, interestRate, interestSpread, createdBy } = {}) {
  const a = await core.lock(c, accountId);
  // The reference platform adjusts overdraft terms on active accounts (and one in arrears is
  // active); before activation they are part of the account's terms.
  if (!['ACTIVE', 'IN_ARREARS', 'PENDING_APPROVAL', 'APPROVED'].includes(a.status)) {
    throw err(`OVERDRAFT_TERMS_ARE_ADJUSTED_ON_ACTIVE_ACCOUNTS: the account is ${a.status}`, 409);
  }
  const lim = limit === undefined ? round2(a.overdraft_limit) : round2(limit);
  if (!(lim >= 0)) throw err('INVALID_OVERDRAFT_LIMIT', 400);
  if (lim > 0 && !a.allow_overdraft) throw err('PRODUCT_DOES_NOT_ALLOW_OVERDRAFTS', 409);
  if (a.max_overdraft_limit !== null && lim > Number(a.max_overdraft_limit)) throw err(`OVERDRAFT_LIMIT_ABOVE_PRODUCT_MAXIMUM: ${a.max_overdraft_limit}`, 400);
  if (Number(a.balance) < -lim && !a.allow_technical_overdraft) throw err(`BALANCE_ALREADY_BELOW_THAT_LIMIT: ${a.balance}`, 409);
  // The overdraft expiry date (the reference platform): optional, a date or null to clear it.
  let expires = a.overdraft_expires_on ? S.ymd(a.overdraft_expires_on) : null;
  if (expiryDate !== undefined) {
    if (expiryDate === null || expiryDate === '') expires = null;
    else {
      expires = String(expiryDate).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) throw err('OVERDRAFT_EXPIRY_DATE_IS_A_DATE: yyyy-MM-dd', 400);
    }
  }
  // The credit arrangement it is linked to, or the product's requirement for one.
  await CA.onOverdraft(c, a, { limit: lim, expiresOn: expires });
  // The account's overdraft rate (fixed) or spread (index), within the product's range (the reference platform's Adjust Overdraft Terms).
  let odRate = a.overdraft_rate === null ? null : Number(a.overdraft_rate);
  let odSpread = a.overdraft_spread === null || a.overdraft_spread === undefined ? null : Number(a.overdraft_spread);
  const inRange = (v, lo, hi, what) => {
    if (!Number.isFinite(v)) throw err(`${what}_IS_A_NUMBER`, 400);
    if (lo !== null && lo !== undefined && v < Number(lo)) throw err(`${what}_BELOW_THE_PRODUCT_MINIMUM: ${lo}`, 400);
    if (hi !== null && hi !== undefined && v > Number(hi)) throw err(`${what}_ABOVE_THE_PRODUCT_MAXIMUM: ${hi}`, 400);
  };
  if (interestRate !== undefined) {
    if ((a.od_rate_terms || 'FIXED') !== 'FIXED') throw err(`THE_OVERDRAFT_RATE_OF_A_${a.od_rate_terms}_PRODUCT_IS_SET_ON_THE_PRODUCT`, 409);
    odRate = interestRate === null ? null : Number(interestRate);
    if (odRate !== null) { inRange(odRate, a.od_rate_min, a.od_rate_max, 'OVERDRAFT_RATE'); if (odRate < 0) throw err('OVERDRAFT_RATE_CANNOT_BE_NEGATIVE', 400); }
  }
  if (interestSpread !== undefined) {
    if (a.od_rate_terms !== 'INDEX') throw err('A_SPREAD_IS_FOR_AN_INDEX_OVERDRAFT_RATE', 409);
    odSpread = interestSpread === null ? null : Number(interestSpread);
    if (odSpread !== null) inRange(odSpread, a.od_spread_min, a.od_spread_max, 'OVERDRAFT_SPREAD');
  }
  const { rows: [r] } = await c.query(
    'UPDATE savings_accounts SET overdraft_limit = $1, overdraft_expires_on = $3, overdraft_rate = $4, overdraft_spread = $5 WHERE id = $2 RETURNING *',
    [lim, a.id, expires, odRate, odSpread]);
  for (const [was, now] of [[a.overdraft_rate, odRate], [a.overdraft_spread, odSpread]]) {
    if ((was === null || was === undefined ? null : Number(was)) !== now && (interestRate !== undefined || interestSpread !== undefined)) {
      await c.query(`INSERT INTO savings_interest_rate_changes (product_id, account_id, kind, scope, value_date, old_rate, new_rate, created_by)
        VALUES ($1,$2,'OVERDRAFT','ACCOUNT',current_date,$3,$4,$5)`, [a.product_id, a.id, was, now, createdBy || 'SYSTEM']);
      break;
    }
  }
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'OVERDRAFT_LIMIT_SET', entity: 'savings_account', entityId: a.id, before: JSON.stringify({ overdraftLimit: Number(a.overdraft_limit), overdraftExpiryDate: a.overdraft_expires_on ? S.ymd(a.overdraft_expires_on) : null }), after: JSON.stringify({ overdraftLimit: lim, overdraftExpiryDate: expires, overdraftRate: odRate, overdraftSpread: odSpread }) });
  if (await core.followArrears(c, a.id, await orgToday(c), { limitChanged: lim < Number(a.overdraft_limit), createdBy: createdBy || 'SYSTEM' })) {
    return (await c.query('SELECT * FROM savings_accounts WHERE id = $1', [a.id])).rows[0];
  }
  return r;
}

/**
 * Write off an overdraft: the balance returns to zero. Under accrual the
 * portfolio (principal, applied interest and fees) and any accrued overdraft
 * interest go to the write-off expense; under cash, charges owed but never
 * recognised are simply cleared.
 */
async function writeOffOverdraft(c, accountId, { narration, createdBy, closing = false } = {}) {
  const a = await core.lock(c, accountId);
  if (a.status === 'LOCKED' && !closing) throw err('ACCOUNT_LOCKED: unlock it first', 409);
  const overdrawn = round2(-Number(a.balance));
  if (!(overdrawn > 0)) throw err('ACCOUNT_IS_NOT_OVERDRAWN', 409);
  const cashCharges = round2(Number(a.od_fees_due) + Number(a.od_interest_due));
  const portfolio = round2(overdrawn - cashCharges);
  const accruedOd = round2(a.od_interest_booked);
  let entryId = null;
  if (core.books(a)) {
    const credits = [];
    if (portfolio > 0) credits.push({ glCode: a.gl_od_portfolio, amount: portfolio, memberId: a.member_id, branchId: a.branch_id });
    if (accruedOd > 0) credits.push({ glCode: a.gl_od_interest_rec, amount: accruedOd, memberId: a.member_id, branchId: a.branch_id });
    const total = round2(portfolio + accruedOd);
    if (total > 0) {
      entryId = (await acct.post(c, {
        debits: [{ glCode: a.gl_od_writeoff, amount: total, memberId: a.member_id, branchId: a.branch_id }],
        credits, narration: narration || `Overdraft write-off ${a.account_no}`,
        sourceType: 'OVERDRAFT_WRITE_OFF', sourceId: a.id, createdBy, branchId: a.branch_id,
      })).entryId;
    }
  }
  await c.query(
    `UPDATE savings_accounts SET balance = 0, od_fees_due = 0, od_interest_due = 0, od_interest_accrued = 0,
       od_interest_booked = 0, overdraft_limit = 0 WHERE id = $1`, [a.id]);
  const t = await core.record(c, {
    reference: core.ref('OW'), kind: 'OVERDRAFT_WRITE_OFF', memberId: a.member_id, savingsAccountId: a.id, amount: overdrawn,
    branchId: a.branch_id, entryId, createdBy, narration,
    // What it cleared, so that undoing a closing write-off puts it back.
    allocation: { portfolio, accruedInterest: accruedOd, cashChargesCleared: cashCharges,
      cleared: { odFeesDue: Number(a.od_fees_due), odInterestDue: Number(a.od_interest_due), odInterestAccrued: Number(a.od_interest_accrued),
        odInterestBooked: Number(a.od_interest_booked), overdraftLimit: Number(a.overdraft_limit) },
      closing, statusBefore: a.status },
  });
  if (!closing) await core.followArrears(c, a.id, await orgToday(c), { createdBy: createdBy || 'SYSTEM' });
  return t;
}

/** An account's own rate, spread, maximum balance and term, checked against its product. */
function accountTerms(p, x) {
  const out = { interestRate: null, interestSpread: null, overdraftRate: null, overdraftSpread: null, maxBalance: null, termLength: null };
  const within = (v, lo, hi, what) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw err(`${what}_IS_A_NUMBER`, 400);
    if (lo !== null && lo !== undefined && n < Number(lo)) throw err(`${what}_BELOW_THE_PRODUCT_MINIMUM: ${lo}`, 400);
    if (hi !== null && hi !== undefined && n > Number(hi)) throw err(`${what}_ABOVE_THE_PRODUCT_MAXIMUM: ${hi}`, 400);
    return n;
  };
  if (x.interestRate !== undefined && x.interestRate !== null) {
    if ((p.interest_rate_terms || 'FIXED') !== 'FIXED') throw err(`A_${p.interest_rate_terms}_PRODUCT_SETS_THE_RATE`, 400);
    out.interestRate = within(x.interestRate, p.interest_rate_min, p.interest_rate_max, 'INTEREST_RATE');
    if (out.interestRate < 0 && !p.allow_negative_rate) throw err('A_NEGATIVE_RATE_NEEDS_ALLOW_NEGATIVE_RATE', 400);
  }
  if (x.interestSpread !== undefined && x.interestSpread !== null) {
    if (p.interest_rate_terms !== 'INDEX') throw err('A_SPREAD_IS_FOR_AN_INDEX_RATE', 400);
    out.interestSpread = within(x.interestSpread, p.interest_spread_min, p.interest_spread_max, 'INTEREST_SPREAD');
  }
  if (x.overdraftRate !== undefined && x.overdraftRate !== null) {
    if (!p.allow_overdraft || (p.od_rate_terms || 'FIXED') !== 'FIXED') throw err('AN_OVERDRAFT_RATE_NEEDS_A_FIXED_OVERDRAFT_RATE_PRODUCT', 400);
    out.overdraftRate = within(x.overdraftRate, p.od_rate_min, p.od_rate_max, 'OVERDRAFT_RATE');
  }
  if (x.overdraftSpread !== undefined && x.overdraftSpread !== null) {
    if (p.od_rate_terms !== 'INDEX') throw err('A_SPREAD_IS_FOR_AN_INDEX_OVERDRAFT_RATE', 400);
    out.overdraftSpread = within(x.overdraftSpread, p.od_spread_min, p.od_spread_max, 'OVERDRAFT_SPREAD');
  }
  if (x.maxBalance !== undefined && x.maxBalance !== null) out.maxBalance = within(x.maxBalance, 0, null, 'MAX_BALANCE');
  if (x.termLength !== undefined && x.termLength !== null) {
    if (!DR.hasTerm(p.product_type)) throw err('A_TERM_IS_FOR_FIXED_DEPOSITS_AND_SAVINGS_PLANS', 400);
    out.termLength = within(x.termLength, p.term_min, p.term_max, 'TERM_LENGTH');
    if (!Number.isInteger(out.termLength) || out.termLength <= 0) throw err('TERM_LENGTH_IS_A_WHOLE_NUMBER', 400);
  }
  return out;
}

Object.assign(module.exports, {
  changeInterestRate, ownLimits, TERM_FIELDS, updateAccount, setOverdraftLimit, writeOffOverdraft, accountTerms,
});
