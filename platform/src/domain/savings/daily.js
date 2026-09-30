'use strict';

/**
 * Deposit accounts: the end of day (accrual, application, maturity, monthly fees, dormancy, arrears).
 */

const S = require('../schedule');
const { recordAudit } = require('../../lib/auditLog');
const core = require('./core');
const interest = require('./interest');
const transactions = require('./transactions');

/**
 * The end of day for deposits: accrue every open account, apply on
 * application dates (not on dormant accounts), mature the fixed deposits and savings plans whose date
 * has come, charge monthly fees, and make dormant the accounts without
 * financial activity for the product's dormancy days (the reference platform: anything but
 * interest postings counts as activity; fees the end of day charges do not).
 */
async function endOfDay(c, { date, createdBy = 'EOD' } = {}) {
  const { rows } = await c.query(
    `SELECT a.id, a.status, a.opened_on, a.maturity_date, p.interest_application, p.interest_fixed_dates
       FROM savings_accounts a JOIN savings_products p ON p.id = a.product_id
     WHERE a.status = ANY($1) ORDER BY a.account_no`, [core.OPEN]);
  let accrued = 0;
  let applied = 0;
  let matured = 0;
  for (const r of rows) {
    const x = await interest.accrueInterest(c, r.id, { date, createdBy });
    if (x) accrued += 1;
    // A dormant account gets no automated transactions (the reference platform): what it
    // accrued before is applied once it is active again.
    if (r.status !== 'DORMANT' && interest.isApplicationDate(date, { ...r, opened_on: S.ymd(r.opened_on) })) {
      const done = await interest.applyInterest(c, r.id, { date, createdBy });
      if (done.length) applied += 1;
    }
    if (r.maturity_date && S.ymd(r.maturity_date) <= date && ['ACTIVE', 'DORMANT'].includes(r.status)) {
      await c.query("UPDATE savings_accounts SET status = 'MATURED' WHERE id = $1", [r.id]);
      await recordAudit(c, { actor: createdBy, action: 'SAVINGS_ACCOUNT_MATURED', entity: 'savings_account', entityId: r.id, before: JSON.stringify({ status: r.status }), after: JSON.stringify({ status: 'MATURED', on: date }) });
      matured += 1;
    }
  }
  const fees = await transactions.applyMonthlyFees(c, { date, createdBy });
  const { rows: dormant } = await c.query(
    `UPDATE savings_accounts a SET status = 'DORMANT'
       FROM savings_products p
      WHERE p.id = a.product_id AND a.status = 'ACTIVE' AND p.dormancy_days IS NOT NULL
        AND p.product_type NOT IN ('FIXED_DEPOSIT', 'SAVINGS_PLAN')
        AND COALESCE(a.last_activity_on, a.opened_on) <= ($1::date - p.dormancy_days)
      RETURNING a.id, a.account_no`, [date]);
  for (const d of dormant) {
    await recordAudit(c, { actor: createdBy, action: 'SAVINGS_ACCOUNT_DORMANT', entity: 'savings_account', entityId: d.id, before: JSON.stringify({ status: 'ACTIVE' }), after: JSON.stringify({ status: 'DORMANT', on: date }) });
  }
  // In Arrears: overdrawn past the overdraft expiry date, or covered again.
  const { rows: watch } = await c.query(
    `SELECT id FROM savings_accounts WHERE status = 'IN_ARREARS'
        OR (status = 'ACTIVE' AND balance < 0 AND overdraft_expires_on < $1::date) ORDER BY account_no`, [date]);
  let inArrears = 0;
  for (const w of watch) if (await core.followArrears(c, w.id, date, { createdBy }) === 'IN_ARREARS') inArrears += 1;
  return { accounts: rows.length, accrued, applied, matured, dormant: dormant.length, inArrears, fees };
}

Object.assign(module.exports, {
  endOfDay,
});
