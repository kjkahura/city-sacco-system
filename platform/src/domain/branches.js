'use strict';

const acct = require('./accounting');
const ledger = require('./ledger');
const savings = require('./savings');
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

const today = () => new Date().toISOString().slice(0, 10);

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

async function create(c, { code, name, town = null, phone = null, createdBy }) {
  if (!code || !/^[A-Z0-9_-]{2,16}$/.test(code)) throw err('BRANCH_CODE_MUST_BE_2_TO_16_UPPERCASE_CHARACTERS', 400);
  if (!name) throw err('BRANCH_NAME_REQUIRED', 400);
  const { rows } = await c.query(
    'INSERT INTO branches (code, name, town, phone) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING RETURNING *', [code, name, town, phone]);
  if (!rows.length) throw err('BRANCH_CODE_EXISTS', 409);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'BRANCH_CREATED','branch',$2,$3)`,
    [createdBy || 'SYSTEM', rows[0].id, JSON.stringify(rows[0])]);
  return rows[0];
}

async function update(c, id, { name, town, phone, status, createdBy }) {
  const { rows: [before] } = await c.query('SELECT * FROM branches WHERE id::text = $1 OR code = $1 FOR UPDATE', [id]);
  if (!before) throw err('BRANCH_NOT_FOUND', 404);
  if (status && !['ACTIVE', 'CLOSED'].includes(status)) throw err('STATUS_MUST_BE_ACTIVE_OR_CLOSED', 400);
  const { rows: [after] } = await c.query(
    `UPDATE branches SET name = COALESCE($2, name), town = COALESCE($3, town), phone = COALESCE($4, phone),
       status = COALESCE($5, status) WHERE id = $1 RETURNING *`, [before.id, name ?? null, town ?? null, phone ?? null, status ?? null]);
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,'BRANCH_CHANGED','branch',$2,$3,$4)`,
    [createdBy || 'SYSTEM', before.id, JSON.stringify(before), JSON.stringify(after)]);
  return after;
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
  if (date >= today()) throw err('CLOSURE_DATE_MUST_BE_IN_THE_PAST', 400);
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

async function updateSettings(c, { autoClosureEnabled, autoClosureIntervalDays, glSuspense, createdBy } = {}) {
  const before = await settings(c);
  if (autoClosureIntervalDays !== undefined && autoClosureIntervalDays !== null
    && !(Number.isInteger(Number(autoClosureIntervalDays)) && Number(autoClosureIntervalDays) >= 1 && Number(autoClosureIntervalDays) <= 366)) {
    throw err('AUTOMATED_ACCOUNTING_CLOSURES_INTERVAL_MUST_BE_1_TO_366_DAYS', 400);
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
       gl_suspense = COALESCE($3, gl_suspense), updated_at = now() WHERE only_row RETURNING *`,
    [Boolean(enabling), interval || null, glSuspense || null]);
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
 * accounting-enabled product cannot move (Mambu's NO_INTER_BRANCH_GL_ACCOUNT).
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
};
