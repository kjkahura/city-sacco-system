'use strict';

const acct = require('./accounting');
const { err, round2 } = acct;

/**
 * Transaction channels, after the reference platform's "Transaction Channels": the forms of
 * payment money comes in and goes out through (cash, M-Pesa, bank transfer).
 *
 * Each channel has an ID, a name, a type, the GL account it posts to, an
 * order, usage rights (the roles that may post through it; NULL for all
 * users) and constraints for loan and for deposit transactions. A
 * constraint is NULL (unconstrained) or {"match": "ALL"|"ANY", "filters":
 * [...]} with filters of three kinds:
 *
 *   {"type": "AMOUNT", "min": 0, "max": 100000}
 *   {"type": "TYPE", "values": ["REPAYMENT", "DISBURSEMENT"]}
 *   {"type": "PRODUCT", "values": ["NL01"]}
 *
 * Limited usage with no filters means the channel takes none of those
 * transactions. The default channel (cash) cannot be deleted or
 * deactivated; a channel that has been used can be deactivated, not
 * deleted. Postings check the channel through assertUsable.
 */

const TYPES = ['CASH', 'MOBILE', 'TRANSFER', 'CHEQUE', 'INTERNAL', 'PAYROLL'];
const ROLE = require('./roles');
const TRANSACTION_TYPES = {
  LOAN: ['DISBURSEMENT', 'REPAYMENT', 'RECOVERY'],
  SAVINGS: ['DEPOSIT', 'WITHDRAWAL'],
};

async function audit(c, actor, action, id, before, after) {
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,$2,'transaction_channel',$3,$4,$5)`,
    [actor || 'SYSTEM', action, id, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
}

function normConstraints(side, v) {
  if (v === undefined) return undefined;
  if (v === null || v === 'UNCONSTRAINED' || v?.match === 'UNCONSTRAINED') return null;
  if (typeof v !== 'object') throw err(`${side}_CONSTRAINTS_ARE_NULL_OR_AN_OBJECT`, 400);
  const match = v.match || 'ALL';
  if (!['ALL', 'ANY'].includes(match)) throw err('CONSTRAINT_MATCH_IS_ALL_OR_ANY', 400);
  const filters = (v.filters || []).map((f) => {
    const type = String(f.type || '').toUpperCase();
    if (type === 'AMOUNT') {
      const min = f.min === undefined || f.min === null || f.min === '' ? null : round2(f.min);
      const max = f.max === undefined || f.max === null || f.max === '' ? null : round2(f.max);
      if (min === null && max === null) throw err('AN_AMOUNT_FILTER_NEEDS_A_MIN_OR_A_MAX', 400);
      if (min !== null && max !== null && min > max) throw err('AMOUNT_FILTER_MIN_ABOVE_MAX', 400);
      return { type, min, max };
    }
    if (type === 'TYPE') {
      const values = (f.values || []).map((x) => String(x).toUpperCase());
      const bad = values.filter((x) => !TRANSACTION_TYPES[side].includes(x));
      if (!values.length || bad.length) throw err(`TYPE_FILTER_VALUES_ARE: ${TRANSACTION_TYPES[side].join(', ')}`, 400);
      return { type, values };
    }
    if (type === 'PRODUCT') {
      const values = (f.values || []).map(String);
      if (!values.length) throw err('A_PRODUCT_FILTER_NEEDS_PRODUCTS', 400);
      return { type, values };
    }
    throw err('FILTER_TYPE_IS_AMOUNT_TYPE_OR_PRODUCT', 400);
  });
  return { match, filters };
}

async function list(c, { includeInactive = true, user = null } = {}) {
  const { rows } = await c.query(
    `SELECT ch.*, (SELECT count(*)::int FROM transactions t WHERE t.channel_id = ch.id) AS used
     FROM transaction_channels ch WHERE ($1::boolean OR ch.is_active) ORDER BY ch.sort_order, ch.id`, [includeInactive]);
  return rows.filter((ch) => !user || !user.role || ch.usage_roles === null || ROLE.names(ch.usage_roles, user));
}

async function find(c, id) {
  const { rows: [ch] } = await c.query('SELECT * FROM transaction_channels WHERE id = $1', [id]);
  if (!ch) throw err(`UNKNOWN_TRANSACTION_CHANNEL: ${id}`, 404);
  return ch;
}

async function assertGl(c, code) {
  if (!code) return;
  const { rows: [g] } = await c.query('SELECT code, type FROM gl_accounts WHERE code = $1', [code]);
  if (!g) throw err(`UNKNOWN_GL_ACCOUNT: ${code}`, 400);
}

function shape(body, creating) {
  const out = {};
  if (creating) {
    const id = String(body.id || '').trim();
    if (!/^\S{1,32}$/.test(id)) throw err('CHANNEL_ID_IS_1_TO_32_CHARACTERS_WITHOUT_SPACES', 400);
    out.id = id;
  }
  if (body.name !== undefined || creating) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 255) throw err('CHANNEL_NAME_IS_1_TO_255_CHARACTERS', 400);
    out.name = name;
  }
  if (body.channelType !== undefined || creating) {
    const t = String(body.channelType || 'CASH').toUpperCase();
    if (!TYPES.includes(t)) throw err(`CHANNEL_TYPE_IS_ONE_OF: ${TYPES.join(', ')}`, 400);
    out.channel_type = t;
  }
  if (body.glAccount !== undefined) out.gl_account_code = body.glAccount || null;
  if (body.usageRoles !== undefined) {
    if (body.usageRoles !== null && !Array.isArray(body.usageRoles)) throw err('USAGE_ROLES_IS_A_LIST_OR_NULL', 400);
    out.usage_roles = body.usageRoles === null ? null : [...new Set(body.usageRoles)];
  }
  const lc = normConstraints('LOAN', body.loanConstraints);
  if (lc !== undefined) out.loan_constraints = lc === null ? null : JSON.stringify(lc);
  const sc = normConstraints('SAVINGS', body.savingsConstraints);
  if (sc !== undefined) out.savings_constraints = sc === null ? null : JSON.stringify(sc);
  if (body.isActive !== undefined) out.is_active = body.isActive !== false;
  return out;
}

async function create(c, body = {}, { createdBy } = {}) {
  const cols = shape(body, true);
  await ROLE.assertKnown(c, cols.usage_roles);
  if (!cols.gl_account_code) throw err('A_CHANNEL_NEEDS_A_GL_ACCOUNT', 400);
  await assertGl(c, cols.gl_account_code);
  const { rows: [n] } = await c.query('SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM transaction_channels');
  cols.sort_order = n.n;
  const keys = Object.keys(cols);
  const { rows: [ch] } = await c.query(
    `INSERT INTO transaction_channels (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (id) DO NOTHING RETURNING *`, keys.map((k) => cols[k]));
  if (!ch) throw err(`CHANNEL_EXISTS: ${cols.id}`, 409);
  await audit(c, createdBy, 'CHANNEL_CREATED', ch.id, null, ch);
  return ch;
}

async function update(c, id, body = {}, { createdBy } = {}) {
  const before = await find(c, id);
  const cols = shape(body, false);
  await ROLE.assertKnown(c, cols.usage_roles);
  if (cols.gl_account_code !== undefined) {
    if (!cols.gl_account_code) throw err('A_CHANNEL_NEEDS_A_GL_ACCOUNT', 400);
    await assertGl(c, cols.gl_account_code);
  }
  if (before.is_default && cols.is_active === false) throw err('THE_DEFAULT_CHANNEL_CANNOT_BE_DEACTIVATED', 409);
  const keys = Object.keys(cols);
  if (!keys.length) throw err('NO_UPDATABLE_FIELDS', 400);
  const { rows: [after] } = await c.query(
    `UPDATE transaction_channels SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [before.id, ...keys.map((k) => cols[k])]);
  await audit(c, createdBy, 'CHANNEL_CHANGED', before.id, before, after);
  const glMoved = cols.gl_account_code && cols.gl_account_code !== before.gl_account_code;
  const { rows: [u] } = await c.query('SELECT 1 FROM transactions WHERE channel_id = $1 LIMIT 1', [before.id]);
  // A channel already used keeps its past postings on the old account;
  // The reference platform asks for manual journal entries to move them.
  return { ...after, warning: glMoved && u ? 'GL account changed on a channel already used: move past balances with a manual journal entry' : undefined };
}

async function remove(c, id, { createdBy } = {}) {
  const ch = await find(c, id);
  if (ch.is_default) throw err('THE_DEFAULT_CHANNEL_CANNOT_BE_DELETED', 409);
  const { rows: [u] } = await c.query(
    `SELECT (SELECT count(*) FROM transactions WHERE channel_id = $1) + (SELECT count(*) FROM journal_entries WHERE channel_id = $1) AS n`, [ch.id]);
  if (Number(u.n) > 0) throw err('CHANNEL_HAS_BEEN_USED: deactivate it instead', 409);
  await c.query('DELETE FROM transaction_channels WHERE id = $1', [ch.id]);
  await audit(c, createdBy, 'CHANNEL_DELETED', ch.id, ch, null);
  return { deleted: ch.id };
}

async function rearrange(c, ids, { createdBy } = {}) {
  if (!Array.isArray(ids) || !ids.length) throw err('ORDER_IS_A_LIST_OF_CHANNEL_IDS', 400);
  // The channels named come first, in that order; the rest follow as they were.
  const { rows: all } = await c.query('SELECT id FROM transaction_channels ORDER BY sort_order, id');
  const unknown = ids.filter((id) => !all.some((x) => x.id === id));
  if (unknown.length) throw err(`UNKNOWN_TRANSACTION_CHANNEL: ${unknown.join(', ')}`, 404);
  const order = [...new Set(ids), ...all.map((x) => x.id).filter((id) => !ids.includes(id))];
  for (let k = 0; k < order.length; k += 1) await c.query('UPDATE transaction_channels SET sort_order = $2 WHERE id = $1', [order[k], k + 1]);
  await audit(c, createdBy, 'CHANNELS_REARRANGED', null, null, { order: ids });
  return list(c);
}

function passes(con, { type, amount, productId }) {
  if (!con) return true;
  const tests = con.filters.map((f) => {
    if (f.type === 'AMOUNT') return (f.min === null || amount >= f.min) && (f.max === null || amount <= f.max);
    if (f.type === 'TYPE') return f.values.includes(type);
    return f.values.includes(String(productId));
  });
  if (!tests.length) return false;
  return con.match === 'ANY' ? tests.some(Boolean) : tests.every(Boolean);
}

/**
 * The active channel, checked for a posting: its usage rights (when a user
 * posts) and the loan or deposit constraints for the transaction. `side` is
 * LOAN or SAVINGS; with no side only the rights are checked (shares).
 */
async function assertUsable(c, id, { side = null, type = null, amount = 0, productId = null, user = null } = {}) {
  const { rows: [ch] } = await c.query('SELECT * FROM transaction_channels WHERE id = $1 AND is_active', [id]);
  if (!ch) throw err(`UNKNOWN_TRANSACTION_CHANNEL: ${id}`);
  if (user && user.role && ch.usage_roles !== null && !ROLE.names(ch.usage_roles, user)) {
    throw err(`CHANNEL_NOT_AVAILABLE_TO_YOUR_ROLE: ${id}`, 403);
  }
  if (side) {
    const con = side === 'LOAN' ? ch.loan_constraints : ch.savings_constraints;
    if (!passes(con, { type, amount: round2(amount), productId })) {
      throw err(`CHANNEL_CONSTRAINTS_REFUSE: ${id} does not take this ${side === 'LOAN' ? 'loan' : 'deposit'} ${String(type || '').toLowerCase()} of ${round2(amount)}`, 409);
    }
  }
  return ch;
}

module.exports = { list, find, create, update, remove, rearrange, assertUsable, TRANSACTION_TYPES, TYPES };
