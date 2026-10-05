'use strict';

const { orgToday } = require('../lib/orgDate');
const PERMS = require('../lib/permissions');
const acct = require('./accounting');
const SETUP = require('./clientSetup');
const CF = require('./customFields');
const IDT = require('./idTemplates');
const DUP = require('./duplicates');
const B = require('./branches');
const { recordAudit } = require('../lib/auditLog');
const MESSAGES = require('./notifications/messages');
const { err } = acct;

/**
 * Clients and groups (the reference platform's Clients and Groups; the platform calls
 * clients "members").
 *
 * HOLDERS. An individual member (holder_type CLIENT) and a group (GROUP)
 * are both rows of the members table, so either holds loans, deposit
 * accounts and shares through the same code. A group keeps its name in
 * first_name, and has no personal details; its members are individuals,
 * each with any number of group role names.
 *
 * LIFE CYCLE (clients). A new client starts INACTIVE or PENDING_APPROVAL
 * (the client controls). Approve, reject, exit and blacklist move it, each
 * with an undo, each with its own permission. ACTIVE and INACTIVE follow the
 * accounts on their own, in the database (refresh_member_state): ACTIVE while
 * there is a running loan or an open deposit account. The database refuses
 * a new account unless the holder is INACTIVE or ACTIVE and of a type that
 * may open accounts, and a guarantee unless the guarantor is. Groups are
 * INACTIVE or ACTIVE only.
 *
 *   PENDING_APPROVAL --approve--> INACTIVE <--auto--> ACTIVE
 *   PENDING_APPROVAL --reject--> REJECTED
 *   INACTIVE --exit--> EXITED (no open accounts, no pledged guarantees,
 *                              no shares held, in no group)
 *   PENDING_APPROVAL, INACTIVE, ACTIVE --blacklist--> BLACKLISTED
 *   and each undone: undo approve (only with no accounts at all), undo
 *   reject, undo exit (not once anonymized), undo blacklist (back to where
 *   it was).
 *
 * A blacklisted client's details cannot be changed; its custom fields can,
 * with EDIT_BLACKLISTED_CLIENT_CFV, and its existing accounts transact.
 *
 * DUPLICATES. Four checks, each at NONE, WARNING or ERROR (client controls):
 * a document number (the national ID or any ID document, compared without
 * spaces, hyphens or case), name with birth date, phone (the last nine
 * digits, so 0712... and 254712... match), and email. ERROR refuses the
 * create or the edit; WARNING lets it through and says what it matched.
 * The checks look across every branch.
 */

const CLIENT_STATES = ['PENDING_APPROVAL', 'INACTIVE', 'ACTIVE', 'EXITED', 'BLACKLISTED', 'REJECTED'];
const LANGUAGES = ['ENGLISH', 'PORTUGESE', 'SPANISH', 'RUSSIAN', 'FRENCH', 'GEORGIAN', 'CHINESE', 'INDONESIAN', 'ROMANIAN', 'BURMESE',
  'GERMAN', 'PORTUGUESE_BRAZIL', 'VIETNAMESE', 'ITALIAN', 'THAI', 'NORWEGIAN', 'PHRASE', 'SWAHILI'];
const GENDERS = { MALE: 'MALE', FEMALE: 'FEMALE', OTHER: 'OTHER', M: 'MALE', F: 'FEMALE' };

const COLUMNS = `id, member_no, holder_type, client_type_id, first_name, middle_name, last_name, national_id, kra_pin, phone, phone2,
                 email, date_of_birth, gender, preferred_language, branch_id, centre_id, employer, status,
                 joined_on, exited_on, address_line1, address_line2, city, postcode, region, country,
                 credit_officer, prior_loan_cycles, notes, approved_at, activated_at, state_reason, exit_reason,
                 blacklisted_from, anonymized_at, import_id, created_at, updated_at`;

// Body key -> column, for the free fields.
const TEXT_FIELDS = {
  firstName: ['first_name', 100], middleName: ['middle_name', 100], lastName: ['last_name', 100],
  kraPin: ['kra_pin', 32], phone: ['phone', 32], phone2: ['phone2', 32], email: ['email', 254], employer: ['employer', 255],
  addressLine1: ['address_line1', 255], addressLine2: ['address_line2', 255], city: ['city', 255], postcode: ['postcode', 32],
  region: ['region', 255], country: ['country', 255], notes: ['notes', 4000],
};
const PERSONAL = ['middleName', 'kraPin', 'phone', 'phone2', 'email', 'employer', 'addressLine1', 'addressLine2', 'city', 'postcode',
  'region', 'country', 'notes', 'nationalId', 'dateOfBirth', 'gender', 'preferredLanguage'];

const PERM = {
  CLIENT: { view: 'VIEW_CLIENT_DETAILS', create: 'CREATE_CLIENT', edit: 'EDIT_CLIENT', del: 'DELETE_CLIENTS', id: 'EDIT_CLIENT_ID',
    type: 'CHANGE_CLIENT_TYPE', assoc: 'MANAGE_CLIENT_ASSOCIATION' },
  GROUP: { view: 'VIEW_GROUP_DETAILS', create: 'CREATE_GROUP', edit: 'EDIT_GROUP', del: 'DELETE_GROUP', id: 'EDIT_GROUP_ID',
    type: 'CHANGE_GROUP_TYPE', assoc: 'MANAGE_GROUP_ASSOCIATION' },
};

function need(user, code) {
  if (user && !PERMS.can(user, code)) throw err(`PERMISSION_REQUIRED: ${code}`, 403);
}

async function audit(c, actor, action, id, before, after) {
  await recordAudit(c, { actor: actor || 'SYSTEM', action: action, entity: 'member', entityId: id, before: before ? JSON.stringify(before) : null, after: after ? JSON.stringify(after) : null });
}

async function logState(c, memberId, from, to, action, reason, actor) {
  await c.query(`INSERT INTO member_state_changes (member_id, from_state, to_state, action, reason, actor) VALUES ($1,$2,$3,$4,$5,$6)`,
    [memberId, from, to, action, reason || null, actor || 'SYSTEM']);
}

// --------------------------------------------------------------------------
// Finding
// --------------------------------------------------------------------------

async function find(c, ref, { holderType = null, lock = false } = {}) {
  const s = String(ref ?? '');
  const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  const { rows: [m] } = await c.query(
    `SELECT * FROM members WHERE ${byId ? 'id = $1::uuid' : 'member_no = $1'}${lock ? ' FOR UPDATE' : ''}`, [s]);
  if (!m || (holderType && m.holder_type !== holderType)) {
    throw err(holderType === 'GROUP' ? 'GROUP_NOT_FOUND' : 'MEMBER_NOT_FOUND', 404);
  }
  return m;
}

// --------------------------------------------------------------------------
// Checking what comes in
// --------------------------------------------------------------------------

const { normId, docKey } = DUP;

function isoDate(v, label) {
  const s = String(v).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw err(`${label}_IS_A_DATE: yyyy-MM-dd`, 400);
  }
  return s;
}

/**
 * The columns a body sets. `today` bounds the birth date. Only the fields
 * present in the body are returned; `clear` lists the personal fields a PUT
 * leaves out, which it clears.
 */
function columnsFrom(b, { holderType, today, creating = false, clear = [] }) {
  const out = {};
  const isGroup = holderType === 'GROUP';
  const present = (k) => b[k] !== undefined || clear.includes(k);
  for (const [k, [col, max]] of Object.entries(TEXT_FIELDS)) {
    if (!present(k)) continue;
    if (isGroup && ['firstName', 'middleName', 'lastName', 'kraPin', 'employer'].includes(k)) continue;
    const v = b[k] === null || b[k] === undefined ? '' : String(b[k]).trim();
    if (v.length > max) throw err(`${col.toUpperCase()}_IS_AT_MOST_${max}_CHARACTERS`, 400);
    out[col] = v || null;
  }
  if (isGroup && (b.groupName !== undefined || creating)) {
    const v = String(b.groupName ?? b.name ?? '').trim();
    if (!v || v.length > 255) throw err('GROUP_NAME_IS_1_TO_255_CHARACTERS', 400);
    out.first_name = v;
    out.last_name = '';
  }
  if (!isGroup) {
    if (creating && (!out.first_name || !out.last_name)) throw err('FIRST_AND_LAST_NAME_REQUIRED', 400);
    if (!creating && ('first_name' in out || 'last_name' in out) && (out.first_name === null || out.last_name === null)) {
      throw err('FIRST_AND_LAST_NAME_REQUIRED', 400);
    }
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw err('EMAIL_IS_NOT_AN_EMAIL_ADDRESS', 400);
  for (const col of ['phone', 'phone2']) {
    if (out[col] && !/^\+?[0-9][0-9 ()-]{5,30}$/.test(out[col])) throw err(`${col.toUpperCase()}_IS_NOT_A_PHONE_NUMBER`, 400);
  }
  if (!isGroup) {
    if (present('nationalId')) out.national_id = b.nationalId ? normId(b.nationalId) : null;
    if (out.national_id && out.national_id.length > 32) throw err('NATIONAL_ID_IS_AT_MOST_32_CHARACTERS', 400);
    if (present('dateOfBirth')) {
      if (!b.dateOfBirth) out.date_of_birth = null;
      else {
        const d = isoDate(b.dateOfBirth, 'DATE_OF_BIRTH');
        if (d > today) throw err('DATE_OF_BIRTH_IS_IN_THE_FUTURE', 400);
        if (d < '1900-01-01') throw err('DATE_OF_BIRTH_IS_BEFORE_1900', 400);
        out.date_of_birth = d;
      }
    }
    if (present('gender')) {
      if (!b.gender) out.gender = null;
      else {
        const g = GENDERS[String(b.gender).toUpperCase()];
        if (!g) throw err('GENDER_IS_MALE_FEMALE_OR_OTHER', 400);
        out.gender = g;
      }
    }
    if (b.priorLoanCycles !== undefined) {
      const n = Number(b.priorLoanCycles);
      if (!Number.isInteger(n) || n < 0) throw err('PRIOR_LOAN_CYCLES_MUST_BE_A_WHOLE_NUMBER', 400);
      out.prior_loan_cycles = n;
    }
  }
  if (present('preferredLanguage')) {
    const l = b.preferredLanguage ? String(b.preferredLanguage).toUpperCase() : null;
    if (l && !LANGUAGES.includes(l)) throw err(`PREFERRED_LANGUAGE_IS_ONE_OF: ${LANGUAGES.join(', ')}`, 400);
    out.preferred_language = l;
  }
  return out;
}

/** Branch, centre and credit officer for a new holder, defaulting the branch to the creator's. */
async function association(c, b, { user, before = null }) {
  const out = {};
  let branch = null;
  if (b.branchId !== undefined) {
    branch = b.branchId ? await B.resolve(c, b.branchId) : null;
    if (branch && branch.status !== 'ACTIVE') throw err('BRANCH_IS_DEACTIVATED', 409);
    out.branch_id = branch ? branch.id : null;
  }
  const branchId = 'branch_id' in out ? out.branch_id : before ? before.branch_id : null;
  if (b.centreId !== undefined) {
    const centre = await B.centreFor(c, b.centreId, branchId);
    out.centre_id = centre ? centre.id : null;
    if (centre && !branchId) out.branch_id = centre.branch_id;
  } else if (before && 'branch_id' in out && before.centre_id) {
    // A branch change takes the member out of a centre of the old branch.
    const { rows: [ce] } = await c.query('SELECT branch_id FROM centres WHERE id = $1', [before.centre_id]);
    if (!ce || ce.branch_id !== out.branch_id) out.centre_id = null;
  }
  if (b.creditOfficer !== undefined) out.credit_officer = b.creditOfficer || null;
  // The creator's own branch when none is named (the reference platform fills it in).
  if (!before && !out.branch_id && user) {
    const own = user.branchId || (Array.isArray(user.branches) && user.branches.length === 1 ? user.branches[0] : null);
    if (own) {
      const { rows: [br] } = await c.query("SELECT id FROM branches WHERE id = $1 AND status = 'ACTIVE'", [own]);
      if (br) out.branch_id = br.id;
    }
  }
  return out;
}

async function assertRequired(c, row) {
  const ctl = await SETUP.controlsRow(c);
  const req = ctl.required_assignments || [];
  if (req.includes('BRANCH') && !row.branch_id) throw err('BRANCH_REQUIRED: the client controls require a branch', 400);
  if (req.includes('CENTRE') && !row.centre_id) throw err('CENTRE_REQUIRED: the client controls require a centre', 400);
  if (req.includes('CREDIT_OFFICER') && !row.credit_officer) throw err('CREDIT_OFFICER_REQUIRED: the client controls require a credit officer', 400);
}

// --------------------------------------------------------------------------
// Duplicates
// --------------------------------------------------------------------------

const duplicates = (c, row, opts) => DUP.find(c, row, opts);

function refuseDuplicates(found) {
  const hard = found.filter((d) => d.level === 'ERROR');
  if (hard.length) {
    throw Object.assign(err(`DUPLICATE_CLIENT: ${hard.map((d) => `${d.check} matches ${d.memberNo}${d.state === 'BLACKLISTED' ? ' (BLACKLISTED)' : ''}`).join('; ')}`, 409),
      { duplicates: hard });
  }
  return found.filter((d) => d.level === 'WARNING');
}

// --------------------------------------------------------------------------
// National ID and the template that fills it
// --------------------------------------------------------------------------

async function nationalTemplate(c) {
  const { rows: [t] } = await c.query('SELECT id FROM id_templates WHERE national_id');
  return t ? t.id : null;
}

// --------------------------------------------------------------------------
// Create
// --------------------------------------------------------------------------

/**
 * Create a member (holderType CLIENT) or a group. Returns the row and any
 * duplicate warnings. `imported` skips the ID permission (the import has
 * its own) and takes the state given.
 */
async function create(c, b = {}, { user = null, holderType = 'CLIENT', imported = false } = {}) {
  const P = PERM[holderType];
  const actor = user?.email || 'SYSTEM';
  const today = await orgToday(c);
  const type = b.clientTypeId ? await SETUP.typeRow(c, b.clientTypeId, { holderType }) : await SETUP.defaultType(c, holderType);
  if (!type) throw err(`NO_DEFAULT_${holderType}_TYPE`, 500);
  const cols = columnsFrom(b, { holderType, today, creating: true });
  Object.assign(cols, await association(c, b, { user }));
  cols.holder_type = holderType;
  cols.client_type_id = type.id;

  if (b.memberNo !== undefined && b.memberNo !== null && b.memberNo !== '') {
    if (!imported) need(user, P.id);
    cols.member_no = SETUP.checkId(b.memberNo);
    const { rows: [t] } = await c.query('SELECT member_no_taken($1) AS taken', [cols.member_no]);
    if (t.taken) throw err(`DUPLICATE_MEMBER: the ID ${cols.member_no} is taken`, 409);
  } else {
    cols.member_no = await SETUP.nextId(c, type.id);
  }

  const ctl = await SETUP.controlsRow(c);
  cols.status = holderType === 'GROUP' ? 'INACTIVE' : ctl.initial_state;
  if (b.status !== undefined && b.status !== null) {
    if (!imported) throw err('THE_STATE_IS_SET_BY_THE_CLIENT_CONTROLS_AND_THE_STATE_ACTIONS', 400);
    if (!CLIENT_STATES.includes(b.status)) throw err(`STATE_IS_ONE_OF: ${CLIENT_STATES.join(', ')}`, 400);
    cols.status = b.status;
  }
  if (cols.status === 'INACTIVE') cols.approved_at = new Date();
  if (cols.status === 'EXITED') cols.exited_on = b.exitedOn || today;
  if (imported && b.joinedOn) cols.joined_on = b.joinedOn;

  // Identification documents (individuals); the national ID template fills the national ID.
  let docs = [];
  if (holderType === 'CLIENT') {
    docs = await IDT.forNewMember(c, b.identificationDocuments || [], { requireMandatory: type.require_id_documents });
    const nt = await nationalTemplate(c);
    const nd = nt && docs.find((d) => d.template_id === nt);
    if (nd) {
      const v = normId(nd.document_id);
      if (cols.national_id && docKey(cols.national_id) !== docKey(v)) throw err('NATIONAL_ID_DIFFERS_FROM_THE_NATIONAL_ID_DOCUMENT', 400);
      cols.national_id = cols.national_id || v;
    }
  } else if (b.identificationDocuments && b.identificationDocuments.length) {
    throw err('GROUPS_HAVE_NO_IDENTIFICATION_DOCUMENTS', 400);
  }
  await assertRequired(c, cols);
  const warnings = refuseDuplicates(await duplicates(c, cols, { docs }));

  const values = await CF.prepare(c, holderType === 'GROUP' ? 'GROUP' : 'MEMBER', {
    item: type.id, patch: b.customFields || {}, user, creating: true });
  cols.custom_fields = JSON.stringify(values);

  const keys = Object.keys(cols);
  let row;
  try {
    ({ rows: [row] } = await c.query(
      `INSERT INTO members (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${COLUMNS}`,
      keys.map((k) => cols[k])));
  } catch (e) {
    if (e.code === '23505') throw err(`DUPLICATE_MEMBER: ${e.constraint}`, 409);
    throw e;
  }
  if (docs.length) await IDT.storeForMember(c, row.id, docs, { createdBy: actor });
  await logState(c, row.id, null, row.status, 'CREATED', null, actor);
  await audit(c, actor, holderType === 'GROUP' ? 'GROUP_CREATED' : 'MEMBER_CREATED', row.id, null, row);
  let groupWarnings = [];
  if (holderType === 'GROUP' && Array.isArray(b.groupMembers)) {
    groupWarnings = (await setGroupMembers(c, row.id, b.groupMembers, { user, checkPermission: false })).warnings;
  }
  return { member: row, duplicateWarnings: warnings, groupWarnings };
}

// --------------------------------------------------------------------------
// Update
// --------------------------------------------------------------------------

/**
 * Change a holder's details. Each kind of change needs its own permission:
 * the details EDIT_CLIENT (EDIT_GROUP), the ID EDIT_CLIENT_ID, the type
 * CHANGE_CLIENT_TYPE, the branch, centre and credit officer
 * MANAGE_CLIENT_ASSOCIATION. `clear` (a PUT) empties the personal fields
 * left out.
 */
async function update(c, ref, b = {}, { user = null, holderType = null, clear = [] } = {}) {
  const before = await find(c, ref, { holderType, lock: true });
  const H = before.holder_type;
  const P = PERM[H];
  const actor = user?.email || 'SYSTEM';
  if (b.status !== undefined || b.state !== undefined) throw err('STATE_CHANGES_USE_THE_STATE_ACTIONS: POST /api/members/{id}/state', 400);
  const today = await orgToday(c);
  const cols = columnsFrom(b, { holderType: H, today, clear });
  const detailChange = Object.keys(cols).length > 0;
  const assocChange = ['branchId', 'centreId', 'creditOfficer'].some((k) => b[k] !== undefined);
  if (before.status === 'BLACKLISTED' && (detailChange || assocChange || b.memberNo !== undefined || b.clientTypeId !== undefined)) {
    throw err('A_BLACKLISTED_CLIENT_CANNOT_BE_CHANGED: only its custom fields, with EDIT_BLACKLISTED_CLIENT_CFV', 409);
  }
  if (before.anonymized_at && (detailChange || b.customFields !== undefined)) throw err('THE_MEMBER_IS_ANONYMIZED', 409);
  if (detailChange) need(user, P.edit);
  if (assocChange) {
    need(user, P.assoc);
    Object.assign(cols, await association(c, b, { user, before }));
  }
  if (b.memberNo !== undefined && b.memberNo !== before.member_no) {
    need(user, P.id);
    cols.member_no = SETUP.checkId(b.memberNo);
    const { rows: [t] } = await c.query('SELECT member_no_taken($1) AS taken', [cols.member_no]);
    if (t.taken) throw err(`DUPLICATE_MEMBER: the ID ${cols.member_no} is taken`, 409);
  }
  let type = null;
  if (b.clientTypeId !== undefined && b.clientTypeId !== before.client_type_id) {
    need(user, P.type);
    type = await SETUP.typeRow(c, b.clientTypeId, { holderType: H });
    cols.client_type_id = type.id;
  }
  if (b.customFields !== undefined) {
    if (before.status === 'BLACKLISTED') need(user, 'EDIT_BLACKLISTED_CLIENT_CFV');
    else if (!detailChange) need(user, P.edit);
    const values = await CF.prepare(c, H === 'GROUP' ? 'GROUP' : 'MEMBER', {
      item: cols.client_type_id || before.client_type_id, patch: b.customFields, previous: before.custom_fields, user, recordId: before.id });
    cols.custom_fields = JSON.stringify(values);
  }
  const keys = Object.keys(cols);
  if (!keys.length) {
    if (H === 'GROUP' && Array.isArray(b.groupMembers)) {
      const r = await setGroupMembers(c, before.id, b.groupMembers, { user });
      return { member: await find(c, before.id), duplicateWarnings: [], groupWarnings: r.warnings };
    }
    throw err('NO_UPDATABLE_FIELDS', 400);
  }
  const next = { ...before, ...cols };
  if (assocChange) await assertRequired(c, next);
  let warnings = [];
  if (H === 'CLIENT' && ['national_id', 'first_name', 'last_name', 'date_of_birth', 'phone', 'phone2', 'email'].some((k) => k in cols)) {
    warnings = refuseDuplicates(await duplicates(c, next, { exclude: before.id }));
  }
  let row;
  try {
    ({ rows: [row] } = await c.query(
      `UPDATE members SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      [before.id, ...keys.map((k) => cols[k])]));
  } catch (e) {
    if (e.code === '23505') throw err(`DUPLICATE_MEMBER: ${e.constraint}`, 409);
    throw e;
  }
  // The national ID document follows the national ID.
  if ('national_id' in cols && cols.national_id) {
    const nt = await nationalTemplate(c);
    if (nt) await c.query('UPDATE member_identifications SET document_id = $3 WHERE member_id = $1 AND template_id = $2', [before.id, nt, cols.national_id]);
  }
  await audit(c, actor, H === 'GROUP' ? 'GROUP_UPDATED' : 'MEMBER_UPDATED', before.id, before, row);
  let groupWarnings = [];
  if (H === 'GROUP' && Array.isArray(b.groupMembers)) groupWarnings = (await setGroupMembers(c, before.id, b.groupMembers, { user })).warnings;
  return { member: row, duplicateWarnings: warnings, groupWarnings };
}

// --------------------------------------------------------------------------
// State actions
// --------------------------------------------------------------------------

const ACTIONS = {
  APPROVE: { from: ['PENDING_APPROVAL'], to: 'INACTIVE', perm: 'APPROVE_CLIENT' },
  UNDO_APPROVE: { from: ['INACTIVE'], to: 'PENDING_APPROVAL', perm: 'UNDO_CLIENT_STATE_CHANGED' },
  REJECT: { from: ['PENDING_APPROVAL'], to: 'REJECTED', perm: 'REJECT_CLIENT' },
  UNDO_REJECT: { from: ['REJECTED'], to: 'PENDING_APPROVAL', perm: 'UNDO_CLIENT_STATE_CHANGED' },
  EXIT: { from: ['INACTIVE'], to: 'EXITED', perm: 'EXIT_CLIENT' },
  UNDO_EXIT: { from: ['EXITED'], to: 'INACTIVE', perm: 'UNDO_CLIENT_STATE_CHANGED' },
  BLACKLIST: { from: ['PENDING_APPROVAL', 'INACTIVE', 'ACTIVE'], to: 'BLACKLISTED', perm: 'BLACKLIST_CLIENT' },
  UNDO_BLACKLIST: { from: ['BLACKLISTED'], to: null, perm: 'UNDO_CLIENT_STATE_CHANGED' },
};

/** What still ties a member down: open accounts, pledges, shares and groups. */
async function openTies(c, memberId) {
  const { rows: [r] } = await c.query(
    `SELECT (SELECT count(*)::int FROM loan_accounts WHERE member_id = $1 AND status NOT LIKE 'CLOSED%') AS loans,
            (SELECT count(*)::int FROM savings_accounts WHERE member_id = $1 AND status <> 'CLOSED') AS deposits,
            (SELECT count(*)::int FROM share_accounts WHERE member_id = $1 AND status = 'ACTIVE' AND units > 0) AS shares,
            (SELECT count(*)::int FROM loan_guarantors g JOIN loan_accounts l ON l.id = g.loan_id
              WHERE g.member_id = $1 AND g.status = 'PLEDGED' AND l.status NOT LIKE 'CLOSED%') AS pledges,
            (SELECT count(*)::int FROM group_members WHERE member_id = $1) AS groups`, [memberId]);
  return r;
}

async function anyAccounts(c, memberId) {
  const { rows: [r] } = await c.query(
    `SELECT EXISTS (SELECT 1 FROM loan_accounts WHERE member_id = $1) OR EXISTS (SELECT 1 FROM savings_accounts WHERE member_id = $1)
         OR EXISTS (SELECT 1 FROM share_accounts WHERE member_id = $1) OR EXISTS (SELECT 1 FROM loan_guarantors WHERE member_id = $1)
         OR EXISTS (SELECT 1 FROM loan_accounts WHERE solidarity_group_id = $1) OR EXISTS (SELECT 1 FROM credit_arrangements WHERE holder_id = $1) AS any`,
    [memberId]);
  return r.any;
}

async function changeState(c, ref, action, { reason = null, user = null } = {}) {
  const a = ACTIONS[String(action || '').toUpperCase()];
  if (!a) throw err(`UNKNOWN_STATE_ACTION: ${action}; one of ${Object.keys(ACTIONS).join(', ')}`, 400);
  const name = String(action).toUpperCase();
  const m = await find(c, ref, { lock: true });
  if (m.holder_type === 'GROUP') throw err('GROUPS_HAVE_NO_STATE_ACTIONS: a group is INACTIVE or ACTIVE by its accounts', 409);
  need(user, a.perm);
  if (!a.from.includes(m.status)) throw err(`CANNOT_${name}_A_CLIENT_IN_STATE: ${m.status}`, 409);
  const actor = user?.email || 'SYSTEM';
  const note = reason === null || reason === undefined ? null : String(reason).slice(0, 1000);
  const sets = {};
  let to = a.to;
  if (name === 'APPROVE') sets.approved_at = new Date();
  if (name === 'UNDO_APPROVE') {
    if (await anyAccounts(c, m.id)) throw err('CANNOT_UNDO_APPROVE: the client has accounts or guarantees', 409);
    sets.approved_at = null;
  }
  if (name === 'REJECT' || name === 'BLACKLIST') sets.state_reason = note;
  if (name === 'UNDO_REJECT') sets.state_reason = null;
  if (name === 'EXIT') {
    const t = await openTies(c, m.id);
    const left = Object.entries(t).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
    if (left.length) throw err(`CANNOT_EXIT: close or release first: ${left.join(', ')}`, 409);
    // Share accounts emptied by a transfer are closed with the member.
    await c.query("UPDATE share_accounts SET status = 'CLOSED' WHERE member_id = $1 AND status = 'ACTIVE' AND units = 0", [m.id]);
    sets.exited_on = await orgToday(c);
    sets.exit_reason = note;
  }
  if (name === 'UNDO_EXIT') {
    if (m.anonymized_at) throw err('CANNOT_UNDO_EXIT: the member is anonymized', 409);
    sets.exited_on = null;
    sets.exit_reason = null;
  }
  if (name === 'BLACKLIST') sets.blacklisted_from = m.status;
  if (name === 'UNDO_BLACKLIST') {
    to = m.blacklisted_from || 'INACTIVE';
    sets.blacklisted_from = null;
    sets.state_reason = null;
  }
  sets.status = to;
  const keys = Object.keys(sets);
  await c.query(`UPDATE members SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
    [m.id, ...keys.map((k) => sets[k])]);
  await logState(c, m.id, m.status, to, name, note, actor);
  // Back in INACTIVE or ACTIVE, the state follows the accounts again.
  await c.query('SELECT refresh_member_state($1)', [m.id]);
  const after = await find(c, m.id);
  await audit(c, actor, `MEMBER_${name}`, m.id, { status: m.status }, { status: after.status, reason: note });
  return after;
}

async function stateHistory(c, ref) {
  const m = await find(c, ref);
  const { rows } = await c.query(
    'SELECT from_state, to_state, action, reason, actor, changed_at FROM member_state_changes WHERE member_id = $1 ORDER BY changed_at, id', [m.id]);
  return rows;
}

// --------------------------------------------------------------------------
// Reassigning (one or many): branch, centre, credit officer, and the accounts
// --------------------------------------------------------------------------

async function reassign(c, refs, b = {}, { user = null } = {}) {
  if (!Array.isArray(refs) || !refs.length) throw err('MEMBERS_IS_A_LIST_OF_MEMBER_IDS', 400);
  if (refs.length > 1000) throw err('AT_MOST_1000_MEMBERS_AT_ONCE', 400);
  if (b.branchId === undefined && b.centreId === undefined && b.creditOfficer === undefined) throw err('NOTHING_TO_REASSIGN', 400);
  const actor = user?.email || 'SYSTEM';
  const moveAccounts = b.moveAccounts === true;
  if (moveAccounts) { need(user, 'MANAGE_LOAN_ASSOCIATION'); need(user, 'MANAGE_DEPOSIT_ASSOCIATION'); }
  // In bulk an empty centre or credit officer keeps what each member has (the reference platform).
  const spec = {};
  if (b.branchId) spec.branchId = b.branchId;
  if (b.centreId !== undefined && (b.centreId || refs.length === 1)) spec.centreId = b.centreId;
  if (b.creditOfficer !== undefined && (b.creditOfficer || refs.length === 1)) spec.creditOfficer = b.creditOfficer;
  const out = [];
  for (const ref of refs) {
    const before = await find(c, ref, { lock: true });
    need(user, PERM[before.holder_type].assoc);
    if (before.status === 'BLACKLISTED') throw err(`A_BLACKLISTED_CLIENT_CANNOT_BE_CHANGED: ${before.member_no}`, 409);
    const cols = await association(c, spec, { user, before });
    const next = { ...before, ...cols };
    await assertRequired(c, next);
    const keys = Object.keys(cols).filter((k) => cols[k] !== before[k]);
    if (keys.length) {
      await c.query(`UPDATE members SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
        [before.id, ...keys.map((k) => cols[k])]);
    }
    const moved = [];
    if (moveAccounts) {
      const officer = 'credit_officer' in cols ? cols.credit_officer : undefined;
      const { rows: loans } = await c.query("SELECT id, branch_id FROM loan_accounts WHERE member_id = $1 AND status NOT LIKE 'CLOSED%'", [before.id]);
      for (const l of loans) {
        if (next.branch_id && l.branch_id !== next.branch_id) {
          moved.push(await B.moveAccount(c, { kind: 'LOAN', accountId: l.id, branchId: next.branch_id, createdBy: actor }));
        }
        if (officer !== undefined) await c.query('UPDATE loan_accounts SET credit_officer = $2 WHERE id = $1', [l.id, officer]);
      }
      const { rows: deps } = await c.query("SELECT id, branch_id FROM savings_accounts WHERE member_id = $1 AND status <> 'CLOSED'", [before.id]);
      for (const a of deps) {
        if (next.branch_id && a.branch_id !== next.branch_id) {
          moved.push(await B.moveAccount(c, { kind: 'SAVINGS', accountId: a.id, branchId: next.branch_id, createdBy: actor }));
        }
      }
    }
    const after = await find(c, before.id);
    await audit(c, actor, 'MEMBER_REASSIGNED', before.id,
      { branch_id: before.branch_id, centre_id: before.centre_id, credit_officer: before.credit_officer },
      { branch_id: after.branch_id, centre_id: after.centre_id, credit_officer: after.credit_officer, accountsMoved: moved.length });
    out.push({ memberId: after.id, memberNo: after.member_no, branchId: after.branch_id, centreId: after.centre_id,
      creditOfficer: after.credit_officer, accountsMoved: moved });
  }
  return { reassigned: out.length, members: out };
}

// --------------------------------------------------------------------------
// Delete and anonymize
// --------------------------------------------------------------------------

const REDACTED = { redacted: true };

/** Take a member's personal details out of the audit log's copies of it. */
async function redactAudit(c, m) {
  // The one change the change log allows (migration 042), for this statement only.
  await c.query("SELECT set_config('app.audit_maintenance', 'anonymize', true)");
  await c.query(`UPDATE audit_log SET before = CASE WHEN before IS NULL THEN NULL ELSE $2::jsonb END,
                                       after = CASE WHEN after IS NULL THEN NULL ELSE $2::jsonb END
                  WHERE entity = 'member' AND entity_id = $1`, [String(m.id), JSON.stringify({ ...REDACTED, memberNo: m.member_no })]);
  await c.query("SELECT set_config('app.audit_maintenance', '', true)");
}

async function removePortal(c, memberId) {
  for (const t of ['member_sessions', 'member_login_attempts', 'beneficiaries', 'member_credentials']) {
    const { rows: [x] } = await c.query('SELECT to_regclass($1) AS t', [t]);
    if (x.t) await c.query(`DELETE FROM ${t} WHERE member_id = $1`, [memberId]);
  }
}

/** Delete a member or group that never held an account or a guarantee (the reference platform). */
async function remove(c, ref, { user = null, holderType = null } = {}) {
  const m = await find(c, ref, { holderType, lock: true });
  need(user, PERM[m.holder_type].del);
  if (await anyAccounts(c, m.id)) throw err(`CANNOT_DELETE: ${m.holder_type === 'GROUP' ? 'the group' : 'the member'} has had accounts or guarantees`, 409);
  const actor = user?.email || 'SYSTEM';
  await c.query('DELETE FROM group_members WHERE group_id = $1 OR member_id = $1', [m.id]);
  await c.query('UPDATE tasks SET member_id = NULL WHERE member_id = $1', [m.id]);
  await removePortal(c, m.id);
  try {
    await c.query('SAVEPOINT member_delete');
    await c.query('DELETE FROM members WHERE id = $1', [m.id]);
    await c.query('RELEASE SAVEPOINT member_delete');
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT member_delete');
    if (e.code === '23503') throw err(`CANNOT_DELETE: records still refer to it (${e.table})`, 409);
    throw e;
  }
  await redactAudit(c, m);
  await audit(c, actor, m.holder_type === 'GROUP' ? 'GROUP_DELETED' : 'MEMBER_DELETED', m.id, null, { memberNo: m.member_no });
  return { deleted: m.member_no };
}

/**
 * Anonymize an exited member once the tenant's retention period has passed
 * since the exit: personal details, ID documents, portal access and custom
 * field values, the picture and the signature go; the number, the
 * accounts and the ledger stay.
 */
async function anonymize(c, ref, { user = null } = {}) {
  const m = await find(c, ref, { holderType: 'CLIENT', lock: true });
  need(user, 'ANONYMIZE_CLIENT');
  if (m.anonymized_at) throw err('ALREADY_ANONYMIZED', 409);
  if (m.status !== 'EXITED') throw err(`ONLY_AN_EXITED_MEMBER_IS_ANONYMIZED: ${m.status}`, 409);
  const ctl = await SETUP.controlsRow(c);
  if (ctl.anonymize_after_days === null || ctl.anonymize_after_days === undefined) {
    throw err('ANONYMIZATION_RETENTION_NOT_SET: set anonymizeAfterDays in the client controls first', 409);
  }
  const { rows: [d] } = await c.query(
    `SELECT COALESCE($2::date, (SELECT max(changed_at)::date FROM member_state_changes WHERE member_id = $1 AND to_state = 'EXITED'), $3::date)
            + $4::int AS allowed_from, current_date AS today`, [m.id, m.exited_on, m.updated_at, ctl.anonymize_after_days]);
  const allowed = d.allowed_from instanceof Date ? d.allowed_from.toISOString().slice(0, 10) : String(d.allowed_from).slice(0, 10);
  const today = await orgToday(c);
  if (allowed > today) throw err(`RETENTION_PERIOD_NOT_OVER: anonymize from ${allowed}`, 409);
  const actor = user?.email || 'SYSTEM';
  await c.query(
    `UPDATE members SET first_name = 'Anonymized', last_name = member_no, middle_name = NULL, national_id = NULL, kra_pin = NULL,
            phone = NULL, phone2 = NULL, email = NULL, date_of_birth = NULL, gender = NULL, employer = NULL, address_line1 = NULL,
            address_line2 = NULL, city = NULL, postcode = NULL, region = NULL, country = NULL, notes = NULL, state_reason = NULL,
            exit_reason = NULL, custom_fields = '{}', anonymized_at = now(), updated_at = now() WHERE id = $1`, [m.id]);
  await c.query('DELETE FROM member_identifications WHERE member_id = $1', [m.id]);
  await c.query('DELETE FROM member_media WHERE member_id = $1', [m.id]);
  await removePortal(c, m.id);
  await c.query('UPDATE member_state_changes SET reason = NULL WHERE member_id = $1', [m.id]);
  // The communication log keeps that messages were sent, not to which address or what they said.
  await MESSAGES.forgetMember(c, m.id);
  await redactAudit(c, m);
  await audit(c, actor, 'MEMBER_ANONYMIZED', m.id, null, { memberNo: m.member_no });
  return find(c, m.id);
}

// --------------------------------------------------------------------------
// Group membership
// --------------------------------------------------------------------------

async function groupMembers(c, groupId) {
  const { rows } = await c.query(
    `SELECT gm.member_id, m.member_no, m.first_name, m.last_name, m.status, gm.added_at,
            COALESCE(array_agg(r.role_name_id ORDER BY r.role_name_id) FILTER (WHERE r.role_name_id IS NOT NULL), '{}') AS roles,
            COALESCE(array_agg(rn.name ORDER BY r.role_name_id) FILTER (WHERE r.role_name_id IS NOT NULL), '{}') AS role_names
       FROM group_members gm LEFT JOIN members m ON m.id = gm.member_id
       LEFT JOIN group_member_roles r ON r.group_id = gm.group_id AND r.member_id = gm.member_id
       LEFT JOIN group_role_names rn ON rn.id = r.role_name_id
      WHERE gm.group_id = $1 GROUP BY gm.member_id, m.member_no, m.first_name, m.last_name, m.status, gm.added_at
      ORDER BY m.last_name, m.first_name`, [groupId]);
  return rows;
}

async function groupsOf(c, memberId) {
  const { rows } = await c.query(
    `SELECT g.id, g.member_no, g.first_name AS group_name,
            COALESCE(array_agg(r.role_name_id) FILTER (WHERE r.role_name_id IS NOT NULL), '{}') AS roles
       FROM group_members gm JOIN members g ON g.id = gm.group_id
       LEFT JOIN group_member_roles r ON r.group_id = gm.group_id AND r.member_id = gm.member_id
      WHERE gm.member_id = $1 GROUP BY g.id, g.member_no, g.first_name ORDER BY g.first_name`, [memberId]);
  return rows;
}

/**
 * Replace a group's members: [{ memberId, roles: [roleNameId] }] (memberId an
 * id or member number). The client controls decide whether a client may be
 * in more than one group and how large a group may be.
 */
async function setGroupMembers(c, groupRef, list, { user = null, checkPermission = true } = {}) {
  const g = await find(c, groupRef, { holderType: 'GROUP', lock: true });
  if (checkPermission) need(user, 'EDIT_GROUP');
  if (!Array.isArray(list)) throw err('GROUP_MEMBERS_IS_A_LIST', 400);
  const actor = user?.email || 'SYSTEM';
  const ctl = await SETUP.controlsRow(c);
  const wanted = new Map();
  for (const x of list) {
    const ref = typeof x === 'string' ? x : x?.memberId ?? x?.clientKey;
    if (!ref) throw err('A_GROUP_MEMBER_NEEDS_ITS_MEMBER_ID', 400);
    const m = await find(c, ref);
    if (m.holder_type !== 'CLIENT') throw err('A_GROUP_HOLDS_INDIVIDUAL_CLIENTS_ONLY', 400);
    const roles = [...new Set((typeof x === 'object' && Array.isArray(x.roles) ? x.roles : [])
      .map((r) => (typeof r === 'object' ? r.groupRoleNameKey ?? r.id : r)).filter(Boolean).map(String))];
    wanted.set(m.id, { m, roles });
  }
  const warnings = [];
  if (ctl.group_size_limit_type !== 'NONE' && ctl.group_size_limit && wanted.size > ctl.group_size_limit) {
    const msg = `GROUP_SIZE_LIMIT: ${wanted.size} members, the limit is ${ctl.group_size_limit}`;
    if (ctl.group_size_limit_type === 'HARD') throw err(msg, 409);
    warnings.push(msg);
  }
  const { rows: current } = await c.query('SELECT member_id FROM group_members WHERE group_id = $1', [g.id]);
  const had = new Set(current.map((r) => r.member_id));
  for (const [id, { m }] of wanted) {
    if (had.has(id)) continue;
    if (!ctl.multiple_groups) {
      const { rows: [o] } = await c.query(
        'SELECT g.member_no FROM group_members gm JOIN members g ON g.id = gm.group_id WHERE gm.member_id = $1 AND gm.group_id <> $2 LIMIT 1', [id, g.id]);
      if (o) throw err(`CLIENT_ALREADY_IN_A_GROUP: ${m.member_no} is in ${o.member_no}`, 409);
    }
    await c.query('INSERT INTO group_members (group_id, member_id, added_by) VALUES ($1,$2,$3)', [g.id, id, actor]);
  }
  const gone = [...had].filter((id) => !wanted.has(id));
  if (gone.length) await c.query('DELETE FROM group_members WHERE group_id = $1 AND member_id = ANY($2::uuid[])', [g.id, gone]);
  await c.query('DELETE FROM group_member_roles WHERE group_id = $1', [g.id]);
  for (const [id, { roles }] of wanted) {
    for (const r of roles) {
      const { rows: [rn] } = await c.query('SELECT id FROM group_role_names WHERE id = $1 OR name = $1', [r]);
      if (!rn) throw err(`UNKNOWN_GROUP_ROLE_NAME: ${r}`, 400);
      await c.query('INSERT INTO group_member_roles (group_id, member_id, role_name_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [g.id, id, rn.id]);
    }
  }
  await audit(c, actor, 'GROUP_MEMBERS_CHANGED', g.id, { members: [...had] }, { members: [...wanted.keys()], added: [...wanted.keys()].filter((i) => !had.has(i)), removed: gone });
  return { members: await groupMembers(c, g.id), warnings };
}

async function addGroupMember(c, groupRef, { memberId, roles = [] } = {}, { user = null } = {}) {
  const g = await find(c, groupRef, { holderType: 'GROUP' });
  const cur = await groupMembers(c, g.id);
  const m = await find(c, memberId);
  if (cur.some((x) => x.member_id === m.id)) throw err(`ALREADY_A_MEMBER_OF_THE_GROUP: ${m.member_no}`, 409);
  return setGroupMembers(c, g.id, [...cur.map((x) => ({ memberId: x.member_id, roles: x.roles })), { memberId: m.id, roles }], { user });
}

async function removeGroupMember(c, groupRef, memberRef, { user = null } = {}) {
  const g = await find(c, groupRef, { holderType: 'GROUP' });
  const m = await find(c, memberRef);
  const cur = await groupMembers(c, g.id);
  if (!cur.some((x) => x.member_id === m.id)) throw err('NOT_A_MEMBER_OF_THE_GROUP', 404);
  return setGroupMembers(c, g.id, cur.filter((x) => x.member_id !== m.id).map((x) => ({ memberId: x.member_id, roles: x.roles })), { user });
}

// --------------------------------------------------------------------------
// The reference platform's shapes (API v2 /clients and /groups)
// --------------------------------------------------------------------------

async function officerKeys(c, rows) {
  const emails = [...new Set(rows.map((r) => r.credit_officer).filter(Boolean).map((e) => e.toLowerCase()))];
  if (!emails.length) return new Map();
  const { rows: us } = await c.query(
    `SELECT u.id, lower(u.email) AS email FROM platform.users u JOIN platform.tenants t ON t.id = u.tenant_id
      WHERE t.schema_name = current_schema() AND lower(u.email) = ANY($1)`, [emails]);
  return new Map(us.map((u) => [u.email, u.id]));
}

async function loanCycles(c, ids) {
  if (!ids.length) return { own: new Map(), group: new Map() };
  const { rows } = await c.query(
    `SELECT m.id,
            (SELECT count(*)::int FROM loan_accounts l WHERE l.member_id = m.id AND l.status = 'CLOSED_REPAID') + m.prior_loan_cycles AS own,
            (SELECT count(*)::int FROM loan_accounts l JOIN group_members gm ON gm.group_id = l.member_id
              WHERE gm.member_id = m.id AND l.status = 'CLOSED_REPAID')
            -- A member's own solidarity loans advance their group loan cycle too (the reference platform: individually).
            + (SELECT count(*)::int FROM loan_accounts l WHERE l.member_id = m.id AND l.solidarity_group_id IS NOT NULL
              AND l.status = 'CLOSED_REPAID') AS grp
       FROM members m WHERE m.id = ANY($1::uuid[])`, [ids]);
  return { own: new Map(rows.map((r) => [r.id, r.own])), group: new Map(rows.map((r) => [r.id, r.grp])) };
}

const iso = (d) => (d instanceof Date ? d.toISOString() : d || null);
const addressOf = (m) => (['address_line1', 'address_line2', 'city', 'postcode', 'region', 'country'].some((k) => m[k])
  ? [{ line1: m.address_line1, line2: m.address_line2, city: m.city, postcode: m.postcode, region: m.region, country: m.country }] : []);

/** The reference platform Client objects for rows of individuals, with their documents, groups and custom fields. */
async function clientsOut(c, rows, { user = null } = {}) {
  const ids = rows.map((r) => r.id);
  const officers = await officerKeys(c, rows);
  const cycles = await loanCycles(c, ids);
  const { rows: docs } = ids.length ? await c.query('SELECT * FROM member_identifications WHERE member_id = ANY($1::uuid[]) ORDER BY created_at', [ids]) : { rows: [] };
  const { rows: grp } = ids.length ? await c.query('SELECT member_id, group_id FROM group_members WHERE member_id = ANY($1::uuid[])', [ids]) : { rows: [] };
  const out = [];
  for (const m of rows) {
    const cf = await CF.getValues(c, 'MEMBER', m.id, { user, record: m });
    out.push({
      encodedKey: m.id, id: m.member_no, state: m.status,
      firstName: m.first_name, middleName: m.middle_name, lastName: m.last_name,
      birthDate: m.date_of_birth, gender: m.gender, preferredLanguage: m.preferred_language,
      emailAddress: m.email, mobilePhone: m.phone, mobilePhone2: m.phone2, notes: m.notes,
      clientRoleKey: m.client_type_id, assignedBranchKey: m.branch_id, assignedCentreKey: m.centre_id,
      assignedUserKey: m.credit_officer ? officers.get(m.credit_officer.toLowerCase()) || null : null,
      groupKeys: grp.filter((g) => g.member_id === m.id).map((g) => g.group_id),
      idDocuments: docs.filter((d) => d.member_id === m.id).map((d, i) => ({
        encodedKey: d.id, clientKey: m.id, documentId: d.document_id, documentType: d.id_type, issuingAuthority: d.issuing_authority,
        validUntil: d.valid_until, identificationDocumentTemplateKey: d.template_id, indexInList: i })),
      addresses: addressOf(m),
      loanCycle: cycles.own.get(m.id) ?? 0, groupLoanCycle: cycles.group.get(m.id) ?? 0,
      approvedDate: iso(m.approved_at), activationDate: iso(m.activated_at), closedDate: m.exited_on,
      creationDate: iso(m.created_at), lastModifiedDate: iso(m.updated_at),
      // The platform's own member fields.
      nationalId: m.national_id, kraPin: m.kra_pin, employer: m.employer, joinedOn: m.joined_on,
      stateReason: m.state_reason, exitReason: m.exit_reason, anonymized: Boolean(m.anonymized_at),
      ...CF.toApi(cf),
    });
  }
  return out;
}

async function groupsOut(c, rows, { user = null } = {}) {
  const officers = await officerKeys(c, rows);
  const cycles = await loanCycles(c, rows.map((r) => r.id));
  const out = [];
  for (const g of rows) {
    const cf = await CF.getValues(c, 'GROUP', g.id, { user, record: g });
    const members = await groupMembers(c, g.id);
    out.push({
      encodedKey: g.id, id: g.member_no, groupName: g.first_name, groupRoleKey: g.client_type_id, state: g.status,
      groupMembers: members.map((x) => ({ clientKey: x.member_id,
        roles: x.roles.map((r, i) => ({ groupRoleNameKey: r, roleName: x.role_names[i] })) })),
      assignedBranchKey: g.branch_id, assignedCentreKey: g.centre_id,
      assignedUserKey: g.credit_officer ? officers.get(g.credit_officer.toLowerCase()) || null : null,
      emailAddress: g.email, mobilePhone: g.phone, homePhone: g.phone2, preferredLanguage: g.preferred_language, notes: g.notes,
      addresses: addressOf(g), loanCycle: cycles.own.get(g.id) ?? 0,
      creationDate: iso(g.created_at), lastModifiedDate: iso(g.updated_at),
      ...CF.toApi(cf),
    });
  }
  return out;
}

/** A credit officer given as a user id or an email, as its email. */
async function officerEmail(c, v) {
  if (v === undefined) return undefined;
  if (!v) return null;
  const s = String(v);
  if (s.includes('@')) return s;
  const { rows: [u] } = await c.query(
    `SELECT u.email FROM platform.users u JOIN platform.tenants t ON t.id = u.tenant_id
      WHERE t.schema_name = current_schema() AND u.id::text = $1`, [s]);
  if (!u) throw err(`UNKNOWN_USER: ${s}`, 400);
  return u.email;
}

function customOf(b, { fromPatch = false } = {}) {
  const has = Object.keys(b || {}).some((k) => k.startsWith('_'));
  if (!has) return undefined;
  // A body's values may not be empty; a JSON Patch's cleared fields come through patchFromApi as null.
  return CF.fromApi(b, { allowNull: fromPatch });
}

function addressIn(b, out) {
  if (!Array.isArray(b.addresses)) return;
  const a = b.addresses[0] || {};
  Object.assign(out, { addressLine1: a.line1 ?? null, addressLine2: a.line2 ?? null, city: a.city ?? null, postcode: a.postcode ?? null,
    region: a.region ?? null, country: a.country ?? null });
}

/** A reference platform Client body as the platform's fields (only the keys given). */
async function clientIn(c, b = {}, { fromPatch = false } = {}) {
  const map = { id: 'memberNo', firstName: 'firstName', middleName: 'middleName', lastName: 'lastName', birthDate: 'dateOfBirth',
    gender: 'gender', preferredLanguage: 'preferredLanguage', emailAddress: 'email', mobilePhone: 'phone', mobilePhone2: 'phone2',
    notes: 'notes', clientRoleKey: 'clientTypeId', assignedBranchKey: 'branchId', assignedCentreKey: 'centreId',
    nationalId: 'nationalId', kraPin: 'kraPin', employer: 'employer', state: 'status' };
  const out = {};
  for (const [k, v] of Object.entries(map)) if (b[k] !== undefined) out[v] = b[k];
  if (b.homePhone !== undefined && b.mobilePhone2 === undefined) out.phone2 = b.homePhone;
  if (b.assignedUserKey !== undefined) out.creditOfficer = await officerEmail(c, b.assignedUserKey);
  addressIn(b, out);
  if (Array.isArray(b.idDocuments)) {
    out.identificationDocuments = b.idDocuments.map((d) => ({ templateId: d.identificationDocumentTemplateKey || null, documentId: d.documentId,
      idType: d.documentType, issuingAuthority: d.issuingAuthority, validUntil: d.validUntil }));
  }
  const cf = customOf(b, { fromPatch });
  if (cf) out.customFields = cf;
  return out;
}

async function groupIn(c, b = {}, { fromPatch = false } = {}) {
  const map = { id: 'memberNo', groupName: 'groupName', groupRoleKey: 'clientTypeId', preferredLanguage: 'preferredLanguage',
    emailAddress: 'email', mobilePhone: 'phone', homePhone: 'phone2', notes: 'notes', assignedBranchKey: 'branchId', assignedCentreKey: 'centreId' };
  const out = {};
  for (const [k, v] of Object.entries(map)) if (b[k] !== undefined) out[v] = b[k];
  if (b.assignedUserKey !== undefined) out.creditOfficer = await officerEmail(c, b.assignedUserKey);
  addressIn(b, out);
  if (Array.isArray(b.groupMembers)) {
    out.groupMembers = b.groupMembers.map((x) => ({ memberId: x.clientKey ?? x.memberId, roles: (x.roles || []).map((r) => r.groupRoleNameKey ?? r) }));
  }
  const cf = customOf(b, { fromPatch });
  if (cf) out.customFields = cf;
  return out;
}

/**
 * Apply a JSON Patch (RFC 6902 as the reference platform takes it: ADD, REPLACE, REMOVE)
 * to a reference platform object. Returns the patched copy. Paths are a top-level
 * field, or a custom field set: /_set, /_set/field, and on a grouped set
 * /_set/0 (an entry), /_set/0/field and /_set/- (a new entry, with ADD). A
 * custom field value may not be null or an empty string; REMOVE clears it.
 */
function applyJsonPatch(obj, ops) {
  if (!Array.isArray(ops)) throw err('A_JSON_PATCH_IS_A_LIST_OF_OPERATIONS', 400);
  const out = JSON.parse(JSON.stringify(obj));
  const noEmpty = (v, path) => {
    const bad = (x) => x === null || x === '';
    const deep = (x) => bad(x) || (Array.isArray(x) ? x.some(deep) : x && typeof x === 'object' ? Object.values(x).some(deep) : false);
    if (deep(v)) throw err(`CUSTOM_FIELD_VALUE_CANNOT_BE_EMPTY: ${path}; remove it with REMOVE`, 400);
  };
  for (const o of ops) {
    const op = String(o?.op || '').toUpperCase();
    if (!['ADD', 'REPLACE', 'REMOVE'].includes(op)) throw err(`UNSUPPORTED_PATCH_OPERATION: ${o?.op}; ADD, REPLACE or REMOVE`, 400);
    const parts = String(o.path || '').replace(/^\//, '').split('/').filter(Boolean).map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~'));
    const bad = () => err(`INVALID_PATCH_PATH: ${o.path}`, 400);
    if (!parts.length || parts.length > 3) throw bad();
    if (parts.length === 1) {
      if (parts[0].startsWith('_') && op !== 'REMOVE') noEmpty(o.value, o.path);
      if (op === 'REMOVE') out[parts[0]] = null; else out[parts[0]] = o.value;
      continue;
    }
    const [sid, second, third] = parts;
    if (!sid.startsWith('_')) throw bad();
    if (op !== 'REMOVE') noEmpty(o.value, o.path);
    const set = out[sid];
    const isIndex = /^(\d+|-)$/.test(second);
    if (!isIndex || (Array.isArray(set) === false && set && typeof set === 'object' && parts.length === 2)) {
      // A standard set's field.
      if (parts.length !== 2) throw bad();
      out[sid] = set && typeof set === 'object' && !Array.isArray(set) ? set : {};
      if (op === 'REMOVE') delete out[sid][second]; else out[sid][second] = o.value;
      continue;
    }
    // A grouped set's entry or an entry's field.
    const list = Array.isArray(set) ? set : [];
    out[sid] = list;
    if (second === '-') {
      if (op !== 'ADD' || parts.length !== 2) throw bad();
      if (!o.value || typeof o.value !== 'object' || Array.isArray(o.value)) throw err(`GROUPED_SET_ENTRY_IS_AN_OBJECT: ${o.path}`, 400);
      list.push(o.value);
      continue;
    }
    const k = Number(second);
    if (parts.length === 2) {
      if (op === 'ADD') { if (k > list.length) throw bad(); list.splice(k, 0, o.value); }
      else if (k >= list.length) throw bad();
      else if (op === 'REMOVE') list.splice(k, 1);
      else list[k] = o.value;
      continue;
    }
    if (k >= list.length) throw bad();
    if (op === 'REMOVE') delete list[k][third]; else list[k][third] = o.value;
  }
  return out;
}

/** The keys whose values differ between two the reference platform objects. */
function changedKeys(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));
}

// The state a JSON Patch asks for, as the action from the current state.
function actionFor(from, to) {
  const pairs = {
    'PENDING_APPROVAL>INACTIVE': 'APPROVE', 'PENDING_APPROVAL>REJECTED': 'REJECT', 'PENDING_APPROVAL>BLACKLISTED': 'BLACKLIST',
    'INACTIVE>PENDING_APPROVAL': 'UNDO_APPROVE', 'INACTIVE>EXITED': 'EXIT', 'INACTIVE>BLACKLISTED': 'BLACKLIST',
    'ACTIVE>BLACKLISTED': 'BLACKLIST', 'REJECTED>PENDING_APPROVAL': 'UNDO_REJECT', 'EXITED>INACTIVE': 'UNDO_EXIT',
  };
  if (from === 'BLACKLISTED') return 'UNDO_BLACKLIST';
  const a = pairs[`${from}>${to}`];
  if (!a) throw err(`INVALID_STATE_CHANGE: ${from} to ${to}`, 409);
  return a;
}

module.exports = {
  COLUMNS, CLIENT_STATES, LANGUAGES, PERSONAL, PERM, ACTIONS,
  find, create, update, changeState, stateHistory, reassign, remove, anonymize, duplicates,
  groupMembers, groupsOf, setGroupMembers, addGroupMember, removeGroupMember,
  clientsOut, groupsOut, clientIn, groupIn, applyJsonPatch, changedKeys, actionFor, docKey, normId,
};
