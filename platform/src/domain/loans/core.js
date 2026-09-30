'use strict';

/**
 * Loan accounts: account numbers, the application, state changes, posting without linked entries, and marking arrears.
 */

const acct = require('../accounting');
const ledger = require('../ledger');
const controls = require('../controls');
const CFD = require('../customFields');
const branches = require('../branches');
const tranches = require('../tranches');
const funding = require('../funding');
const securities = require('../securities');
const workflow = require('../workflow');
const fees = require('../fees');
const installments = require('../installments');
const interest = require('../interest');
const types = require('../productTypes');
const PA = require('../productAccounting');
const rates = require('../rates');
const settlementLinks = require('../settlementLinks');
const CA = require('../creditArrangements');
const { can } = require('../../lib/permissions');
const { err, round2 } = acct;
const { OVERRIDES, resolveOverrides, within, lock, balances, post } = ledger;
const { buildSchedule, reschedule } = installments;
const { accrueInterest } = interest;
const { fillPattern } = require('../accountNumbers');
const { recordAudit } = require('../../lib/auditLog');

/**
 * What a product type's hooks may call back into: the lifecycle operations
 * that live above ../productTypes. Passed rather than required, so the type
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
 * What this module stands on (see the layer list in ../ledger):
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

// The pattern filler is shared with deposit accounts (../accountNumbers).

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
 * `refinance` ({ of, arrears, topUp }) is set only by ../restructure when it
 * opens a top-up application, never from a request body: the application
 * then settles that running loan when it is disbursed. `settles` names a
 * running loan the new one replaces (a top-up's, or a reschedule's), which
 * is left out of the exposure check.
 */
async function apply(c, params, { refinance = null, settles = refinance?.of || null, solidarityGroupId = null } = {}) {
  const { memberId, productId = 'NL01', principal, termMonths, purpose, notes, name, accountNo, createdBy,
    tranches: plannedTranches = null, fundingSources = null, collateral = null, branchId = undefined,
    customFields = {}, carriedCustomFields = null, user = null, creditOfficer = undefined } = params;
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

  // A credit arrangement named on the application (the reference platform's creditArrangementKey).
  const arrangement = params.creditArrangementId ?? params.creditArrangementKey ?? null;
  if (arrangement && user && !can(user, 'ADD_ACCOUNTS_TO_LINE_OF_CREDIT')) throw err('PERMISSION_REQUIRED: ADD_ACCOUNTS_TO_LINE_OF_CREDIT', 403);
  // A solidarity loan (../solidarityLoans) keeps its group; a reschedule or
  // refinance of one keeps it too, where the new product is for solidarity groups.
  let solidarity = solidarityGroupId;
  if (!solidarity && settles && (p.available_for || []).includes('SOLIDARITY_GROUPS')) {
    solidarity = (await c.query('SELECT solidarity_group_id FROM loan_accounts WHERE id = $1', [settles])).rows[0]?.solidarity_group_id || null;
  }

  const no = accountNo || await nextAccountNo(c, p);
  const status = p.initial_state || 'PENDING_APPROVAL';
  // The loan sits in its member's branch unless told otherwise.
  const { rows: [mem] } = await c.query('SELECT branch_id, credit_officer FROM members WHERE id = $1', [memberId]);
  const loanBranch = branchId === undefined ? mem?.branch_id || null : branchId;
  // The product must be offered in the loan's branch (the reference platform's product
  // availability); a restructure stays with the product it was given.
  if (!settles) branches.assertProductAvailable(p, loanBranch, 'loan product');
  // Custom fields for the product; a reschedule or top-up carries the old
  // loan's values across (carriedCustomFields) and does not ask for the
  // required ones.
  const values = await CFD.prepare(c, 'LOAN_ACCOUNT', {
    item: p.id, patch: customFields || {}, previous: carriedCustomFields ? await CFD.carry(c, 'LOAN_ACCOUNT', p.id, carriedCustomFields) : {},
    user, creating: !settles,
  });
  const cols = {
    branch_id: loanBranch, custom_fields: JSON.stringify(values),
    account_no: no, member_id: memberId, product_id: productId, principal: amount, term_months: term,
    product_type: p.product_type || 'FIXED_TERM', status, purpose: purpose || null, notes: notes || null, name: name ? String(name).slice(0, 200) : null,
    // The officer responsible: the member's unless the application names one.
    credit_officer: creditOfficer === undefined ? mem?.credit_officer || null : (creditOfficer || null),
    ...(solidarity ? { solidarity_group_id: solidarity } : {}),
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
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'LOAN_APPLIED', entity: 'loan_account', entityId: rows[0].id, after: JSON.stringify(rows[0]) });
  // The pieces an application may arrive with. Each may also be added later.
  if (types.forLoan(p).plansTranches) {
    if (Array.isArray(plannedTranches) && plannedTranches.length) await tranches.setTranches(c, rows[0].id, plannedTranches, { createdBy });
  } else if (plannedTranches) throw err('ONLY_A_TRANCHED_PRODUCT_TAKES_TRANCHES', 400);
  // A rate that can move: an INDEX product's period, or the adjustable
  // periods the application gives (../rates).
  await rates.planPeriods(c, rows[0], p, params.ratePeriods);
  for (const f of fundingSources || []) await funding.addFundingSource(c, rows[0].id, { ...f, createdBy });
  for (const k of collateral || []) await securities.addCollateral(c, rows[0].id, { ...k, createdBy });
  // A settlement deposit account, where the product sets or creates one.
  await settlementLinks.autoLink(c, rows[0], { createdBy });
  // Disbursement details given with the application (../workflow).
  await workflow.setDisbursementDetails(c, rows[0].id, params, { actor: createdBy, user: params.user || null, fresh: true });
  // The credit arrangement: a restructure keeps the old loan's (../creditArrangements).
  if (settles) await CA.carry(c, settles, rows[0]);
  else if (arrangement) await CA.addAccount(c, arrangement, { accountId: rows[0].id, accountType: 'LOAN' }, { user, actor: createdBy });
  return (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [rows[0].id])).rows[0];
}

/** State changes live in ../workflow; this keeps the historical entry point. */
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
 * Mark overdue installments and flip loans into arrears, honouring each
 * product's arrears tolerance (days, and percentage of outstanding with a
 * floor). The arrears logic itself lives in ../workflow so the EOD job, the
 * repayment path and the console read one definition.
 */
async function markArrears(c, { asOf = null } = {}) {
  return workflow.markArrears(c, { asOf });
}

Object.assign(module.exports, {
  ops, nextAccountNo, apply, changeState, postUnlinked, markArrears,
});
