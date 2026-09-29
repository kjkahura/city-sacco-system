'use strict';

const { orgToday } = require('../lib/orgDate');
const acct = require('./accounting');
const ledger = require('./ledger');
const savings = require('./savings');
const CF = require('./customFields');
const { err, round2, isoDay } = acct;

/**
 * Branches, inter-branch rules, accounting closures and moving an account
 * between branches.
 *
 * Every account carries a branch (its member's, when opened) and every
 * journal line carries the branch it belongs to. An entry balances in each
 * branch: when a teller at one branch takes money for an account at another,
 * accounting.post squares the two through the inter-branch account named by
 * the rule for that pair, or the default rule.
 *
 * A closure, tenant-wide or for one branch, refuses anything dated on or
 * before it. Closures can be set by hand or by the end of day every N days.
 */

const today = (c) => orgToday(c);

// --------------------------------------------------------------------------
// Branches
// --------------------------------------------------------------------------

async function list(c) {
  const { rows } = await c.query(
    `SELECT b.*, (SELECT count(*)::int FROM members m WHERE m.branch_id = b.id) AS members,
            closed_through_for(b.id) AS closed_through
     FROM branches b ORDER BY b.code`);
  return rows;
}

const BRANCH_FIELDS = { name: 'name', town: 'town', phone: 'phone', address: 'address', email: 'email', notes: 'notes' };

function branchCols(body, creating) {
  const out = {};
  for (const [k, col] of Object.entries(BRANCH_FIELDS)) {
    if (body[k] === undefined) continue;
    out[col] = body[k] === '' ? null : String(body[k]).slice(0, col === 'notes' ? 4000 : 255);
  }
  if (creating && !out.name) throw err('BRANCH_NAME_REQUIRED', 400);
  if (body.name !== undefined && !out.name) throw err('BRANCH_NAME_REQUIRED', 400);
  if (out.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) throw err('INVALID_EMAIL', 400);
  return out;
}

/**
 * A branch (the reference platform's Administration > Organization > Branches): name and ID
 * (code) required; address, phone, email, notes and custom fields optional.
 */
async function create(c, { code, createdBy, user = null, customFields = {}, ...body }) {
  if (!code || !/^[A-Z0-9_-]{2,16}$/.test(code)) throw err('BRANCH_CODE_MUST_BE_2_TO_16_UPPERCASE_CHARACTERS', 400);
  const cols = { code, ...branchCols(body, true) };
  cols.custom_fields = JSON.stringify(await CF.prepare(c, 'BRANCH', { patch: customFields, user, creating: true }));
  const keys = Object.keys(cols);
  const { rows } = await c.query(
    `INSERT INTO branches (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT (code) DO NOTHING RETURNING *`,
    keys.map((k) => cols[k]));
  if (!rows.length) throw err('BRANCH_CODE_EXISTS', 409);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'BRANCH_CREATED','branch',$2,$3)`,
    [createdBy || 'SYSTEM', rows[0].id, JSON.stringify(rows[0])]);
  return rows[0];
}

/**
 * Edit a branch, or deactivate it (status CLOSED) and reactivate it. A
 * branch with active accounts can be deactivated; one with active centres
 * cannot (the reference platform). A deactivated branch still shows in searches and reports.
 */
async function update(c, id, { status, createdBy, user = null, customFields, ...body }) {
  const { rows: [before] } = await c.query('SELECT * FROM branches WHERE id::text = $1 OR code = $1 FOR UPDATE', [id]);
  if (!before) throw err('BRANCH_NOT_FOUND', 404);
  const cols = branchCols(body, false);
  if (status !== undefined) {
    const st = status === 'INACTIVE' ? 'CLOSED' : status;
    if (!['ACTIVE', 'CLOSED'].includes(st)) throw err('STATUS_MUST_BE_ACTIVE_OR_CLOSED', 400);
    if (st === 'CLOSED' && before.status !== 'CLOSED') {
      const { rows: [n] } = await c.query("SELECT count(*)::int AS n FROM centres WHERE branch_id = $1 AND status = 'ACTIVE'", [before.id]);
      if (n.n > 0) throw err(`BRANCH_HAS_ACTIVE_CENTRES: ${n.n}; deactivate them first`, 409);
    }
    cols.status = st;
  }
  if (customFields !== undefined) {
    cols.custom_fields = JSON.stringify(await CF.prepare(c, 'BRANCH', { patch: customFields, previous: before.custom_fields, user, recordId: before.id }));
  }
  const keys = Object.keys(cols);
  if (!keys.length) throw err('NO_UPDATABLE_FIELDS', 400);
  const { rows: [after] } = await c.query(
    `UPDATE branches SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [before.id, ...keys.map((k) => cols[k])]);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'BRANCH_CHANGED','branch',$2,$3,$4)`,
    [createdBy || 'SYSTEM', before.id, JSON.stringify(before), JSON.stringify(after)]);
  return after;
}

/** A branch with its centres, what sits in it, its holidays and its activity (the reference platform's branch view). */
async function detail(c, id) {
  const b = await resolve(c, id);
  const { rows: [counts] } = await c.query(
    `SELECT (SELECT count(*)::int FROM members WHERE branch_id = $1) AS members,
            (SELECT count(*)::int FROM loan_accounts WHERE branch_id = $1 AND status IN ('ACTIVE', 'IN_ARREARS', 'LOCKED')) AS active_loans,
            (SELECT count(*)::int FROM savings_accounts WHERE branch_id = $1 AND status IN ('ACTIVE', 'IN_ARREARS')) AS active_deposits`, [b.id]);
  const { rows: centres } = await c.query('SELECT * FROM centres WHERE branch_id = $1 ORDER BY code', [b.id]);
  const { rows: holidays } = await c.query('SELECT id, name AS description, holiday_date, recurring FROM holidays WHERE branch_id = $1 ORDER BY holiday_date', [b.id]);
  const { rows: activity } = await c.query(
    `SELECT actor, action, created_at FROM audit_log WHERE entity = 'branch' AND entity_id = $1 ORDER BY created_at DESC LIMIT 50`, [String(b.id)]);
  return { ...b, ...counts, centres, holidays, activity };
}

/** Branch references (IDs or codes) as IDs; null or an empty list for every branch. */
async function resolveBranchIds(c, list) {
  if (list === null || list === undefined || (Array.isArray(list) && !list.length)) return null;
  if (!Array.isArray(list)) throw err('AVAILABLE_BRANCHES_IS_A_LIST_OR_NULL', 400);
  const ids = [];
  for (const ref of list) ids.push((await resolve(c, String(ref))).id);
  return [...new Set(ids)];
}

/** Refuse a product the branch may not offer (the reference platform's product availability per branch). */
function assertProductAvailable(product, branchId, label = 'product') {
  if (!product.branch_ids || !product.branch_ids.length || !branchId) return;
  if (!product.branch_ids.includes(branchId)) throw err(`${label.toUpperCase()}_NOT_AVAILABLE_IN_THIS_BRANCH: ${product.id}`, 409);
}

// --------------------------------------------------------------------------
// Centres
// --------------------------------------------------------------------------

const CENTRE_FIELDS = { name: 'name', address: 'address', notes: 'notes' };

async function centres(c, { branchId = null, includeInactive = true } = {}) {
  const branch = branchId ? (await resolve(c, branchId)).id : null;
  const { rows } = await c.query(
    `SELECT ce.*, b.code AS branch_code, b.name AS branch_name, (SELECT count(*)::int FROM members m WHERE m.centre_id = ce.id) AS members
     FROM centres ce JOIN branches b ON b.id = ce.branch_id
     WHERE ($1::uuid IS NULL OR ce.branch_id = $1) AND ($2::boolean OR ce.status = 'ACTIVE') ORDER BY b.code, ce.code`,
    [branch, includeInactive]);
  return rows;
}

async function findCentre(c, id) {
  const { rows: [ce] } = await c.query('SELECT * FROM centres WHERE id::text = $1 OR code = $1', [String(id)]);
  if (!ce) throw err(`UNKNOWN_CENTRE: ${id}`, 404);
  return ce;
}

function meetingDay(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 6) throw err('MEETING_DAY_IS_0_SUNDAY_TO_6_SATURDAY', 400);
  return n;
}

/**
 * A centre: a subdivision of a branch that members can belong to, with an
 * optional weekly meeting day. A new loan for a member of a centre with a
 * meeting day has its first repayment moved to the next meeting day (./loans).
 */
async function createCentre(c, { code, branchId, meetingDay: md, customFields = {}, createdBy, user = null, ...body } = {}) {
  if (!code || !/^[A-Z0-9_-]{2,16}$/.test(code)) throw err('CENTRE_CODE_MUST_BE_2_TO_16_UPPERCASE_CHARACTERS', 400);
  if (!body.name) throw err('CENTRE_NAME_REQUIRED', 400);
  const b = await resolve(c, branchId);
  if (b.status !== 'ACTIVE') throw err('BRANCH_IS_DEACTIVATED', 409);
  const cols = { code, branch_id: b.id, meeting_day: meetingDay(md) ?? null };
  for (const [k, col] of Object.entries(CENTRE_FIELDS)) if (body[k] !== undefined) cols[col] = body[k] || null;
  cols.custom_fields = JSON.stringify(await CF.prepare(c, 'CENTRE', { patch: customFields, user, creating: true }));
  const keys = Object.keys(cols);
  const { rows: [ce] } = await c.query(
    `INSERT INTO centres (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT (code) DO NOTHING RETURNING *`,
    keys.map((k) => cols[k]));
  if (!ce) throw err('CENTRE_CODE_EXISTS', 409);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'CENTRE_CREATED','centre',$2,$3)`,
    [createdBy || 'SYSTEM', ce.id, JSON.stringify(ce)]);
  return ce;
}

async function updateCentre(c, id, { meetingDay: md, status, customFields, branchId, createdBy, user = null, ...body } = {}) {
  const before = await findCentre(c, id);
  const cols = {};
  for (const [k, col] of Object.entries(CENTRE_FIELDS)) if (body[k] !== undefined) cols[col] = body[k] || null;
  if (cols.name === null) throw err('CENTRE_NAME_REQUIRED', 400);
  const m = meetingDay(md);
  if (m !== undefined) cols.meeting_day = m;
  if (branchId !== undefined) {
    const b = await resolve(c, branchId);
    if (b.id !== before.branch_id) {
      const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM members WHERE centre_id = $1', [before.id]);
      if (n.n > 0) throw err(`CENTRE_HAS_MEMBERS: ${n.n}; it cannot move branch`, 409);
      cols.branch_id = b.id;
    }
  }
  if (status !== undefined) {
    if (!['ACTIVE', 'INACTIVE'].includes(status)) throw err('STATUS_MUST_BE_ACTIVE_OR_INACTIVE', 400);
    if (status === 'ACTIVE') {
      const { rows: [b] } = await c.query('SELECT status FROM branches WHERE id = $1', [cols.branch_id || before.branch_id]);
      if (b.status !== 'ACTIVE') throw err('BRANCH_IS_DEACTIVATED', 409);
    }
    cols.status = status;
  }
  if (customFields !== undefined) {
    cols.custom_fields = JSON.stringify(await CF.prepare(c, 'CENTRE', { patch: customFields, previous: before.custom_fields, user, recordId: before.id }));
  }
  const keys = Object.keys(cols);
  if (!keys.length) throw err('NO_UPDATABLE_FIELDS', 400);
  const { rows: [after] } = await c.query(
    `UPDATE centres SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [before.id, ...keys.map((k) => cols[k])]);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'CENTRE_CHANGED','centre',$2,$3,$4)`,
    [createdBy || 'SYSTEM', before.id, JSON.stringify(before), JSON.stringify(after)]);
  return after;
}

/** The centre a member may be put in: active, and in the member's branch. */
async function centreFor(c, centreId, branchId) {
  if (!centreId) return null;
  const ce = await findCentre(c, centreId);
  if (ce.status !== 'ACTIVE') throw err('CENTRE_IS_DEACTIVATED', 409);
  if (branchId && ce.branch_id !== branchId) throw err('CENTRE_IS_IN_ANOTHER_BRANCH', 409);
  return ce;
}

async function resolve(c, id) {
  if (!id) return null;
  const { rows: [b] } = await c.query('SELECT * FROM branches WHERE id::text = $1 OR code = $1', [id]);
  if (!b) throw err('BRANCH_NOT_FOUND', 404);
  return b;
}

// --------------------------------------------------------------------------
// Inter-branch rules
// --------------------------------------------------------------------------

async function rules(c) {
  const { rows } = await c.query(
    `SELECT r.*, a.code AS branch_a_code, b.code AS branch_b_code FROM inter_branch_rules r
     LEFT JOIN branches a ON a.id = r.branch_a LEFT JOIN branches b ON b.id = r.branch_b
     ORDER BY r.branch_a IS NOT NULL, r.id`);
  return rows;
}

/**
 * Replace the rule set. One rule may leave both branches empty: the default
 * for any pair, which must be in the organisation's base currency (this
 * system has one currency, so any account qualifies). Each named pair may
 * appear once, in either order.
 */
async function setRules(c, list, { createdBy } = {}) {
  if (!Array.isArray(list)) throw err('RULES_MUST_BE_A_LIST', 400);
  const seen = new Set();
  const clean = [];
  for (const r of list) {
    if (!r || !r.id || !/^[A-Za-z0-9]{1,32}$/.test(r.id)) throw err('ID_NOT_ALPHANUMERIC: a rule id is 1 to 32 letters and digits', 400);
    if (seen.has(r.id)) throw err(`ACCOUNTING_RULE_DUPLICATE_ID: ${r.id}`, 400);
    seen.add(r.id);
    const a = r.branchA ? (await resolve(c, r.branchA)).id : null;
    const b = r.branchB ? (await resolve(c, r.branchB)).id : null;
    if ((a === null) !== (b === null)) throw err('BOTH_BRANCHES_MUST_BE_SET_OR_BOTH_BRANCHES_NOT_SET', 400);
    if (a && a === b) throw err('BRANCHES_ARE_EQUAL', 400);
    const { rows: [g] } = await c.query(
      `SELECT g.code, g.is_active, EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.parent_code = g.code) AS is_header
       FROM gl_accounts g WHERE g.code = $1`, [r.glCode]);
    if (!g) throw err(`GLACCOUNT_DOESNT_EXIST: ${r.glCode}`, 400);
    if (!g.is_active || g.is_header) throw err(`GLACCOUNT_NOT_SET: ${r.glCode} must be an active detail account`, 400);
    const pair = [a || '', b || ''].sort().join('|');
    if (clean.some((x) => x.pair === pair)) throw err('DUPLICATE_RULE_FOR_BRANCH_PAIR', 400);
    clean.push({ id: r.id, a, b, gl: r.glCode, pair });
  }
  const before = await rules(c);
  await c.query('DELETE FROM inter_branch_rules');
  for (const r of clean) {
    await c.query('INSERT INTO inter_branch_rules (id, branch_a, branch_b, gl_code) VALUES ($1,$2,$3,$4)', [r.id, r.a, r.b, r.gl]);
  }
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'INTER_BRANCH_RULES_CHANGED','inter_branch_rules','all',$2,$3)`,
    [createdBy || 'SYSTEM', JSON.stringify(before), JSON.stringify(clean)]);
  return rules(c);
}

// --------------------------------------------------------------------------
// Closures
// --------------------------------------------------------------------------

async function closures(c, { includeDeleted = false } = {}) {
  const { rows } = await c.query(
    `SELECT k.*, b.code AS branch_code FROM accounting_closures k LEFT JOIN branches b ON b.id = k.branch_id
     WHERE $1 OR k.deleted_at IS NULL ORDER BY k.closed_through DESC, k.created_at DESC`, [includeDeleted]);
  return rows;
}

/**
 * Close the books through a date, for every branch or one. The date must be
 * in the past and after the closure already covering that scope.
 */
async function close(c, { closedThrough, branchId = null, notes = null, automatic = false, createdBy }) {
  const date = closedThrough ? isoDay(closedThrough) : null;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw err('CLOSURE_DATE_REQUIRED', 400);
  if (date >= (await today(c))) throw err('CLOSURE_DATE_MUST_BE_IN_THE_PAST', 400);
  const branch = branchId ? await resolve(c, branchId) : null;
  const existing = await acct.closedThrough(c, branch ? branch.id : null);
  if (existing && date <= existing) throw err(`CLOSURE_MUST_FOLLOW_THE_LAST_ONE: already closed through ${existing}`, 409);
  if (!branch) {
    // A tenant-wide closure must follow every branch's own too.
    const { rows: [m] } = await c.query('SELECT max(closed_through) AS d FROM accounting_closures WHERE deleted_at IS NULL');
    if (m.d && date <= isoDay(m.d)) throw err(`CLOSURE_MUST_FOLLOW_THE_LAST_ONE: a branch is already closed through ${isoDay(m.d)}`, 409);
  }
  const { rows: [k] } = await c.query(
    `INSERT INTO accounting_closures (branch_id, closed_through, notes, automatic, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [branch ? branch.id : null, date, notes, automatic, createdBy || 'SYSTEM']);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'ACCOUNTING_CLOSED','accounting_closure',$2,$3)`,
    [createdBy || 'SYSTEM', k.id, JSON.stringify(k)]);
  return k;
}

/** Remove a closure, so something can be backdated before it. Kept, marked deleted, for the audit trail. */
async function reopen(c, closureId, { createdBy, reason = null } = {}) {
  const { rows: [k] } = await c.query(
    'UPDATE accounting_closures SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING *', [closureId, createdBy || 'SYSTEM']);
  if (!k) throw err('CLOSURE_NOT_FOUND', 404);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'ACCOUNTING_CLOSURE_DELETED','accounting_closure',$2,$3,$4)`,
    [createdBy || 'SYSTEM', k.id, JSON.stringify(k), JSON.stringify({ reason })]);
  return k;
}

async function settings(c) {
  const { rows: [s] } = await c.query('SELECT * FROM accounting_settings WHERE only_row');
  return s;
}

async function updateSettings(c, { autoClosureEnabled, autoClosureIntervalDays, glSuspense, currencyDecimals, createdBy } = {}) {
  const before = await settings(c);
  if (autoClosureIntervalDays !== undefined && autoClosureIntervalDays !== null
    && !(Number.isInteger(Number(autoClosureIntervalDays)) && Number(autoClosureIntervalDays) >= 1 && Number(autoClosureIntervalDays) <= 366)) {
    throw err('AUTOMATED_ACCOUNTING_CLOSURES_INTERVAL_MUST_BE_1_TO_366_DAYS', 400);
  }
  // The currency's minor units, for amounts worked out from a rate
  // (schedules, interest and penalty accruals). Set from the tenant's
  // currency when the tenant is created; changeable for a currency whose
  // cents have gone out of use.
  if (currencyDecimals !== undefined && !(Number.isInteger(Number(currencyDecimals)) && Number(currencyDecimals) >= 0 && Number(currencyDecimals) <= 4)) {
    throw err('CURRENCY_DECIMALS_MUST_BE_0_TO_4', 400);
  }
  const enabling = autoClosureEnabled ?? before.auto_closure_enabled;
  const interval = autoClosureIntervalDays ?? before.auto_closure_interval_days;
  if (enabling && !interval) throw err('AUTOMATIC_CLOSURES_NEED_AN_INTERVAL', 400);
  if (glSuspense) {
    const { rows: [g] } = await c.query('SELECT is_active FROM gl_accounts WHERE code = $1', [glSuspense]);
    if (!g?.is_active) throw err(`GLACCOUNT_DOESNT_EXIST: ${glSuspense}`, 400);
  }
  const { rows: [after] } = await c.query(
    `UPDATE accounting_settings SET auto_closure_enabled = $1, auto_closure_interval_days = $2,
       gl_suspense = COALESCE($3, gl_suspense), currency_decimals = COALESCE($4, currency_decimals),
       updated_at = now() WHERE only_row RETURNING *`,
    [Boolean(enabling), interval || null, glSuspense || null, currencyDecimals === undefined ? null : Number(currencyDecimals)]);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'ACCOUNTING_SETTINGS_CHANGED','accounting_settings','1',$2,$3)`,
    [createdBy || 'SYSTEM', JSON.stringify(before), JSON.stringify(after)]);
  return after;
}

/**
 * The end of day's automatic closure: every N days, close the whole book
 * through the day before the business date.
 */
async function autoClose(c, { date, createdBy = 'EOD' } = {}) {
  const s = await settings(c);
  if (!s.auto_closure_enabled || !s.auto_closure_interval_days) return { closed: false, reason: 'off' };
  const last = s.last_auto_closure_on ? isoDay(s.last_auto_closure_on) : null;
  if (last) {
    const days = Math.round((new Date(`${date}T00:00:00Z`) - new Date(`${last}T00:00:00Z`)) / 86400000);
    if (days < s.auto_closure_interval_days) return { closed: false, reason: `next in ${s.auto_closure_interval_days - days} day(s)` };
  }
  const through = new Date(new Date(`${date}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
  const existing = await c.query('SELECT max(closed_through) AS d FROM accounting_closures WHERE deleted_at IS NULL');
  if (existing.rows[0].d && through <= isoDay(existing.rows[0].d)) {
    await c.query('UPDATE accounting_settings SET last_auto_closure_on = $1 WHERE only_row', [date]);
    return { closed: false, reason: 'already closed' };
  }
  const k = await close(c, { closedThrough: through, automatic: true, notes: 'Automatic closure', createdBy });
  await c.query('UPDATE accounting_settings SET last_auto_closure_on = $1 WHERE only_row', [date]);
  return { closed: true, through, closureId: k.id };
}

// --------------------------------------------------------------------------
// Moving an account between branches
// --------------------------------------------------------------------------

/**
 * Move a loan or deposit account to another branch. Its balances move with
 * it: one entry takes them out of the old branch and into the new, squared
 * through the inter-branch account, so each branch's books stay whole.
 * Without an inter-branch rule an account that has balances on an
 * accounting-enabled product cannot move (the reference platform's NO_INTER_BRANCH_GL_ACCOUNT).
 */
async function moveAccount(c, { kind, accountId, branchId, createdBy }) {
  const to = await resolve(c, branchId);
  if (!to) throw err('BRANCH_REQUIRED', 400);
  const legs = [];
  let account;
  if (kind === 'LOAN') {
    const l = await ledger.lock(c, accountId);
    account = l;
    if (ledger.booksEntries(l)) {
      const b = ledger.balances(l);
      const { rows: [f] } = await c.query("SELECT count(*)::int AS n FROM loan_funding_sources WHERE loan_id = $1 AND status = 'FUNDED'", [l.id]);
      if (!f.n) legs.push([l.gl_portfolio, b.principal]);
      if (ledger.interestAccrues(l)) legs.push([l.gl_interest_rec, b.interest]);
      if (ledger.isAccrual(l)) { legs.push([l.gl_fee_rec, b.fees]); legs.push([l.gl_penalty_rec, b.penalty]); }
      if (Number(l.credit_balance) > 0) legs.push([l.gl_credit_balance, -Number(l.credit_balance)]);
    }
  } else if (kind === 'SAVINGS') {
    const a = await savings.lock(c, accountId);
    account = a;
    if (savings.books(a)) {
      const bal = Number(a.balance);
      if (bal > 0) legs.push([a.gl_liability, -bal]);
      const portfolio = round2(Math.max(0, -bal) - Number(a.od_fees_due) - Number(a.od_interest_due));
      if (portfolio > 0) legs.push([a.gl_od_portfolio, portfolio]);
      if (Number(a.interest_booked) > 0) legs.push([a.gl_interest_payable, -Number(a.interest_booked)]);
      if (Number(a.neg_interest_booked) > 0) legs.push([a.gl_neg_interest_rec, Number(a.neg_interest_booked)]);
      if (Number(a.od_interest_booked) > 0) legs.push([a.gl_od_interest_rec, Number(a.od_interest_booked)]);
    }
  } else throw err('KIND_MUST_BE_LOAN_OR_SAVINGS', 400);
  if (account.branch_id === to.id) throw err('ACCOUNT_ALREADY_IN_THAT_BRANCH', 409);

  // Each balance is a debit (asset side, positive) or a credit (liability
  // side, negative); moving it credits the old branch and debits the new,
  // or the reverse.
  const debits = [];
  const credits = [];
  const mid = account.member_id;
  for (const [gl, amount] of legs) {
    const a = round2(amount);
    if (!gl || a === 0) continue;
    if (a > 0) {
      debits.push({ glCode: gl, amount: a, memberId: mid, branchId: to.id });
      credits.push({ glCode: gl, amount: a, memberId: mid, branchId: account.branch_id || null });
    } else {
      debits.push({ glCode: gl, amount: -a, memberId: mid, branchId: account.branch_id || null });
      credits.push({ glCode: gl, amount: -a, memberId: mid, branchId: to.id });
    }
  }
  let entryId = null;
  if (debits.length) {
    entryId = (await acct.post(c, {
      debits, credits, branchId: to.id, createdBy,
      narration: `Branch change ${account.account_no} to ${to.code}`, sourceType: 'ACCOUNT_BRANCH_CHANGE', sourceId: account.id,
    })).entryId;
  }
  const table = kind === 'LOAN' ? 'loan_accounts' : 'savings_accounts';
  await c.query(`UPDATE ${table} SET branch_id = $1 WHERE id = $2`, [to.id, account.id]);
  await savings.record(c, {
    reference: savings.ref('BR'), kind: 'ACCOUNT_BRANCH_CHANGE', memberId: mid,
    loanAccountId: kind === 'LOAN' ? account.id : null, savingsAccountId: kind === 'SAVINGS' ? account.id : null,
    amount: 0, entryId, branchId: to.id, createdBy,
    allocation: { from: account.branch_id || null, to: to.id, balancesMoved: debits.length },
  });
  return { accountId: account.id, accountNo: account.account_no, from: account.branch_id || null, to: to.id, entryId };
}

module.exports = {
  list, create, update, resolve, rules, setRules, closures, close, reopen, settings, updateSettings, autoClose, moveAccount,
  detail, resolveBranchIds, assertProductAvailable, centres, findCentre, createCentre, updateCentre, centreFor,
};
