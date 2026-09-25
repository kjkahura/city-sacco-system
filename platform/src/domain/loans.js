'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const S = require('./schedule');
const tax = require('./tax');
const ledger = require('./ledger');
const controls = require('./controls');
const tranches = require('./tranches');
const funding = require('./funding');
const eligibility = require('./eligibility');
const securities = require('./securities');
const workflow = require('./workflow');
const fees = require('./fees');
const installments = require('./installments');
const interest = require('./interest');
const types = require('./productTypes');
const PA = require('./productAccounting');
const writeOffs = require('./writeOffs');
const { err, round2 } = acct;
const { ymd, isoDate } = S;
const {
  OVERRIDES, resolveOverrides, within,
  lock, balances, interestAccrues, booksEntries, post, creditsFor,
} = ledger;
const { buildSchedule, reschedule, applyToInstallments } = installments;
const { accrueInterest } = interest;

/**
 * What a product type's hooks may call back into: the lifecycle operations
 * that live above ./productTypes. Passed rather than required, so the type
 * files stay low in the layer graph.
 */
const ops = { lock, buildSchedule, reschedule, accrueInterest, fees };

/**
 * The money movements of a loan's life: opening the application,
 * disbursement, repayment, write-off and reversal. Every function takes an
 * open tenant client.
 *
 * Balance columns are only ever changed by SQL expressions on the numeric
 * type. Nothing is read into JS, adjusted and written back, so two tellers
 * posting repayments to the same loan cannot lose one of them.
 *
 * What this module stands on (see the layer list in ./ledger):
 *   ledger        reading a loan, balances, overrides, accounting rules
 *   installments  the schedule and its persistence
 *   interest      accrual and capitalisation
 *   eligibility   guarantors, cover, approval rules
 *   workflow      states, history, arrears, the charge cap
 *   fees, funding, tranches, revolving, securities, tax
 *
 * The module's exports also re-export those modules' functions under the
 * names callers learned when everything lived here, so routes, the EOD job
 * and tests keep working unchanged.
 */

// --------------------------------------------------------------------------
// Account numbers
// --------------------------------------------------------------------------

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // no I or O, which read as 1 and 0
const DIGITS = '0123456789';
const pick = (s) => s[Math.floor(Math.random() * s.length)];

/**
 * Fill a product's id_pattern. '#' is a digit, '@' a letter, '$' either,
 * anything else literal. Under INCREMENTAL the run of '#' carries the
 * sequence number, zero-padded; under RANDOM every placeholder is drawn.
 */
function fillPattern(pattern, sequence = null) {
  const hashes = (pattern.match(/#/g) || []).length;
  let digits = sequence === null ? null : String(sequence).padStart(hashes, '0');
  if (digits && digits.length > hashes) {
    // The sequence outgrew the pattern; the extra digits go on the front of
    // the run rather than the number being refused.
    const extra = digits.length - hashes;
    pattern = pattern.replace('#', '#'.repeat(extra + 1));
  }
  let di = 0;
  let out = '';
  for (const ch of pattern) {
    if (ch === '#') out += digits ? digits[di++] : pick(DIGITS);
    else if (ch === '@') out += pick(LETTERS);
    else if (ch === '$') out += pick(LETTERS + DIGITS);
    else out += ch;
  }
  return out;
}

async function nextAccountNo(c, p) {
  const pattern = p.id_pattern || 'LN######';
  if ((p.id_mode || 'INCREMENTAL') === 'INCREMENTAL') {
    // Products that share a pattern share the series: the next number is
    // the larger of this product's counter and one past the highest number
    // already issued under the pattern's prefix, so two products numbered
    // LN###### never both issue LN000001.
    const prefix = pattern.split(/[#@$]/)[0];
    const { rows: [m] } = await c.query(
      `SELECT COALESCE(max(substring(account_no FROM '[0-9]+$')::bigint), 0) AS n
       FROM loan_accounts WHERE account_no LIKE $1 || '%' AND account_no ~ ('^' || $1 || '[A-Z0-9]*[0-9]+$')`,
      [prefix]);
    const { rows: [r] } = await c.query(
      `UPDATE loan_products SET id_next = GREATEST(id_next, $2::bigint + 1) + 1 WHERE id = $1 RETURNING id_next - 1 AS n`,
      [p.id, Number(m.n)]);
    return fillPattern(pattern, Number(r.n));
  }
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = fillPattern(pattern);
    const { rowCount } = await c.query('SELECT 1 FROM loan_accounts WHERE account_no = $1', [candidate]);
    if (!rowCount) return candidate;
  }
  throw err(`ID_PATTERN_EXHAUSTED: ${pattern}`, 409);
}

/**
 * Open a loan application under a product. The core terms (amount and
 * number of installments) default from the product and must sit inside its
 * band; so must every override the member is given (ledger.OVERRIDES: rate,
 * penalty rate, first due date offset, grace, amortisation, arrears
 * tolerance, revolving repayment value, organisation commission). The
 * account number follows the product's pattern and the initial state is
 * the product's: an application that still needs documents starts
 * PARTIAL_APPLICATION, one that is complete PENDING_APPROVAL.
 *
 * `refinance` ({ of, arrears, topUp }) is set only by ./restructure when it
 * opens a top-up application, never from a request body: the application
 * then settles that running loan when it is disbursed. `settles` names a
 * running loan the new one replaces (a top-up's, or a reschedule's), which
 * is left out of the exposure check.
 */
async function apply(c, params, { refinance = null, settles = refinance?.of || null } = {}) {
  const { memberId, productId = 'NL01', principal, termMonths, purpose, notes, accountNo, createdBy,
    tranches: plannedTranches = null, fundingSources = null, collateral = null, branchId = undefined } = params;
  const { rows: [p] } = await c.query('SELECT * FROM loan_products WHERE id = $1 AND is_active', [productId]);
  if (!p) throw err('UNKNOWN_LOAN_PRODUCT', 404);

  const amount = round2(principal ?? p.default_principal);
  if (!(amount > 0)) throw err('INVALID_PRINCIPAL', 400);
  const term = Number(termMonths ?? p.default_term);
  if (!(Number.isInteger(term) && term > 0)) throw err('INVALID_TERM', 400);
  if (term > p.max_term) throw err(`TERM_EXCEEDS_PRODUCT_MAX: ${p.max_term}`, 400);
  within('TERM', term, p.min_term, null);
  within('PRINCIPAL', amount, p.min_principal, p.max_principal);

  const given = Object.fromEntries(Object.keys(OVERRIDES).filter((k) => params[k] !== undefined).map((k) => [k, params[k]]));
  const own = resolveOverrides(p, given, { opening: true, term });

  const exp = await controls.exposure(c, { memberId, requested: amount, refinancing: settles });
  if (exp.reasons.includes('ONE_ACTIVE_LOAN_PER_MEMBER')) throw err('MEMBER_ALREADY_HAS_AN_ACTIVE_LOAN', 409);

  const no = accountNo || await nextAccountNo(c, p);
  const status = p.initial_state || 'PENDING_APPROVAL';
  // The loan sits in its member's branch unless told otherwise.
  const { rows: [mem] } = await c.query('SELECT branch_id FROM members WHERE id = $1', [memberId]);
  const cols = {
    branch_id: branchId === undefined ? mem?.branch_id || null : branchId,
    account_no: no, member_id: memberId, product_id: productId, principal: amount, term_months: term,
    product_type: p.product_type || 'FIXED_TERM', status, purpose: purpose || null, notes: notes || null,
    ...own,
    ...(refinance ? { refinance_of: refinance.of, refinance_arrears: refinance.arrears, top_up_requested: refinance.topUp } : {}),
  };
  const names = Object.keys(cols);
  const { rows } = await c.query(
    `INSERT INTO loan_accounts (${names.join(', ')})
     VALUES (${names.map((_, n) => `$${n + 1}`).join(', ')}) RETURNING *`,
    names.map((k) => cols[k])
  );
  await workflow.history(c, rows[0].id, { from: null, to: status, action: 'APPLY', actor: createdBy });
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after)
     VALUES ($1,'LOAN_APPLIED','loan_account',$2,$3)`,
    [createdBy || 'SYSTEM', rows[0].id, JSON.stringify(rows[0])]
  );
  // The pieces an application may arrive with. Each may also be added later.
  if (types.forLoan(p).plansTranches) {
    if (Array.isArray(plannedTranches) && plannedTranches.length) await tranches.setTranches(c, rows[0].id, plannedTranches, { createdBy });
  } else if (plannedTranches) throw err('ONLY_A_TRANCHED_PRODUCT_TAKES_TRANCHES', 400);
  for (const f of fundingSources || []) await funding.addFundingSource(c, rows[0].id, { ...f, createdBy });
  for (const k of collateral || []) await securities.addCollateral(c, rows[0].id, { ...k, createdBy });
  return (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [rows[0].id])).rows[0];
}

/** State changes live in ./workflow; this keeps the historical entry point. */
async function changeState(c, loanId, action, opts = {}) {
  return workflow.transition(c, loanId, action, opts);
}

/**
 * A product not linked to accounting still moves real money: the channel's
 * leg is posted and its other side is the tenant's suspense account (a
 * funded loan's funders' side is real too, and posted). Nothing touches the
 * loan's own accounts.
 */
async function postUnlinked(c, l, entry, { cash, funded = null, extra = [] }) {
  if (!(cash && cash.amount > 0)) return null;
  const cashIsCredit = entry.credits.includes(cash);
  const other = [...(funded ? funded.debits || funded.credits || [] : []), ...extra];
  const otherTotal = round2(other.reduce((t, x) => t + Number(x.amount), 0));
  const gap = round2(cash.amount - otherTotal);
  const suspense = await PA.suspense(c);
  const suspenseLeg = gap !== 0 ? [{ glCode: suspense, amount: Math.abs(gap), memberId: l.member_id, branchId: l.branch_id }] : [];
  const sameSide = gap > 0;
  const debits = cashIsCredit ? [...other, ...(sameSide ? suspenseLeg : [])] : [cash, ...(sameSide ? [] : suspenseLeg)];
  const credits = cashIsCredit ? [cash, ...(sameSide ? [] : suspenseLeg)] : [...other, ...(sameSide ? suspenseLeg : [])];
  const e = await acct.post(c, { ...entry, debits, credits, branchId: l.branch_id || null });
  return e.entryId;
}

/**
 * Disburse an approved loan. Fees the product defines for disbursement are
 * settled here: deducted fees come out of what the member receives,
 * capitalised fees are added to what they repay, upfront fees become due.
 * The schedule is drawn on the resulting principal. Under ON_DISBURSEMENT
 * posting the schedule's whole interest is applied at once.
 */
async function disburse(c, loanId, { amount, channelId = 'bank', valueDate, narration, createdBy, user = null, fees: selectedFees = [], tranche = null, branchId: tellerBranch = null } = {}) {
  const l = await lock(c, loanId);
  const type = types.forLoan(l);
  const first = l.status === 'APPROVED';
  const again = !first && ['ACTIVE', 'IN_ARREARS'].includes(l.status) && type.disbursesAgain;
  if (!first && !again) throw err(`LOAN_NOT_APPROVED: ${l.status}`, 409);
  // A top-up application pays out by settling the loan it refinances.
  if (l.refinance_of) throw err('TOP_UP_APPLICATION_DISBURSES_THROUGH_REFINANCE', 409);
  const date = valueDate ? ymd(valueDate) : isoDate(new Date());

  // What may be paid out now: the product type says (the principal, the
  // next tranche, or a drawdown within the available limit).
  const { amount: amt, tranche: plannedTranche } = await type.disbursementAmount(c, l, { amount, tranche, date });
  await workflow.assertMayDisburse(c, l, { actor: createdBy, amount: amt, user });

  const { rows: [ch] } = await c.query(
    'SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [channelId]
  );
  if (!ch) throw err(`UNKNOWN_TRANSACTION_CHANNEL: ${channelId}`);
  if (!ch.gl_account_code) throw err(`CHANNEL_HAS_NO_GL_ACCOUNT: ${channelId}`);

  // Disbursement fees: on the amount paid out now. Upfront fees (and the
  // legacy processing fee) are charged once, with the first payout.
  let plan = await fees.disbursementFees(c, l, { amount: amt, selected: selectedFees });
  if (!first) {
    const items = plan.items.filter((x) => x.feeType !== 'DISBURSEMENT_UPFRONT');
    plan = { ...plan, items, upfront: 0 };
  }
  const paidOut = round2(amt - plan.deducted);
  if (!(paidOut > 0)) throw err('FEES_EXCEED_DISBURSEMENT', 400);

  // A revolving drawdown uses the member's credit balance first: their own
  // money back to them, no portfolio movement for that part.
  const fromCredit = type.fromCreditBalance(l, amt);
  const fromLoan = round2(amt - fromCredit);

  // A funded loan's principal is not the SACCO's: it leaves the funders'
  // accounts. Otherwise Dr Portfolio for what the member owes.
  const funded = await funding.fund(c, l, { amount: fromLoan, date, createdBy });
  const debits = [];
  if (funded) debits.push(...funded.debits);
  else if (fromLoan > 0) debits.push({ glCode: l.gl_portfolio, amount: fromLoan, memberId: l.member_id });
  if (plan.capitalized > 0) debits.push({ glCode: l.gl_portfolio, amount: plan.capitalized, memberId: l.member_id });
  if (fromCredit > 0) debits.push({ glCode: l.gl_credit_balance, amount: fromCredit, memberId: l.member_id });
  const credits = [{ glCode: ch.gl_account_code, amount: paidOut, memberId: l.member_id, branchId: tellerBranch || l.branch_id }];
  for (const f of plan.items.filter((x) => x.feeType === 'DISBURSEMENT_DEDUCTED' || x.feeType === 'DISBURSEMENT_CAPITALIZED')) {
    credits.push(...tax.incomeCredits(l, { income: f.net, tax: f.tax }, f.glIncome, l.member_id));
  }
  const entry = {
    debits, credits,
    narration: narration || `Disbursement ${l.account_no}${plannedTranche ? ` tranche ${plannedTranche.number}` : ''}`,
    sourceType: 'LOAN_DISBURSEMENT', sourceId: l.id, channelId,
    bookingDate: date, createdBy,
  };
  const entryId = booksEntries(l) ? await post(c, l, entry) : await postUnlinked(c, l, entry, { cash: credits[0], funded });

  const { rows } = await c.query(
    `UPDATE loan_accounts
     SET principal_disbursed = principal_disbursed + $1,
         principal_capitalized = principal_capitalized + $2,
         credit_balance = credit_balance - $6,
         status = CASE WHEN status = 'APPROVED' THEN 'ACTIVE' ELSE status END,
         disbursed_on = COALESCE(disbursed_on, $3::date),
         accrued_through = COALESCE(accrued_through, $3::date),
         disbursed_by = COALESCE(disbursed_by, $4),
         updated_at = now()
     WHERE id = $5 RETURNING *`,
    [fromLoan, plan.capitalized, date, createdBy || null, l.id, fromCredit]
  );
  if (first) await workflow.history(c, l.id, { from: 'APPROVED', to: 'ACTIVE', action: 'DISBURSE', actor: createdBy });

  for (const f of plan.items) {
    await fees.recordFee(c, l, { ...f, amount: f.net, valueDate: date, createdBy, settled: f.feeType !== 'DISBURSEMENT_UPFRONT' });
  }
  const fresh = { ...l, ...rows[0], _selectedFees: selectedFees };

  // The schedule, or its absence, is the product type's: drawn now, redrawn
  // for a later tranche, or none until the first billing date.
  const sched = await type.afterDisbursement(c, { l, fresh, first, date, plan, createdBy }, ops);

  if (sched && type.appliesInterestAtDisbursement(l) && sched.totals.interest > 0) {
    // The whole term's interest is applied on day one.
    const maturity = sched.installments[sched.installments.length - 1].nominalDue;
    const tx = tax.split(l, 'INTEREST', sched.totals.interest);
    await c.query(
      'UPDATE loan_accounts SET interest_accrued = interest_accrued + $1, tax_charged = tax_charged + $4, accrued_through = $2::date WHERE id = $3',
      [tx.gross, maturity, l.id, tx.tax]);
    let ie = null;
    if (interestAccrues(l)) {
      ie = await post(c, l, {
        debits: [{ glCode: l.gl_interest_rec, amount: tx.gross, memberId: l.member_id }],
        credits: tax.incomeCredits(l, tx, l.gl_interest_inc, l.member_id),
        narration: `Interest applied at disbursement ${l.account_no}`,
        sourceType: 'LOAN_INTEREST_ACCRUAL', sourceId: l.id, bookingDate: date, createdBy,
      });
    }
    await savings.record(c, {
      reference: savings.ref('LI'), kind: 'LOAN_INTEREST_ACCRUAL', memberId: l.member_id,
      loanAccountId: l.id, amount: tx.gross, valueDate: date, entryId: ie,
      allocation: { from: date, through: maturity, method: 'ON_DISBURSEMENT', tax: tx.tax }, createdBy,
    });
  }

  const record = await savings.record(c, {
    reference: savings.ref('LD'), kind: 'LOAN_DISBURSEMENT', memberId: l.member_id,
    loanAccountId: l.id, channelId, amount: amt, valueDate: date,
    entryId, narration, createdBy,
    allocation: {
      paidOut, deducted: plan.deducted, capitalized: plan.capitalized, upfront: plan.upfront,
      fromCreditBalance: fromCredit, tranche: plannedTranche ? plannedTranche.number : undefined,
      funded: funded ? funded.debits.map((d) => ({ glCode: d.glCode, amount: d.amount })) : undefined,
    },
  });
  await type.recordDisbursement(c, { tranche: plannedTranche, amount: amt, date, record });
  return record;
}

/**
 * Repayment allocation follows the product's `allocation_order` (default
 * penalty, fee, interest, principal). Anything left over goes to the
 * member's savings rather than sitting as an unexplained credit on the loan.
 *
 * Each component is credited to the account the accounting method says:
 * under accrual, the receivable that was debited when it was applied; under
 * cash, income. See paidCredit().
 */
async function repay(c, loanId, { amount, channelId = 'mpesa', valueDate, narration, createdBy, branchId: tellerBranch = null } = {}) {
  let l = await lock(c, loanId);
  const type = types.forLoan(l);
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) throw err(`LOAN_NOT_ACTIVE: ${l.status}`, 409);
  let left = round2(amount);
  if (!(left > 0)) throw err('INVALID_REPAYMENT_AMOUNT');

  const ch = (await c.query('SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [channelId])).rows[0];
  if (!ch?.gl_account_code) throw err(`UNKNOWN_OR_UNSETTLED_CHANNEL: ${channelId}`);

  const asOf = valueDate ? ymd(valueDate) : isoDate(new Date());
  // Interest owed is brought up to the payment date first, so a prepayment
  // on a dynamic loan pays the interest it has actually earned (Mambu's
  // "apply interest on prepayments"); a capitalising product folds it into
  // principal at the same moment.
  l = await type.beforeRepayment(c, l, { asOf, createdBy }, ops);

  const b = balances(l);
  const due = { PENALTY: b.penalty, FEE: b.fees, INTEREST: b.interest, PRINCIPAL: b.principal };
  const paid = { PENALTY: 0, FEE: 0, INTEREST: 0, PRINCIPAL: 0 };
  const order = Array.isArray(l.allocation_order) && l.allocation_order.length === 4
    ? l.allocation_order : ['PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL'];
  for (const component of order) {
    const t = round2(Math.min(left, Math.max(0, due[component])));
    paid[component] = t;
    left = round2(left - t);
  }
  const { PENALTY: penalty, FEE: feesPaid, INTEREST: interest, PRINCIPAL: principal } = paid;
  const surplus = round2(left);
  const total = round2(penalty + feesPaid + interest + principal + surplus);
  const finalPayment = round2(b.principal - principal) <= 0 && type.closesWhenPaid;

  // Where each component's money goes. On a funded loan the principal and
  // the funders' share of the interest go back to the funders' accounts;
  // the organisation keeps its commission, fees and penalties.
  // Fees are credited fee by fee, each to its own receivable (or income,
  // under cash), in the order fees.settle will mark them paid.
  const credits = [];
  let distributed = null;
  const feeCredits = await fees.settlementCredits(c, l, feesPaid);
  if (await funding.isFunded(c, l.id)) {
    distributed = await funding.distribute(c, l, { principal, interest, date: asOf, createdBy, finalPayment });
    credits.push(...distributed.credits);
    credits.push(...creditsFor(l, 'INTEREST', distributed.orgInterest, l.member_id));
    credits.push(...feeCredits);
    credits.push(...creditsFor(l, 'PENALTY', penalty, l.member_id));
  } else {
    for (const component of order) {
      if (component === 'FEE') credits.push(...feeCredits);
      else credits.push(...creditsFor(l, component, paid[component], l.member_id));
    }
  }

  // A surplus is the member's money: on a revolving loan with a credit
  // balance it stays on the loan for the next drawdown; otherwise it goes to
  // their savings rather than sitting as an unexplained credit.
  let surplusAccount = null;
  const surplusCredits = [];
  let toCreditBalance = 0;
  if (surplus > 0) {
    if (type.surplusToCreditBalance(l)) {
      if (l.max_credit_balance !== null && round2(l.credit_balance) + surplus > Number(l.max_credit_balance)) {
        throw err(`OVERPAYMENT_EXCEEDS_MAX_CREDIT_BALANCE: ${l.max_credit_balance}`, 409);
      }
      toCreditBalance = surplus;
      credits.push({ glCode: l.gl_credit_balance, amount: surplus, memberId: l.member_id });
    } else {
      const { rows } = await c.query(
        `SELECT a.id FROM savings_accounts a
         JOIN savings_products p ON p.id = a.product_id
         WHERE a.member_id = $1 AND a.status = 'ACTIVE' AND NOT p.is_funding_account ORDER BY a.opened_on LIMIT 1`,
        [l.member_id]
      );
      if (!rows.length) throw err('OVERPAYMENT_WITH_NO_SAVINGS_ACCOUNT_TO_RECEIVE_IT', 409);
      // The surplus lands in savings as a deposit would: it clears any
      // overdraft first, and follows the deposit product's own accounting.
      surplusAccount = await savings.lock(c, rows[0].id);
      surplusAccount.legs = savings.inLegs(surplusAccount, surplus);
      surplusCredits.push(...(savings.books(surplusAccount) ? surplusAccount.legs.credits
        : [{ glCode: await PA.suspense(c), amount: surplus, memberId: l.member_id, branchId: surplusAccount.branch_id }]));
      if (booksEntries(l)) credits.push(...surplusCredits);
    }
  }

  // Under NONE the loan's own accounts are not touched, but the cash is
  // real: the channel is booked against suspense, and the funders' and the
  // savings surplus legs are booked as they are.
  const cashLeg = { glCode: ch.gl_account_code, amount: total, memberId: l.member_id, branchId: tellerBranch || l.branch_id };
  const repayEntry = {
    debits: [cashLeg], credits: credits.filter((x) => x.amount > 0),
    narration: narration || `Repayment ${l.account_no}`,
    sourceType: 'LOAN_REPAYMENT', sourceId: l.id, channelId,
    bookingDate: asOf, createdBy,
  };
  const entryId = booksEntries(l)
    ? await post(c, l, repayEntry)
    : await postUnlinked(c, l, repayEntry, { cash: cashLeg, extra: [...(distributed ? distributed.credits : []), ...surplusCredits] });

  await c.query(
    `UPDATE loan_accounts SET
       penalty_paid = penalty_paid + $1, fees_paid = fees_paid + $2,
       interest_paid = interest_paid + $3, principal_paid = principal_paid + $4,
       credit_balance = credit_balance + $6,
       updated_at = now()
     WHERE id = $5`,
    [penalty, feesPaid, interest, principal, l.id, toCreditBalance]
  );
  if (surplusAccount) {
    await c.query(
      `UPDATE savings_accounts SET balance = balance + $1, od_fees_due = od_fees_due - $2, od_interest_due = od_interest_due - $3
       WHERE id = $4`, [surplus, surplusAccount.legs.allocation.odFees, surplusAccount.legs.allocation.odInterest, surplusAccount.id]);
  }

  // A fixed-term loan's payment settles its installments in order, however
  // early it comes. A dynamic loan's payment settles what has fallen due and
  // anything beyond that is a prepayment: it reduces the balance, and the
  // schedule for what remains is redrawn from that balance. A revolving
  // loan's installments only exist once due, so all of them take a share.
  await applyToInstallments(c, l.id, { principal, interest, fees: feesPaid }, type.installmentScope(asOf));
  await fees.settle(c, l.id, feesPaid);

  const fresh = await lock(c, l.id);
  const after = balances(fresh);
  let rescheduled = null;
  if (after.total <= 0 && type.closesWhenPaid) {
    await c.query("UPDATE loan_accounts SET status = 'CLOSED_REPAID', closed_on = $2::date, updated_at = now() WHERE id = $1", [l.id, asOf]);
    await workflow.history(c, l.id, { from: fresh.status, to: 'CLOSED_REPAID', action: 'PAID_OFF', actor: createdBy });
    await eligibility.releaseGuarantors(c, l.id);
    await securities.onClose(c, l.id);
  } else if (fresh.status === 'IN_ARREARS') {
    await workflow.refreshArrears(c, fresh, asOf);
  }
  rescheduled = await type.afterRepayment(c, fresh, { asOf, principal, interest }, ops);

  return savings.record(c, {
    reference: savings.ref('LR'), kind: 'LOAN_REPAYMENT', memberId: l.member_id,
    loanAccountId: l.id, channelId, amount: total, valueDate: asOf, entryId,
    allocation: {
      penalty, fees: feesPaid, interest, principal, surplus,
      ...(toCreditBalance > 0 ? { creditBalance: toCreditBalance } : {}),
      ...(distributed ? { funding: distributed.allocation, orgInterest: distributed.orgInterest } : {}),
      ...(rescheduled ? { rescheduled: { recalculation: rescheduled.recalculation, dropped: rescheduled.dropped } } : {}),
    },
    narration, createdBy,
  });
}

// Write-offs, recoveries and their reversal live in ./writeOffs.
const { writeOff } = writeOffs;

async function reverseTransaction(c, reference, { narration = 'Reversal', createdBy } = {}) {
  const { rows } = await c.query('SELECT * FROM transactions WHERE reference = $1 FOR UPDATE', [reference]);
  if (!rows.length) throw err('TRANSACTION_NOT_FOUND', 404);
  const tx = rows[0];
  if (tx.reversed_by) throw err('TRANSACTION_ALREADY_REVERSED', 409);
  if (!tx.loan_account_id) throw err('NOT_A_LOAN_TRANSACTION');
  if (tx.kind === 'LOAN_WRITE_OFF' || tx.kind === 'LOAN_RECOVERY') return writeOffs.reverse(c, tx, { narration, createdBy });

  const entry = tx.entry_id ? await acct.reverse(c, tx.entry_id, narration, createdBy) : { entryId: null };
  const a = tx.allocation || {};

  if (tx.kind === 'LOAN_REPAYMENT') {
    await c.query(
      `UPDATE loan_accounts SET
         penalty_paid = penalty_paid - $1, fees_paid = fees_paid - $2,
         interest_paid = interest_paid - $3, principal_paid = principal_paid - $4,
         status = CASE WHEN status = 'CLOSED_REPAID' THEN 'ACTIVE' ELSE status END,
         closed_on = CASE WHEN status = 'CLOSED_REPAID' THEN NULL ELSE closed_on END,
         updated_at = now()
       WHERE id = $5`,
      [a.penalty || 0, a.fees || 0, a.interest || 0, a.principal || 0, tx.loan_account_id]
    );
    if (a.creditBalance > 0) {
      await c.query('UPDATE loan_accounts SET credit_balance = credit_balance - $1 WHERE id = $2', [a.creditBalance, tx.loan_account_id]);
    } else if (a.surplus > 0) {
      await c.query(
        `UPDATE savings_accounts SET balance = balance - $1
         WHERE member_id = $2 AND status = 'ACTIVE'
           AND id = (SELECT a.id FROM savings_accounts a JOIN savings_products p ON p.id = a.product_id
                     WHERE a.member_id = $2 AND a.status = 'ACTIVE' AND NOT p.is_funding_account ORDER BY a.opened_on LIMIT 1)`,
        [a.surplus, tx.member_id]
      );
    }
    if (a.funding) {
      await funding.undistribute(c, { id: tx.loan_account_id }, a.funding, { date: isoDate(new Date()), createdBy });
    }
    // Rebuild installment allocation from what survives. A dynamic loan's
    // schedule may have been redrawn by the payment being reversed, so it
    // goes back to the schedule it was disbursed with and is redrawn from
    // the balance as it now stands.
    const restored = await lock(c, tx.loan_account_id);
    const type = types.forLoan(restored);
    if (type.redrawsOnReversal) await buildSchedule(c, restored);
    await c.query(
      `UPDATE loan_installments SET principal_paid = 0, interest_paid = 0, fee_paid = 0,
         status = CASE WHEN status = 'GRACE' THEN 'GRACE' ELSE 'PENDING' END
       WHERE loan_id = $1`, [tx.loan_account_id]
    );
    const { rows: remaining } = await c.query(
      `SELECT COALESCE(SUM((allocation->>'principal')::numeric),0) AS p,
              COALESCE(SUM((allocation->>'interest')::numeric),0)  AS i,
              COALESCE(SUM((allocation->>'fees')::numeric),0)      AS f
       FROM transactions
       WHERE loan_account_id = $1 AND kind = 'LOAN_REPAYMENT'
         AND reversed_by IS NULL AND id <> $2`,
      [tx.loan_account_id, tx.id]
    );
    const today = isoDate(new Date());
    await applyToInstallments(c, tx.loan_account_id, {
      principal: Number(remaining[0].p), interest: Number(remaining[0].i), fees: Number(remaining[0].f),
    }, type.installmentScope(today));
    await fees.resettle(c, tx.loan_account_id, Number(remaining[0].f));
    if (type.redrawsOnReversal) await reschedule(c, await lock(c, tx.loan_account_id), today);
  } else if (tx.kind === 'LOAN_DISBURSEMENT') {
    const { rows: [cur] } = await c.query('SELECT * FROM loan_accounts WHERE id = $1 FOR UPDATE', [tx.loan_account_id]);
    if (round2(cur.principal_disbursed) !== round2(tx.amount) || Number(cur.principal_paid) > 0) {
      throw err('DISBURSEMENT_REVERSAL_ONLY_FOR_A_SINGLE_UNPAID_DISBURSEMENT', 409);
    }
    await c.query(
      `UPDATE loan_accounts SET principal_disbursed = principal_disbursed - $1,
         principal_capitalized = 0, interest_accrued = 0, interest_accrual_carry = 0, tax_charged = 0, accrued_through = NULL,
         credit_balance = credit_balance + $3, next_billing_on = NULL,
         status = 'APPROVED', disbursed_on = NULL, disbursed_by = NULL, updated_at = now() WHERE id = $2`,
      [tx.amount, tx.loan_account_id, a.fromCreditBalance || 0]
    );
    // Funders get their money back and their pledges stand again.
    const { rows: funders } = await c.query("SELECT * FROM loan_funding_sources WHERE loan_id = $1 AND status = 'FUNDED'", [tx.loan_account_id]);
    for (const f of funders) {
      await c.query('UPDATE savings_accounts SET balance = balance + $1 WHERE id = $2', [f.amount, f.savings_account_id]);
      await c.query("UPDATE loan_funding_sources SET status = 'PLEDGED', funded_at = NULL WHERE id = $1", [f.id]);
    }
    await c.query("UPDATE loan_tranches SET status = 'PLANNED', disbursed_on = NULL, disbursed_amount = NULL, transaction_id = NULL WHERE loan_id = $1 AND status = 'DISBURSED'", [tx.loan_account_id]);
    await fees.undoDisbursementFees(c, tx.loan_account_id, { createdBy });
    await c.query('DELETE FROM loan_installments WHERE loan_id = $1', [tx.loan_account_id]);
    await workflow.history(c, tx.loan_account_id, { from: 'ACTIVE', to: 'APPROVED', action: 'UNDO_DISBURSE', actor: createdBy, note: narration });
  }

  const rev = await savings.record(c, {
    reference: savings.ref('REV'), kind: 'REVERSAL', memberId: tx.member_id,
    loanAccountId: tx.loan_account_id, amount: -tx.amount, entryId: entry.entryId,
    allocation: { reversalOf: tx.reference }, narration, createdBy,
  });
  await c.query('UPDATE transactions SET reversed_by = $1 WHERE id = $2', [rev.id, tx.id]);
  return rev;
}

/**
 * Mark overdue installments and flip loans into arrears, honouring each
 * product's arrears tolerance (days, and percentage of outstanding with a
 * floor). The arrears logic itself lives in ./workflow so the EOD job, the
 * repayment path and the console read one definition.
 */
async function markArrears(c, { asOf = null } = {}) {
  return workflow.markArrears(c, { asOf });
}

module.exports = {
  // Lifecycle, defined here.
  apply, changeState, disburse, repay, writeOff, reverseTransaction, markArrears,
  fillPattern, nextAccountNo,

  // Re-exported so existing callers keep one import.
  ...ledger,
  isDynamic: types.isDynamic, isRevolving: types.isRevolving, isTranched: types.isTranched, isInterestFree: types.isInterestFree,
  productType: types.forLoan,
  dayCount: S.dayCount, addMonths: S.addMonths, annuityPayment: S.annuityPayment,
  buildSchedule, previewSchedule: installments.previewSchedule, reschedule,
  maturityDate: installments.maturityDate, applyToInstallments,
  scheduledInterestThrough: installments.scheduledInterestThrough,
  scheduledOutstanding: installments.scheduledOutstanding,
  accrueInterest, capitalizeInterest: interest.capitalizeInterest,
  OPEN_APPLICATION: eligibility.OPEN_APPLICATION,
  addGuarantor: eligibility.addGuarantor, guarantorCoverage: eligibility.guarantorCoverage,
  releaseGuarantors: eligibility.releaseGuarantors,
  checkEligibility: eligibility.checkEligibility, enforceEligibility: eligibility.enforceEligibility,
  recover: writeOffs.recover, recoverFromGuarantor: writeOffs.recoverFromGuarantor, releaseCall: writeOffs.releaseCall,
};
