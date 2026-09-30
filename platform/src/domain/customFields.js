'use strict';

const acct = require('./accounting');
const { err } = acct;

/**
 * Custom fields, after the reference platform's "Custom Fields" page.
 *
 * A custom field DEFINITION belongs to an entity and, except on guarantors
 * and collateral, to a SET. A standard set holds one value per field; a
 * grouped set repeats, so a record can hold several groups of its fields
 * (a member's bank accounts, say). VALUES are kept with the record in its
 * custom_fields column, in the shape the reference platform's API v2 uses:
 *
 *   { "_bankAccounts": [ { "bankName": "KCB", "accountNo": "01" } ],
 *     "_profile": { "occupation": "Teacher" } }
 *
 * and flat ({ "fieldId": value }) on guarantors and collateral.
 *
 * Types: FREE_TEXT (an input mask of # digit, @ letter, $ either, other
 * characters literal; a unique value flag), SELECTION (options with scores,
 * and options that depend on a parent selection field in the same set),
 * NUMBER, CHECKBOX, DATE, DATE_TIME, MEMBER_LINK and USER_LINK. A value is at
 * most 2048 characters.
 *
 * Usage: Available, Default and Required (Required implies Default implies
 * Available). Loan accounts are set per loan product, deposit accounts per
 * deposit product, transactions per channel, members per client type and
 * groups per group type; the other entities as a whole. A dependent field takes its parent's usage.
 *
 * Rights: view and edit roles per definition (NULL: every role). A user
 * without edit rights cannot enter a value, and may save the record without
 * a required one (the reference platform). A definition with values is deactivated, not
 * deleted: its values stay and no new ones are taken. At most 200 values
 * per record (the reference platform's quota).
 */

const ENTITIES = {
  // Members and groups share the members table; their fields are set per client or group type.
  MEMBER: { table: 'members', key: 'id', item: 'client_type_id', itemLabel: 'client type' },
  GROUP: { table: 'members', key: 'id', item: 'client_type_id', itemLabel: 'group type' },
  LOAN_ACCOUNT: { table: 'loan_accounts', key: 'id', item: 'product_id', itemLabel: 'loan product' },
  SAVINGS_ACCOUNT: { table: 'savings_accounts', key: 'id', item: 'product_id', itemLabel: 'deposit product' },
  SAVINGS_PRODUCT: { table: 'savings_products', key: 'id' },
  GUARANTOR: { table: 'loan_guarantors', key: 'id', noSets: true },
  COLLATERAL: { table: 'loan_collateral', key: 'id', noSets: true },
  BRANCH: { table: 'branches', key: 'id' },
  CENTRE: { table: 'centres', key: 'id' },
  USER: { table: 'platform.users', key: 'id', platform: true },
  TRANSACTION_CHANNEL: { table: 'transactions', key: 'id', item: 'channel_id', itemLabel: 'transaction channel' },
  CREDIT_ARRANGEMENT: { table: 'credit_arrangements', key: 'id' },
};
const TYPES = ['FREE_TEXT', 'SELECTION', 'NUMBER', 'CHECKBOX', 'DATE', 'DATE_TIME', 'MEMBER_LINK', 'USER_LINK'];
const ROLE = require('./roles');
const { recordAudit } = require('../lib/auditLog');
const MAX_LENGTH = 2048;
const QUOTA = 200;

function entityOf(name) {
  const e = ENTITIES[String(name || '').toUpperCase()];
  if (!e) throw err(`UNKNOWN_CUSTOM_FIELD_ENTITY: ${name}; one of ${Object.keys(ENTITIES).join(', ')}`, 400);
  return { name: String(name).toUpperCase(), ...e };
}

async function audit(c, actor, action, entity, id, before, after) {
  await recordAudit(c, { actor: actor || 'SYSTEM', action: action, entity: entity, entityId: id == null ? null : String(id), before: before ? JSON.stringify(before) : null, after: after ? JSON.stringify(after) : null });
}

// The reference platform's Rights on a custom field: roles, built-in or the tenant's own.
async function rolesOrNull(c, v, label) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw err(`${label}_IS_A_LIST_OF_ROLES_OR_NULL`, 400);
  await ROLE.assertKnown(c, v);
  return [...new Set(v)];
}

// --------------------------------------------------------------------------
// Sets
// --------------------------------------------------------------------------

async function sets(c, entity = null) {
  const { rows } = await c.query(
    `SELECT s.*, (SELECT count(*)::int FROM custom_field_definitions d WHERE d.set_id = s.id) AS definitions
     FROM custom_field_sets s WHERE ($1::text IS NULL OR s.entity = $1) ORDER BY s.entity, s.sort_order, s.id`,
    [entity ? entityOf(entity).name : null]);
  return rows;
}

function autoId(name, prefix = '') {
  const base = String(name || '').replace(/[^A-Za-z0-9]+(.)?/g, (_, ch) => (ch ? ch.toUpperCase() : '')).replace(/^[A-Z]/, (x) => x.toLowerCase());
  return `${prefix}${base || 'field'}`.slice(0, 60);
}

async function createSet(c, { entity, name, id = null, type = 'STANDARD', notes = null } = {}, { createdBy } = {}) {
  const e = entityOf(entity);
  if (e.noSets) throw err(`${e.name}_CUSTOM_FIELDS_HAVE_NO_SETS`, 400);
  if (!name) throw err('A_CUSTOM_FIELD_SET_NEEDS_A_NAME', 400);
  const setId = id ? (String(id).startsWith('_') ? String(id) : `_${id}`) : autoId(name, '_');
  if (!/^_[A-Za-z0-9_]{1,63}$/.test(setId)) throw err('SET_ID_IS_LETTERS_DIGITS_UNDERSCORES', 400);
  if (!['STANDARD', 'GROUPED'].includes(type)) throw err('SET_TYPE_IS_STANDARD_OR_GROUPED', 400);
  const { rows: [n] } = await c.query('SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM custom_field_sets WHERE entity = $1', [e.name]);
  const { rows: [s] } = await c.query(
    `INSERT INTO custom_field_sets (id, entity, name, set_type, notes, sort_order, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO NOTHING RETURNING *`, [setId, e.name, name, type, notes, n.n, createdBy || 'SYSTEM']);
  if (!s) throw err(`CUSTOM_FIELD_SET_EXISTS: ${setId}`, 409);
  await audit(c, createdBy, 'CUSTOM_FIELD_SET_CREATED', 'custom_field_set', setId, null, s);
  return s;
}

async function findSet(c, id) {
  const { rows: [s] } = await c.query('SELECT * FROM custom_field_sets WHERE id = $1', [id]);
  if (!s) throw err(`UNKNOWN_CUSTOM_FIELD_SET: ${id}`, 404);
  return s;
}

async function updateSet(c, id, { name, notes } = {}, { createdBy } = {}) {
  const s = await findSet(c, id);
  const { rows: [after] } = await c.query('UPDATE custom_field_sets SET name = COALESCE($2, name), notes = COALESCE($3, notes) WHERE id = $1 RETURNING *',
    [s.id, name || null, notes ?? null]);
  await audit(c, createdBy, 'CUSTOM_FIELD_SET_CHANGED', 'custom_field_set', s.id, s, after);
  return after;
}

async function deleteSet(c, id, { createdBy } = {}) {
  const s = await findSet(c, id);
  const { rows: defs } = await c.query('SELECT * FROM custom_field_definitions WHERE set_id = $1', [s.id]);
  for (const d of defs) {
    if (await used(c, d)) throw err(`CUSTOM_FIELD_SET_IN_USE: ${d.id} has values; deactivate its fields instead`, 409);
  }
  await c.query('DELETE FROM custom_field_sets WHERE id = $1', [s.id]);
  await audit(c, createdBy, 'CUSTOM_FIELD_SET_DELETED', 'custom_field_set', s.id, s, null);
  return { deleted: s.id };
}

async function rearrange(c, table, ids, where = {}) {
  if (!Array.isArray(ids) || !ids.length) throw err('ORDER_IS_A_LIST_OF_IDS', 400);
  for (let k = 0; k < ids.length; k += 1) {
    const { rowCount } = await c.query(`UPDATE ${table} SET sort_order = $2 WHERE id = $1${where.entity ? ' AND entity = $3' : ''}`,
      [ids[k], k + 1, ...(where.entity ? [where.entity] : [])]);
    if (!rowCount) throw err(`UNKNOWN_ID_IN_ORDER: ${ids[k]}`, 404);
  }
}

async function rearrangeSets(c, entity, ids) {
  const e = entityOf(entity);
  await rearrange(c, 'custom_field_sets', ids, { entity: e.name });
  return sets(c, e.name);
}

// --------------------------------------------------------------------------
// Definitions
// --------------------------------------------------------------------------

function normUsage(e, availableForAll, usage = {}) {
  const flags = (u = {}) => {
    const required = u.required === true;
    const dflt = required || u.default === true;
    const available = dflt || u.available === true || u.available === undefined;
    return { available, default: dflt, required };
  };
  if (!e.item || availableForAll) {
    const f = flags(usage);
    return { default: f.default, required: f.required };
  }
  const items = {};
  for (const [k, v] of Object.entries(usage.items || {})) {
    const f = flags({ available: false, ...v });
    if (f.available) items[k] = f;
  }
  return { items };
}

function normOptions(options, parentOptions = null) {
  if (!Array.isArray(options) || !options.length) throw err('A_SELECTION_FIELD_NEEDS_OPTIONS', 400);
  const seen = new Set();
  return options.map((o, k) => {
    const label = String(o.label ?? o.value ?? '').trim();
    if (!label) throw err(`OPTION_${k + 1}_NEEDS_A_LABEL`, 400);
    const id = String(o.id || autoId(label)).slice(0, 64);
    if (seen.has(id)) throw err(`DUPLICATE_OPTION_ID: ${id}`, 400);
    seen.add(id);
    const out = { id, label };
    if (o.score !== undefined && o.score !== null && o.score !== '') {
      if (!Number.isFinite(Number(o.score))) throw err(`OPTION_SCORE_MUST_BE_A_NUMBER: ${label}`, 400);
      out.score = Number(o.score);
    }
    if (parentOptions) {
      if (!parentOptions.some((p) => p.id === o.parent)) throw err(`OPTION_${label}_NEEDS_A_PARENT_OPTION_OF_THE_PARENT_FIELD`, 400);
      out.parent = o.parent;
    }
    return out;
  });
}

async function findDefinition(c, id) {
  const { rows: [d] } = await c.query('SELECT * FROM custom_field_definitions WHERE id = $1', [id]);
  if (!d) throw err(`UNKNOWN_CUSTOM_FIELD: ${id}`, 404);
  return d;
}

async function shapeDefinition(c, body, before = null) {
  const e = entityOf(before ? before.entity : body.entity);
  const out = {};
  if (!before) {
    if (!body.name) throw err('A_CUSTOM_FIELD_NEEDS_A_NAME', 400);
    out.id = String(body.id || autoId(body.name));
    if (!/^[A-Za-z0-9_]{1,64}$/.test(out.id)) throw err('CUSTOM_FIELD_ID_IS_LETTERS_DIGITS_UNDERSCORES', 400);
    out.entity = e.name;
    if (e.noSets) {
      if (body.setId) throw err(`${e.name}_CUSTOM_FIELDS_HAVE_NO_SETS`, 400);
      out.set_id = null;
    } else {
      if (!body.setId) throw err('A_CUSTOM_FIELD_NEEDS_A_SET', 400);
      const s = await findSet(c, body.setId);
      if (s.entity !== e.name) throw err(`SET_${s.id}_IS_FOR_${s.entity}`, 400);
      out.set_id = s.id;
    }
    const type = String(body.type || '').toUpperCase();
    if (!TYPES.includes(type)) throw err(`CUSTOM_FIELD_TYPE_IS_ONE_OF: ${TYPES.join(', ')}`, 400);
    out.field_type = type;
  }
  const type = before ? before.field_type : out.field_type;
  const setId = before ? before.set_id : out.set_id;
  if (body.name !== undefined) out.name = String(body.name).trim();
  if (body.description !== undefined) out.description = body.description || null;
  if (body.longField !== undefined) out.long_field = body.longField === true;
  if (body.format !== undefined) {
    if (body.format && type !== 'FREE_TEXT') throw err('ONLY_A_FREE_TEXT_FIELD_TAKES_A_FORMAT', 400);
    out.format = body.format || null;
  }
  if (body.uniqueValue !== undefined) {
    if (body.uniqueValue && !['FREE_TEXT', 'NUMBER'].includes(type)) throw err('ONLY_TEXT_AND_NUMBER_FIELDS_CAN_BE_UNIQUE', 400);
    if (body.uniqueValue && e.platform) throw err('USER_FIELDS_CANNOT_BE_UNIQUE', 400);
    out.unique_value = body.uniqueValue === true;
  }
  let parent = null;
  if (body.dependentOn !== undefined && body.dependentOn !== null && body.dependentOn !== '') {
    if (type !== 'SELECTION') throw err('ONLY_A_SELECTION_FIELD_CAN_DEPEND_ON_ANOTHER', 400);
    parent = await findDefinition(c, body.dependentOn);
    if (parent.field_type !== 'SELECTION' || parent.set_id !== setId) throw err('THE_PARENT_MUST_BE_A_SELECTION_FIELD_IN_THE_SAME_SET', 400);
    if (before && parent.id === before.id) throw err('A_FIELD_CANNOT_DEPEND_ON_ITSELF', 400);
    out.dependent_on = parent.id;
  } else if (body.dependentOn === null || body.dependentOn === '') {
    out.dependent_on = null;
  } else if (before?.dependent_on) {
    parent = await findDefinition(c, before.dependent_on);
  }
  if (body.options !== undefined || (!before && type === 'SELECTION')) {
    if (type !== 'SELECTION') { if (body.options?.length) throw err('ONLY_A_SELECTION_FIELD_TAKES_OPTIONS', 400); }
    else out.options = JSON.stringify(normOptions(body.options, parent ? parent.options : null));
  }
  if (e.item) {
    if (body.availableForAll !== undefined) out.available_for_all = body.availableForAll !== false;
  } else out.available_for_all = true;
  const all = out.available_for_all ?? before?.available_for_all ?? true;
  if (parent) out.usage = JSON.stringify(parent.usage);
  else if (body.usage !== undefined || body.availableForAll !== undefined || !before) out.usage = JSON.stringify(normUsage(e, all, body.usage || {}));
  if (body.viewRoles !== undefined) out.view_roles = await rolesOrNull(c, body.viewRoles, 'VIEW_ROLES');
  if (body.editRoles !== undefined) out.edit_roles = await rolesOrNull(c, body.editRoles, 'EDIT_ROLES');
  const view = out.view_roles !== undefined ? out.view_roles : before?.view_roles ?? null;
  const edit = out.edit_roles !== undefined ? out.edit_roles : before?.edit_roles ?? null;
  // Edit rights carry view rights.
  if (view && edit === null) out.view_roles = null;
  else if (view && edit) out.view_roles = [...new Set([...view, ...edit])];
  if (body.isActive !== undefined) out.is_active = body.isActive !== false;
  return out;
}

async function definitions(c, { entity = null, setId = null, includeInactive = true } = {}) {
  const { rows } = await c.query(
    `SELECT d.*, s.name AS set_name, s.set_type, s.sort_order AS set_order FROM custom_field_definitions d
     LEFT JOIN custom_field_sets s ON s.id = d.set_id
     WHERE ($1::text IS NULL OR d.entity = $1) AND ($2::text IS NULL OR d.set_id = $2) AND ($3::boolean OR d.is_active)
     ORDER BY d.entity, s.sort_order NULLS FIRST, d.set_id NULLS FIRST, d.sort_order, d.id`,
    [entity ? entityOf(entity).name : null, setId, includeInactive]);
  return rows;
}

async function createDefinition(c, body = {}, { createdBy } = {}) {
  const cols = await shapeDefinition(c, body);
  const { rows: [n] } = await c.query(
    'SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM custom_field_definitions WHERE entity = $1 AND set_id IS NOT DISTINCT FROM $2', [cols.entity, cols.set_id]);
  cols.sort_order = n.n;
  cols.created_by = createdBy || 'SYSTEM';
  const keys = Object.keys(cols);
  const { rows: [d] } = await c.query(
    `INSERT INTO custom_field_definitions (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (id) DO NOTHING RETURNING *`, keys.map((k) => cols[k]));
  if (!d) throw err(`CUSTOM_FIELD_EXISTS: ${cols.id}`, 409);
  await audit(c, createdBy, 'CUSTOM_FIELD_CREATED', 'custom_field_definition', d.id, null, d);
  return d;
}

async function updateDefinition(c, id, body = {}, { createdBy } = {}) {
  const before = await findDefinition(c, id);
  if (body.type !== undefined && String(body.type).toUpperCase() !== before.field_type) throw err('A_CUSTOM_FIELD_TYPE_CANNOT_CHANGE', 409);
  const cols = await shapeDefinition(c, body, before);
  const keys = Object.keys(cols);
  if (!keys.length) throw err('NO_UPDATABLE_FIELDS', 400);
  const { rows: [after] } = await c.query(
    `UPDATE custom_field_definitions SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [before.id, ...keys.map((k) => cols[k])]);
  // Dependent fields follow their parent's usage.
  if (cols.usage) await c.query('UPDATE custom_field_definitions SET usage = $2 WHERE dependent_on = $1', [before.id, cols.usage]);
  await audit(c, createdBy, 'CUSTOM_FIELD_CHANGED', 'custom_field_definition', before.id, before, after);
  return after;
}

/** Whether any record holds a value for the definition. */
async function used(c, d) {
  const e = entityOf(d.entity);
  const where = e.noSets ? 'custom_fields ? $1' : 'custom_fields ? $2 AND (jsonb_typeof(custom_fields -> $2) = \'object\' AND (custom_fields -> $2) ? $1 OR jsonb_typeof(custom_fields -> $2) = \'array\' AND jsonb_path_exists(custom_fields -> $2, (\'$[*].\' || $1)::jsonpath))';
  const scope = e.platform ? ' AND tenant_id = (SELECT id FROM platform.tenants WHERE schema_name = current_schema())' : '';
  const { rows } = await c.query(`SELECT 1 FROM ${e.table} WHERE ${where}${scope} LIMIT 1`, e.noSets ? [d.id] : [d.id, d.set_id]);
  return rows.length > 0;
}

async function deleteDefinition(c, id, { createdBy } = {}) {
  const d = await findDefinition(c, id);
  if (await used(c, d)) throw err(`CUSTOM_FIELD_IN_USE: ${d.id} has values; deactivate it instead`, 409);
  const { rows: [dep] } = await c.query('SELECT id FROM custom_field_definitions WHERE dependent_on = $1 LIMIT 1', [d.id]);
  if (dep) throw err(`CUSTOM_FIELD_HAS_DEPENDENTS: ${dep.id}`, 409);
  await c.query('DELETE FROM custom_field_definitions WHERE id = $1', [d.id]);
  await audit(c, createdBy, 'CUSTOM_FIELD_DELETED', 'custom_field_definition', d.id, d, null);
  return { deleted: d.id };
}

async function rearrangeDefinitions(c, entity, ids) {
  const e = entityOf(entity);
  await rearrange(c, 'custom_field_definitions', ids, { entity: e.name });
  // A dependent field stays below its parent.
  const defs = await definitions(c, { entity: e.name });
  for (const d of defs.filter((x) => x.dependent_on)) {
    const p = defs.find((x) => x.id === d.dependent_on);
    if (p && p.sort_order > d.sort_order) throw err(`DEPENDENT_FIELD_${d.id}_MUST_COME_AFTER_${p.id}`, 409);
  }
  return defs;
}

// --------------------------------------------------------------------------
// Values
// --------------------------------------------------------------------------

/** How a definition is used for one item (a product or channel), or for the entity. */
function usageFor(d, item) {
  const u = d.usage || {};
  if (d.available_for_all || !u.items) return { available: true, default: Boolean(u.default), required: Boolean(u.required) };
  const x = u.items[item];
  return x ? { available: true, default: Boolean(x.default), required: Boolean(x.required) } : { available: false, default: false, required: false };
}

const mayEdit = (d, user) => !user || !user.role || d.edit_roles === null || ROLE.names(d.edit_roles, user);
const mayView = (d, user) => !user || !user.role || d.view_roles === null || ROLE.names(d.view_roles, user)
  || (d.edit_roles !== null && ROLE.names(d.edit_roles, user));

function maskMatches(mask, v) {
  if (v.length !== mask.length) return false;
  for (let k = 0; k < mask.length; k += 1) {
    const m = mask[k]; const ch = v[k];
    if (m === '#' && !/[0-9]/.test(ch)) return false;
    if (m === '@' && !/[A-Za-z]/.test(ch)) return false;
    if (m === '$' && !/[A-Za-z0-9]/.test(ch)) return false;
    if (!'#@$'.includes(m) && m !== ch) return false;
  }
  return true;
}

async function coerce(c, d, raw, group, label) {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const bad = (why) => err(`INVALID_CUSTOM_FIELD_VALUE: ${label}: ${why}`, 400);
  switch (d.field_type) {
    case 'FREE_TEXT': {
      const v = String(raw);
      if (v.length > MAX_LENGTH) throw bad(`at most ${MAX_LENGTH} characters`);
      if (d.format && !maskMatches(d.format, v)) throw bad(`must match ${d.format}`);
      return v;
    }
    case 'NUMBER': {
      const v = Number(raw);
      if (!Number.isFinite(v)) throw bad('a number');
      return v;
    }
    case 'CHECKBOX':
      if (![true, false, 'true', 'false'].includes(raw)) throw bad('true or false');
      return raw === true || raw === 'true';
    case 'DATE': {
      const v = String(raw).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad('a date YYYY-MM-DD');
      return v;
    }
    case 'DATE_TIME': {
      const t = Date.parse(raw);
      if (Number.isNaN(t)) throw bad('a date and time');
      return new Date(t).toISOString();
    }
    case 'SELECTION': {
      const o = (d.options || []).find((x) => x.id === String(raw) || x.label === String(raw));
      if (!o) throw bad(`one of ${(d.options || []).map((x) => x.id).join(', ')}`);
      if (d.dependent_on) {
        const parentValue = group ? group[d.dependent_on] : undefined;
        if (o.parent !== parentValue) throw bad(`not an option for ${d.dependent_on} = ${parentValue ?? 'nothing'}`);
      }
      return o.id;
    }
    case 'MEMBER_LINK': {
      const { rows: [m] } = await c.query('SELECT id FROM members WHERE id::text = $1 OR member_no = $1', [String(raw)]);
      if (!m) throw bad('no such member');
      return m.id;
    }
    case 'USER_LINK': {
      const { rows: [u] } = await c.query(
        `SELECT u.id FROM platform.users u JOIN platform.tenants t ON t.id = u.tenant_id
         WHERE t.schema_name = current_schema() AND (u.id::text = $1 OR lower(u.email) = lower($1))`, [String(raw)]);
      if (!u) throw bad('no such user');
      return u.id;
    }
    default: throw bad('unknown type');
  }
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const countValues = (v) => Object.values(v || {}).reduce((n, x) => {
  if (Array.isArray(x)) return n + x.reduce((m, g) => m + Object.keys(g).length, 0);
  if (x && typeof x === 'object') return n + Object.keys(x).length;
  return n + 1;
}, 0);

async function assertUnique(c, e, d, value, recordId) {
  const filter = e.noSets ? { [d.id]: value } : null;
  const std = e.noSets ? null : { [d.set_id]: { [d.id]: value } };
  const grp = e.noSets ? null : { [d.set_id]: [{ [d.id]: value }] };
  const { rows } = await c.query(
    `SELECT 1 FROM ${e.table} WHERE ${e.key}::text IS DISTINCT FROM $1::text AND (custom_fields @> $2::jsonb${e.noSets ? '' : ' OR custom_fields @> $3::jsonb'}) LIMIT 1`,
    e.noSets ? [recordId, JSON.stringify(filter)] : [recordId, JSON.stringify(std), JSON.stringify(grp)]);
  if (rows.length) throw err(`DUPLICATE_UNIQUE_VALUE: ${d.id} = ${value} is already used (926)`, 409);
}

/**
 * Check `patch` against the definitions for the entity and item and merge
 * it into `previous`. A set in the patch replaces that set; a field set to
 * null or '' is cleared. Required fields are checked on creation, and on an
 * update for the sets the patch touches. Returns the values to store.
 */
async function prepare(c, entity, { item = null, patch = {}, previous = {}, user = null, recordId = null, creating = false } = {}) {
  const e = entityOf(entity);
  if (patch === null || patch === undefined) patch = {};
  if (typeof patch !== 'object' || Array.isArray(patch)) throw err('CUSTOM_FIELDS_IS_AN_OBJECT_OF_SETS', 400);
  const defs = await definitions(c, { entity: e.name });
  const byId = new Map(defs.map((d) => [d.id, d]));
  const merged = JSON.parse(JSON.stringify(previous || {}));
  const touched = new Set();

  const checkField = async (d, raw, group, prevValue, label) => {
    const value = await coerce(c, d, raw, group, label);
    if (same(value, prevValue)) return value;
    if (!d.is_active) throw err(`CUSTOM_FIELD_DEACTIVATED: ${d.id}`, 409);
    if (!usageFor(d, item).available) throw err(`CUSTOM_FIELD_NOT_AVAILABLE: ${d.id} is not available for ${e.itemLabel || e.name.toLowerCase()} ${item}`, 400);
    if (!mayEdit(d, user)) throw err(`CUSTOM_FIELD_NOT_EDITABLE_BY_YOUR_ROLE: ${d.id}`, 403);
    if (d.unique_value && value !== undefined) await assertUnique(c, e, d, value, recordId);
    return value;
  };

  if (e.noSets) {
    for (const [fid, raw] of Object.entries(patch)) {
      const d = byId.get(fid);
      if (!d) throw err(`UNKNOWN_CUSTOM_FIELD: ${fid}`, 400);
      const v = await checkField(d, raw, patch, merged[fid], fid);
      if (v === undefined) delete merged[fid]; else merged[fid] = v;
      touched.add(null);
    }
  } else {
    for (const [sid, content] of Object.entries(patch)) {
      const sd = defs.filter((d) => d.set_id === sid);
      const { rows: [s] } = await c.query('SELECT * FROM custom_field_sets WHERE id = $1 AND entity = $2', [sid, e.name]);
      if (!s) throw err(`UNKNOWN_CUSTOM_FIELD_SET: ${sid}`, 400);
      touched.add(sid);
      const one = async (group, prevGroup, label) => {
        const out = {};
        for (const fid of Object.keys(group || {})) if (!sd.some((d) => d.id === fid)) throw err(`UNKNOWN_CUSTOM_FIELD: ${sid}.${fid}`, 400);
        // Fields in the set's order, so a parent is coerced before its dependants.
        for (const d of sd) {
          const had = prevGroup ? prevGroup[d.id] : undefined;
          if (!(d.id in (group || {}))) { if (had !== undefined) out[d.id] = had; continue; }
          const v = await checkField(d, group[d.id], { ...(prevGroup || {}), ...group, ...out }, had, `${label}.${d.id}`);
          if (v !== undefined) out[d.id] = v;
        }
        return out;
      };
      if (s.set_type === 'GROUPED') {
        if (content !== null && !Array.isArray(content)) throw err(`GROUPED_SET_TAKES_A_LIST: ${sid}`, 400);
        const prevList = Array.isArray(merged[sid]) ? merged[sid] : [];
        const list = [];
        for (let k = 0; k < (content || []).length; k += 1) list.push(await one(content[k], prevList[k], `${sid}[${k}]`));
        // Removed groups count as changes to their fields.
        for (let k = list.length; k < prevList.length; k += 1) {
          for (const fid of Object.keys(prevList[k])) { const d = byId.get(fid); if (d && !mayEdit(d, user)) throw err(`CUSTOM_FIELD_NOT_EDITABLE_BY_YOUR_ROLE: ${fid}`, 403); }
        }
        const kept = list.filter((g) => Object.keys(g).length);
        if (kept.length) merged[sid] = kept; else delete merged[sid];
      } else {
        if (content !== null && (typeof content !== 'object' || Array.isArray(content))) throw err(`STANDARD_SET_TAKES_AN_OBJECT: ${sid}`, 400);
        const g = await one(content || {}, merged[sid] || {}, sid);
        if (content === null) {
          for (const fid of Object.keys(merged[sid] || {})) { const d = byId.get(fid); if (d && !mayEdit(d, user)) throw err(`CUSTOM_FIELD_NOT_EDITABLE_BY_YOUR_ROLE: ${fid}`, 403); }
          delete merged[sid];
        } else if (Object.keys(g).length) merged[sid] = g; else delete merged[sid];
      }
    }
  }

  // Required fields, for the user who may enter them.
  for (const d of defs) {
    if (!d.is_active || !usageFor(d, item).required || !mayEdit(d, user)) continue;
    const key = e.noSets ? null : d.set_id;
    if (!creating && !touched.has(key)) continue;
    const missing = e.noSets ? merged[d.id] === undefined
      : Array.isArray(merged[d.set_id]) ? !merged[d.set_id].length || merged[d.set_id].some((g) => g[d.id] === undefined)
        : !(merged[d.set_id] && merged[d.set_id][d.id] !== undefined);
    if (missing) throw err(`CUSTOM_FIELD_REQUIRED: ${e.noSets ? '' : `${d.set_id}.`}${d.id} (${d.name})`, 400);
  }
  if (countValues(merged) > QUOTA) throw err(`CUSTOM_FIELD_VALUES_QUOTA_EXCEEDED: at most ${QUOTA} per record`, 409);
  return merged;
}

async function loadRecord(c, e, id) {
  const scope = e.platform ? ' AND tenant_id = (SELECT id FROM platform.tenants WHERE schema_name = current_schema())' : '';
  const alt = e.name === 'LOAN_ACCOUNT' || e.name === 'SAVINGS_ACCOUNT' ? ' OR account_no = $1'
    : e.name === 'MEMBER' ? ' OR member_no = $1' : ['BRANCH', 'CENTRE'].includes(e.name) ? ' OR code = $1'
      : e.name === 'TRANSACTION_CHANNEL' ? ' OR reference = $1' : '';
  const { rows: [r] } = await c.query(`SELECT * FROM ${e.table} WHERE (${e.key}::text = $1${alt})${scope} FOR UPDATE`, [String(id)]);
  if (!r) throw err(`${e.name}_NOT_FOUND: ${id}`, 404);
  if (e.name === 'TRANSACTION_CHANNEL' && !r.channel_id) throw err('ONLY_A_TRANSACTION_POSTED_THROUGH_A_CHANNEL_TAKES_CUSTOM_FIELDS', 409);
  return r;
}

/** Set values on a record (any state: the reference platform lets custom fields be edited on closed accounts too). */
async function setValues(c, entity, id, patch, { user = null, createdBy } = {}) {
  const e = entityOf(entity);
  const r = await loadRecord(c, e, id);
  const values = await prepare(c, e.name, { item: e.item ? r[e.item] : null, patch, previous: r.custom_fields || {}, user, recordId: r[e.key] });
  await c.query(`UPDATE ${e.table} SET custom_fields = $2 WHERE ${e.key} = $1`, [r[e.key], JSON.stringify(values)]);
  await audit(c, createdBy, 'CUSTOM_FIELDS_CHANGED', e.name.toLowerCase(), r[e.key], r.custom_fields, values);
  return getValues(c, e.name, r[e.key], { user, record: { ...r, custom_fields: values } });
}

/** The values a user may see, with the definitions that apply and each set's score. */
async function getValues(c, entity, id, { user = null, record = null } = {}) {
  const e = entityOf(entity);
  const r = record || await (async () => {
    const scope = e.platform ? ' AND tenant_id = (SELECT id FROM platform.tenants WHERE schema_name = current_schema())' : '';
    const { rows: [x] } = await c.query(`SELECT * FROM ${e.table} WHERE ${e.key}::text = $1${scope}`, [String(id)]);
    if (!x) throw err(`${e.name}_NOT_FOUND: ${id}`, 404);
    return x;
  })();
  const item = e.item ? r[e.item] : null;
  const defs = (await definitions(c, { entity: e.name })).filter((d) => mayView(d, user));
  const values = visible(defs, r.custom_fields || {}, e);
  return {
    entity: e.name, id: r[e.key], item, values,
    definitions: defs.filter((d) => d.is_active || hasValue(values, d, e)).map((d) => ({
      id: d.id, setId: d.set_id, setName: d.set_name, setType: d.set_type, name: d.name, type: d.field_type, options: d.options,
      dependentOn: d.dependent_on, format: d.format, longField: d.long_field, isActive: d.is_active,
      usage: usageFor(d, item), editable: mayEdit(d, user),
    })),
    scores: scores(defs, values),
  };
}

const hasValue = (values, d, e) => (e.noSets ? values[d.id] !== undefined
  : Array.isArray(values[d.set_id]) ? values[d.set_id].some((g) => g[d.id] !== undefined) : values[d.set_id]?.[d.id] !== undefined);

function visible(defs, values, e) {
  const ids = new Set(defs.map((d) => d.id));
  if (e.noSets) return Object.fromEntries(Object.entries(values).filter(([k]) => ids.has(k)));
  const out = {};
  for (const [sid, content] of Object.entries(values)) {
    const pick = (g) => Object.fromEntries(Object.entries(g).filter(([k]) => ids.has(k)));
    if (Array.isArray(content)) { const l = content.map(pick).filter((g) => Object.keys(g).length); if (l.length) out[sid] = l; }
    else if (content && typeof content === 'object') { const g = pick(content); if (Object.keys(g).length) out[sid] = g; }
  }
  return out;
}

/** The total of the selected options' scores in each set (the reference platform's scores). */
function scores(defs, values) {
  const out = {};
  for (const d of defs.filter((x) => x.field_type === 'SELECTION' && (x.options || []).some((o) => o.score !== undefined))) {
    const groups = d.set_id ? (Array.isArray(values[d.set_id]) ? values[d.set_id] : values[d.set_id] ? [values[d.set_id]] : []) : [values];
    for (const g of groups) {
      const o = d.options.find((x) => x.id === g[d.id]);
      if (o && o.score !== undefined) out[d.set_id || '_'] = (out[d.set_id || '_'] || 0) + o.score;
    }
  }
  return out;
}

/** Custom field values as display text, keyed `setId.fieldId`, for document placeholders. */
async function displayValues(c, entity, values) {
  const e = entityOf(entity);
  const defs = await definitions(c, { entity: e.name });
  const out = {};
  const show = (d, v) => {
    if (v === undefined || v === null) return '';
    if (d.field_type === 'SELECTION') return (d.options || []).find((o) => o.id === v)?.label ?? String(v);
    if (d.field_type === 'CHECKBOX') return v ? 'Yes' : 'No';
    return String(v);
  };
  for (const d of defs) {
    const key = d.set_id ? `${d.set_id}.${d.id}` : d.id;
    const src = d.set_id ? values[d.set_id] : values;
    out[key] = Array.isArray(src) ? src.map((g) => show(d, g[d.id])).filter(Boolean).join(', ') : show(d, src ? src[d.id] : undefined);
  }
  return out;
}

/**
 * Custom fields on a transaction posted through a channel (the reference platform's
 * transactions by channel): checked against the definitions available for
 * that channel, required ones included, and stored on the transaction.
 * A transaction with no channel, or none found, is left as it is.
 */
async function applyToTransaction(c, tx, patch, { user = null } = {}) {
  const row = tx && (tx.id ? tx : tx.transaction || tx.loanTransaction || null);
  if (!row || !row.id) return tx;
  const { rows: [t] } = await c.query('SELECT id, channel_id, custom_fields FROM transactions WHERE id = $1', [row.id]);
  if (!t || !t.channel_id) return tx;
  const values = await prepare(c, 'TRANSACTION_CHANNEL', { item: t.channel_id, patch: patch || {}, previous: t.custom_fields || {}, user, recordId: t.id, creating: true });
  if (Object.keys(values).length || Object.keys(t.custom_fields || {}).length) {
    await c.query('UPDATE transactions SET custom_fields = $2 WHERE id = $1', [t.id, JSON.stringify(values)]);
    if (row === tx) tx.custom_fields = values; else row.custom_fields = values;
  }
  return tx;
}

/**
 * Values carried from one record to another (a reschedule's new loan): the
 * fields still active and available for the new item, nothing else.
 */
async function carry(c, entity, item, values) {
  const e = entityOf(entity);
  const defs = (await definitions(c, { entity: e.name })).filter((d) => d.is_active && usageFor(d, item).available);
  return visible(defs, values || {}, e);
}

module.exports = {
  applyToTransaction, carry,
  ENTITIES, TYPES, sets, createSet, updateSet, deleteSet, rearrangeSets,
  definitions, createDefinition, updateDefinition, deleteDefinition, rearrangeDefinitions, findDefinition,
  prepare, setValues, getValues, displayValues, usageFor, maskMatches, entityOf,
};
