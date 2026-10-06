'use strict';

const express = require('express');
const { pageParams } = require('../lib/page');
const { can } = require('../lib/permissions');
const { orgToday } = require('../lib/orgDate');
const SEARCH = require('../lib/searchCriteria');
const S = require('../domain/savings');
const DR = require('../domain/depositRules');
const CF = require('../domain/customFields');
const CLD = require('../domain/clients');
const CTL = require('../domain/controls');
const LT = require('../domain/loanTransfers');
const { err, round2 } = require('../domain/accounting');
const H = require('../lib/handlers');
const { pagingHeaders } = require('../lib/handlers');
const run = (fn, opts = {}) => H.run(fn, { keepStatus: true, ...opts });

/**
 * The reference platform's API v2 for deposit accounts at /api/deposits: the account object
 * with its nested settings (interestSettings, overdraftSettings,
 * overdraftInterestSettings, internalControls, balances, accruedAmounts),
 * list, search, create, read, replace, JSON Patch and delete, the colon
 * actions, and the transaction, block and hold endpoints. It is a layer
 * over ../domain/savings: every rule is the one /api/savings applies, and
 * the two APIs work on the same accounts.
 *
 * The permission table lets each route in by the permission of the
 * /api/savings route it matches; the colon actions share the shape of
 * POST /deposits/:id, so each checks its own here.
 */

const router = express.Router();

const need = (req, code) => { if (!can(req.auth, code)) throw err(`PERMISSION_REQUIRED: ${code}`, 403); };
const d = (v) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);
const ts = (v) => (v instanceof Date ? v.toISOString() : v || null);
const num = (v) => (v === null || v === undefined ? null : Number(v));

// The platform's names and the reference platform's.
const TYPE_OUT = { CURRENT_ACCOUNT: 'CURRENT_ACCOUNT', SAVINGS_ACCOUNT: 'REGULAR_SAVINGS', FIXED_DEPOSIT: 'FIXED_DEPOSIT', SAVINGS_PLAN: 'SAVINGS_PLAN', INVESTOR_ACCOUNT: 'INVESTOR_ACCOUNT' };
const TERMS_OUT = { FIXED: 'FIXED', INDEX: 'FIXED', TIERED_BALANCE: 'TIERED', TIERED_BANDS: 'TIERED_BAND', TIERED_PERIOD: 'TIERED_PERIOD' };
const DAYS_OUT = { ACTUAL_365: 'ACTUAL_365_FIXED', ACTUAL_360: 'ACTUAL_360', THIRTY_360: 'E30_360', ACTUAL_ACTUAL_ISDA: 'ACTUAL_ACTUAL_ISDA' };
const KIND_OUT = {
  SAVINGS_DEPOSIT: 'DEPOSIT', SAVINGS_WITHDRAWAL: 'WITHDRAWAL', SAVINGS_TRANSFER: 'TRANSFER', SAVINGS_FEE: 'FEE_APPLIED',
  SAVINGS_INTEREST_APPLIED: 'INTEREST_APPLIED', SAVINGS_WITHHOLDING_TAX: 'WITHHOLDING_TAX', SAVINGS_NEGATIVE_INTEREST: 'INTEREST_APPLIED',
  OVERDRAFT_INTEREST_APPLIED: 'INTEREST_APPLIED', OVERDRAFT_WRITE_OFF: 'WRITE_OFF', SAVINGS_SEIZURE: 'SEIZED_AMOUNT',
};
const ADJUSTED = { DEPOSIT: 'DEPOSIT_ADJUSTMENT', WITHDRAWAL: 'WITHDRAWAL_ADJUSTMENT', TRANSFER: 'TRANSFER_ADJUSTMENT', FEE_APPLIED: 'FEE_ADJUSTED',
  INTEREST_APPLIED: 'INTEREST_APPLIED_ADJUSTMENT', WITHHOLDING_TAX: 'WITHHOLDING_TAX_ADJUSTMENT', SEIZED_AMOUNT: 'SEIZED_AMOUNT_ADJUSTMENT', WRITE_OFF: 'WRITE_OFF_ADJUSTMENT' };

// The reference platform's account state as SQL, for search and list filters.
const STATE_SQL = `CASE WHEN a.status = 'IN_ARREARS' THEN 'ACTIVE_IN_ARREARS'
  WHEN a.status = 'CLOSED' AND a.closed_as = 'REJECTED' THEN 'CLOSED_REJECTED'
  WHEN a.status = 'CLOSED' AND a.closed_as = 'WITHDRAWN' THEN 'WITHDRAWN'
  WHEN a.status = 'CLOSED' AND a.closed_as = 'WRITTEN_OFF' THEN 'CLOSED_WRITTEN_OFF' ELSE a.status END`;
const TYPE_SQL = `CASE p.product_type WHEN 'SAVINGS_ACCOUNT' THEN 'REGULAR_SAVINGS' ELSE p.product_type END`;
const FIELDS = {
  encodedKey: { sql: 'a.id::text', type: 'text' }, id: { sql: 'a.account_no', type: 'text' },
  name: { sql: 'COALESCE(a.name, p.name)', type: 'text' }, accountHolderKey: { sql: 'a.member_id::text', type: 'text' },
  accountHolderId: { sql: 'm.member_no', type: 'text' }, accountState: { sql: STATE_SQL, type: 'text' }, accountType: { sql: TYPE_SQL, type: 'text' },
  productTypeKey: { sql: 'a.product_id', type: 'text' }, assignedBranchKey: { sql: 'a.branch_id::text', type: 'text' },
  creditArrangementKey: { sql: 'a.credit_arrangement_id::text', type: 'text' },
  creationDate: { sql: 'a.created_at', type: 'timestamp' }, approvedDate: { sql: 'a.approved_on', type: 'date' },
  activationDate: { sql: 'COALESCE(a.activated_on, a.opened_on)', type: 'date' }, closedDate: { sql: 'a.closed_on', type: 'date' },
  maturityDate: { sql: 'a.maturity_date', type: 'date' }, lastInterestStoredDate: { sql: 'a.last_interest_applied_on', type: 'date' },
  'balances.totalBalance': { sql: 'a.balance', type: 'number' },
  'overdraftSettings.overdraftLimit': { sql: 'a.overdraft_limit', type: 'number' },
  'overdraftSettings.overdraftExpiryDate': { sql: 'a.overdraft_expires_on', type: 'date' },
};

/** The account as the reference platform's DepositAccount. */
async function shape(c, ref, { user = null, tenant = null } = {}) {
  const b = await S.summary(c, String(ref));
  const { rows: [a] } = await c.query(
    `SELECT a.*, m.member_no, m.holder_type, p.product_type, p.allow_overdraft, p.interest_rate_terms, p.interest_index_source_id,
            p.interest_review_count, p.interest_review_unit, p.interest_rate_tiers, p.interest_day_count, p.interest_calc_balance,
            p.interest_application, p.interest_fixed_dates, p.od_rate_terms, p.od_index_source_id, p.od_review_count, p.od_review_unit,
            p.od_rate_tiers, p.od_day_count, p.od_calc_balance
       FROM savings_accounts a JOIN members m ON m.id = a.member_id JOIN savings_products p ON p.id = a.product_id WHERE a.id = $1`, [b.accountId]);
  const cf = await CF.getValues(c, 'SAVINGS_ACCOUNT', a.id, { user, record: a });
  const overdrawn = b.balances.overdraftAmountDue;
  const principal = round2(Math.max(0, overdrawn - Number(a.od_interest_due || 0) - Number(a.od_fees_due || 0)));
  const rate = (terms, rateValue, spread, source, review, tiers, days) => ({
    interestRate: terms === 'INDEX' ? null : rateValue, interestSpread: spread,
    interestRateSource: terms === 'INDEX' ? 'INDEX_INTEREST_RATE' : 'FIXED_INTEREST_RATE',
    interestRateTerms: TERMS_OUT[terms || 'FIXED'], indexSourceKey: terms === 'INDEX' ? source : null,
    interestRateReviewCount: review.count || null, interestRateReviewUnit: review.unit || null,
    interestRateTiers: (tiers || []).map((t) => ({ endingBalance: t.ending ?? null, interestRate: Number(t.rate) })),
    daysInYear: DAYS_OUT[days] || days,
  });
  return {
    encodedKey: a.id, id: a.account_no, name: b.name,
    accountHolderKey: a.member_id, accountHolderId: a.member_no, accountHolderType: a.holder_type === 'GROUP' ? 'GROUP' : 'CLIENT',
    accountState: b.accountState, accountType: TYPE_OUT[a.product_type] || a.product_type, productTypeKey: a.product_id,
    assignedBranchKey: a.branch_id, creditArrangementKey: a.credit_arrangement_id || null, currencyCode: tenant?.currency_code || null,
    notes: a.notes || null,
    creationDate: ts(a.created_at), lastModifiedDate: ts(a.updated_at), approvedDate: d(a.approved_on),
    activationDate: d(a.activated_on || (['PENDING_APPROVAL', 'APPROVED'].includes(a.status) ? null : a.opened_on)),
    lockedDate: d(a.locked_on), closedDate: d(a.closed_on), maturityDate: d(a.maturity_date),
    lastInterestCalculationDate: d(a.accrued_through), lastInterestStoredDate: d(a.last_interest_applied_on),
    lastSetToArrearsDate: d(a.in_arrears_since), withholdingTaxSourceKey: b.withholdingTaxSourceId,
    balances: {
      totalBalance: b.balances.totalBalance, availableBalance: b.balances.availableBalance,
      forwardAvailableBalance: round2(b.balances.availableBalance + b.balances.pendingCredits),
      blockedBalance: b.balances.blockedBalance, holdBalance: b.balances.holdBalance, lockedBalance: b.balances.lockedBalance,
      overdraftAmount: principal, technicalOverdraftAmount: round2(Math.max(0, principal - Number(a.overdraft_limit || 0))),
      overdraftInterestDue: num(a.od_interest_due), feesDue: num(a.od_fees_due),
    },
    accruedAmounts: {
      interestAccrued: round2(a.interest_accrued), negativeInterestAccrued: round2(a.neg_interest_accrued),
      overdraftInterestAccrued: round2(a.od_interest_accrued),
    },
    interestSettings: {
      interestRateSettings: rate(a.interest_rate_terms, b.interestRate, b.interestSpread, a.interest_index_source_id,
        { count: a.interest_review_count, unit: a.interest_review_unit }, a.interest_rate_tiers, a.interest_day_count || 'ACTUAL_365'),
      interestPaymentSettings: { interestPaymentPoint: a.interest_application, interestPaymentDates: a.interest_fixed_dates || [] },
      interestCalculationBalance: a.interest_calc_balance,
    },
    overdraftSettings: { allowOverdraft: Boolean(a.allow_overdraft), overdraftLimit: b.overdraftLimit, overdraftExpiryDate: b.overdraftExpiryDate },
    overdraftInterestSettings: {
      interestRateSettings: rate(a.od_rate_terms, b.overdraftRate, b.overdraftSpread, a.od_index_source_id,
        { count: a.od_review_count, unit: a.od_review_unit }, a.od_rate_tiers, a.od_day_count || a.interest_day_count || 'ACTUAL_365'),
      interestCalculationBalance: a.od_calc_balance,
    },
    internalControls: { maxDepositBalance: b.maxBalance, maxWithdrawalAmount: b.maxWithdrawalAmount, recommendedDepositAmount: b.recommendedDepositAmount },
    ...CF.toApi(cf),
  };
}

/** A transaction as the reference platform's DepositTransaction. */
function txOut(t, original = null) {
  const al = t.allocation || {};
  const type = t.kind === 'REVERSAL' ? (ADJUSTED[KIND_OUT[original?.kind]] || 'ADJUSTMENT') : (KIND_OUT[t.kind] || t.kind);
  return {
    encodedKey: t.id, id: t.reference, type, amount: Number(t.amount), parentAccountKey: t.savings_account_id,
    valueDate: d(t.value_date), bookingDate: d(t.value_date), creationDate: ts(t.created_at), notes: t.narration || null,
    userKey: t.created_by, branchKey: t.branch_id, adjustmentTransactionKey: t.reversed_by || null,
    transactionDetails: { transactionChannelKey: t.channel_id || null },
    transferDetails: al.toAccountId ? { linkedDepositTransactionKey: null, linkedAccountKey: al.toAccountId, linkedAccountId: al.toAccountNo } : undefined,
    affectedAmounts: {
      fundsAmount: num(al.savings ?? al.from?.savings ?? null), overdraftAmount: num(al.odPrincipal ?? al.from?.odPrincipal ?? null),
      overdraftFeesAmount: num(al.odFees ?? null), overdraftInterestAmount: num(al.odInterest ?? null),
    },
    holdExternalReferenceId: al.hold || null, platformKind: t.kind,
  };
}

// The reference platform's custom field values on a body: `_setId` objects at the top level,
// with no empty values (CF.fromApi); or the platform's own customFields object.
const customFieldsOf = (b) => (b.customFields && typeof b.customFields === 'object' ? b.customFields : CF.fromApi(b));
const channelOf = (b) => b.transactionDetails?.transactionChannelId || b.transactionDetails?.transactionChannelKey || b.channelId || 'cash';

async function holder(c, ref) {
  const { rows: [m] } = await c.query('SELECT id FROM members WHERE id::text = $1 OR member_no = $1', [String(ref || '')]);
  if (!m) throw err(`ACCOUNT_HOLDER_NOT_FOUND: ${ref}`, 404);
  return m.id;
}

// --------------------------------------------------------------------------
// Listing and search
// --------------------------------------------------------------------------

async function list(c, req, res, body = {}) {
  const { offset, limit } = pageParams(req.method === 'POST' ? { ...req.query, ...body } : req.query);
  const criteria = { filterCriteria: [...(body.filterCriteria || [])], sortingCriteria: body.sortingCriteria };
  if (req.method === 'GET') {
    const q = req.query;
    if (q.accountState) criteria.filterCriteria.push({ field: 'accountState', operator: 'EQUALS', value: q.accountState });
    if (q.branchId) criteria.filterCriteria.push({ field: 'assignedBranchKey', operator: 'EQUALS', value: q.branchId });
    if (q.accountHolderKey) criteria.filterCriteria.push({ field: 'accountHolderKey', operator: 'EQUALS', value: q.accountHolderKey });
    if (q.sortBy) { const [field, order] = String(q.sortBy).split(':'); criteria.sortingCriteria = { field, order }; }
  }
  const s = SEARCH.build(criteria, FIELDS, { customColumn: 'a.custom_fields', today: await orgToday(c), custom: await CF.searchFields(c, 'SAVINGS_ACCOUNT') });
  const { rows } = await c.query(
    `SELECT a.id, count(*) OVER () AS total FROM savings_accounts a JOIN members m ON m.id = a.member_id JOIN savings_products p ON p.id = a.product_id
      WHERE ${s.where} ORDER BY ${s.order ? `${s.order}, ` : ''}a.account_no LIMIT ${limit} OFFSET ${offset}`, s.params);
  pagingHeaders(req, res, { offset, limit, total: rows.length ? rows[0].total : 0 });
  const out = [];
  for (const r of rows) out.push(await shape(c, r.id, { user: req.auth, tenant: req.tenant }));
  return CF.detailed(req, out);
}

// The account is read under its row lock (as GET /api/savings/:id/balance is), so reads run in a write transaction.
router.get('/', ...run((c, req, res) => list(c, req, res), { write: true }));
const search = run((c, req, res) => list(c, req, res, req.body || {}), { write: true });
// Bulk deposits (the reference platform's POST /deposits/deposit-transactions:bulk), as /api/savings has them.
router.post('/deposit-transactions\\:bulk', ...require('./savings').bulkDeposits);

// --------------------------------------------------------------------------
// Create, read, replace, patch, delete
// --------------------------------------------------------------------------

router.post('/', ...run(async (c, req) => {
  const b = req.body || {};
  const odRate = b.overdraftInterestSettings?.interestRateSettings || {};
  const rate = b.interestSettings?.interestRateSettings || {};
  const ic = b.internalControls || {};
  const a = await S.open(c, {
    memberId: await holder(c, b.accountHolderKey || b.accountHolderId), productId: b.productTypeKey || b.productId,
    accountNo: b.id || undefined, name: b.name || null, branchId: b.assignedBranchKey || undefined, user: req.auth,
    overdraftLimit: b.overdraftSettings?.overdraftLimit || 0, overdraftExpiryDate: b.overdraftSettings?.overdraftExpiryDate || null,
    overdraftRate: odRate.interestRate ?? undefined, overdraftSpread: odRate.interestSpread ?? undefined,
    interestRate: rate.interestRate ?? undefined, interestSpread: rate.interestSpread ?? undefined,
    maxBalance: ic.maxDepositBalance ?? undefined, maxWithdrawalAmount: ic.maxWithdrawalAmount ?? undefined,
    recommendedDepositAmount: ic.recommendedDepositAmount ?? undefined, customFields: customFieldsOf(b),
  });
  if (b.notes) await S.updateAccount(c, a.id, { notes: b.notes }, { createdBy: req.auth.email, user: req.auth });
  if (b.withholdingTaxSourceKey) await S.changeWithholdingTax(c, a.id, { sourceId: b.withholdingTaxSourceKey, createdBy: req.auth.email });
  return CF.detailed(req, await shape(c, a.id, { user: req.auth, tenant: req.tenant }));
}, { write: true, status: 201 }));

router.get('/:id', ...run(async (c, req) => CF.detailed(req, await shape(c, req.params.id, { user: req.auth, tenant: req.tenant })), { write: true }));

const get = (o, path) => path.split('.').reduce((x, k) => (x === null || x === undefined ? undefined : x[k]), o);
const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);

/**
 * Apply the changes a replacement or a patch asks for, field by field, each
 * through the rule that governs it: the name, notes, limits and custom
 * fields at any time; the rates before activation; the overdraft as
 * Adjusting Overdraft Terms. A field that cannot change is refused.
 */
async function applyChanges(c, req, current, next, { fromPatch = false } = {}) {
  const fixed = ['encodedKey', 'id', 'accountHolderKey', 'accountHolderType', 'productTypeKey', 'accountType', 'currencyCode', 'accountState'];
  const moved = fixed.filter((k) => next[k] !== undefined && !same(next[k], current[k]));
  if (moved.length) throw err(`FIELDS_NOT_EDITABLE: ${moved.join(', ')}${moved.includes('accountState') ? '; use :changeState' : ''}`, 400);
  const id = current.encodedKey;
  const opts = { createdBy: req.auth.email, user: req.auth };
  const patch = {};
  const took = [];
  const pick = (path, key) => {
    const v = get(next, path);
    if (v !== undefined && !same(v, get(current, path))) { patch[key] = v; took.push(path); }
  };
  pick('name', 'name'); pick('notes', 'notes');
  pick('internalControls.maxDepositBalance', 'maxBalance'); pick('internalControls.maxWithdrawalAmount', 'maxWithdrawalAmount');
  pick('internalControls.recommendedDepositAmount', 'recommendedDepositAmount');
  pick('interestSettings.interestRateSettings.interestRate', 'interestRate');
  pick('interestSettings.interestRateSettings.interestSpread', 'interestSpread');
  // Custom fields: a replacement's sets may not hold empty values; a patch's removed fields are cleared.
  if (!fromPatch) CF.fromApi(next);
  const customOf = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => k.startsWith('_') && (!keys || keys.includes(k))));
  // A replacement changes the sets it names; a patch every set it touched.
  const named = fromPatch ? null : Object.keys(next).filter((k) => k.startsWith('_'));
  const cf = CF.patchFromApi(customOf(current, named), customOf(next, named));
  if (Object.keys(cf).length) patch.customFields = cf;
  if (Object.keys(patch).length) await S.updateAccount(c, id, patch, opts);
  const od = {};
  if (get(next, 'overdraftSettings.overdraftLimit') !== undefined && !same(get(next, 'overdraftSettings.overdraftLimit'), current.overdraftSettings.overdraftLimit)) od.limit = next.overdraftSettings.overdraftLimit;
  if (get(next, 'overdraftSettings.overdraftExpiryDate') !== undefined && !same(get(next, 'overdraftSettings.overdraftExpiryDate'), current.overdraftSettings.overdraftExpiryDate)) od.expiryDate = next.overdraftSettings.overdraftExpiryDate;
  const odr = 'overdraftInterestSettings.interestRateSettings';
  if (get(next, `${odr}.interestRate`) !== undefined && !same(get(next, `${odr}.interestRate`), get(current, `${odr}.interestRate`))) od.interestRate = get(next, `${odr}.interestRate`);
  if (get(next, `${odr}.interestSpread`) !== undefined && !same(get(next, `${odr}.interestSpread`), get(current, `${odr}.interestSpread`))) od.interestSpread = get(next, `${odr}.interestSpread`);
  if (Object.keys(od).length) await S.setOverdraftLimit(c, id, { ...od, createdBy: req.auth.email });
  return shape(c, id, { user: req.auth, tenant: req.tenant });
}

router.put('/:id', ...run(async (c, req) => {
  const current = await shape(c, req.params.id, { user: req.auth, tenant: req.tenant });
  return CF.detailed(req, await applyChanges(c, req, current, req.body || {}));
}, { write: true }));

/** The reference platform's PATCH: JSON Patch operations (add, replace, remove) on paths into the account object. */
function jsonPatch(obj, ops) {
  if (!Array.isArray(ops)) throw err('A_JSON_PATCH_IS_A_LIST_OF_OPERATIONS', 400);
  let out = JSON.parse(JSON.stringify(obj));
  for (const o of ops) {
    const op = String(o?.op || '').toUpperCase();
    if (!['ADD', 'REPLACE', 'REMOVE'].includes(op)) throw err(`UNSUPPORTED_PATCH_OPERATION: ${o?.op}; ADD, REPLACE or REMOVE`, 400);
    const parts = String(o.path || '').replace(/^\//, '').split('/').filter(Boolean);
    if (!parts.length) throw err(`INVALID_PATCH_PATH: ${o.path}`, 400);
    // Custom field paths (/_set/..., grouped entries included) as /clients takes them.
    if (parts[0].startsWith('_')) { out = CLD.applyJsonPatch(out, [o]); continue; }
    let at = out;
    for (const p of parts.slice(0, -1)) { at[p] = at[p] && typeof at[p] === 'object' ? at[p] : {}; at = at[p]; }
    at[parts[parts.length - 1]] = op === 'REMOVE' ? null : o.value;
  }
  return out;
}

router.patch('/:id', ...run(async (c, req) => {
  const current = await shape(c, req.params.id, { user: req.auth, tenant: req.tenant });
  return CF.detailed(req, await applyChanges(c, req, current, jsonPatch(current, req.body), { fromPatch: true }));
}, { write: true }));

router.delete('/:id', ...run(async (c, req, res) => {
  await S.deleteAccount(c, req.params.id, { createdBy: req.auth.email });
  res.status(204).end();
}, { write: true }));

// --------------------------------------------------------------------------
// Colon actions (each checks its own permission)
// --------------------------------------------------------------------------

const action = (name, fn) => router.post(`/:id\\:${name}`, ...run(async (c, req) => {
  await fn(c, req);
  return CF.detailed(req, await shape(c, req.params.id, { user: req.auth, tenant: req.tenant }));
}, { write: true }));

action('changeState', (c, req) => S.changeState(c, req.params.id, req.body?.action, { notes: req.body?.notes || null, user: req.auth, createdBy: req.auth.email }));
action('changeInterestRate', (c, req) => {
  need(req, 'EDIT_SAVINGS_ACCOUNT');
  return S.changeInterestRate(c, req.params.id, { interestRate: req.body?.interestRate, valueDate: req.body?.valueDate || null, notes: req.body?.notes || null, createdBy: req.auth.email });
});
action('changeWithholdingTax', (c, req) => {
  need(req, 'EDIT_SAVINGS_ACCOUNT');
  return S.changeWithholdingTax(c, req.params.id, { sourceId: req.body?.withholdingTaxSourceKey ?? null, createdBy: req.auth.email });
});
action('startMaturity', async (c, req) => {
  need(req, 'ACTIVATE_MATURITY');
  let termLength = req.body?.termLength ?? null;
  // The reference platform takes the maturity date: here it must be a whole number of the product's term units from today.
  if (req.body?.maturityDate && termLength === null) {
    const a = await S.lock(c, req.params.id);
    const today = await orgToday(c);
    const want = d(req.body.maturityDate);
    for (let n = 1; n <= 1200 && termLength === null; n += 1) if (DR.maturityDate(today, n, a.term_unit) === want) termLength = n;
    if (termLength === null) throw err(`MATURITY_DATE_IS_NOT_A_WHOLE_TERM: in ${a.term_unit} from ${today}`, 400);
  }
  return S.startMaturity(c, req.params.id, { termLength, createdBy: req.auth.email });
});
action('undoMaturity', (c, req) => { need(req, 'UNDO_MATURITY'); return S.undoMaturity(c, req.params.id, { createdBy: req.auth.email }); });
action('applyInterest', async (c, req) => {
  need(req, 'APPLY_ACCRUED_SAVINGS_INTEREST');
  const today = await orgToday(c);
  const date = d(req.body?.interestApplicationDate) || today;
  if (date > today) throw err('INTEREST_APPLICATION_DATE_CANNOT_BE_IN_THE_FUTURE', 400);
  await S.accrueInterest(c, req.params.id, { date, createdBy: req.auth.email });
  return S.applyInterest(c, req.params.id, { date, createdBy: req.auth.email });
});

// --------------------------------------------------------------------------
// Transactions
// --------------------------------------------------------------------------

async function txShaped(c, t) {
  let original = null;
  if (t.kind === 'REVERSAL' && t.allocation?.reversalOf) {
    original = (await c.query('SELECT kind FROM transactions WHERE reference = $1', [t.allocation.reversalOf])).rows[0] || null;
  }
  return txOut(t, original);
}

router.get('/:id/transactions', ...run(async (c, req, res) => {
  const { offset, limit } = pageParams(req.query);
  const a = await S.lock(c, req.params.id);
  const { rows } = await c.query(
    `SELECT t.*, count(*) OVER () AS total FROM transactions t WHERE t.savings_account_id = $1
      ORDER BY t.created_at DESC, t.id LIMIT $2 OFFSET $3`, [a.id, limit, offset]);
  pagingHeaders(req, res, { offset, limit, total: rows.length ? rows[0].total : 0 });
  const out = [];
  for (const t of rows) out.push(await txShaped(c, t));
  return out;
}, { write: true }));

const posting = (kind, fn) => router.post(`/:id/${kind}`, ...run(async (c, req) => {
  const t = await fn(c, req, req.body || {});
  const cf = customFieldsOf(req.body || {});
  // Always, so a channel's required fields are asked for even when none are sent.
  if (t && t.id) await CF.applyToTransaction(c, t, cf, { user: req.auth });
  return txShaped(c, t);
}, { write: true, status: 201 }));

posting('deposit-transactions', async (c, req, b) => {
  await CTL.assertWithinLimit(c, req.auth, 'deposit', b.amount);
  return S.deposit(c, req.params.id, { amount: b.amount, channelId: channelOf(b), valueDate: b.valueDate || undefined, narration: b.notes || null,
    createdBy: req.auth.email, user: req.auth, holdExternalReferenceId: b.holdExternalReferenceId || null });
});
posting('withdrawal-transactions', async (c, req, b) => {
  await CTL.assertWithinLimit(c, req.auth, 'withdrawal', b.amount);
  return S.withdraw(c, req.params.id, { amount: b.amount, channelId: channelOf(b), valueDate: b.valueDate || undefined, narration: b.notes || null,
    createdBy: req.auth.email, user: req.auth, holdExternalReferenceId: b.holdExternalReferenceId || null });
});
posting('transfer-transactions', async (c, req, b) => {
  const td = b.transferDetails || {};
  const target = td.linkedAccountId || td.linkedAccountKey;
  if (!target) throw err('TRANSFER_DETAILS_LINKED_ACCOUNT_REQUIRED', 400);
  if (String(td.linkedAccountType || 'DEPOSIT').toUpperCase() === 'LOAN') {
    need(req, 'ENTER_REPAYMENT');
    await CTL.assertWithinLimit(c, req.auth, 'repayment', b.amount);
    const r = await LT.repayFromDeposit(c, target, { amount: b.amount, savingsAccountId: req.params.id, valueDate: b.valueDate || null,
      narration: b.notes || null, createdBy: req.auth.email, user: req.auth });
    return r.savingsTransaction || r.savings || r;
  }
  await CTL.assertWithinLimit(c, req.auth, 'withdrawal', b.amount);
  return S.transfer(c, req.params.id, { toAccountId: target, amount: b.amount, valueDate: b.valueDate || undefined, narration: b.notes || null,
    createdBy: req.auth.email, user: req.auth });
});
posting('fee-transactions', async (c, req, b) => {
  if (b.amount !== undefined) await CTL.assertWithinLimit(c, req.auth, 'fee', b.amount);
  return S.applyFee(c, req.params.id, { feeCode: b.predefinedFeeKey || null, amount: b.amount ?? null, name: b.notes || null,
    valueDate: b.valueDate || undefined, createdBy: req.auth.email, narration: b.notes || null });
});
posting('seizure-transactions', (c, req, b) => S.seizeFunds(c, req.params.id, { blockId: b.blockId, amount: b.amount,
  channelId: channelOf({ ...b, channelId: b.channelId || 'bank' }), notes: b.notes || null, createdBy: req.auth.email, user: req.auth }));

// --------------------------------------------------------------------------
// Blocks, holds, withholding tax history
// --------------------------------------------------------------------------

router.get('/:id/blocks', ...run((c, req) => S.blocksOf(c, req.params.id), { write: true }));
router.post('/:id/blocks', ...run((c, req) => S.blockFunds(c, req.params.id, { externalReferenceId: req.body?.externalReferenceId,
  amount: req.body?.amount, notes: req.body?.notes || null, createdBy: req.auth.email }), { write: true, status: 201 }));
router.delete('/:id/blocks/:reference', ...run((c, req) => S.unblockFunds(c, req.params.id, req.params.reference, { createdBy: req.auth.email }), { write: true }));
router.get('/:id/authorizationholds', ...run((c, req) => S.holdsOf(c, req.params.id, { status: req.query.status || null }), { write: true }));
router.post('/:id/authorizationholds', ...run((c, req) => S.createHold(c, req.params.id, { ...req.body, createdBy: req.auth.email }), { write: true, status: 201 }));
router.delete('/:id/authorizationholds/:reference', ...run((c, req) => S.reverseHold(c, req.params.id, req.params.reference, { createdBy: req.auth.email }), { write: true }));
router.get('/:id/withholdingtaxes', ...run((c, req) => S.withholdingHistory(c, req.params.id), { write: true }));

module.exports = { router, search, shape, txOut };
