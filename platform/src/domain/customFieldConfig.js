'use strict';

/**
 * Custom field definitions in the reference platform's shapes: the read
 * endpoints of its API v2 (custom fields and custom field sets) and its
 * configuration as code (GET and PUT /configuration/customfields.yaml).
 *
 * The YAML file lists custom field sets, each with its fields:
 *
 *   customFieldSets:
 *     - id: _profile            (a set ID starts with _)
 *       name: Profile
 *       type: SINGLE | GROUPED
 *       availableFor: CLIENT | GROUP | LOAN_ACCOUNT | DEPOSIT_ACCOUNT | DEPOSIT_PRODUCT | GUARANTOR | ASSET
 *                     | BRANCH | CENTRE | USER | TRANSACTION_CHANNEL | TRANSACTION_TYPE | CREDIT_ARRANGEMENT
 *       customFields:
 *         - id: occupation
 *           type: FREE_TEXT | SELECTION | NUMBER | CHECKBOX | DATE | DATE_TIME | CLIENT_LINK | GROUP_LINK | USER_LINK
 *           state: ACTIVE | INACTIVE
 *           validationRules: { validationPattern, unique }      (free text and number)
 *           displaySettings: { displayName, description, fieldSize: SHORT | LONG }
 *           availableForAll: true, required: false, default: true   (the entity as a whole)
 *           usage: [ { id, required, default } ]                    (per item, availableForAll false)
 *           viewRights: { allUsers, roles }, editRights: { allUsers, roles }
 *           selectionOptions: [ { forSelectionId, availableOptions: [ { selectionId, value, score } ] } ]
 *           dependentFieldId: parentField
 *
 * Guarantors and assets have no sets: their fields sit under one set per
 * entity in the file, whose ID and name are not stored.
 *
 * A PUT follows the reference platform's rules. It replaces the
 * configuration of every entity the file names and leaves the others alone.
 * Sets and fields of those entities that the file leaves out are
 * deactivated, not deleted. Selection options, usage and rights a field
 * leaves out are removed. A field without view or edit rights, or with
 * per-item usage and no items, is deactivated. A required field is default
 * as well. It all runs in one transaction, so a file with an error changes
 * nothing.
 */

const CF = require('./customFields');
const YAML = require('../lib/yaml');
const { err } = require('../lib/errors');
const { recordAudit } = require('../lib/auditLog');

const API_ENTITY = {
  MEMBER: 'CLIENT', GROUP: 'GROUP', LOAN_ACCOUNT: 'LOAN_ACCOUNT', SAVINGS_ACCOUNT: 'DEPOSIT_ACCOUNT', SAVINGS_PRODUCT: 'DEPOSIT_PRODUCT',
  GUARANTOR: 'GUARANTOR', COLLATERAL: 'ASSET', BRANCH: 'BRANCH', CENTRE: 'CENTRE', USER: 'USER',
  TRANSACTION_CHANNEL: 'TRANSACTION_CHANNEL', TRANSACTION_TYPE: 'TRANSACTION_TYPE', CREDIT_ARRANGEMENT: 'CREDIT_ARRANGEMENT',
};
const ENTITY_OF = Object.fromEntries(Object.entries(API_ENTITY).map(([k, v]) => [v, k]));
const NO_SET_ID = { GUARANTOR: '_guarantors', COLLATERAL: '_assets' };

function entityFor(apiName, where) {
  const e = ENTITY_OF[String(apiName || '').toUpperCase()];
  if (!e) throw err(`${where}: availableFor is one of ${Object.keys(ENTITY_OF).join(', ')}`, 400);
  return e;
}

// ---------------------------------------------------------------------------
// Reading: a definition and a set in the reference platform's shape
// ---------------------------------------------------------------------------

const rights = (roles) => (roles === null || roles === undefined ? { allUsers: true, roles: [] } : { allUsers: false, roles: [...roles] });

function optionsOut(d, parent) {
  const opts = d.options || [];
  const one = (o) => ({ selectionId: o.id, value: o.label, ...(o.score !== undefined ? { score: o.score } : {}) });
  if (!d.dependent_on) return [{ availableOptions: opts.map(one) }];
  const parents = (parent?.options || []).map((p) => p.id);
  const keys = [...new Set([...parents, ...opts.map((o) => o.parent)])].filter((k) => opts.some((o) => o.parent === k));
  return keys.map((k) => ({ forSelectionId: k, availableOptions: opts.filter((o) => o.parent === k).map(one) }));
}

/** A definition as the reference platform's custom field (the configuration file's shape). */
function fieldOut(d, byId = new Map()) {
  const e = CF.entityOf(d.entity);
  const out = { id: d.id, type: d.field_type, state: d.is_active ? 'ACTIVE' : 'INACTIVE' };
  if (d.format || d.unique_value) out.validationRules = { validationPattern: d.format || null, unique: Boolean(d.unique_value) };
  out.displaySettings = { displayName: d.name, description: d.description || null, fieldSize: d.long_field ? 'LONG' : 'SHORT' };
  const u = d.usage || {};
  if (!e.item || d.available_for_all || !u.items) {
    if (e.item) out.availableForAll = true;
    out.required = Boolean(u.required);
    out.default = Boolean(u.default || u.required);
  } else {
    out.availableForAll = false;
    out.usage = Object.entries(u.items).map(([id, f]) => ({ id, required: Boolean(f.required), default: Boolean(f.default || f.required) }));
  }
  out.viewRights = rights(d.view_roles);
  out.editRights = rights(d.edit_roles);
  if (d.field_type === 'SELECTION') {
    if (d.dependent_on) out.dependentFieldId = d.dependent_on;
    out.selectionOptions = optionsOut(d, byId.get(d.dependent_on));
  }
  return out;
}

/** The API v2 custom field: the file's shape, with its set and entity. */
async function customField(c, id) {
  const d = await CF.findDefinition(c, id);
  const all = await CF.definitions(c, { entity: d.entity });
  const byId = new Map(all.map((x) => [x.id, x]));
  return { ...fieldOut(d, byId), customFieldSetId: d.set_id, availableFor: API_ENTITY[d.entity] };
}

/** The API v2 custom field sets, optionally for one entity. */
async function customFieldSets(c, { availableFor = null } = {}) {
  const entity = availableFor ? entityFor(availableFor, 'availableFor') : null;
  const rows = await CF.sets(c, entity);
  return rows.map((s, i) => ({
    id: s.id, name: s.name, description: s.notes || null, type: s.set_type === 'GROUPED' ? 'GROUPED' : 'SINGLE',
    availableFor: API_ENTITY[s.entity], order: s.sort_order ?? i + 1, customFieldsCount: s.definitions,
  }));
}

/** The API v2 custom fields of one set, in order. */
async function fieldsOfSet(c, setId) {
  const { rows: [s] } = await c.query('SELECT * FROM custom_field_sets WHERE id = $1', [setId]);
  if (!s) throw err(`UNKNOWN_CUSTOM_FIELD_SET: ${setId}`, 404);
  const all = await CF.definitions(c, { entity: s.entity });
  const byId = new Map(all.map((x) => [x.id, x]));
  return all.filter((d) => d.set_id === s.id).map((d) => ({ ...fieldOut(d, byId), customFieldSetId: s.id, availableFor: API_ENTITY[s.entity] }));
}

/** The whole configuration as the YAML file's object. */
async function configuration(c) {
  const sets = await CF.sets(c);
  const defs = await CF.definitions(c);
  const byId = new Map(defs.map((x) => [x.id, x]));
  const out = [];
  for (const s of sets) {
    out.push({
      id: s.id, name: s.name, description: s.notes || null, type: s.set_type === 'GROUPED' ? 'GROUPED' : 'SINGLE', availableFor: API_ENTITY[s.entity],
      customFields: defs.filter((d) => d.set_id === s.id).map((d) => fieldOut(d, byId)),
    });
  }
  for (const [entity, id] of Object.entries(NO_SET_ID)) {
    const fields = defs.filter((d) => d.entity === entity);
    if (fields.length) out.push({ id, name: API_ENTITY[entity] === 'ASSET' ? 'Assets' : 'Guarantors', type: 'SINGLE', availableFor: API_ENTITY[entity], customFields: fields.map((d) => fieldOut(d, byId)) });
  }
  return { customFieldSets: out };
}

const configurationYaml = async (c) => YAML.stringify(await configuration(c));

/** A starting file: one set of each type with one field of each common kind. */
function template() {
  return YAML.stringify({
    customFieldSets: [
      {
        id: '_personal_details', name: 'Personal details', description: 'Fields for every client', type: 'SINGLE', availableFor: 'CLIENT',
        customFields: [
          { id: 'occupation', type: 'FREE_TEXT', state: 'ACTIVE', validationRules: { validationPattern: null, unique: false },
            displaySettings: { displayName: 'Occupation', description: null, fieldSize: 'SHORT' },
            availableForAll: true, required: false, default: true,
            viewRights: { allUsers: true, roles: [] }, editRights: { allUsers: true, roles: [] } },
          { id: 'income_band', type: 'SELECTION', state: 'ACTIVE',
            displaySettings: { displayName: 'Income band', description: null, fieldSize: 'SHORT' },
            availableForAll: true, required: false, default: false,
            viewRights: { allUsers: true, roles: [] }, editRights: { allUsers: false, roles: ['TENANT_ADMIN', 'MANAGER'] },
            selectionOptions: [{ availableOptions: [{ selectionId: 'low', value: 'Low', score: 1 }, { selectionId: 'high', value: 'High', score: 3 }] }] },
        ],
      },
      {
        id: '_bank_accounts', name: 'Bank accounts', description: null, type: 'GROUPED', availableFor: 'CLIENT',
        customFields: [
          { id: 'bank_name', type: 'FREE_TEXT', state: 'ACTIVE', displaySettings: { displayName: 'Bank name', description: null, fieldSize: 'SHORT' },
            availableForAll: true, required: false, default: true,
            viewRights: { allUsers: true, roles: [] }, editRights: { allUsers: true, roles: [] } },
        ],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Writing: PUT /configuration/customfields.yaml
// ---------------------------------------------------------------------------

const bool = (v) => v === true || v === 'true' || v === 'TRUE';

function rolesIn(r) {
  if (r === undefined || r === null) return undefined;
  if (bool(r.allUsers)) return null;
  return Array.isArray(r.roles) ? r.roles.map(String) : [];
}

/** A field of the file as the body createDefinition and updateDefinition take. */
function fieldIn(f, entity, setId, where) {
  if (!f || typeof f !== 'object') throw err(`${where}: a custom field is a mapping`, 400);
  if (!f.id) throw err(`${where}: id is required`, 400);
  const e = CF.entityOf(entity);
  const ds = f.displaySettings || {};
  if (!ds.displayName) throw err(`${where}: displaySettings.displayName is required`, 400);
  const type = String(f.type || '').toUpperCase();
  const body = {
    entity, id: String(f.id), name: String(ds.displayName), type, description: ds.description ?? null,
    longField: String(ds.fieldSize || 'SHORT').toUpperCase() === 'LONG',
  };
  if (!e.noSets) body.setId = setId;
  const vr = f.validationRules || {};
  if (['FREE_TEXT', 'NUMBER'].includes(type)) {
    if (type === 'FREE_TEXT') body.format = vr.validationPattern || null;
    body.uniqueValue = bool(vr.unique);
  }
  let active = String(f.state || 'ACTIVE').toUpperCase() === 'ACTIVE';
  // Usage: the entity as a whole, or per item.
  const all = !e.item || f.availableForAll === undefined || bool(f.availableForAll);
  if (e.item) body.availableForAll = all;
  if (all) {
    const required = bool(f.required);
    body.usage = { required, default: required || bool(f.default) };
  } else {
    const list = Array.isArray(f.usage) ? f.usage : [];
    if (!list.length) active = false;
    body.usage = { items: Object.fromEntries(list.map((u, k) => {
      if (!u || !u.id) throw err(`${where}.usage[${k}]: id is required`, 400);
      const required = bool(u.required);
      return [String(u.id), { available: true, required, default: required || bool(u.default) }];
    })) };
  }
  // Rights: a field with no view or edit rights is deactivated.
  const view = rolesIn(f.viewRights); const edit = rolesIn(f.editRights);
  if (view === undefined || edit === undefined) active = false;
  body.viewRoles = view === undefined ? [] : view;
  body.editRoles = edit === undefined ? [] : edit;
  if (type === 'SELECTION') {
    body.dependentOn = f.dependentFieldId || null;
    const groups = Array.isArray(f.selectionOptions) ? f.selectionOptions : [];
    body.options = groups.flatMap((g) => (Array.isArray(g.availableOptions) ? g.availableOptions : []).map((o) => ({
      id: o.selectionId === undefined || o.selectionId === null ? undefined : String(o.selectionId), label: o.value,
      ...(o.score !== undefined && o.score !== null ? { score: o.score } : {}),
      ...(f.dependentFieldId ? { parent: g.forSelectionId === undefined ? undefined : String(g.forSelectionId) } : {}),
    })));
  }
  body.isActive = active;
  return body;
}

async function applyConfiguration(c, text, { createdBy, user = null } = {}) {
  const doc = typeof text === 'string' ? YAML.parse(text) : text;
  if (!doc || !Array.isArray(doc.customFieldSets)) throw err('CONFIGURATION_NEEDS_A_customFieldSets_LIST', 400);
  const summary = { entities: [], setsCreated: 0, setsUpdated: 0, fieldsCreated: 0, fieldsUpdated: 0, fieldsDeactivated: 0 };
  const seenSets = new Set(); const seenFields = new Set();
  const plan = [];
  doc.customFieldSets.forEach((s, i) => {
    const where = `customFieldSets[${i}]`;
    if (!s || typeof s !== 'object') throw err(`${where}: a set is a mapping`, 400);
    const entity = entityFor(s.availableFor, where);
    const e = CF.entityOf(entity);
    if (!e.noSets) {
      if (!s.id || !/^_[A-Za-z0-9_]{1,63}$/.test(String(s.id))) throw err(`${where}: id is required and starts with _ (letters, digits, underscores)`, 400);
      if (!s.name) throw err(`${where}: name is required`, 400);
      if (seenSets.has(s.id)) throw err(`${where}: the set ID ${s.id} appears twice`, 400);
      seenSets.add(s.id);
    } else if (plan.some((p) => p.entity === entity)) throw err(`${where}: ${s.availableFor} fields sit in one set`, 400);
    const type = String(s.type || 'SINGLE').toUpperCase();
    if (!['SINGLE', 'GROUPED'].includes(type)) throw err(`${where}: type is SINGLE or GROUPED`, 400);
    if (e.noSets && type === 'GROUPED') throw err(`${where}: ${s.availableFor} fields have no grouped sets`, 400);
    const fields = (Array.isArray(s.customFields) ? s.customFields : []).map((f, k) => {
      const body = fieldIn(f, entity, e.noSets ? null : String(s.id), `${where}.customFields[${k}]`);
      if (seenFields.has(body.id)) throw err(`${where}.customFields[${k}]: the field ID ${body.id} appears twice`, 400);
      seenFields.add(body.id);
      return body;
    });
    plan.push({ entity, noSets: e.noSets, id: e.noSets ? null : String(s.id), name: s.name, notes: s.description ?? null, type: type === 'GROUPED' ? 'GROUPED' : 'STANDARD', fields });
  });
  const entities = [...new Set(plan.map((p) => p.entity))];
  summary.entities = entities.map((x) => API_ENTITY[x]);
  const opts = { createdBy };

  // Sets first, in order.
  for (const p of plan.filter((x) => !x.noSets)) {
    const { rows: [have] } = await c.query('SELECT * FROM custom_field_sets WHERE id = $1', [p.id]);
    if (!have) { await CF.createSet(c, { entity: p.entity, name: p.name, id: p.id, type: p.type, notes: p.notes }, opts); summary.setsCreated += 1; continue; }
    if (have.entity !== p.entity) throw err(`CUSTOM_FIELD_SET_${p.id}_IS_FOR_${API_ENTITY[have.entity]}`, 409);
    if (have.set_type !== p.type) {
      const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM custom_field_definitions WHERE set_id = $1', [p.id]);
      if (n.n) throw err(`CUSTOM_FIELD_SET_TYPE_CANNOT_CHANGE_WITH_FIELDS: ${p.id}`, 409);
      await c.query('UPDATE custom_field_sets SET set_type = $2 WHERE id = $1', [p.id, p.type]);
    }
    await CF.updateSet(c, p.id, { name: p.name, notes: p.notes ?? null }, opts);
    summary.setsUpdated += 1;
  }
  // Fields: parents before the fields that depend on them.
  const all = plan.flatMap((p) => p.fields);
  const ordered = [...all.filter((f) => !f.dependentOn), ...all.filter((f) => f.dependentOn)];
  for (const f of ordered) {
    const { rows: [have] } = await c.query('SELECT * FROM custom_field_definitions WHERE id = $1', [f.id]);
    if (!have) { await CF.createDefinition(c, f, opts); summary.fieldsCreated += 1; continue; }
    if (have.entity !== f.entity) throw err(`CUSTOM_FIELD_${f.id}_IS_FOR_${API_ENTITY[have.entity]}`, 409);
    if ((have.set_id || null) !== (f.setId || null)) throw err(`CUSTOM_FIELD_CANNOT_MOVE_TO_ANOTHER_SET: ${f.id} is in ${have.set_id}`, 409);
    const { entity: _e, setId: _s, id: _i, ...changes } = f;
    await CF.updateDefinition(c, f.id, changes, opts);
    summary.fieldsUpdated += 1;
  }
  // What the file leaves out, for the entities it names, is deactivated.
  const { rows: gone } = await c.query(
    'UPDATE custom_field_definitions SET is_active = false, updated_at = now() WHERE entity = ANY($1) AND is_active AND NOT (id = ANY($2)) RETURNING id',
    [entities, [...seenFields]]);
  summary.fieldsDeactivated = gone.length;
  // The file's order: sets, then the fields across each entity.
  for (const entity of entities) {
    const setIds = plan.filter((p) => p.entity === entity && !p.noSets).map((p) => p.id);
    const { rows: others } = await c.query('SELECT id FROM custom_field_sets WHERE entity = $1 AND NOT (id = ANY($2)) ORDER BY sort_order, id', [entity, setIds]);
    const sets = [...setIds, ...others.map((x) => x.id)];
    for (let k = 0; k < sets.length; k += 1) await c.query('UPDATE custom_field_sets SET sort_order = $2 WHERE id = $1', [sets[k], k + 1]);
    const fieldIds = plan.filter((p) => p.entity === entity).flatMap((p) => p.fields.map((f) => f.id));
    const { rows: rest } = await c.query(
      `SELECT d.id FROM custom_field_definitions d LEFT JOIN custom_field_sets s ON s.id = d.set_id
        WHERE d.entity = $1 AND NOT (d.id = ANY($2)) ORDER BY s.sort_order NULLS FIRST, d.sort_order, d.id`, [entity, fieldIds]);
    const order = [...fieldIds, ...rest.map((x) => x.id)];
    for (let k = 0; k < order.length; k += 1) await c.query('UPDATE custom_field_definitions SET sort_order = $2 WHERE id = $1', [order[k], k + 1]);
  }
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'CUSTOM_FIELD_CONFIGURATION_APPLIED', entity: 'custom_field_configuration', after: JSON.stringify(summary) });
  void user;
  return summary;
}

module.exports = { API_ENTITY, fieldOut, customField, customFieldSets, fieldsOfSet, configuration, configurationYaml, template, applyConfiguration };
