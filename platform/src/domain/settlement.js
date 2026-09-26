'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const ledger = require('./ledger');
const savings = require('./savings');
const loans = require('./loans');
const G = require('./eodGuard');
const { round2 } = acct;
const { ymd, isoDate } = S;

/**
 * The settlement transfer (./settlementLinks for the links): at the end of
 * the day, every running loan linked to a settlement deposit account has
 * what it owes now taken from that account, in the product's settlement
 * option:
 *
 *   FULL_DUES  only if the account can cover the whole amount due
 *   PARTIAL    whatever the account can cover
 *   NONE       nothing (the accounts are only linked)
 *
 * What is due is the charges owed (penalties, fees, interest earned) and
 * the principal of installments fallen due: what the loan would take
 * without it being a prepayment. The deposit account's own rules stand (a
 * product that cannot be withdrawn from, the minimum balance, deposits
 * pledged as loan security, overdraft only where allowed), so a transfer
 * the account cannot make is not made and the loan goes into arrears as
 * any unpaid loan would. It is a withdrawal from the deposit account and a
 * repayment of the loan through the settlement channel (290-200 Settlement
 * Clearing), so the clearing account nets to nothing.
 *
 * A deposit account settling several loans pays them in the order they were
 * linked. The run happens on each day something is due, so a loan that
 * could not be paid on its due date is paid once the money arrives.
 *
 * This module stands above ./loans, like ./restructure.
 */

async function dueNow(c, l, asOf) {
  const b = ledger.balances(l);
  const { rows: [pd] } = await c.query(
    `SELECT COALESCE(sum(principal_due - principal_paid), 0) AS p FROM loan_installments
     WHERE loan_id = $1 AND due_date <= $2::date AND status NOT IN ('PAID', 'GRACE')`, [l.id, asOf]);
  return round2(Math.max(0, b.penalty) + Math.max(0, b.fees) + Math.max(0, b.interest) + Math.min(Number(pd.p), b.principal));
}

async function run(c, { asOf = null, createdBy = 'EOD', loanId = null } = {}) {
  const date = asOf ? ymd(asOf) : isoDate(new Date());
  const { rows } = await c.query(
    `SELECT l.id FROM loan_accounts l JOIN loan_products p ON p.id = l.product_id
     WHERE l.settlement_account_id IS NOT NULL AND l.status IN ('ACTIVE', 'IN_ARREARS')
       AND p.settlement_enabled AND p.settlement_option <> 'NONE' AND ${G.EXCLUDED_SQL('l')}
       AND ($1::uuid IS NULL OR l.id = $1::uuid)
     ORDER BY l.settlement_account_id, l.settlement_linked_at, l.id`, [loanId]);
  const out = { loans: rows.length, transferred: 0, amount: 0, short: 0, failed: 0 };
  for (const { id } of rows) {
    const l = await ledger.lock(c, id);
    const due = await dueNow(c, l, date);
    if (!(due > 0)) continue;
    const a = await savings.lock(c, l.settlement_account_id);
    if (a.status !== 'ACTIVE' || !a.withdrawable) { out.short += 1; continue; }
    const available = savings.availableOf(a, await savings.pledgedAmount(c, a.member_id));
    let amount;
    if (l.settlement_option === 'FULL_DUES') amount = available >= due ? due : 0;
    else amount = round2(Math.min(Math.max(0, available), due));
    if (!(amount > 0)) { out.short += 1; continue; }
    await c.query('SAVEPOINT settlement');
    try {
      await savings.withdraw(c, a.id, { amount, channelId: 'settlement', valueDate: date, narration: `Settlement of loan ${l.account_no}`, createdBy });
      await loans.repay(c, l.id, { amount, channelId: 'settlement', valueDate: date, narration: `From settlement account ${a.account_no}`, createdBy });
      await c.query('RELEASE SAVEPOINT settlement');
      out.transferred += 1;
      out.amount = round2(out.amount + amount);
      if (amount < due) out.short += 1;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT settlement');
      out.failed += 1;
      (out.errors = out.errors || []).push({ loan: l.account_no, error: String(e.message).slice(0, 200) });
    }
  }
  return out;
}

module.exports = { run, dueNow };
