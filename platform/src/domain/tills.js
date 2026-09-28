'use strict';

const acct = require('./accounting');
const { orgToday } = require('../lib/orgDate');

/**
 * Teller tills (the reference platform's Tellers and Tellering widgets). A till is one
 * teller's cash drawer for a session. A supervisor opens it for a teller with
 * an opening amount and, if wanted, balance limits (soft: warned; hard:
 * refused). While it is open every cash transaction the teller enters goes
 * through it (the triggers in migration 031 link it and move the till's
 * expected cash), and cash can be added or removed. Closing it records the
 * cash counted; a difference from the expected cash is booked to cash over
 * and short. A closed till's transactions cannot be reversed until the close
 * is undone (the reference platform's Undo Close Till). A teller has one open till at a time.
 *
 * Accounting. Each till names a GL cash account, by default its channel's
 * (Cash on Hand), in which case adding or removing cash posts nothing, as in
 * The reference platform. A till with its own GL account holds its cash there: its
 * transactions post to it in place of the channel's account (./accounting
 * post), and cash added or removed moves between it and the account the
 * cash came from or goes to.
 */

function err(msg, status = 400) { return Object.assign(new Error(msg), { status }); }
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const CODE = /^[A-Z]{3}[0-9]{3}$/;
const CONSTRAINTS = ['NONE', 'SOFT', 'HARD'];

const SELECT = `
  SELECT t.*, till_expected(t.id) AS expected, b.code AS branch_code,
         (SELECT count(*) FROM till_movements m WHERE m.till_id = t.id)::int AS movements,
         u.full_name AS teller_name
  FROM tills t
  LEFT JOIN branches b ON b.id = t.branch_id
  LEFT JOIN platform.users u ON u.id = t.teller_id`;

function shape(t) {
  const expected = t.status === 'OPEN' ? round2(t.expected) : round2(t.expected_cash ?? t.expected);
  const outside = (t.min_balance !== null && expected < Number(t.min_balance)) || (t.max_balance !== null && expected > Number(t.max_balance));
  return {
    id: t.id, tillId: t.till_code, status: t.status,
    teller: { id: t.teller_id, email: t.teller_email, name: t.teller_name || null },
    branch: t.branch_id ? { id: t.branch_id, code: t.branch_code } : null,
    channelId: t.channel_id, glAccount: t.gl_code,
    openingAmount: round2(t.opening_amount), expectedCash: expected,
    balanceConstraint: t.balance_constraint,
    minBalance: t.min_balance === null ? null : round2(t.min_balance), maxBalance: t.max_balance === null ? null : round2(t.max_balance),
    outsideLimits: t.balance_constraint !== 'NONE' && outside,
    countedCash: t.counted_cash === null ? null : round2(t.counted_cash),
    difference: t.difference === null ? null : round2(t.difference),
    overShortEntryId: t.over_short_entry,
    reopenedFrom: t.reopened_from, movements: t.movements,
    openedBy: t.opened_by, openedAt: t.opened_at, closedBy: t.closed_by, closedAt: t.closed_at,
  };
}

async function list(c, { includeClosed = false, branchId = null } = {}) {
  const { rows } = await c.query(
    `${SELECT} WHERE ($1 OR t.status = 'OPEN') AND ($2::text IS NULL OR t.branch_id::text = $2 OR b.code = $2)
     ORDER BY t.status DESC, t.till_code, t.opened_at DESC`, [Boolean(includeClosed), branchId]);
  return rows.map(shape);
}

async function find(c, id, { lock = false } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) {
    // A till code names its open session, or its latest.
    const { rows: [t] } = await c.query(
      "SELECT id FROM tills WHERE till_code = $1 ORDER BY (status = 'OPEN') DESC, opened_at DESC LIMIT 1", [String(id).toUpperCase()]);
    if (!t) throw err(`TILL_NOT_FOUND: ${id}`, 404);
    id = t.id;
  }
  if (lock) await c.query('SELECT 1 FROM tills WHERE id = $1 FOR UPDATE', [id]);
  const { rows: [t] } = await c.query(`${SELECT} WHERE t.id = $1`, [id]);
  if (!t) throw err(`TILL_NOT_FOUND: ${id}`, 404);
  return t;
}

/** A till with its log: every movement, with the transaction behind it. */
async function get(c, id) {
  const t = await find(c, id);
  const { rows } = await c.query(
    `SELECT m.id, m.kind, m.amount, m.note, m.created_by, m.created_at, m.entry_id,
            x.reference, x.kind AS transaction_kind, x.value_date, x.reversed_by,
            COALESCE(la.account_no, sa.account_no) AS account_no, mb.member_no
     FROM till_movements m
     LEFT JOIN transactions x ON x.id = m.transaction_id
     LEFT JOIN loan_accounts la ON la.id = x.loan_account_id
     LEFT JOIN savings_accounts sa ON sa.id = x.savings_account_id
     LEFT JOIN members mb ON mb.id = x.member_id
     WHERE m.till_id = $1 ORDER BY m.id`, [t.id]);
  let running = round2(t.opening_amount);
  const log = rows.map((m) => {
    running = round2(running + Number(m.amount));
    return {
      id: Number(m.id), kind: m.kind, amount: round2(m.amount), balance: running, note: m.note,
      reference: m.reference, transactionKind: m.transaction_kind, valueDate: m.value_date, reversed: Boolean(m.reversed_by),
      accountNo: m.account_no, memberNo: m.member_no, entryId: m.entry_id, createdBy: m.created_by, createdAt: m.created_at,
    };
  });
  return { ...shape(t), log };
}

/** The open till of a teller, or null. */
async function openFor(c, email) {
  const { rows: [t] } = await c.query(`${SELECT} WHERE t.status = 'OPEN' AND lower(t.teller_email) = lower($1)`, [email]);
  return t ? shape(t) : null;
}

async function nextCode(c) {
  const { rows: [r] } = await c.query(
    "SELECT COALESCE(max(substr(till_code, 4)::int), 0) + 1 AS n FROM tills WHERE till_code LIKE 'TIL%'");
  if (r.n > 999) throw err('TILL_CODES_EXHAUSTED: give the till an id of your own (three letters, three digits)', 409);
  return `TIL${String(r.n).padStart(3, '0')}`;
}

function money(v, name, { allowNull = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (allowNull) return null;
    throw err(`${name}_REQUIRED`);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw err(`${name}_MUST_BE_ZERO_OR_MORE`);
  return round2(n);
}

async function teller(c, { tellerId = null, tellerEmail = null }) {
  const key = tellerId || tellerEmail;
  if (!key) throw err('TELLER_REQUIRED');
  const { rows: [u] } = await c.query(
    `SELECT u.id, u.email, u.role, u.role_code, u.status, u.branch_id, COALESCE(u.user_type, r.user_type) AS user_type
     FROM platform.users u
     LEFT JOIN roles r ON r.code = u.role_code
     WHERE u.tenant_id = (SELECT id FROM platform.tenants WHERE schema_name = current_schema())
       AND (u.id::text = $1 OR lower(u.email) = lower($1))`, [String(key)]);
  if (!u) throw err(`TELLER_NOT_FOUND: ${key}`, 404);
  if (u.status !== 'ACTIVE') throw err('TELLER_NOT_ACTIVE', 409);
  // The reference platform: tills go to teller users, and a user cannot be both administrator and teller.
  const isTeller = u.user_type ? u.user_type === 'TELLER' : u.role === 'TELLER';
  if (!isTeller) throw err('ONLY_A_TELLER_USER_HOLDS_A_TILL: give the user a teller role', 409);
  return u;
}

/** Post cash between the till's account and another, unless they are the same account. */
async function cashEntry(c, t, { amount, otherGl, direction, narration, createdBy }) {
  if (!otherGl || otherGl === t.gl_code || !(amount > 0)) return null;
  const into = direction === 'IN';
  const { entryId } = await acct.post(c, {
    debits: [{ glCode: into ? t.gl_code : otherGl, amount }],
    credits: [{ glCode: into ? otherGl : t.gl_code, amount }],
    narration, sourceType: 'TILL_CASH', sourceId: t.id, branchId: t.branch_id, createdBy,
  });
  return entryId;
}

async function channelOf(c, channelId) {
  const { rows: [ch] } = channelId
    ? await c.query('SELECT * FROM transaction_channels WHERE id = $1', [channelId])
    : await c.query('SELECT * FROM transaction_channels WHERE is_default LIMIT 1');
  if (!ch) throw err(`UNKNOWN_CHANNEL: ${channelId}`, 404);
  if (!ch.gl_account_code) throw err(`CHANNEL_HAS_NO_GL_ACCOUNT: ${ch.id}`, 409);
  return ch;
}

async function checkGl(c, code) {
  const { rows: [g] } = await c.query('SELECT code, type FROM gl_accounts WHERE code = $1', [code]);
  if (!g) throw err(`UNKNOWN_GL_ACCOUNT: ${code}`, 400);
  if (g.type !== 'ASSET') throw err(`A_TILL_HOLDS_CASH_IN_AN_ASSET_ACCOUNT: ${code} is ${g.type}`, 400);
}

function limits(body) {
  const balanceConstraint = String(body.balanceConstraint || 'NONE').toUpperCase();
  if (!CONSTRAINTS.includes(balanceConstraint)) throw err(`BALANCE_CONSTRAINT_MUST_BE_ONE_OF: ${CONSTRAINTS.join(', ')}`);
  const minBalance = money(body.minBalance, 'MIN_BALANCE', { allowNull: true });
  const maxBalance = money(body.maxBalance, 'MAX_BALANCE', { allowNull: true });
  if (balanceConstraint !== 'NONE' && minBalance === null && maxBalance === null) throw err('A_BALANCE_CONSTRAINT_NEEDS_A_MINIMUM_OR_A_MAXIMUM');
  if (minBalance !== null && maxBalance !== null && minBalance > maxBalance) throw err('MIN_BALANCE_ABOVE_MAX_BALANCE');
  return { balanceConstraint, minBalance, maxBalance };
}

/** Open a till for a teller (OPEN_TILL). */
async function open(c, body = {}, { createdBy } = {}) {
  const u = await teller(c, body);
  const ch = await channelOf(c, body.channelId || null);
  const glCode = body.glAccount || body.glCode || ch.gl_account_code;
  await checkGl(c, glCode);
  const code = body.tillId ? String(body.tillId).toUpperCase() : await nextCode(c);
  if (!CODE.test(code)) throw err('TILL_ID_FORMAT: three letters and three digits, like TIL001');
  const opening = money(body.openingAmount ?? 0, 'OPENING_AMOUNT');
  const lim = limits(body);
  if (lim.balanceConstraint === 'HARD' && ((lim.minBalance !== null && opening < lim.minBalance) || (lim.maxBalance !== null && opening > lim.maxBalance))) {
    throw err('OPENING_AMOUNT_OUTSIDE_THE_LIMITS', 409);
  }
  let t;
  try {
    ({ rows: [t] } = await c.query(
      `INSERT INTO tills (till_code, teller_id, teller_email, branch_id, channel_id, gl_code, opening_amount,
         balance_constraint, min_balance, max_balance, reopened_from, opened_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [code, u.id, u.email, u.branch_id, ch.id, glCode, opening, lim.balanceConstraint, lim.minBalance, lim.maxBalance,
        body.reopenedFrom || null, createdBy || null]));
  } catch (e) {
    if (e.code === '23505') {
      throw err(/teller/.test(e.constraint || '') ? 'THE_TELLER_ALREADY_HAS_AN_OPEN_TILL' : `TILL_ID_IN_USE: ${code}`, 409);
    }
    throw e;
  }
  // Cash for the drawer, from the vault account, when the till keeps its own account.
  const entry = await cashEntry(c, t, { amount: opening, otherGl: body.sourceGlAccount || ch.gl_account_code, direction: 'IN', narration: `Till ${code} opened`, createdBy });
  if (entry) await c.query("INSERT INTO till_movements (till_id, kind, amount, entry_id, note, created_by) VALUES ($1, 'ADD_CASH', 0, $2, 'opening amount from the vault', $3)", [t.id, entry, createdBy || null]);
  await audit(c, createdBy, 'TILL_OPENED', t);
  return get(c, t.id);
}

/** Undo Open Till: only while nothing has gone through it. */
async function undoOpen(c, id, { createdBy } = {}) {
  const t = await find(c, id, { lock: true });
  if (t.status !== 'OPEN') throw err('ONLY_AN_OPEN_TILL_CAN_BE_UNDONE', 409);
  const { rows: [n] } = await c.query("SELECT count(*)::int AS n FROM till_movements WHERE till_id = $1 AND NOT (kind = 'ADD_CASH' AND amount = 0)", [t.id]);
  if (n.n) throw err('THE_TILL_HAS_TRANSACTIONS: close it instead', 409);
  const { rows: entries } = await c.query('SELECT entry_id FROM till_movements WHERE till_id = $1 AND entry_id IS NOT NULL', [t.id]);
  for (const e of entries) await acct.reverse(c, e.entry_id, `Till ${t.till_code} opening undone`, createdBy || 'SYSTEM');
  await c.query('DELETE FROM tills WHERE id = $1', [t.id]);
  await audit(c, createdBy, 'TILL_OPEN_UNDONE', t);
  return { deleted: t.id, tillId: t.till_code };
}

/** Add or remove cash (ADD_CASH, REMOVE_CASH). */
async function moveCash(c, id, { amount, glAccount = null, note = null } = {}, { createdBy, direction }) {
  const t = await find(c, id, { lock: true });
  if (t.status !== 'OPEN') throw err('THE_TILL_IS_CLOSED', 409);
  const amt = money(amount, 'AMOUNT');
  if (!(amt > 0)) throw err('AMOUNT_MUST_BE_MORE_THAN_ZERO');
  const expected = round2(t.expected);
  const after = round2(direction === 'IN' ? expected + amt : expected - amt);
  if (after < 0) throw err(`THE_TILL_HOLDS_${expected}`, 409);
  if (t.balance_constraint === 'HARD' && ((t.min_balance !== null && after < Number(t.min_balance)) || (t.max_balance !== null && after > Number(t.max_balance)))) {
    throw err(`TILL_BALANCE_CONSTRAINT: the till would hold ${after}`, 409);
  }
  const ch = await channelOf(c, t.channel_id);
  if (glAccount) await checkGl(c, glAccount);
  const entry = await cashEntry(c, t, { amount: amt, otherGl: glAccount || ch.gl_account_code, direction, narration: `${direction === 'IN' ? 'Cash added to' : 'Cash removed from'} till ${t.till_code}`, createdBy });
  await c.query(
    'INSERT INTO till_movements (till_id, kind, amount, entry_id, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
    [t.id, direction === 'IN' ? 'ADD_CASH' : 'REMOVE_CASH', direction === 'IN' ? amt : -amt, entry, note, createdBy || null]);
  return get(c, t.id);
}

async function overShortGl(c) {
  const { rows: [s] } = await c.query('SELECT gl_cash_over_short FROM accounting_settings LIMIT 1');
  return s?.gl_cash_over_short || '500-330';
}

/**
 * Close a till (CLOSE_TILL) with the cash counted. A shortage is debited to
 * cash over and short and credited to the till's account; an overage the
 * other way round. Without a count, the expected cash is taken as counted.
 */
async function close(c, id, { countedCash, note = null } = {}, { createdBy, user = null } = {}) {
  const t = await find(c, id, { lock: true });
  if (t.status !== 'OPEN') throw err('THE_TILL_IS_ALREADY_CLOSED', 409);
  // A teller may close their own till; closing another's needs a supervisor.
  if (user && user.email && user.email.toLowerCase() !== t.teller_email.toLowerCase() && !user.canCloseOthers) {
    throw err('ONLY_THE_TELLER_OR_A_SUPERVISOR_CLOSES_A_TILL', 403);
  }
  const expected = round2(t.expected);
  const counted = countedCash === undefined || countedCash === null ? expected : money(countedCash, 'COUNTED_CASH');
  const difference = round2(counted - expected);
  let entry = null;
  if (difference !== 0) {
    const gl = await overShortGl(c);
    const amt = Math.abs(difference);
    ({ entryId: entry } = await acct.post(c, {
      debits: [{ glCode: difference < 0 ? gl : t.gl_code, amount: amt }],
      credits: [{ glCode: difference < 0 ? t.gl_code : gl, amount: amt }],
      narration: `Till ${t.till_code} ${difference < 0 ? 'short' : 'over'} by ${amt} at close`,
      sourceType: 'TILL_OVER_SHORT', sourceId: t.id, branchId: t.branch_id, createdBy: createdBy || 'SYSTEM',
    }));
  }
  await c.query(
    `UPDATE tills SET status = 'CLOSED', closed_by = $2, closed_at = now(), expected_cash = $3, counted_cash = $4,
       difference = $5, over_short_entry = $6 WHERE id = $1`,
    [t.id, createdBy || null, expected, counted, difference, entry]);
  await audit(c, createdBy, 'TILL_CLOSED', { tillId: t.till_code, expected, counted, difference, note });
  return get(c, t.id);
}

/** Undo Close Till: the till opens again as it was, its over or short entry reversed. */
async function undoClose(c, id, { createdBy } = {}) {
  const t = await find(c, id, { lock: true });
  if (t.status !== 'CLOSED') throw err('THE_TILL_IS_NOT_CLOSED', 409);
  const { rows: [other] } = await c.query("SELECT till_code FROM tills WHERE teller_id = $1 AND status = 'OPEN'", [t.teller_id]);
  if (other) throw err(`THE_TELLER_HAS_ANOTHER_OPEN_TILL: ${other.till_code}`, 409);
  const { rows: [again] } = await c.query("SELECT 1 FROM tills WHERE till_code = $1 AND status = 'OPEN'", [t.till_code]);
  if (again) throw err(`TILL_ID_IN_USE: ${t.till_code} is open again`, 409);
  const { rows: [later] } = await c.query('SELECT 1 FROM tills WHERE reopened_from = $1', [t.id]);
  if (later) throw err('THE_TILL_WAS_REOPENED: undo the close of its latest session', 409);
  if (t.over_short_entry) await acct.reverse(c, t.over_short_entry, `Till ${t.till_code} close undone`, createdBy || 'SYSTEM');
  await c.query(
    `UPDATE tills SET status = 'OPEN', closed_by = NULL, closed_at = NULL, expected_cash = NULL, counted_cash = NULL,
       difference = NULL, over_short_entry = NULL WHERE id = $1`, [t.id]);
  await audit(c, createdBy, 'TILL_CLOSE_UNDONE', { tillId: t.till_code });
  return get(c, t.id);
}

/**
 * Reopen Till: a new session under the same till id, opening with the cash
 * counted at the close, with the same limits. Its predecessor's transactions
 * stay closed; the reference platform recommends Undo Close Till instead, and so does this.
 */
async function reopen(c, id, { createdBy } = {}) {
  const t = await find(c, id, { lock: true });
  if (t.status !== 'CLOSED') throw err('THE_TILL_IS_NOT_CLOSED', 409);
  return open(c, {
    tellerId: t.teller_id, tillId: t.till_code, channelId: t.channel_id, glAccount: t.gl_code,
    openingAmount: t.counted_cash, balanceConstraint: t.balance_constraint, minBalance: t.min_balance, maxBalance: t.max_balance,
    reopenedFrom: t.id, sourceGlAccount: t.gl_code,
  }, { createdBy });
}

async function audit(c, actor, action, after) {
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,$2,'till',$3,$4)`,
    [actor || 'SYSTEM', action, after.id || after.tillId || null, JSON.stringify(after)]);
}

/** The tellering widget's summary: today's tills with what they hold. */
async function summary(c) {
  const today = await orgToday(c);
  const tills = await list(c, {});
  return { date: today, open: tills.length, cashInTills: round2(tills.reduce((s, t) => s + t.expectedCash, 0)), tills };
}

module.exports = { list, get, find, openFor, open, undoOpen, moveCash, close, undoClose, reopen, summary, nextCode };
