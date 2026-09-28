'use strict';

const crypto = require('crypto');
const acct = require('./accounting');
const { err } = acct;

/**
 * The setup behind clients and groups, after the reference platform's Client Types, Group
 * Types, Group Role Names and the client and group part of Internal
 * Controls.
 *
 * A TYPE (client_types) is for individuals (CLIENT) or groups (GROUP). Each
 * kind has one default ("Client", "Group"), which cannot be deleted; a type
 * in use cannot be deleted either. A type says whether its holders may open
 * accounts and act as guarantors, whether its clients must bring the
 * mandatory ID documents, whether the default address fields are shown, and
 * the pattern of the IDs it gives out.
 *
 * An ID PATTERN is literal characters with # for a digit, @ for a letter and
 * $ for either (the reference platform's). The run of # is filled from the type's counter,
 * zero-padded and never cut: M###### gives M000041, and M1000000 after
 * M999999. @ and $ are drawn at random. A pattern without # is drawn wholly
 * at random. The counter row is locked while an ID is given out, so two
 * members created at once cannot take the same one, and an ID already taken
 * (by hand or by an import) is stepped over.
 *
 * The CONTROLS (client_controls, one row) are the new client's initial state,
 * the duplicate checks, the required assignments, whether a client may be in
 * more than one group, the group size limit, and how long after exiting a
 * member may be anonymized (unset: not until the SACCO sets it).
 */

const HOLDER_TYPES = ['CLIENT', 'GROUP'];
const DUPLICATE_FIELDS = ['DOCUMENT_ID', 'NAME_AND_BIRTH_DATE', 'PHONE', 'EMAIL'];
const LEVELS = ['NONE', 'WARNING', 'ERROR'];
const ASSIGNMENTS = ['BRANCH', 'CENTRE', 'CREDIT_OFFICER'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

async function audit(c, actor, action, entity, id, before, after) {
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,$2,$3,$4,$5,$6)`,
    [actor || 'SYSTEM', action, entity, id == null ? null : String(id), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
}

// --------------------------------------------------------------------------
// ID patterns
// --------------------------------------------------------------------------

function checkPattern(p) {
  if (p === null || p === undefined || p === '') return null;
  const s = String(p).trim();
  if (!/^[A-Za-z0-9#@$_.-]{1,32}$/.test(s)) throw err('ID_PATTERN_IS_UP_TO_32_LETTERS_DIGITS_AND_#_@_$', 400);
  if (!/[#@$]/.test(s)) throw err('ID_PATTERN_NEEDS_AT_LEAST_ONE_OF_#_@_$', 400);
  if ((s.match(/#+/g) || []).length > 1) throw err('ID_PATTERN_HAS_ONE_RUN_OF_#_AT_MOST', 400);
  return s;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALNUM = `${LETTERS}0123456789`;
const pick = (set) => set[crypto.randomInt(set.length)];

/** One ID from a pattern and a counter value. */
function render(pattern, n) {
  const run = pattern.match(/#+/);
  let out = '';
  for (let k = 0; k < pattern.length; k += 1) {
    const ch = pattern[k];
    if (ch === '#') {
      if (run && k === run.index) out += String(n).padStart(run[0].length, '0');
      if (run && k >= run.index && k < run.index + run[0].length) continue;
      out += pick('0123456789');
    } else if (ch === '@') out += pick(LETTERS);
    else if (ch === '$') out += pick(ALNUM);
    else out += ch;
  }
  return out;
}

/**
 * The next free ID of a type. Locks the type's row (the counter) for the
 * rest of the transaction.
 */
async function nextId(c, typeId) {
  const { rows: [t] } = await c.query('SELECT id, id_pattern, holder_type, next_number FROM client_types WHERE id = $1 FOR UPDATE', [typeId]);
  if (!t) throw err(`UNKNOWN_CLIENT_TYPE: ${typeId}`, 404);
  const pattern = t.id_pattern || (t.holder_type === 'GROUP' ? 'G######' : 'M######');
  const counted = pattern.includes('#');
  let n = Number(t.next_number);
  for (let tries = 0; tries < 10000; tries += 1) {
    const id = render(pattern, n);
    if (counted) n += 1;
    const { rowCount } = await c.query('SELECT 1 FROM members WHERE member_no = $1', [id]);
    if (!rowCount) {
      if (counted) await c.query('UPDATE client_types SET next_number = $2 WHERE id = $1', [t.id, n]);
      return id;
    }
  }
  throw err(`NO_FREE_ID_FOR_TYPE: ${t.id}; widen its ID pattern`, 409);
}

/** An ID entered by hand: letters, digits and . _ - (it appears in URLs). */
function checkId(v) {
  const s = String(v ?? '').trim();
  if (!ID_RE.test(s)) throw err('ID_IS_1_TO_32_LETTERS_DIGITS_DOTS_HYPHENS_OR_UNDERSCORES', 400);
  return s;
}

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

function typeOut(t) {
  return {
    id: t.id, holderType: t.holder_type, clientType: t.holder_type, name: t.name, description: t.description,
    idPattern: t.id_pattern, canOpenAccounts: t.can_open_accounts, canGuarantee: t.can_guarantee,
    requireIdentificationDocuments: t.holder_type === 'CLIENT' ? t.require_id_documents : false,
    useDefaultAddress: t.use_default_address, isDefault: t.is_default, inUse: t.in_use ?? undefined,
    creationDate: t.created_at, lastModifiedDate: t.updated_at,
  };
}

async function types(c, { holderType = null } = {}) {
  const { rows } = await c.query(
    `SELECT t.*, (SELECT count(*)::int FROM members m WHERE m.client_type_id = t.id) AS in_use
       FROM client_types t WHERE ($1::text IS NULL OR t.holder_type = $1) ORDER BY t.holder_type, NOT t.is_default, t.name`, [holderType]);
  return rows.map(typeOut);
}

async function typeRow(c, id, { holderType = null } = {}) {
  const { rows: [t] } = await c.query('SELECT * FROM client_types WHERE id = $1', [String(id)]);
  if (!t) throw err(`UNKNOWN_${holderType === 'GROUP' ? 'GROUP' : 'CLIENT'}_TYPE: ${id}`, 404);
  if (holderType && t.holder_type !== holderType) throw err(`NOT_A_${holderType}_TYPE: ${id}`, 400);
  return t;
}

async function defaultType(c, holderType) {
  const { rows: [t] } = await c.query('SELECT * FROM client_types WHERE holder_type = $1 AND is_default', [holderType]);
  return t;
}

function typeColumns(b, creating) {
  const out = {};
  if (b.name !== undefined || creating) {
    const name = String(b.name ?? '').trim();
    if (!name || name.length > 255) throw err('NAME_IS_1_TO_255_CHARACTERS', 400);
    out.name = name;
  }
  if (b.description !== undefined) {
    const d = b.description === null ? null : String(b.description);
    if (d && d.length > 256) throw err('DESCRIPTION_IS_AT_MOST_256_CHARACTERS', 400);
    out.description = d || null;
  }
  if (b.idPattern !== undefined) out.id_pattern = checkPattern(b.idPattern);
  const flags = { canOpenAccounts: 'can_open_accounts', canGuarantee: 'can_guarantee',
    requireIdentificationDocuments: 'require_id_documents', useDefaultAddress: 'use_default_address' };
  for (const [k, col] of Object.entries(flags)) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== 'boolean') throw err(`${k.toUpperCase()}_IS_TRUE_OR_FALSE`, 400);
    out[col] = b[k];
  }
  return out;
}

async function createType(c, b = {}, { actor } = {}) {
  const holder = String(b.holderType || b.clientType || '').toUpperCase();
  if (!HOLDER_TYPES.includes(holder)) throw err('HOLDER_TYPE_IS_CLIENT_OR_GROUP', 400);
  const id = b.id ? String(b.id) : `${holder === 'GROUP' ? 'group' : 'client'}_${crypto.randomBytes(3).toString('hex')}`;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw err('TYPE_ID_IS_1_TO_32_LETTERS_DIGITS_HYPHENS_OR_UNDERSCORES', 400);
  const cols = { ...typeColumns(b, true), id, holder_type: holder, created_by: actor || 'SYSTEM' };
  if (holder === 'GROUP') cols.require_id_documents = false;
  const keys = Object.keys(cols);
  const { rows: [t] } = await c.query(
    `INSERT INTO client_types (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT DO NOTHING RETURNING *`, keys.map((k) => cols[k]));
  if (!t) throw err(`CLIENT_TYPE_EXISTS: the ID or the name is taken (${id}, ${cols.name})`, 409);
  await audit(c, actor, 'CLIENT_TYPE_CREATED', 'client_type', t.id, null, t);
  return typeOut(t);
}

async function updateType(c, id, b = {}, { actor } = {}) {
  const before = await typeRow(c, id);
  if (b.id !== undefined && b.id !== before.id) throw err('A_TYPE_ID_CANNOT_CHANGE', 400);
  if (b.holderType !== undefined && String(b.holderType).toUpperCase() !== before.holder_type) throw err('A_TYPE_KEEPS_ITS_HOLDER_TYPE', 400);
  const cols = typeColumns(b, false);
  if (before.holder_type === 'GROUP') delete cols.require_id_documents;
  const keys = Object.keys(cols);
  if (!keys.length) return typeOut(before);
  const { rows: [t] } = await c.query(
    `UPDATE client_types SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [before.id, ...keys.map((k) => cols[k])]).catch((e) => {
    if (e.code === '23505') throw err(`CLIENT_TYPE_NAME_TAKEN: ${cols.name}`, 409);
    throw e;
  });
  await audit(c, actor, 'CLIENT_TYPE_CHANGED', 'client_type', t.id, before, t);
  return typeOut(t);
}

async function deleteType(c, id, { actor } = {}) {
  const t = await typeRow(c, id);
  if (t.is_default) throw err('THE_DEFAULT_TYPE_CANNOT_BE_DELETED', 409);
  const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM members WHERE client_type_id = $1', [t.id]);
  if (n.n) throw err(`CLIENT_TYPE_IN_USE: ${n.n}`, 409);
  await c.query('DELETE FROM client_types WHERE id = $1', [t.id]);
  await audit(c, actor, 'CLIENT_TYPE_DELETED', 'client_type', t.id, t, null);
  return { deleted: t.id };
}

// --------------------------------------------------------------------------
// Group role names
// --------------------------------------------------------------------------

const roleOut = (r) => ({ id: r.id, encodedKey: r.id, name: r.name, inUse: r.in_use ?? undefined, creationDate: r.created_at });

async function roleNames(c) {
  const { rows } = await c.query(
    `SELECT r.*, (SELECT count(*)::int FROM group_member_roles g WHERE g.role_name_id = r.id) AS in_use
       FROM group_role_names r ORDER BY r.name`);
  return rows.map(roleOut);
}

async function createRoleName(c, b = {}, { actor } = {}) {
  const name = String(b.name ?? '').trim();
  if (!name || name.length > 254) throw err('NAME_IS_1_TO_254_CHARACTERS', 400);
  const id = b.id ? String(b.id) : `role_${crypto.randomBytes(3).toString('hex')}`;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw err('ROLE_NAME_ID_IS_1_TO_32_LETTERS_DIGITS_HYPHENS_OR_UNDERSCORES', 400);
  const { rows: [r] } = await c.query(
    'INSERT INTO group_role_names (id, name, created_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *', [id, name, actor || 'SYSTEM']);
  if (!r) throw err(`GROUP_ROLE_NAME_EXISTS: the ID or the name is taken (${id}, ${name})`, 409);
  await audit(c, actor, 'GROUP_ROLE_NAME_CREATED', 'group_role_name', r.id, null, r);
  return roleOut(r);
}

async function updateRoleName(c, id, b = {}, { actor } = {}) {
  const { rows: [before] } = await c.query('SELECT * FROM group_role_names WHERE id = $1', [String(id)]);
  if (!before) throw err(`UNKNOWN_GROUP_ROLE_NAME: ${id}`, 404);
  const name = String(b.name ?? '').trim();
  if (!name || name.length > 254) throw err('NAME_IS_1_TO_254_CHARACTERS', 400);
  const { rows: [r] } = await c.query('UPDATE group_role_names SET name = $2 WHERE id = $1 RETURNING *', [before.id, name]).catch((e) => {
    if (e.code === '23505') throw err(`GROUP_ROLE_NAME_TAKEN: ${name}`, 409);
    throw e;
  });
  await audit(c, actor, 'GROUP_ROLE_NAME_CHANGED', 'group_role_name', r.id, before, r);
  return roleOut(r);
}

async function deleteRoleName(c, id, { actor } = {}) {
  const { rows: [r] } = await c.query('SELECT * FROM group_role_names WHERE id = $1', [String(id)]);
  if (!r) throw err(`UNKNOWN_GROUP_ROLE_NAME: ${id}`, 404);
  const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM group_member_roles WHERE role_name_id = $1', [r.id]);
  if (n.n) throw err(`GROUP_ROLE_NAME_IN_USE: ${n.n} group member(s) hold it`, 409);
  await c.query('DELETE FROM group_role_names WHERE id = $1', [r.id]);
  await audit(c, actor, 'GROUP_ROLE_NAME_DELETED', 'group_role_name', r.id, r, null);
  return { deleted: r.id };
}

// --------------------------------------------------------------------------
// Controls
// --------------------------------------------------------------------------

function controlsOut(r) {
  return {
    initialState: r.initial_state,
    duplicateChecks: r.duplicate_checks,
    requiredAssignments: r.required_assignments,
    multipleGroups: r.multiple_groups,
    groupSizeLimitType: r.group_size_limit_type,
    groupSizeLimit: r.group_size_limit,
    anonymizeAfterDays: r.anonymize_after_days,
    creditArrangementInitialState: r.credit_arrangement_initial_state || 'PENDING_APPROVAL',
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

async function controlsRow(c) {
  const { rows: [r] } = await c.query('SELECT * FROM client_controls WHERE id = 1');
  return r || {
    initial_state: 'INACTIVE', duplicate_checks: { DOCUMENT_ID: 'ERROR', NAME_AND_BIRTH_DATE: 'WARNING', PHONE: 'WARNING', EMAIL: 'NONE' },
    required_assignments: [], multiple_groups: true, group_size_limit_type: 'NONE', group_size_limit: null, anonymize_after_days: null,
    credit_arrangement_initial_state: 'PENDING_APPROVAL',
  };
}

async function controls(c) { return controlsOut(await controlsRow(c)); }

async function updateControls(c, b = {}, { actor } = {}) {
  const before = await controlsRow(c);
  const sets = {};
  if (b.initialState !== undefined) {
    if (!['INACTIVE', 'PENDING_APPROVAL'].includes(b.initialState)) throw err('INITIAL_STATE_IS_INACTIVE_OR_PENDING_APPROVAL', 400);
    sets.initial_state = b.initialState;
  }
  if (b.duplicateChecks !== undefined) {
    const d = b.duplicateChecks;
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw err(`DUPLICATE_CHECKS_IS_AN_OBJECT_OF: ${DUPLICATE_FIELDS.join(', ')}`, 400);
    const next = { ...before.duplicate_checks };
    for (const [k, v] of Object.entries(d)) {
      if (!DUPLICATE_FIELDS.includes(k)) throw err(`UNKNOWN_DUPLICATE_CHECK: ${k}; one of ${DUPLICATE_FIELDS.join(', ')}`, 400);
      if (!LEVELS.includes(v)) throw err(`DUPLICATE_CHECK_LEVEL_IS_ONE_OF: ${LEVELS.join(', ')}`, 400);
      next[k] = v;
    }
    sets.duplicate_checks = JSON.stringify(next);
  }
  if (b.requiredAssignments !== undefined) {
    if (!Array.isArray(b.requiredAssignments) || b.requiredAssignments.some((x) => !ASSIGNMENTS.includes(x))) {
      throw err(`REQUIRED_ASSIGNMENTS_IS_A_LIST_OF: ${ASSIGNMENTS.join(', ')}`, 400);
    }
    sets.required_assignments = [...new Set(b.requiredAssignments)];
  }
  if (b.multipleGroups !== undefined) {
    if (typeof b.multipleGroups !== 'boolean') throw err('MULTIPLE_GROUPS_IS_TRUE_OR_FALSE', 400);
    if (!b.multipleGroups) {
      const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM (SELECT member_id FROM group_members GROUP BY 1 HAVING count(*) > 1) x');
      if (n.n) throw err(`CLIENTS_ALREADY_IN_MORE_THAN_ONE_GROUP: ${n.n}`, 409);
    }
    sets.multiple_groups = b.multipleGroups;
  }
  const type = b.groupSizeLimitType ?? before.group_size_limit_type;
  if (b.groupSizeLimitType !== undefined) {
    if (!['NONE', 'WARNING', 'HARD'].includes(type)) throw err('GROUP_SIZE_LIMIT_TYPE_IS_NONE_WARNING_OR_HARD', 400);
    sets.group_size_limit_type = type;
  }
  if (b.groupSizeLimit !== undefined) {
    if (b.groupSizeLimit !== null && !(Number.isInteger(b.groupSizeLimit) && b.groupSizeLimit >= 1)) throw err('GROUP_SIZE_LIMIT_IS_A_WHOLE_NUMBER_FROM_1', 400);
    sets.group_size_limit = b.groupSizeLimit;
  }
  if (type !== 'NONE' && (sets.group_size_limit === undefined ? before.group_size_limit : sets.group_size_limit) == null) {
    throw err('GROUP_SIZE_LIMIT_REQUIRED_WITH_A_LIMIT_TYPE', 400);
  }
  if (b.anonymizeAfterDays !== undefined) {
    if (b.anonymizeAfterDays !== null && !(Number.isInteger(b.anonymizeAfterDays) && b.anonymizeAfterDays >= 0)) {
      throw err('ANONYMIZE_AFTER_DAYS_IS_A_WHOLE_NUMBER_OR_NULL', 400);
    }
    sets.anonymize_after_days = b.anonymizeAfterDays;
  }
  if (b.creditArrangementInitialState !== undefined) {
    if (!['PENDING_APPROVAL', 'APPROVED'].includes(b.creditArrangementInitialState)) {
      throw err('CREDIT_ARRANGEMENT_INITIAL_STATE_IS_PENDING_APPROVAL_OR_APPROVED', 400);
    }
    sets.credit_arrangement_initial_state = b.creditArrangementInitialState;
  }
  const keys = Object.keys(sets);
  if (!keys.length) return controlsOut(before);
  const { rows: [after] } = await c.query(
    `UPDATE client_controls SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_by = $${keys.length + 1}, updated_at = now()
     WHERE id = 1 RETURNING *`, [...keys.map((k) => sets[k]), actor || 'SYSTEM']);
  await audit(c, actor, 'CLIENT_CONTROLS_CHANGED', 'client_controls', 1, controlsOut(before), controlsOut(after));
  return controlsOut(after);
}

module.exports = {
  HOLDER_TYPES, DUPLICATE_FIELDS, ASSIGNMENTS,
  checkPattern, render, nextId, checkId,
  types, typeRow, defaultType, createType, updateType, deleteType, typeOut,
  roleNames, createRoleName, updateRoleName, deleteRoleName,
  controls, controlsRow, updateControls,
};
