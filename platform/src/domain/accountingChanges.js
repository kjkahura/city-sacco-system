'use strict';

const acct = require('./accounting');
const PA = require('./productAccounting');
const accruals = require('./accruals');
const tax = require('./tax');
const ledger = require('./ledger');
const savings = require('./savings');
const { err, round2 } = acct;

/**
 * Changing the accounting method of a product that has accounts.
 *
 * Mambu's documentation lets the method be edited but does not say what
 * happens to balances already booked. Here a change is its own action, never
 * a plain product edit, and it converts what is open so nothing is stranded:
 *
 *   ACCRUAL to CASH or NONE   receivables and payables built by accrual are
 *                             reversed against income or expense
 *   CASH or NONE to ACCRUAL   what is owed at the change is booked into them
 *   anything to NONE          the portfolio and deposit balances leave the
 *                             product's accounts for the suspense account
 *   NONE to anything          and come back from it
 *
 * The change is allowed only once the previous month is closed (a tenant-
 * wide accounting closure through its last day or later), so it happens at
 * a period boundary and never rewrites a period someone has reported. It is
 * booked today, one entry per account, and recorded with the reason, who
 * made it and the amounts converted on every account.
 */

const today = () => new Date().toISOString().slice(0, 10);
const lastDayOfPreviousMonth = (iso) => {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  return new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
};

async function assertAtBoundary(c, date) {
  const { rows: [r] } = await c.query(
    'SELECT max(closed_through) AS d FROM accounting_closures WHERE deleted_at IS NULL AND branch_id IS NULL');
  const need = lastDayOfPreviousMonth(date);
  const have = r.d ? acct.isoDay(r.d) : null;
  if (!have || have < need) {
    throw err(`CHANGE_NEEDS_PREVIOUS_MONTH_CLOSED: close the books tenant-wide through ${need} first${have ? ` (closed through ${have})` : ''}`, 409);
  }
}

/** Post pending accrual lines for a product now, whatever their mode, so the conversion reads booked figures. */
async function flushProduct(c, kind, productId, date, createdBy) {
  const { rows } = await c.query(
    `SELECT DISTINCT account_id FROM accrual_lines
     WHERE account_kind = $1 AND product_id = $2 AND entry_id IS NULL AND settled_at IS NULL`, [kind, productId]);
  if (!rows.length) return 0;
  await c.query(
    `UPDATE accrual_lines SET post_mode = 'END_OF_DAY', booking_date = LEAST(booking_date, $3::date)
     WHERE account_kind = $1 AND product_id = $2 AND entry_id IS NULL AND settled_at IS NULL`, [kind, productId, date]);
  await accruals.flush(c, { date, createdBy });
  return rows.length;
}

function lines() {
  const debits = [];
  const credits = [];
  return {
    debits, credits,
    move(dr, cr, amount, memberId, branchId) {
      const a = round2(amount);
      if (!(a > 0)) return;
      debits.push({ glCode: dr, amount: a, memberId, branchId });
      credits.push({ glCode: cr, amount: a, memberId, branchId });
    },
  };
}

async function record(c, row) {
  const { rows: [r] } = await c.query(
    `INSERT INTO product_accounting_changes (product_kind, product_id, from_method, to_method, from_accrued_accounting,
       to_accrued_accounting, effective_on, reason, accounts, entry_ids, detail, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [row.kind, row.productId, row.from, row.to, row.fromAcc, row.toAcc, row.date, row.reason, row.accounts,
      row.entryIds, JSON.stringify(row.detail), row.createdBy || 'SYSTEM']);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [row.createdBy || 'SYSTEM', `${row.kind}_PRODUCT_ACCOUNTING_CHANGED`, row.kind === 'LOAN' ? 'loan_product' : 'savings_product',
      row.productId, JSON.stringify({ method: row.from, accruedAccounting: row.fromAcc }),
      JSON.stringify({ method: row.to, accruedAccounting: row.toAcc, reason: row.reason, changeId: r.id })]);
  return r;
}

function normalise(to, toAcc) {
  if (!PA.METHODS.includes(to)) throw err(`accounting method must be one of ${PA.METHODS.join(', ')}`, 400);
  const acc = toAcc ?? (to === 'ACCRUAL' ? 'DAILY' : 'NONE');
  if (!PA.ACCRUED.includes(acc)) throw err(`interestAccruedAccounting must be one of ${PA.ACCRUED.join(', ')}`, 400);
  if (to !== 'ACCRUAL' && acc !== 'NONE') throw err(`INTEREST_ACCRUED_METHOD_INVALID: under ${to} the interest accrued method must be NONE`, 400);
  return acc;
}

// --------------------------------------------------------------------------
// Loan products
// --------------------------------------------------------------------------

async function changeLoanProduct(c, productId, { method, interestAccruedAccounting, mappings = {}, reason, createdBy } = {}) {
  if (!reason || !String(reason).trim()) throw err('REASON_REQUIRED', 400);
  const { rows: [p] } = await c.query('SELECT * FROM loan_products WHERE id = $1 FOR UPDATE', [productId]);
  if (!p) throw err('UNKNOWN_LOAN_PRODUCT', 404);
  if (p.funding_enabled) throw err('FUNDED_PRODUCT_METHOD_CHANGE_NOT_SUPPORTED: funded loans split interest with funders; create a new product', 409);
  const toAcc = normalise(method, interestAccruedAccounting);
  if (method === p.accounting_method && toAcc === p.interest_accrued_accounting) throw err('NOTHING_TO_CHANGE', 409);
  const date = today();
  await assertAtBoundary(c, date);

  const next = { ...p, ...mappings, accounting_method: method, interest_accrued_accounting: toAcc };
  const pa = await PA.validate(c, 'LOAN', next, mappings);
  if (pa.problems.length) throw err(`INVALID_ACCOUNTING_CHANGE: ${pa.problems.join('; ')}`, 400);

  await flushProduct(c, 'LOAN', productId, date, createdBy);
  const suspense = await PA.suspense(c);
  const oldP = p;
  const newP = next;
  const principalIn = (x) => x.accounting_method !== 'NONE';
  const interestIn = (x) => ledger.interestAccrues(x);
  const chargesIn = (x) => x.accounting_method === 'ACCRUAL';

  const { rows: open } = await c.query(
    `SELECT id FROM loan_accounts WHERE product_id = $1 AND status IN ('ACTIVE','IN_ARREARS','LOCKED') ORDER BY account_no`, [productId]);
  const entryIds = [];
  const detail = [];
  for (const { id } of open) {
    const l = await ledger.lock(c, id);
    const b = ledger.balances(l);
    const L = lines();
    const mid = l.member_id;
    const br = l.branch_id;
    const conv = {};
    // Principal: the portfolio.
    if (principalIn(oldP) !== principalIn(newP) && b.principal > 0) {
      if (principalIn(oldP)) L.move(suspense, oldP.gl_portfolio, b.principal, mid, br);
      else L.move(newP.gl_portfolio, suspense, b.principal, mid, br);
      conv.principal = b.principal;
    }
    // Interest, fees and penalties: the receivables.
    const comps = [
      ['interest', 'INTEREST', b.interest, interestIn, 'gl_interest_rec', (x) => x.gl_interest_inc],
      ['fees', 'FEE', b.fees, chargesIn, 'gl_fee_rec', (x) => x.gl_fee_inc || x.gl_interest_inc],
      ['penalty', 'PENALTY', b.penalty, chargesIn, 'gl_penalty_rec', (x) => x.gl_penalty_inc || x.gl_interest_inc],
    ];
    for (const [name, component, amount, inGl, recCol, incomeOf] of comps) {
      if (!(amount > 0) || inGl(oldP) === inGl(newP)) continue;
      const side = inGl(oldP) ? oldP : newP;
      const s = tax.splitPaid({ ...l, ...side }, component, amount);
      if (inGl(oldP)) {
        L.move(incomeOf(oldP), oldP[recCol], s.income, mid, br);
        if (s.tax > 0) L.move(oldP.gl_tax_payable, oldP[recCol], s.tax, mid, br);
      } else {
        L.move(newP[recCol], incomeOf(newP), s.income, mid, br);
        if (s.tax > 0) L.move(newP[recCol], newP.gl_tax_payable, s.tax, mid, br);
      }
      conv[name] = amount;
    }
    if (L.debits.length) {
      const e = await acct.post(c, {
        debits: L.debits, credits: L.credits, branchId: br,
        narration: `Accounting method ${oldP.accounting_method} to ${method} ${l.account_no}`,
        sourceType: 'ACCOUNTING_METHOD_CHANGE', sourceId: l.id, bookingDate: date, createdBy,
      });
      entryIds.push(e.entryId);
    }
    if (Object.keys(conv).length) detail.push({ accountId: l.id, accountNo: l.account_no, ...conv });
  }

  const cols = { ...mappings, accounting_method: method, interest_accrued_accounting: toAcc };
  const keys = Object.keys(cols);
  const { rows: [after] } = await c.query(
    `UPDATE loan_products SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [productId, ...keys.map((k) => cols[k])]);
  await PA.recordMappings(c, 'LOAN', productId, p, after, createdBy);
  return record(c, {
    kind: 'LOAN', productId, from: p.accounting_method, to: method, fromAcc: p.interest_accrued_accounting, toAcc,
    date, reason, accounts: open.length, entryIds, detail, createdBy,
  });
}

// --------------------------------------------------------------------------
// Deposit products
// --------------------------------------------------------------------------

async function changeDepositProduct(c, productId, { method, interestAccruedAccounting, mappings = {}, reason, createdBy } = {}) {
  if (!reason || !String(reason).trim()) throw err('REASON_REQUIRED', 400);
  const { rows: [p] } = await c.query('SELECT * FROM savings_products WHERE id = $1 FOR UPDATE', [productId]);
  if (!p) throw err('UNKNOWN_DEPOSIT_PRODUCT', 404);
  const toAcc = normalise(method, interestAccruedAccounting);
  if (method === p.accounting_method && toAcc === p.interest_accrued_accounting) throw err('NOTHING_TO_CHANGE', 409);
  const date = today();
  await assertAtBoundary(c, date);

  const next = { ...p, ...mappings, accounting_method: method, interest_accrued_accounting: toAcc };
  const pa = await PA.validate(c, 'DEPOSIT', next, mappings);
  if (pa.problems.length) throw err(`INVALID_ACCOUNTING_CHANGE: ${pa.problems.join('; ')}`, 400);

  await flushProduct(c, 'SAVINGS', productId, date, createdBy);
  const suspense = await PA.suspense(c);
  const oldP = p;
  const newP = next;
  const booksOf = (x) => x.accounting_method !== 'NONE';

  const { rows: open } = await c.query(
    `SELECT id FROM savings_accounts WHERE product_id = $1 AND status IN ('ACTIVE','DORMANT','LOCKED') ORDER BY account_no`, [productId]);
  const entryIds = [];
  const detail = [];
  for (const { id } of open) {
    const a = await savings.lock(c, id);
    const L = lines();
    const mid = a.member_id;
    const br = a.branch_id;
    const conv = {};
    const bal = Number(a.balance);
    const positive = round2(Math.max(0, bal));
    const odDues = round2(Number(a.od_fees_due) + Number(a.od_interest_due));
    const portfolio = round2(Math.max(0, -bal) - odDues);
    const sets = [];

    if (booksOf(oldP) !== booksOf(newP)) {
      if (positive > 0) {
        if (booksOf(oldP)) L.move(oldP.gl_liability, suspense, positive, mid, br);
        else L.move(suspense, newP.gl_liability, positive, mid, br);
        conv.savings = positive;
      }
      if (portfolio > 0) {
        if (booksOf(oldP)) L.move(suspense, oldP.gl_od_portfolio, portfolio, mid, br);
        else L.move(newP.gl_od_portfolio, suspense, portfolio, mid, br);
        conv.overdraft = portfolio;
      }
    }
    // Overdraft charges owed under cash become portfolio and income under accrual.
    if (oldP.accounting_method === 'CASH' && newP.accounting_method === 'ACCRUAL' && odDues > 0) {
      L.move(newP.gl_od_portfolio, newP.gl_fee_inc, a.od_fees_due, mid, br);
      L.move(newP.gl_od_portfolio, newP.gl_od_interest_inc, a.od_interest_due, mid, br);
      sets.push('od_fees_due = 0', 'od_interest_due = 0');
      conv.overdraftChargesRecognised = odDues;
    }
    // Accrued interest: payable and receivables.
    const oldAcc = booksOf(oldP) && PA.accrues(oldP);
    const newAcc = booksOf(newP) && PA.accrues(newP);
    const comps = [
      ['interest', 'interest_accrued', 'interest_booked', 'gl_interest_exp', 'gl_interest_payable'],
      ['negativeInterest', 'neg_interest_accrued', 'neg_interest_booked', 'gl_neg_interest_rec', 'gl_neg_interest_inc'],
      ['overdraftInterest', 'od_interest_accrued', 'od_interest_booked', 'gl_od_interest_rec', 'gl_od_interest_inc'],
    ];
    if (oldAcc !== newAcc) {
      for (const [name, accruedCol, bookedCol, drCol, crCol] of comps) {
        if (oldAcc) {
          const booked = round2(a[bookedCol]);
          if (booked > 0 && oldP[drCol] && oldP[crCol]) {
            L.move(oldP[crCol], oldP[drCol], booked, mid, br);
            sets.push(`${bookedCol} = 0`);
            conv[name] = booked;
          }
        } else {
          const accrued = round2(a[accruedCol]);
          if (accrued > 0 && newP[drCol] && newP[crCol]) {
            L.move(newP[drCol], newP[crCol], accrued, mid, br);
            sets.push(`${bookedCol} = ${accrued}`);
            conv[name] = accrued;
          }
        }
      }
    }
    if (L.debits.length) {
      const e = await acct.post(c, {
        debits: L.debits, credits: L.credits, branchId: br,
        narration: `Accounting method ${oldP.accounting_method} to ${method} ${a.account_no}`,
        sourceType: 'ACCOUNTING_METHOD_CHANGE', sourceId: a.id, bookingDate: date, createdBy,
      });
      entryIds.push(e.entryId);
    }
    if (sets.length) await c.query(`UPDATE savings_accounts SET ${sets.join(', ')} WHERE id = $1`, [a.id]);
    if (Object.keys(conv).length) detail.push({ accountId: a.id, accountNo: a.account_no, ...conv });
  }

  const cols = { ...mappings, accounting_method: method, interest_accrued_accounting: toAcc };
  const keys = Object.keys(cols);
  const { rows: [after] } = await c.query(
    `UPDATE savings_products SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [productId, ...keys.map((k) => cols[k])]);
  await PA.recordMappings(c, 'DEPOSIT', productId, p, after, createdBy);
  return record(c, {
    kind: 'DEPOSIT', productId, from: p.accounting_method, to: method, fromAcc: p.interest_accrued_accounting, toAcc,
    date, reason, accounts: open.length, entryIds, detail, createdBy,
  });
}

async function history(c, kind, productId) {
  const { rows } = await c.query(
    'SELECT * FROM product_accounting_changes WHERE product_kind = $1 AND product_id = $2 ORDER BY created_at', [kind, productId]);
  return rows;
}

module.exports = { changeLoanProduct, changeDepositProduct, history, assertAtBoundary, lastDayOfPreviousMonth };
