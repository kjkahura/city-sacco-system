'use strict';

/**
 * Transaction channels in the reference platform's shapes: its API v2
 * (/organization/transactionChannels) and its configuration as code
 * (GET and PUT /configuration/transactionchannels.yaml). The channels
 * themselves, their rules and the check on a posting are in ./channels.
 *
 * A constraint in the API v2 shape:
 *
 *   { usage: UNCONSTRAINED | LIMITED, matchFiltersOption: ALL | ANY,
 *     constraints: [ { criteria: AMOUNT | TYPE | PRODUCT, operator, value, secondValue, values } ] }
 *
 * and in the configuration file:
 *
 *   { usage: UNCONSTRAINED_USAGE | LIMITED_USAGE, matchFilter: ALL | ANY,
 *     constraints: [ { criteria, filterElement, values: [..] } ] }
 *
 * Operators: AMOUNT takes EQUALS, MORE_THAN, LESS_THAN, BETWEEN, EMPTY and
 * NOT_EMPTY; TYPE and PRODUCT take IN, EMPTY and NOT_EMPTY. MORE_THAN and
 * LESS_THAN are strict and BETWEEN is inclusive. Amounts are in cents, so a
 * strict bound is stored as an inclusive one a cent inside it (MORE_THAN 100
 * is a minimum of 100.01) and read back as the operator it came from.
 *
 * A PUT of the file follows the reference platform's rules: channels the
 * file leaves out are deleted, or deactivated with a warning when they have
 * been used; the default channel's ID cannot change. The channels the
 * platform posts through itself (internal, settlement, transfer) are kept
 * when the file leaves them out, with a warning. It all runs in one
 * transaction, so a file with an error changes nothing.
 *
 * Two additions to the reference shapes: `channelType` (CASH, MOBILE,
 * TRANSFER, CHEQUE, INTERNAL, PAYROLL), and RECOVERY among the loan types.
 */

const CH = require('./channels');
const ROLE = require('./roles');
const YAML = require('../lib/yaml');
const { err } = require('../lib/errors');
const { recordAudit } = require('../lib/auditLog');

const AMOUNT_OPS = ['EQUALS', 'MORE_THAN', 'LESS_THAN', 'BETWEEN', 'EMPTY', 'NOT_EMPTY'];
const LIST_OPS = ['IN', 'EMPTY', 'NOT_EMPTY'];
const CENT = 0.01;
const cents = (n) => Math.round(n * 100) / 100;
const money = (n) => cents(n).toFixed(2);

// ---------------------------------------------------------------------------
// A stored filter as a reference constraint, and back
// ---------------------------------------------------------------------------

/** A stored filter as { criteria, operator, values }. */
function filterOut(f) {
  if (f.operator) return { criteria: f.type, operator: f.operator, values: [] };
  if (f.type !== 'AMOUNT') return { criteria: f.type, operator: 'IN', values: [...f.values] };
  const min = f.min === null || f.min === undefined ? null : Number(f.min);
  const max = f.max === null || f.max === undefined ? null : Number(f.max);
  if (min !== null && max !== null) {
    return min === max ? { criteria: 'AMOUNT', operator: 'EQUALS', values: [money(min)] } : { criteria: 'AMOUNT', operator: 'BETWEEN', values: [money(min), money(max)] };
  }
  // A minimum of zero takes every amount.
  if (min !== null && min < CENT) return { criteria: 'AMOUNT', operator: 'NOT_EMPTY', values: [] };
  if (min !== null) return { criteria: 'AMOUNT', operator: 'MORE_THAN', values: [money(min - CENT)] };
  return { criteria: 'AMOUNT', operator: 'LESS_THAN', values: [money(max + CENT)] };
}

/** A reference constraint { criteria, operator, values } as a stored filter (./channels checks the rest). */
function filterIn(side, k, where) {
  const criteria = String(k.criteria || '').toUpperCase();
  const operator = String(k.operator || '').toUpperCase();
  const values = k.values;
  if (!['AMOUNT', 'TYPE', 'PRODUCT'].includes(criteria)) throw err(`${where}: criteria is AMOUNT, TYPE or PRODUCT`, 400);
  const allowed = criteria === 'AMOUNT' ? AMOUNT_OPS : LIST_OPS;
  if (!allowed.includes(operator)) throw err(`${where}: the ${criteria} criterion takes ${allowed.join(', ')}`, 400);
  if (operator === 'EMPTY' || operator === 'NOT_EMPTY') {
    if (values.length) throw err(`${where}: ${operator} takes no values`, 400);
    return { type: criteria, operator };
  }
  if (criteria !== 'AMOUNT') {
    if (!values.length) throw err(`${where}: IN needs at least one value`, 400);
    if (criteria === 'TYPE') {
      const bad = values.filter((v) => !CH.TRANSACTION_TYPES[side].includes(String(v).toUpperCase()));
      if (bad.length) throw err(`${where}: ${side === 'LOAN' ? 'loan' : 'deposit'} types are ${CH.TRANSACTION_TYPES[side].join(', ')}`, 400);
    }
    return { type: criteria, values: values.map((v) => (criteria === 'TYPE' ? String(v).toUpperCase() : String(v))) };
  }
  const want = operator === 'BETWEEN' ? 2 : 1;
  if (values.length !== want) throw err(`${where}: ${operator} takes ${want === 2 ? 'two values' : 'one value'}`, 400);
  const n = values.map((v) => {
    const x = typeof v === 'number' ? v : (/^\s*\d+(\.\d+)?\s*$/.test(String(v)) ? Number(v) : NaN);
    if (!Number.isFinite(x) || x < 0) throw err(`${where}: an amount is a number not below zero`, 400);
    if (Math.abs(cents(x) - x) > 1e-9) throw err(`${where}: an amount has at most two decimals`, 400);
    return cents(x);
  });
  if (operator === 'EQUALS') return { type: 'AMOUNT', min: n[0], max: n[0] };
  if (operator === 'MORE_THAN') return { type: 'AMOUNT', min: cents(n[0] + CENT), max: null };
  if (operator === 'LESS_THAN') {
    if (n[0] < CENT) throw err(`${where}: LESS_THAN needs an amount above zero`, 400);
    return { type: 'AMOUNT', min: null, max: cents(n[0] - CENT) };
  }
  if (n[0] > n[1]) throw err(`${where}: BETWEEN takes the lower amount first`, 400);
  return { type: 'AMOUNT', min: n[0], max: n[1] };
}

const asList = (v, where) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw err(`${where}: constraints is a list`, 400);
  return v;
};

// ---------------------------------------------------------------------------
// API v2
// ---------------------------------------------------------------------------

function apiConstraintsOut(con) {
  if (!con) return { usage: 'UNCONSTRAINED', constraints: [] };
  return {
    usage: 'LIMITED',
    matchFiltersOption: con.match,
    constraints: con.filters.map((f) => {
      const o = filterOut(f);
      if (o.criteria === 'AMOUNT' && o.values.length) return { criteria: o.criteria, operator: o.operator, value: o.values[0], ...(o.values[1] ? { secondValue: o.values[1] } : {}) };
      return { criteria: o.criteria, operator: o.operator, ...(o.values.length ? { value: o.values[0], values: o.values } : {}) };
    }),
  };
}

function apiConstraintsIn(side, v, where) {
  if (v === undefined || v === null) throw err(`${where} is required`, 400);
  if (typeof v !== 'object' || Array.isArray(v)) throw err(`${where} is an object`, 400);
  const usage = String(v.usage || '').toUpperCase();
  const list = asList(v.constraints, where);
  if (usage === 'UNCONSTRAINED') {
    if (list.length) throw err(`${where}: UNCONSTRAINED usage takes no constraints`, 400);
    return null;
  }
  if (usage !== 'LIMITED') throw err(`${where}: usage is UNCONSTRAINED or LIMITED`, 400);
  const match = String(v.matchFiltersOption || 'ALL').toUpperCase();
  if (!['ALL', 'ANY'].includes(match)) throw err(`${where}: matchFiltersOption is ALL or ANY`, 400);
  const filters = list.map((k, i) => {
    const at = `${where}.constraints[${i}]`;
    if (!k || typeof k !== 'object') throw err(`${at}: a constraint is an object`, 400);
    let values;
    if (Array.isArray(k.values) && k.values.length) values = k.values;
    else values = [k.value, k.secondValue].filter((x) => x !== undefined && x !== null && x !== '');
    return filterIn(side, { criteria: k.criteria, operator: k.operator, values }, at);
  });
  return CH.normConstraints(side, { match, filters });
}

const rightsOut = (roles) => (roles === null || roles === undefined ? { availableForAll: true, usageRights: [] } : { availableForAll: false, usageRights: [...roles] });

/** A channel in the API v2 shape. */
function toApi(ch) {
  return {
    id: ch.id,
    name: ch.name,
    state: ch.is_active ? 'ACTIVE' : 'INACTIVE',
    glAccount: ch.gl_account_code || null,
    isDefault: Boolean(ch.is_default),
    ...rightsOut(ch.usage_roles),
    loanConstraints: apiConstraintsOut(ch.loan_constraints),
    depositConstraints: apiConstraintsOut(ch.savings_constraints),
    channelType: ch.channel_type,
  };
}

function rolesIn(allUsers, roles, where) {
  if (allUsers === undefined || allUsers === null) allUsers = roles === undefined || roles === null || (Array.isArray(roles) && !roles.length);
  if (typeof allUsers !== 'boolean') throw err(`${where}: availableForAll is true or false`, 400);
  if (allUsers) return null;
  if (!Array.isArray(roles) || !roles.length) throw err(`${where}: name the roles when the channel is not for all users`, 400);
  const list = roles.map((r) => String(r || '').trim());
  if (list.some((r) => !r)) throw err(`${where}: a role ID is blank`, 400);
  if (new Set(list).size !== list.length) throw err(`${where}: a role appears twice`, 400);
  return list;
}

function stateIn(state, where) {
  if (state === undefined || state === null) return true;
  const s = String(state).toUpperCase();
  if (!['ACTIVE', 'INACTIVE'].includes(s)) throw err(`${where}: state is ACTIVE or INACTIVE`, 400);
  return s === 'ACTIVE';
}

/** An API v2 body as the body ./channels takes; every field is set (a PUT replaces the channel). */
function fromApi(b, where = 'body') {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw err(`${where} is an object`, 400);
  const out = {
    id: b.id,
    name: b.name,
    glAccount: b.glAccount === undefined ? null : b.glAccount,
    usageRoles: rolesIn(b.availableForAll, b.usageRights, where),
    loanConstraints: apiConstraintsIn('LOAN', b.loanConstraints, `${where}.loanConstraints`),
    savingsConstraints: apiConstraintsIn('SAVINGS', b.depositConstraints, `${where}.depositConstraints`),
    isActive: stateIn(b.state, where),
  };
  if (b.channelType !== undefined) out.channelType = b.channelType;
  return out;
}

async function apiList(c, { state = null } = {}) {
  let s = null;
  if (state !== null && state !== undefined && state !== '') {
    s = String(state).toUpperCase();
    if (!['ACTIVE', 'INACTIVE'].includes(s)) throw err('TRANSACTION_CHANNEL_STATE_IS_ACTIVE_OR_INACTIVE', 400);
  }
  const rows = await CH.list(c);
  return rows.filter((ch) => s === null || (s === 'ACTIVE') === ch.is_active).map(toApi);
}

const apiGet = async (c, id) => toApi(await CH.find(c, id));

async function apiCreate(c, body, opts) {
  const b = fromApi(body);
  if (b.isActive === false) throw err('A_NEW_CHANNEL_IS_ACTIVE', 400);
  delete b.isActive;
  return toApi(await CH.create(c, b, opts));
}

async function apiUpdate(c, id, body, opts) {
  const have = await CH.find(c, id);
  if (body && body.id !== undefined && body.id !== null && String(body.id) !== have.id) throw err('THE_CHANNEL_ID_CANNOT_CHANGE', 400);
  const b = fromApi(body);
  delete b.id;
  const after = await CH.update(c, have.id, b, opts);
  return { ...toApi(after), ...(after.warning ? { warning: after.warning } : {}) };
}

async function apiDelete(c, id, opts) {
  await CH.remove(c, id, opts);
}

// ---------------------------------------------------------------------------
// Configuration as code
// ---------------------------------------------------------------------------

function yamlConstraintsOut(con) {
  if (!con) return { usage: 'UNCONSTRAINED_USAGE', constraints: [] };
  // Limited with no filter (closed) is written as the reference closes a channel: PRODUCT EMPTY.
  if (!con.filters.length) return { usage: 'LIMITED_USAGE', constraints: [{ criteria: 'PRODUCT', filterElement: 'EMPTY', values: [] }], matchFilter: con.match };
  return {
    usage: 'LIMITED_USAGE',
    constraints: con.filters.map((f) => { const o = filterOut(f); return { criteria: o.criteria, filterElement: o.operator, values: o.values }; }),
    matchFilter: con.match,
  };
}

function yamlConstraintsIn(side, v, where) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw err(`${where} is a mapping`, 400);
  const usage = String(v.usage || '').toUpperCase();
  const list = asList(v.constraints, where);
  if (usage === 'UNCONSTRAINED_USAGE') {
    if (list.length) throw err(`${where}: UNCONSTRAINED_USAGE takes no constraints`, 400);
    if (v.matchFilter !== undefined && v.matchFilter !== null && v.matchFilter !== '') throw err(`${where}: UNCONSTRAINED_USAGE takes no matchFilter`, 400);
    return null;
  }
  if (usage !== 'LIMITED_USAGE') throw err(`${where}: usage is UNCONSTRAINED_USAGE or LIMITED_USAGE`, 400);
  if (!list.length) throw err(`${where}: LIMITED_USAGE needs constraints`, 400);
  const match = String(v.matchFilter || '').toUpperCase();
  if (!['ALL', 'ANY'].includes(match)) throw err(`${where}: LIMITED_USAGE needs matchFilter ALL or ANY`, 400);
  const filters = list.map((k, i) => {
    const at = `${where}.constraints[${i}]`;
    if (!k || typeof k !== 'object') throw err(`${at}: a constraint is a mapping`, 400);
    if (k.values !== undefined && k.values !== null && !Array.isArray(k.values)) throw err(`${at}: values is a list`, 400);
    return filterIn(side, { criteria: k.criteria, operator: k.filterElement, values: k.values || [] }, at);
  });
  return CH.normConstraints(side, { match, filters });
}

function yamlChannel(ch) {
  return {
    id: ch.id,
    name: ch.name,
    state: ch.is_active ? 'ACTIVE' : 'INACTIVE',
    loansConstraints: yamlConstraintsOut(ch.loan_constraints),
    savingsConstraints: yamlConstraintsOut(ch.savings_constraints),
    ...(ch.gl_account_code ? { glAccountCode: ch.gl_account_code } : {}),
    usageRights: ch.usage_roles === null || ch.usage_roles === undefined ? { roles: [], allUsers: true } : { roles: [...ch.usage_roles].sort(), allUsers: false },
    channelType: ch.channel_type,
  };
}

async function configuration(c) {
  const rows = await CH.list(c);
  const def = rows.find((ch) => ch.is_default);
  return {
    defaultTransactionChannel: def ? yamlChannel(def) : null,
    transactionChannels: rows.filter((ch) => !ch.is_default).map(yamlChannel),
  };
}

const configurationYaml = async (c) => YAML.stringify(await configuration(c));

/** A starting file: the default channel and two limited ones. */
function template() {
  const open = { usage: 'UNCONSTRAINED_USAGE', constraints: [] };
  return YAML.stringify({
    defaultTransactionChannel: { id: 'cash', name: 'Cash', state: 'ACTIVE', loansConstraints: open, savingsConstraints: open,
      glAccountCode: '100-200', usageRights: { roles: [], allUsers: true }, channelType: 'CASH' },
    transactionChannels: [
      { id: 'mpesa', name: 'M-Pesa', state: 'ACTIVE',
        loansConstraints: { usage: 'LIMITED_USAGE', constraints: [{ criteria: 'TYPE', filterElement: 'IN', values: ['REPAYMENT'] }], matchFilter: 'ALL' },
        savingsConstraints: { usage: 'LIMITED_USAGE', constraints: [{ criteria: 'AMOUNT', filterElement: 'LESS_THAN', values: ['250000.00'] }], matchFilter: 'ALL' },
        glAccountCode: '100-220', usageRights: { roles: [], allUsers: true }, channelType: 'MOBILE' },
      { id: 'bank', name: 'Bank Transfer', state: 'ACTIVE',
        loansConstraints: { usage: 'LIMITED_USAGE', constraints: [{ criteria: 'AMOUNT', filterElement: 'MORE_THAN', values: ['10000.00'] }], matchFilter: 'ALL' },
        savingsConstraints: open,
        glAccountCode: '100-210', usageRights: { roles: ['TENANT_ADMIN', 'MANAGER'], allUsers: false }, channelType: 'TRANSFER' },
    ],
  });
}

/** One channel of the file as the body ./channels takes. */
function channelIn(x, where) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw err(`${where}: a channel is a mapping`, 400);
  const id = x.id === undefined || x.id === null ? '' : String(x.id).trim();
  if (!/^\S{1,32}$/.test(id)) throw err(`${where}: id is 1 to 32 characters without spaces`, 400);
  if (x.name === undefined || x.name === null || !String(x.name).trim()) throw err(`${where}: name is required`, 400);
  if (String(x.name).trim().length > 255) throw err(`${where}: name is at most 255 characters`, 400);
  if (x.state === undefined || x.state === null) throw err(`${where}: state is required`, 400);
  const r = x.usageRights;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw err(`${where}: usageRights is required`, 400);
  if (typeof r.allUsers !== 'boolean') throw err(`${where}: usageRights.allUsers is true or false`, 400);
  let roles = null;
  if (!r.allUsers) {
    if (!Array.isArray(r.roles) || !r.roles.length) throw err(`${where}: usageRights.roles is required when allUsers is false`, 400);
    roles = r.roles.map((v) => String(v ?? '').trim());
    if (roles.some((v) => !v)) throw err(`${where}: usageRights.roles has a blank ID`, 400);
    if (new Set(roles).size !== roles.length) throw err(`${where}: usageRights.roles has a duplicate`, 400);
  }
  const loans = x.loansConstraints !== undefined ? x.loansConstraints : x.loanConstraints;
  const body = {
    id,
    name: String(x.name).trim(),
    isActive: stateIn(x.state, where),
    glAccount: x.glAccountCode === undefined || x.glAccountCode === null || x.glAccountCode === '' ? null : String(x.glAccountCode),
    usageRoles: roles,
    loanConstraints: yamlConstraintsIn('LOAN', loans, `${where}.loansConstraints`),
    savingsConstraints: yamlConstraintsIn('SAVINGS', x.savingsConstraints, `${where}.savingsConstraints`),
  };
  if (x.channelType !== undefined && x.channelType !== null) body.channelType = x.channelType;
  return body;
}

async function applyConfiguration(c, text, { createdBy, user = null } = {}) {
  const doc = typeof text === 'string' ? YAML.parse(text) : text;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw err('CONFIGURATION_IS_A_MAPPING', 400);
  if (!doc.defaultTransactionChannel) throw err('CONFIGURATION_NEEDS_A_defaultTransactionChannel', 400);
  if (doc.transactionChannels !== undefined && doc.transactionChannels !== null && !Array.isArray(doc.transactionChannels)) {
    throw err('transactionChannels IS_A_LIST', 400);
  }
  const def = channelIn(doc.defaultTransactionChannel, 'defaultTransactionChannel');
  const others = (doc.transactionChannels || []).map((x, i) => channelIn(x, `transactionChannels[${i}]`));
  const seen = new Set();
  for (const b of [def, ...others]) {
    if (seen.has(b.id)) throw err(`CHANNEL_ID_APPEARS_TWICE: ${b.id}`, 400);
    seen.add(b.id);
  }

  // One configuration change at a time per SACCO; postings through channels go on (they only read the rows).
  await c.query('LOCK TABLE transaction_channels IN SHARE ROW EXCLUSIVE MODE');
  const { rows: current } = await c.query('SELECT * FROM transaction_channels ORDER BY sort_order, id');
  const curDefault = current.find((x) => x.is_default);
  if (!curDefault) throw err('NO_DEFAULT_CHANNEL: the SACCO has no default channel to configure', 409);
  if (curDefault.id !== def.id) throw err(`THE_DEFAULT_CHANNEL_ID_CANNOT_CHANGE: it is ${curDefault.id}`, 400);
  if (!def.isActive) throw err('THE_DEFAULT_CHANNEL_CANNOT_BE_DEACTIVATED', 400);
  await ROLE.assertKnown(c, [...new Set([def, ...others].flatMap((b) => b.usageRoles || []))]);

  const summary = { created: [], updated: [], deleted: [], deactivated: [], warnings: [] };
  const opts = { createdBy, user };
  for (const b of [def, ...others]) {
    const have = current.find((x) => x.id === b.id);
    if (!have) {
      if (!b.isActive) throw err(`A_NEW_CHANNEL_IS_ACTIVE: ${b.id}`, 400);
      const { isActive: _a, ...rest } = b;
      await CH.create(c, rest, opts);
      summary.created.push(b.id);
      continue;
    }
    const { id: _i, ...changes } = b;
    if (changes.glAccount === null && !have.gl_account_code) delete changes.glAccount;
    else if (changes.glAccount === null) throw err(`A_CHANNEL_NEEDS_A_GL_ACCOUNT: ${b.id}`, 400);
    const after = await CH.update(c, b.id, changes, opts);
    if (after.warning) summary.warnings.push(`${b.id}: ${after.warning}`);
    summary.updated.push(b.id);
  }
  // What the file leaves out goes: deleted when unused, deactivated otherwise.
  for (const ch of current.filter((x) => !seen.has(x.id))) {
    if (CH.SYSTEM.includes(ch.id)) {
      summary.warnings.push(`TransactionChannel [${ch.id}] was kept: the platform posts through it.`);
      continue;
    }
    // Deleted when nothing refers to it; a channel used by a transaction, or named by
    // a loan account, till or collection batch, is deactivated instead.
    await c.query('SAVEPOINT channel_delete');
    try {
      await CH.remove(c, ch.id, opts);
      await c.query('RELEASE SAVEPOINT channel_delete');
      summary.deleted.push(ch.id);
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT channel_delete');
      if (!(e.status === 409 && /CHANNEL_HAS_BEEN_USED/.test(e.message)) && e.code !== '23503') throw e;
      if (ch.is_active) await CH.update(c, ch.id, { isActive: false }, opts);
      summary.deactivated.push(ch.id);
      summary.warnings.push(`TransactionChannel [${ch.id}] could not be deleted: The transaction channel cannot be deleted since it is used in a transaction.`);
    }
  }
  // The file's order for the channels it lists; the default keeps its place.
  const { rows: now } = await c.query('SELECT id, is_default FROM transaction_channels ORDER BY sort_order, id');
  const listed = others.map((b) => b.id);
  const rest = now.filter((x) => !x.is_default && !listed.includes(x.id)).map((x) => x.id);
  const order = [...listed, ...rest];
  order.splice(Math.min(now.findIndex((x) => x.is_default), order.length), 0, def.id);
  for (let k = 0; k < order.length; k += 1) await c.query('UPDATE transaction_channels SET sort_order = $2 WHERE id = $1', [order[k], k + 1]);

  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'TRANSACTION_CHANNEL_CONFIGURATION_APPLIED', entity: 'transaction_channel_configuration', after: JSON.stringify(summary) });
  return summary;
}

module.exports = {
  toApi, fromApi, apiList, apiGet, apiCreate, apiUpdate, apiDelete,
  configuration, configurationYaml, template, applyConfiguration, filterIn, filterOut,
};
