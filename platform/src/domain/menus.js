'use strict';

const PERMS = require('../lib/permissions');
const V = require('./customViews');
const ROLES = require('./roles');
const { err } = require('../lib/errors');

/**
 * Menu items (the reference platform's Menu Items). The navigation holds items without views
 * (Dashboard, Reports, Accounting and the other fixed pages) and items with
 * views: an item of one kind (members, loans, tasks...) with the custom
 * views filed under it. Six items with views come predefined (Clients,
 * Loans, Deposits, Loan Transactions, Deposit Transactions, Activities);
 * users add their own.
 *
 * Who sees an item: its kind's permission, and then its creator, an
 * administrator, or users of the roles it is shared with (every user when
 * All Users is set). Only administrators set usage rights. A predefined item
 * can be renamed, moved and hidden from roles, not deleted.
 */

const ADMIN = 'TENANT_ADMIN';
const VISIBLE = `(v.owner_email = lower($1) OR $3::boolean OR v.all_users OR $2 = ANY(v.roles))`;
const who = (user) => [user.email, user.roleCode || user.role, user.role === ADMIN];

/** Items without views, as the reference platform has them, each with what it needs. */
// The console's top menus (public/js/menuDef.js), each with the permissions
// of its entries: the user needs any one. null: shown to every user.
const ADMINISTRATION = ['MANAGE_GENERAL_SETUP', 'MANAGE_HOLIDAYS', 'MANAGE_CURRENCIES', 'MANAGE_INDEX_RATES', 'MANAGE_EOD_PROCESSING',
  'MANAGE_INTERBRANCH_GLACCOUNT_RULES', 'MAKE_ACCOUNTING_CLOSURE', 'CREATE_ACCOUNTING_RATES', 'EDIT_BRANCH',
  'VIEW_USER_DETAILS', 'VIEW_ROLE', 'MANAGE_ACCESS_PREFERENCES', 'VIEW_API_CONSUMERS_AND_KEYS', 'MANAGE_AUDIT_TRAIL',
  'CREATE_LOAN_PRODUCT', 'EDIT_LOAN_PRODUCT', 'CREATE_SAVINGS_PRODUCT', 'EDIT_SAVINGS_PRODUCT', 'CREATE_CUSTOM_FIELD', 'EDIT_CUSTOM_FIELD',
  'CREATE_COMMUNICATION_TEMPLATES', 'EDIT_COMMUNICATION_TEMPLATES', 'CREATE_PRODUCT_DOCUMENT_TEMPLATES', 'EDIT_PRODUCT_DOCUMENT_TEMPLATES',
  'CREATE_REPORTS', 'EDIT_REPORTS', 'MANAGE_RETURNS', 'IMPORT_DATA', 'DOWNLOAD_BACKUPS', 'VIEW_DATA_IMPORTS', 'EXTRACT_DATA'];
const FIXED = [
  { key: 'dashboard', name: 'Dashboard', permission: null },
  { key: 'clients', name: 'Clients', permission: null },
  { key: 'groups', name: 'Groups', permission: ['VIEW_GROUP_DETAILS'] },
  { key: 'loans', name: 'Loans', permission: null },
  { key: 'deposits', name: 'Deposits', permission: ['VIEW_SAVINGS_ACCOUNT_DETAILS'] },
  { key: 'loanTransactions', name: 'Loan Transactions', permission: ['VIEW_LOAN_ACCOUNT_DETAILS'] },
  { key: 'depositTransactions', name: 'Deposit Transactions', permission: ['VIEW_SAVINGS_ACCOUNT_DETAILS'] },
  { key: 'activities', name: 'Activities', permission: ['AUDIT_TRANSACTIONS'] },
  { key: 'creditArrangements', name: 'Credit Arrangements', permission: ['VIEW_LINE_OF_CREDIT_DETAILS'] },
  { key: 'products', name: 'Products', permission: null },
  { key: 'reporting', name: 'Reporting', permission: null },
  { key: 'accounting', name: 'Accounting', permission: null },
  { key: 'administration', name: 'Administration', permission: ADMINISTRATION },
];

function shape(m, user) {
  return {
    id: m.id, name: m.name, type: m.type, includeCollections: m.include_collections, predefined: m.predefined,
    owner: m.owner_email, usageRights: { allUsers: m.all_users, roles: m.roles }, position: m.position,
    canEdit: user.role === ADMIN || m.owner_email.toLowerCase() === String(user.email).toLowerCase(),
  };
}

function typeOk(type) {
  const t = String(type || '').toUpperCase();
  if (!V.ENTITIES[t]) throw err(`UNKNOWN_MENU_ITEM_TYPE: ${type} (use ${Object.keys(V.ENTITIES).join(', ')})`);
  return t;
}

async function list(c, user) {
  const { rows } = await c.query(`SELECT * FROM menu_items v WHERE ${VISIBLE} ORDER BY v.position, lower(v.name)`, who(user));
  return rows.filter((m) => PERMS.can(user, V.ENTITIES[m.type].permission)).map((m) => shape(m, user));
}

/** The navigation for a user: the fixed items they may open, then items with the views under them. */
async function navigation(c, user) {
  const items = await list(c, user);
  const views = await V.list(c, user);
  return {
    fixed: FIXED.filter((f) => !f.permission || f.permission.some((code) => PERMS.can(user, code))).map(({ key, name }) => ({ key, name })),
    items: items.map((m) => ({
      ...m,
      views: views.filter((v) => v.menuItemId === m.id || (!v.menuItemId && m.predefined && v.entity === m.type))
        .map((v) => ({ id: v.id, name: v.name, favourite: v.favourite })),
    })),
  };
}

async function find(c, id, user) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw err('MENU_ITEM_NOT_FOUND', 404);
  const { rows: [m] } = await c.query(`SELECT * FROM menu_items v WHERE v.id = $4::uuid AND ${VISIBLE}`, [...who(user), id]);
  if (!m || !PERMS.can(user, V.ENTITIES[m.type].permission)) throw err('MENU_ITEM_NOT_FOUND', 404);
  return m;
}

async function rightsOf(c, body, user, before = null) {
  const r = body.usageRights || {};
  const allUsers = r.allUsers !== undefined ? Boolean(r.allUsers) : before ? before.all_users : false;
  const roles = r.roles !== undefined ? r.roles : before ? before.roles : [];
  const known = await ROLES.codes(c);
  if (!Array.isArray(roles) || roles.some((x) => !known.includes(x))) throw err(`INVALID_ROLES: use ${known.join(', ')}`);
  const changed = before ? (allUsers !== before.all_users || JSON.stringify([...roles].sort()) !== JSON.stringify([...before.roles].sort())) : (allUsers || roles.length);
  if (changed && user.role !== ADMIN) throw err('ONLY_AN_ADMINISTRATOR_SETS_USAGE_RIGHTS', 403);
  return { allUsers, roles: [...new Set(roles)] };
}

function nameOf(body, before) {
  const name = body.name !== undefined ? String(body.name || '').trim() : before?.name;
  if (!name) throw err('MENU_ITEM_NAME_REQUIRED');
  if (name.length > 32) throw err('MENU_ITEM_NAME_TOO_LONG: at most 32 characters');
  return name;
}

async function create(c, body = {}, user) {
  const type = typeOk(body.type);
  if (!PERMS.can(user, V.ENTITIES[type].permission)) throw err(`PERMISSION_REQUIRED: ${V.ENTITIES[type].permission}`, 403);
  const name = nameOf(body);
  const rights = await rightsOf(c, body, user);
  const includeCollections = Boolean(body.includeCollections) && ['LOAN_TRANSACTIONS', 'DEPOSIT_TRANSACTIONS'].includes(type);
  const { rows: [pos] } = await c.query('SELECT COALESCE(max(position), 0) + 1 AS n FROM menu_items');
  const { rows: [m] } = await c.query(
    `INSERT INTO menu_items (name, type, include_collections, owner_email, all_users, roles, position)
     VALUES ($1,$2,$3,lower($4),$5,$6,$7) RETURNING *`,
    [name, type, includeCollections, user.email, rights.allUsers, rights.roles, pos.n]);
  return shape(m, user);
}

async function editable(c, id, user) {
  const m = await find(c, id, user);
  if (user.role !== ADMIN && m.owner_email.toLowerCase() !== String(user.email).toLowerCase()) throw err('ONLY_THE_OWNER_OR_AN_ADMINISTRATOR_CHANGES_A_MENU_ITEM', 403);
  return m;
}

async function update(c, id, body = {}, user) {
  const before = await editable(c, id, user);
  if (body.type !== undefined && typeOk(body.type) !== before.type) throw err('A_MENU_ITEM_KEEPS_ITS_TYPE: its views are of that kind', 409);
  const name = nameOf(body, before);
  const rights = await rightsOf(c, body, user, before);
  const position = body.position !== undefined ? Number(body.position) : before.position;
  if (!Number.isInteger(position) || position < 0) throw err('POSITION_MUST_BE_A_WHOLE_NUMBER');
  const includeCollections = body.includeCollections !== undefined
    ? Boolean(body.includeCollections) && ['LOAN_TRANSACTIONS', 'DEPOSIT_TRANSACTIONS'].includes(before.type) : before.include_collections;
  const { rows: [m] } = await c.query(
    `UPDATE menu_items SET name = $2, all_users = $3, roles = $4, position = $5, include_collections = $6 WHERE id = $1 RETURNING *`,
    [before.id, name, rights.allUsers, rights.roles, position, includeCollections]);
  return shape(m, user);
}

/** Rearrange: the ids in their new order. */
async function rearrange(c, ids, user) {
  if (user.role !== ADMIN) throw err('ONLY_AN_ADMINISTRATOR_REARRANGES_THE_MENU', 403);
  if (!Array.isArray(ids)) throw err('IDS_MUST_BE_A_LIST');
  const { rows } = await c.query('SELECT id FROM menu_items ORDER BY position, name');
  const known = new Set(rows.map((r) => r.id));
  for (const id of ids) if (!known.has(String(id))) throw err(`MENU_ITEM_NOT_FOUND: ${id}`, 404);
  // The items named come first, in that order; the rest follow in their old order.
  const named = [...new Set(ids.map(String))];
  const order = [...named, ...rows.map((r) => r.id).filter((id) => !named.includes(id))];
  for (const [i, id] of order.entries()) await c.query('UPDATE menu_items SET position = $2 WHERE id = $1', [id, i + 1]);
  return list(c, user);
}

async function remove(c, id, user) {
  const m = await editable(c, id, user);
  if (m.predefined) throw err('A_PREDEFINED_MENU_ITEM_CANNOT_BE_DELETED: rename it or take its roles away', 409);
  // Its views stay, filed under nothing (the reference platform keeps them under the type's default item).
  await c.query('DELETE FROM menu_items WHERE id = $1', [m.id]);
  return { deleted: m.id };
}

module.exports = { FIXED, list, navigation, find, create, update, rearrange, remove };
