'use strict';

const { orgToday } = require('../lib/orgDate');
const { can } = require('../lib/permissions');
const acct = require('./accounting');
const NUMBERS = require('./accountNumbers');
const CF = require('./customFields');
const SEARCH = require('../lib/searchCriteria');

const { err, round2 } = acct;

/**
 * Credit arrangements (the reference platform's lines of credit): one holder's credit limit
 * across several loan accounts and deposit accounts with an overdraft.
 *
 * States (the reference platform):
 *   PENDING_APPROVAL --APPROVE--> APPROVED --first account added--> ACTIVE --CLOSE--> CLOSED
 *   PENDING_APPROVAL --REJECT--> REJECTED, --WITHDRAW--> WITHDRAWN
 * Approve, reject and withdraw each have an undo; a closed arrangement can
 * be reopened (UNDO_CLOSE). A new arrangement starts in the state the client
 * controls give (PENDING_APPROVAL unless set to APPROVED).
 *
 * Exposure, on the arrangement's exposure limit type:
 *   APPROVED_AMOUNT     loan amounts and overdraft limits of the linked
 *                       accounts that are not closed
 *   OUTSTANDING_AMOUNT  the principal they owe and the overdrawn balances
 * Consumed is the exposure; available is the amount less consumed, and may
 * be negative when the amount is lowered below the exposure (the reference platform).
 *
 * The engine calls in where an exposure grows: an account is added, a loan
 * is disbursed (first payout, a tranche or a revolving draw), a loan amount
 * or an overdraft limit is changed, and, on the outstanding basis, a
 * withdrawal goes into the overdraft. A product decides whether its
 * accounts are linked: NOT_REQUIRED (none may be), OPTIONAL or REQUIRED
 * (a loan is not approved or disbursed, and an overdraft not set, without
 * one). Every product starts NOT_REQUIRED, so nothing existing changes.
 *
 * Depends on accounting, account numbers and custom fields only: loans,
 * savings and the loan workflow call into it.
 */

const STATES = ['PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'CLOSED', 'WITHDRAWN', 'REJECTED'];
const EXPOSURE_TYPES = ['APPROVED_AMOUNT', 'OUTSTANDING_AMOUNT'];
const REQUIREMENTS = ['OPTIONAL', 'REQUIRED', 'NOT_REQUIRED'];
const RUNNING = ['APPROVED', 'ACTIVE'];
const LINKABLE_LOAN_STATES = ['PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'IN_ARREARS'];
const OPEN_DEPOSIT_STATES = ['ACTIVE', 'IN_ARREARS', 'DORMANT', 'LOCKED'];

// action: [from states, to (PREVIOUS: the state before closing), permission]
const ACTIONS = {
  APPROVE: [['PENDING_APPROVAL'], 'APPROVED', 'APPROVE_LINE_OF_CREDIT'],
  UNDO_APPROVE: [['APPROVED'], 'PENDING_APPROVAL', 'UNDO_APPROVE_LINE_OF_CREDIT'],
  REJECT: [['PENDING_APPROVAL'], 'REJECTED', 'REJECT_LINE_OF_CREDIT'],
  UNDO_REJECT: [['REJECTED'], 'PENDING_APPROVAL', 'UNDO_REJECT_LINE_OF_CREDIT'],
  WITHDRAW: [['PENDING_APPROVAL'], 'WITHDRAWN', 'WITHDRAW_LINE_OF_CREDIT'],
  UNDO_WITHDRAW: [['WITHDRAWN'], 'PENDING_APPROVAL', 'UNDO_WITHDRAW_LINE_OF_CREDIT'],
  CLOSE: [['APPROVED', 'ACTIVE'], 'CLOSED', 'CLOSE_LINES_OF_CREDIT'],
  UNDO_CLOSE: [['CLOSED'], 'PREVIOUS', 'CLOSE_LINES_OF_CREDIT'],
};

const ymd = (d) => (d ? String(d).slice(0, 10) : null);
const iso = (d) => (d instanceof Date ? d.toISOString() : d || null);

function isoDate(v, label) {
  if (v === undefined) return undefined;
  const s = String(v || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) {
    throw err(`${label}_IS_A_DATE: yyyy-MM-dd`, 400);
  }
  return s;
}

function assertAllowed(user, code) {
  if (user && !can(user, code)) throw err(`PERMISSION_REQUIRED: ${code}`, 403);
}

async function audit(c, actor, action, id, before, after) {
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,$2,'credit_arrangement',$3,$4,$5)`,
    [actor || 'SYSTEM', action, String(id), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
}

// --------------------------------------------------------------------------
// Reading
// --------------------------------------------------------------------------

async function row(c, ref, { lock = false } = {}) {
  const { rows: [r] } = await c.query(
    `SELECT ca.*, m.member_no AS holder_no, m.holder_type, m.first_name, m.last_name
       FROM credit_arrangements ca JOIN members m ON m.id = ca.holder_id
      WHERE ca.id::text = $1 OR ca.arrangement_no = $1${lock ? ' FOR UPDATE OF ca' : ''}`, [String(ref)]);
  if (!r) throw err('CREDIT_ARRANGEMENT_NOT_FOUND', 404);
  return r;
}

/**
 * The exposure of an arrangement on both bases, leaving out the accounts
 * in `exclude` (a loan being replaced by a reschedule or refinance).
 */
async function exposure(c, ca, { exclude = [] } = {}) {
  const { rows: [x] } = await c.query(
    `SELECT
       (SELECT COALESCE(SUM(l.principal), 0) FROM loan_accounts l
         WHERE l.credit_arrangement_id = $1 AND l.status NOT LIKE 'CLOSED%' AND NOT (l.id = ANY ($2::uuid[]))) AS loan_amounts,
       (SELECT COALESCE(SUM(GREATEST(l.principal_disbursed + l.principal_capitalized - l.principal_paid, 0)), 0) FROM loan_accounts l
         WHERE l.credit_arrangement_id = $1 AND l.status NOT LIKE 'CLOSED%' AND NOT (l.id = ANY ($2::uuid[]))) AS loan_outstanding,
       (SELECT COALESCE(SUM(a.overdraft_limit), 0) FROM savings_accounts a
         WHERE a.credit_arrangement_id = $1 AND a.status <> 'CLOSED' AND NOT (a.id = ANY ($2::uuid[]))) AS overdraft_limits,
       (SELECT COALESCE(SUM(GREATEST(-a.balance, 0)), 0) FROM savings_accounts a
         WHERE a.credit_arrangement_id = $1 AND a.status <> 'CLOSED' AND NOT (a.id = ANY ($2::uuid[]))) AS overdrawn`,
    [ca.id, exclude.filter(Boolean)]);
  const approved = round2(Number(x.loan_amounts) + Number(x.overdraft_limits));
  const outstanding = round2(Number(x.loan_outstanding) + Number(x.overdrawn));
  const consumed = ca.exposure_limit_type === 'OUTSTANDING_AMOUNT' ? outstanding : approved;
  return { approved, outstanding, consumed, available: round2(Number(ca.amount) - consumed) };
}

/** Refuse when adding `add` to the exposure would take it past the amount. */
async function assertRoom(c, ca, add, { exclude = [], what = 'THE_CHANGE' } = {}) {
  const e = await exposure(c, ca, { exclude });
  const extra = round2(add);
  if (extra > 0 && round2(e.consumed + extra) > Number(ca.amount)) {
    throw err(`CREDIT_ARRANGEMENT_LIMIT_EXCEEDED: ${ca.arrangement_no} has ${e.available} available, ${what} needs ${extra}`, 409);
  }
  return e;
}

async function linked(c, ca) {
  const { rows: loans } = await c.query(
    `SELECT l.id, l.account_no, l.product_id, l.status, l.principal, l.disbursed_on, l.expected_disbursement_date,
            GREATEST(l.principal_disbursed + l.principal_capitalized - l.principal_paid, 0) AS principal_outstanding,
            (SELECT max(i.due_date)::text FROM loan_installments i WHERE i.loan_id = l.id) AS maturity_date
       FROM loan_accounts l WHERE l.credit_arrangement_id = $1 ORDER BY l.created_at`, [ca.id]);
  const { rows: deposits } = await c.query(
    `SELECT a.id, a.account_no, a.product_id, a.status, a.balance, a.overdraft_limit, a.overdraft_expires_on
       FROM savings_accounts a WHERE a.credit_arrangement_id = $1 ORDER BY a.created_at, a.account_no`, [ca.id]);
  return { loans, deposits };
}

async function out(c, ca, { user = null } = {}) {
  const e = await exposure(c, ca);
  const cf = await CF.getValues(c, 'CREDIT_ARRANGEMENT', ca.id, { user, record: ca });
  return {
    encodedKey: ca.id, id: ca.arrangement_no,
    holderKey: ca.holder_id, holderId: ca.holder_no, holderType: ca.holder_type === 'GROUP' ? 'GROUP' : 'CLIENT',
    holderName: ca.holder_type === 'GROUP' ? ca.first_name : `${ca.first_name} ${ca.last_name}`.trim(),
    amount: Number(ca.amount), availableCreditAmount: e.available, consumedCreditAmount: e.consumed,
    exposureLimitType: ca.exposure_limit_type, state: ca.state,
    startDate: ymd(ca.start_date), expireDate: ymd(ca.expire_date),
    approvedDate: iso(ca.approved_at), closedDate: iso(ca.closed_at),
    creationDate: iso(ca.created_at), lastModifiedDate: iso(ca.updated_at), notes: ca.notes,
    // Both bases, so a console can show them side by side (the reference platform shows available and consumed on each).
    exposure: { approvedAmount: e.approved, outstandingAmount: e.outstanding },
    ...cf.values,
  };
}

async function find(c, ref, { user = null } = {}) { return out(c, await row(c, ref), { user }); }

async function list(c, { holderId = null, state = null, offset = 0, limit = 50, user = null } = {}) {
  const where = [];
  const vals = [];
  if (holderId) { vals.push(String(holderId)); where.push(`(m.id::text = $${vals.length} OR m.member_no = $${vals.length})`); }
  if (state) {
    const s = String(state).toUpperCase();
    if (!STATES.includes(s)) throw err(`STATE_IS_ONE_OF: ${STATES.join(', ')}`, 400);
    vals.push(s); where.push(`ca.state = $${vals.length}`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows: [n] } = await c.query(`SELECT count(*)::int AS n FROM credit_arrangements ca JOIN members m ON m.id = ca.holder_id ${w}`, vals);
  const { rows } = await c.query(
    `SELECT ca.*, m.member_no AS holder_no, m.holder_type, m.first_name, m.last_name
       FROM credit_arrangements ca JOIN members m ON m.id = ca.holder_id ${w}
      ORDER BY ca.created_at, ca.arrangement_no OFFSET $${vals.length + 1} LIMIT $${vals.length + 2}`, [...vals, offset, limit]);
  const items = [];
  for (const r of rows) items.push(await out(c, r, { user }));
  return { total: n.n, items };
}

async function accounts(c, ref) {
  const ca = await row(c, ref);
  const { loans, deposits } = await linked(c, ca);
  return {
    loanAccounts: loans.map((l) => ({
      encodedKey: l.id, id: l.account_no, productId: l.product_id, accountState: l.status, loanAmount: Number(l.principal),
      principalBalance: Number(l.principal_outstanding), disbursementDate: ymd(l.disbursed_on), maturityDate: ymd(l.maturity_date),
    })),
    depositAccounts: deposits.map((a) => ({
      encodedKey: a.id, id: a.account_no, productId: a.product_id, accountState: a.status, balance: Number(a.balance),
      overdraftLimit: Number(a.overdraft_limit), overdraftExpiryDate: ymd(a.overdraft_expires_on),
    })),
  };
}

// The reference platform's search fields for credit arrangements (POST /creditarrangements:search).
const SEARCH_FIELDS = {
  encodedKey: { sql: 'ca.id::text', type: 'text' }, id: { sql: 'ca.arrangement_no', type: 'text' },
  holderKey: { sql: 'ca.holder_id::text', type: 'text' }, holderId: { sql: 'm.member_no', type: 'text' },
  holderType: { sql: "CASE WHEN m.holder_type = 'GROUP' THEN 'GROUP' ELSE 'CLIENT' END", type: 'text' },
  amount: { sql: 'ca.amount', type: 'number' }, state: { sql: 'ca.state', type: 'text' },
  exposureLimitType: { sql: 'ca.exposure_limit_type', type: 'text' },
  startDate: { sql: 'ca.start_date', type: 'date' }, expireDate: { sql: 'ca.expire_date', type: 'date' },
  approvedDate: { sql: 'ca.approved_at', type: 'timestamp' }, closedDate: { sql: 'ca.closed_at', type: 'timestamp' },
  creationDate: { sql: 'ca.created_at', type: 'timestamp' }, lastModifiedDate: { sql: 'ca.updated_at', type: 'timestamp' },
  notes: { sql: 'ca.notes', type: 'text' },
};

/**
 * Search (the reference platform's POST /creditarrangements:search): filterCriteria and
 * sortingCriteria on the fields above, and custom fields as _set.field.
 */
async function search(c, body = {}, { offset = 0, limit = 50, user = null } = {}) {
  const q = SEARCH.build(body, SEARCH_FIELDS, { customColumn: 'ca.custom_fields', today: await orgToday(c) });
  const { rows } = await c.query(
    `SELECT ca.*, m.member_no AS holder_no, m.holder_type, m.first_name, m.last_name, count(*) OVER () AS total_count
       FROM credit_arrangements ca JOIN members m ON m.id = ca.holder_id
      WHERE ${q.where}
      ORDER BY ${q.order ? `${q.order}, ` : ''}ca.created_at, ca.arrangement_no
      OFFSET $${q.params.length + 1} LIMIT $${q.params.length + 2}`, [...q.params, offset, limit]);
  const items = [];
  for (const r of rows) items.push(await out(c, r, { user }));
  return { total: rows.length ? Number(rows[0].total_count) : 0, items };
}

// The reference platform's installment states; the platform's OVERDUE is the reference platform's LATE.
const INSTALLMENT_STATE = { PENDING: 'PENDING', PARTIALLY_PAID: 'PARTIALLY_PAID', PAID: 'PAID', OVERDUE: 'LATE', GRACE: 'GRACE' };

/**
 * The schedule of the arrangement (the reference platform's GET /creditarrangements/{id}/schedule):
 * the instalments of its loan accounts that are not closed, by due date.
 */
async function schedule(c, ref) {
  const ca = await row(c, ref);
  const { rows } = await c.query(
    `SELECT i.*, l.id AS loan_id, l.account_no, l.status AS loan_status
       FROM loan_installments i JOIN loan_accounts l ON l.id = i.loan_id
      WHERE l.credit_arrangement_id = $1 AND l.status NOT LIKE 'CLOSED%'
      ORDER BY i.due_date, l.account_no, i.number`, [ca.id]);
  const money = (due, paid) => {
    const expected = round2(due);
    const p = round2(paid || 0);
    return { amount: { expected, paid: p, due: round2(Math.max(0, expected - p)) } };
  };
  return {
    installments: rows.map((i) => ({
      encodedKey: i.id, parentAccountKey: i.loan_id, parentAccountId: i.account_no, number: String(i.number),
      dueDate: ymd(i.due_date), state: INSTALLMENT_STATE[i.status] || i.status, isPaymentHoliday: Boolean(i.payment_holiday),
      principal: money(i.principal_due, i.principal_paid), interest: money(i.interest_due, i.interest_paid), fee: money(i.fee_due, i.fee_paid),
    })),
  };
}

// --------------------------------------------------------------------------
// Creating and editing
// --------------------------------------------------------------------------

function amountOf(v) {
  const a = round2(v);
  if (!(a > 0)) throw err('AMOUNT_IS_MORE_THAN_ZERO', 400);
  return a;
}

function exposureType(v) {
  const t = String(v || '').toUpperCase();
  if (!EXPOSURE_TYPES.includes(t)) throw err(`EXPOSURE_LIMIT_TYPE_IS_ONE_OF: ${EXPOSURE_TYPES.join(', ')}`, 400);
  return t;
}

/** The linked accounts must sit inside the arrangement's dates. */
async function assertDatesCover(c, ca, start, expire) {
  if (!(expire > start)) throw err('EXPIRE_DATE_IS_AFTER_THE_START_DATE', 400);
  const { loans, deposits } = await linked(c, ca);
  for (const l of loans.filter((x) => !x.status.startsWith('CLOSED'))) {
    if (l.disbursed_on && ymd(l.disbursed_on) < start) throw err(`LOAN_${l.account_no}_WAS_DISBURSED_BEFORE_THE_START_DATE: ${ymd(l.disbursed_on)}`, 409);
    if (l.maturity_date && ymd(l.maturity_date) > expire) throw err(`LOAN_${l.account_no}_MATURES_AFTER_THE_EXPIRE_DATE: ${ymd(l.maturity_date)}`, 409);
  }
  for (const a of deposits.filter((x) => x.status !== 'CLOSED')) {
    if (a.overdraft_expires_on && ymd(a.overdraft_expires_on) > expire) {
      throw err(`OVERDRAFT_OF_${a.account_no}_EXPIRES_AFTER_THE_EXPIRE_DATE: ${ymd(a.overdraft_expires_on)}`, 409);
    }
  }
}

async function create(c, b = {}, { user = null, actor } = {}) {
  const holderRef = b.holderKey ?? b.holderId ?? b.memberId;
  if (!holderRef) throw err('HOLDER_KEY_REQUIRED', 400);
  const { rows: [m] } = await c.query('SELECT id, member_no, holder_type, status FROM members WHERE id::text = $1 OR member_no = $1', [String(holderRef)]);
  if (!m) throw err('HOLDER_NOT_FOUND', 404);
  if (b.holderType && !['CLIENT', 'GROUP'].includes(String(b.holderType).toUpperCase())) throw err('HOLDER_TYPE_IS_CLIENT_OR_GROUP', 400);
  if (b.holderType && (String(b.holderType).toUpperCase() === 'GROUP') !== (m.holder_type === 'GROUP')) {
    throw err(`HOLDER_TYPE_DOES_NOT_MATCH: ${m.member_no} is ${m.holder_type === 'GROUP' ? 'a group' : 'a client'}`, 400);
  }
  if (!['INACTIVE', 'ACTIVE'].includes(m.status)) throw err(`HOLDER_MAY_NOT_HAVE_A_CREDIT_ARRANGEMENT: ${m.member_no} is ${m.status}`, 409);
  const amount = amountOf(b.amount);
  const start = isoDate(b.startDate ?? await orgToday(c), 'START_DATE');
  if (b.expireDate === undefined || b.expireDate === null) throw err('EXPIRE_DATE_REQUIRED', 400);
  const expire = isoDate(b.expireDate, 'EXPIRE_DATE');
  if (!(expire > start)) throw err('EXPIRE_DATE_IS_AFTER_THE_START_DATE', 400);
  const type = b.exposureLimitType === undefined ? 'APPROVED_AMOUNT' : exposureType(b.exposureLimitType);
  let no;
  if (b.id !== undefined && b.id !== null && b.id !== '') {
    no = String(b.id);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(no)) throw err('ID_IS_UP_TO_32_LETTERS_DIGITS_DASHES_OR_UNDERSCORES', 400);
    const { rows: [t] } = await c.query("SELECT account_no_taken('CREDIT_ARRANGEMENTS', $1) AS taken", [no]);
    if (t.taken) throw err(`ID_ALREADY_IN_USE: ${no}`, 409);
  } else no = await NUMBERS.next(c, 'CREDIT_ARRANGEMENTS');
  const { rows: [ctl] } = await c.query('SELECT credit_arrangement_initial_state AS s FROM client_controls WHERE id = 1');
  const state = ctl?.s || 'PENDING_APPROVAL';
  const cf = await CF.prepare(c, 'CREDIT_ARRANGEMENT', { patch: customFieldsOf(b), user, creating: true });
  const { rows: [r] } = await c.query(
    `INSERT INTO credit_arrangements (arrangement_no, holder_id, amount, start_date, expire_date, exposure_limit_type, state, notes,
       custom_fields, approved_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [no, m.id, amount, start, expire, type, state, b.notes || null, JSON.stringify(cf), state === 'APPROVED' ? new Date() : null, actor || 'SYSTEM']);
  await audit(c, actor, 'CREDIT_ARRANGEMENT_CREATED', r.id, null, { id: no, holder: m.member_no, amount, startDate: start, expireDate: expire, exposureLimitType: type, state });
  return find(c, r.id, { user });
}

// Custom fields arrive as the reference platform's `_set` keys on the object, or as customFields.
function customFieldsOf(b) {
  if (b.customFields && typeof b.customFields === 'object') return b.customFields;
  return Object.fromEntries(Object.entries(b).filter(([k]) => k.startsWith('_')));
}

const EDITABLE = ['amount', 'startDate', 'expireDate', 'exposureLimitType', 'notes', 'customFields'];

async function update(c, ref, patch = {}, { user = null, actor } = {}) {
  const ca = await row(c, ref, { lock: true });
  if (['CLOSED', 'WITHDRAWN', 'REJECTED'].includes(ca.state)) throw err(`CREDIT_ARRANGEMENT_IS_${ca.state}`, 409);
  const cfPatch = customFieldsOf(patch);
  const unknown = Object.keys(patch).filter((k) => !EDITABLE.includes(k) && !k.startsWith('_')
    && !['encodedKey', 'id', 'holderKey', 'holderType', 'state', 'availableCreditAmount', 'consumedCreditAmount', 'creationDate',
      'lastModifiedDate', 'approvedDate', 'closedDate', 'holderId', 'holderName', 'exposure'].includes(k));
  if (unknown.length) throw err(`NOT_EDITABLE: ${unknown.join(', ')}`, 400);
  if (patch.holderKey !== undefined && patch.holderKey !== ca.holder_id) throw err('THE_HOLDER_CANNOT_CHANGE', 400);
  if (patch.state !== undefined && patch.state !== ca.state) throw err('THE_STATE_CHANGES_THROUGH_changeState', 400);
  const sets = {};
  if (patch.amount !== undefined) sets.amount = amountOf(patch.amount);
  const start = patch.startDate !== undefined ? isoDate(patch.startDate, 'START_DATE') : ymd(ca.start_date);
  const expire = patch.expireDate !== undefined ? isoDate(patch.expireDate, 'EXPIRE_DATE') : ymd(ca.expire_date);
  if (patch.startDate !== undefined || patch.expireDate !== undefined) {
    await assertDatesCover(c, ca, start, expire);
    sets.start_date = start; sets.expire_date = expire;
  }
  if (patch.exposureLimitType !== undefined) sets.exposure_limit_type = exposureType(patch.exposureLimitType);
  if (patch.notes !== undefined) sets.notes = patch.notes || null;
  if (Object.keys(cfPatch).length) {
    sets.custom_fields = JSON.stringify(await CF.prepare(c, 'CREDIT_ARRANGEMENT', { patch: cfPatch, previous: ca.custom_fields, user, recordId: ca.id }));
  }
  const keys = Object.keys(sets);
  if (!keys.length) return out(c, ca, { user });
  await c.query(`UPDATE credit_arrangements SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
    [ca.id, ...keys.map((k) => sets[k])]);
  await audit(c, actor, 'CREDIT_ARRANGEMENT_EDITED', ca.id,
    Object.fromEntries(keys.map((k) => [k, ca[k]])), Object.fromEntries(keys.map((k) => [k, sets[k]])));
  return find(c, ca.id, { user });
}

/** PUT: the whole object; the editable fields left out keep their values, notes is cleared. */
async function replace(c, ref, body = {}, opts = {}) {
  const b = { ...body };
  if (b.notes === undefined) b.notes = null;
  return update(c, ref, b, opts);
}

async function remove(c, ref, { actor } = {}) {
  const ca = await row(c, ref, { lock: true });
  const { rows: [n] } = await c.query(
    `SELECT (SELECT count(*) FROM loan_accounts WHERE credit_arrangement_id = $1)
          + (SELECT count(*) FROM savings_accounts WHERE credit_arrangement_id = $1) AS n`, [ca.id]);
  if (Number(n.n)) throw err(`CREDIT_ARRANGEMENT_HAS_ACCOUNTS: ${n.n}`, 409);
  await c.query('DELETE FROM credit_arrangements WHERE id = $1', [ca.id]);
  await audit(c, actor, 'CREDIT_ARRANGEMENT_DELETED', ca.id, { id: ca.arrangement_no, holder: ca.holder_no, amount: Number(ca.amount) }, null);
  return { deleted: ca.arrangement_no };
}

// --------------------------------------------------------------------------
// States
// --------------------------------------------------------------------------

async function changeState(c, ref, action, { notes = null, user = null, actor } = {}) {
  const name = String(action || '').toUpperCase();
  const t = ACTIONS[name];
  if (!t) throw err(`ACTION_IS_ONE_OF: ${Object.keys(ACTIONS).join(', ')}`, 400);
  assertAllowed(user, t[2]);
  const ca = await row(c, ref, { lock: true });
  if (!t[0].includes(ca.state)) throw err(`INVALID_STATE_TRANSITION: ${ca.state} -> ${name}`, 409);
  let to = t[1];
  const sets = {};
  if (name === 'APPROVE') sets.approved_at = new Date();
  if (name === 'UNDO_APPROVE') sets.approved_at = null;
  if (name === 'CLOSE') {
    const { loans, deposits } = await linked(c, ca);
    const open = [...loans.filter((l) => !l.status.startsWith('CLOSED')).map((l) => l.account_no),
      ...deposits.filter((a) => a.status !== 'CLOSED').map((a) => a.account_no)];
    if (open.length) throw err(`ACCOUNTS_STILL_OPEN: ${open.join(', ')}`, 409);
    sets.closed_at = new Date();
    sets.state_before_close = ca.state;
  }
  if (name === 'UNDO_CLOSE') {
    if (ymd(ca.expire_date) < await orgToday(c)) throw err(`CREDIT_ARRANGEMENT_EXPIRED: ${ymd(ca.expire_date)}`, 409);
    to = ca.state_before_close || 'APPROVED';
    sets.closed_at = null;
    sets.state_before_close = null;
  }
  sets.state = to;
  const keys = Object.keys(sets);
  await c.query(`UPDATE credit_arrangements SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
    [ca.id, ...keys.map((k) => sets[k])]);
  await audit(c, actor, `CREDIT_ARRANGEMENT_${name}`, ca.id, { state: ca.state }, { state: to, notes });
  return find(c, ca.id, { user });
}

// --------------------------------------------------------------------------
// Linking accounts
// --------------------------------------------------------------------------

function accountTypeOf(v) {
  const t = String(v || '').toUpperCase();
  if (t === 'LOAN') return 'LOAN';
  if (t === 'DEPOSIT' || t === 'SAVINGS') return 'DEPOSIT';
  throw err('ACCOUNT_TYPE_IS_LOAN_OR_DEPOSIT', 400);
}

async function addAccount(c, ref, { accountId, accountType } = {}, { user = null, actor } = {}) {
  const type = accountTypeOf(accountType);
  if (!accountId) throw err('ACCOUNT_ID_REQUIRED', 400);
  const ca = await row(c, ref, { lock: true });
  if (!RUNNING.includes(ca.state)) throw err(`CREDIT_ARRANGEMENT_IS_${ca.state}: accounts are added once it is approved`, 409);
  const start = ymd(ca.start_date);
  const expire = ymd(ca.expire_date);
  if (type === 'LOAN') {
    const { rows: [l] } = await c.query(
      `SELECT l.*, p.credit_arrangement_requirement AS requirement,
              (SELECT max(i.due_date)::text FROM loan_installments i WHERE i.loan_id = l.id) AS maturity_date
         FROM loan_accounts l JOIN loan_products p ON p.id = l.product_id
        WHERE l.id::text = $1 OR l.account_no = $1 FOR UPDATE OF l`, [String(accountId)]);
    if (!l) throw err('LOAN_ACCOUNT_NOT_FOUND', 404);
    if (l.member_id !== ca.holder_id) throw err(`THE_ACCOUNT_BELONGS_TO_ANOTHER_HOLDER: ${l.account_no}`, 409);
    if (l.credit_arrangement_id) throw err(`ALREADY_IN_A_CREDIT_ARRANGEMENT: ${l.account_no}`, 409);
    if (l.requirement === 'NOT_REQUIRED') throw err(`PRODUCT_DOES_NOT_TAKE_CREDIT_ARRANGEMENTS: ${l.product_id}`, 409);
    if (!LINKABLE_LOAN_STATES.includes(l.status)) throw err(`LOAN_IS_${l.status}`, 409);
    const disb = l.disbursed_on ? ymd(l.disbursed_on) : ymd(l.expected_disbursement_date);
    if (disb && disb < start) throw err(`DISBURSEMENT_BEFORE_THE_START_DATE: ${disb} is before ${start}`, 409);
    if (disb && disb > expire) throw err(`DISBURSEMENT_AFTER_THE_EXPIRE_DATE: ${disb} is after ${expire}`, 409);
    if (l.maturity_date && ymd(l.maturity_date) > expire) throw err(`MATURITY_AFTER_THE_EXPIRE_DATE: ${ymd(l.maturity_date)} is after ${expire}`, 409);
    const add = ca.exposure_limit_type === 'OUTSTANDING_AMOUNT'
      ? round2(Math.max(0, Number(l.principal_disbursed) + Number(l.principal_capitalized || 0) - Number(l.principal_paid)))
      : Number(l.principal);
    await assertRoom(c, ca, add, { what: `loan ${l.account_no}` });
    await c.query('UPDATE loan_accounts SET credit_arrangement_id = $2, updated_at = now() WHERE id = $1', [l.id, ca.id]);
    await audit(c, actor, 'CREDIT_ARRANGEMENT_ACCOUNT_ADDED', ca.id, null, { loan: l.account_no });
  } else {
    const { rows: [a] } = await c.query(
      `SELECT a.*, p.credit_arrangement_requirement AS requirement, p.allow_overdraft
         FROM savings_accounts a JOIN savings_products p ON p.id = a.product_id
        WHERE a.id::text = $1 OR a.account_no = $1 FOR UPDATE OF a`, [String(accountId)]);
    if (!a) throw err('SAVINGS_ACCOUNT_NOT_FOUND', 404);
    if (a.member_id !== ca.holder_id) throw err(`THE_ACCOUNT_BELONGS_TO_ANOTHER_HOLDER: ${a.account_no}`, 409);
    if (a.credit_arrangement_id) throw err(`ALREADY_IN_A_CREDIT_ARRANGEMENT: ${a.account_no}`, 409);
    if (a.requirement === 'NOT_REQUIRED') throw err(`PRODUCT_DOES_NOT_TAKE_CREDIT_ARRANGEMENTS: ${a.product_id}`, 409);
    if (!a.allow_overdraft) throw err(`PRODUCT_DOES_NOT_ALLOW_OVERDRAFTS: ${a.product_id}`, 409);
    if (!OPEN_DEPOSIT_STATES.includes(a.status)) throw err(`DEPOSIT_ACCOUNT_IS_${a.status}`, 409);
    // The reference platform: an overdraft is linked only with an expiry date, inside the arrangement's.
    if (!a.overdraft_expires_on) throw err(`OVERDRAFT_EXPIRY_DATE_REQUIRED: ${a.account_no}`, 409);
    if (ymd(a.overdraft_expires_on) > expire) throw err(`OVERDRAFT_EXPIRES_AFTER_THE_EXPIRE_DATE: ${ymd(a.overdraft_expires_on)} is after ${expire}`, 409);
    const add = ca.exposure_limit_type === 'OUTSTANDING_AMOUNT' ? round2(Math.max(0, -Number(a.balance))) : Number(a.overdraft_limit);
    await assertRoom(c, ca, add, { what: `deposit account ${a.account_no}` });
    await c.query('UPDATE savings_accounts SET credit_arrangement_id = $2 WHERE id = $1', [a.id, ca.id]);
    await audit(c, actor, 'CREDIT_ARRANGEMENT_ACCOUNT_ADDED', ca.id, null, { deposit: a.account_no });
  }
  if (ca.state === 'APPROVED') {
    await c.query("UPDATE credit_arrangements SET state = 'ACTIVE', updated_at = now() WHERE id = $1", [ca.id]);
    await audit(c, actor, 'CREDIT_ARRANGEMENT_ACTIVATED', ca.id, { state: 'APPROVED' }, { state: 'ACTIVE' });
  }
  return find(c, ca.id, { user });
}

async function removeAccount(c, ref, { accountId, accountType } = {}, { user = null, actor } = {}) {
  const type = accountTypeOf(accountType);
  const ca = await row(c, ref, { lock: true });
  const table = type === 'LOAN' ? 'loan_accounts' : 'savings_accounts';
  const products = type === 'LOAN' ? 'loan_products' : 'savings_products';
  const { rows: [x] } = await c.query(
    `SELECT a.id, a.account_no, a.status, a.credit_arrangement_id, p.credit_arrangement_requirement AS requirement
       FROM ${table} a JOIN ${products} p ON p.id = a.product_id WHERE a.id::text = $1 OR a.account_no = $1 FOR UPDATE OF a`, [String(accountId)]);
  if (!x || x.credit_arrangement_id !== ca.id) throw err('ACCOUNT_NOT_IN_THIS_CREDIT_ARRANGEMENT', 404);
  if (x.status.startsWith('CLOSED')) throw err(`ACCOUNT_IS_CLOSED: ${x.account_no}`, 409);
  if (x.requirement === 'REQUIRED') throw err(`PRODUCT_REQUIRES_A_CREDIT_ARRANGEMENT: ${x.account_no}`, 409);
  await c.query(`UPDATE ${table} SET credit_arrangement_id = NULL WHERE id = $1`, [x.id]);
  await audit(c, actor, 'CREDIT_ARRANGEMENT_ACCOUNT_REMOVED', ca.id, { [type === 'LOAN' ? 'loan' : 'deposit']: x.account_no }, null);
  return find(c, ca.id, { user });
}

// --------------------------------------------------------------------------
// The engine's checks
// --------------------------------------------------------------------------

async function ofAccount(c, id) {
  if (!id) return null;
  const { rows: [ca] } = await c.query('SELECT * FROM credit_arrangements WHERE id = $1 FOR UPDATE', [id]);
  return ca || null;
}

async function requirementOf(c, table, productId) {
  const { rows: [p] } = await c.query(`SELECT credit_arrangement_requirement AS r FROM ${table} WHERE id = $1`, [productId]);
  return p?.r || 'NOT_REQUIRED';
}

/** At loan approval: a product that requires an arrangement has one. */
async function onLoanApprove(c, l) {
  if (!l.credit_arrangement_id && await requirementOf(c, 'loan_products', l.product_id) === 'REQUIRED') {
    throw err(`LOAN_NEEDS_A_CREDIT_ARRANGEMENT: product ${l.product_id} requires one`, 409);
  }
}

/**
 * Before money is paid out on a loan (first payout, tranche or revolving
 * draw): the arrangement is approved or active, the date is inside its
 * dates, and on the outstanding basis the payout fits.
 */
async function onLoanDisburse(c, l, { amount, date }) {
  await onLoanApprove(c, l);
  const ca = await ofAccount(c, l.credit_arrangement_id);
  if (!ca) return;
  if (!RUNNING.includes(ca.state)) throw err(`CREDIT_ARRANGEMENT_IS_${ca.state}: ${ca.arrangement_no}`, 409);
  if (date < ymd(ca.start_date)) throw err(`DISBURSEMENT_BEFORE_THE_START_DATE: ${ca.arrangement_no} starts ${ymd(ca.start_date)}`, 409);
  if (date > ymd(ca.expire_date)) throw err(`CREDIT_ARRANGEMENT_EXPIRED: ${ca.arrangement_no} expired ${ymd(ca.expire_date)}`, 409);
  if (ca.exposure_limit_type === 'OUTSTANDING_AMOUNT') await assertRoom(c, ca, amount, { what: `the disbursement on ${l.account_no}` });
  else {
    const e = await exposure(c, ca);
    if (e.available < 0) throw err(`CREDIT_ARRANGEMENT_LIMIT_EXCEEDED: ${ca.arrangement_no} has ${e.available} available`, 409);
  }
}

/** After a loan's schedule is drawn: it matures by the arrangement's expire date. */
async function afterLoanDisburse(c, loanId) {
  const { rows: [l] } = await c.query(
    `SELECT l.account_no, l.credit_arrangement_id, (SELECT max(i.due_date)::text FROM loan_installments i WHERE i.loan_id = l.id) AS maturity
       FROM loan_accounts l WHERE l.id = $1`, [loanId]);
  if (!l?.credit_arrangement_id || !l.maturity) return;
  const ca = await ofAccount(c, l.credit_arrangement_id);
  if (ymd(l.maturity) > ymd(ca.expire_date)) {
    throw err(`MATURITY_AFTER_THE_EXPIRE_DATE: ${l.account_no} matures ${ymd(l.maturity)}, ${ca.arrangement_no} expires ${ymd(ca.expire_date)}`, 409);
  }
}

/** A loan amount changed on the application: on the approved basis the difference must fit. */
async function onLoanAmount(c, l, principal) {
  const ca = await ofAccount(c, l.credit_arrangement_id);
  if (!ca || ca.exposure_limit_type !== 'APPROVED_AMOUNT') return;
  await assertRoom(c, ca, round2(Number(principal) - Number(l.principal)), { what: `the new amount of ${l.account_no}` });
}

/**
 * A reschedule or refinance: the new loan takes the old one's arrangement
 * (The reference platform keeps it linked), and the new principal must fit once the old
 * loan is left out.
 */
async function carry(c, oldLoanId, fresh) {
  const { rows: [old] } = await c.query('SELECT credit_arrangement_id FROM loan_accounts WHERE id = $1', [oldLoanId]);
  if (!old?.credit_arrangement_id) return;
  const ca = await ofAccount(c, old.credit_arrangement_id);
  await assertRoom(c, ca, Number(fresh.principal), { exclude: [oldLoanId, fresh.id], what: `the new loan ${fresh.account_no}` });
  await c.query('UPDATE loan_accounts SET credit_arrangement_id = $2 WHERE id = $1', [fresh.id, ca.id]);
}

/** A loan reopened (undo close, withdraw or reject): not into a closed arrangement. */
async function onLoanReopen(c, l) {
  const ca = await ofAccount(c, l.credit_arrangement_id);
  if (ca && ca.state === 'CLOSED') throw err(`CREDIT_ARRANGEMENT_IS_CLOSED: ${ca.arrangement_no}`, 409);
}

/** An overdraft limit (and its expiry) set on a deposit account. */
async function onOverdraft(c, a, { limit, expiresOn }) {
  const requirement = await requirementOf(c, 'savings_products', a.product_id);
  if (limit > 0 && !a.credit_arrangement_id && requirement === 'REQUIRED') {
    throw err(`OVERDRAFT_NEEDS_A_CREDIT_ARRANGEMENT: product ${a.product_id} requires one`, 409);
  }
  const ca = await ofAccount(c, a.credit_arrangement_id);
  if (!ca) return;
  if (!expiresOn) throw err(`OVERDRAFT_EXPIRY_DATE_REQUIRED: ${a.account_no} is in ${ca.arrangement_no}`, 409);
  if (expiresOn > ymd(ca.expire_date)) throw err(`OVERDRAFT_EXPIRES_AFTER_THE_EXPIRE_DATE: ${ca.arrangement_no} expires ${ymd(ca.expire_date)}`, 409);
  if (ca.exposure_limit_type === 'APPROVED_AMOUNT') {
    if (!RUNNING.includes(ca.state) && limit > Number(a.overdraft_limit)) throw err(`CREDIT_ARRANGEMENT_IS_${ca.state}: ${ca.arrangement_no}`, 409);
    await assertRoom(c, ca, round2(limit - Number(a.overdraft_limit)), { what: `the overdraft limit of ${a.account_no}` });
  }
}

/** Money out of a linked deposit account into its overdraft, on the outstanding basis. */
async function onOverdraw(c, a, amount, date) {
  if (!a.credit_arrangement_id) return;
  const before = Math.max(0, -Number(a.balance));
  const after = Math.max(0, round2(Number(amount) - Number(a.balance)));
  const more = round2(after - before);
  if (!(more > 0)) return;
  const ca = await ofAccount(c, a.credit_arrangement_id);
  if (!RUNNING.includes(ca.state)) throw err(`CREDIT_ARRANGEMENT_IS_${ca.state}: ${ca.arrangement_no}`, 409);
  if (date > ymd(ca.expire_date)) throw err(`CREDIT_ARRANGEMENT_EXPIRED: ${ca.arrangement_no} expired ${ymd(ca.expire_date)}`, 409);
  if (ca.exposure_limit_type === 'OUTSTANDING_AMOUNT') await assertRoom(c, ca, more, { what: `the overdraft on ${a.account_no}` });
}

/** A product's setting may not go to NOT_REQUIRED while its open accounts are linked. */
async function assertRequirement(c, kind, productId, value) {
  if (value === undefined) return undefined;
  const v = String(value || '').toUpperCase();
  if (!REQUIREMENTS.includes(v)) throw err(`CREDIT_ARRANGEMENT_REQUIREMENT_IS_ONE_OF: ${REQUIREMENTS.join(', ')}`, 400);
  if (v === 'NOT_REQUIRED' && productId) {
    const sql = kind === 'LOAN'
      ? "SELECT count(*)::int AS n FROM loan_accounts WHERE product_id = $1 AND credit_arrangement_id IS NOT NULL AND status NOT LIKE 'CLOSED%'"
      : "SELECT count(*)::int AS n FROM savings_accounts WHERE product_id = $1 AND credit_arrangement_id IS NOT NULL AND status <> 'CLOSED'";
    const { rows: [n] } = await c.query(sql, [productId]);
    if (n.n) throw err(`ACCOUNTS_ARE_IN_CREDIT_ARRANGEMENTS: ${n.n}`, 409);
  }
  return v;
}

module.exports = {
  STATES, EXPOSURE_TYPES, REQUIREMENTS, ACTIONS,
  row, exposure, find, list, search, schedule, accounts, create, update, replace, remove, changeState, addAccount, removeAccount,
  onLoanApprove, onLoanDisburse, afterLoanDisburse, onLoanAmount, carry, onLoanReopen, onOverdraft, onOverdraw, assertRequirement,
};
