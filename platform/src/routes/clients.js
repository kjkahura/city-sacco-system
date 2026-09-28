'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { orgToday } = require('../lib/orgDate');
const { pageParams } = require('../lib/page');
const SEARCH = require('../lib/searchCriteria');
const CL = require('../domain/clients');
const SETUP = require('../domain/clientSetup');

/**
 * The reference platform's API v2 for clients and groups: /clients, /groups, their
 * :search, and the setup behind them (/client-types, /group-role-names,
 * /client-controls). The rules are in ../domain/clients and
 * ../domain/clientSetup; this file only translates the reference platform's shapes.
 *
 * PATCH takes the reference platform's JSON Patch (a list of { op, path, value }), or a plain
 * object of the fields to change. A patch of /state is the state action
 * that leads there from the current state. PUT takes the whole object and
 * clears the personal fields it leaves out. Lists take offset, limit and
 * paginationDetails=ON (the items-* headers).
 */

const run = (fn, { write = false, status = 200 } = {}) => [requireAuth(), async (req, res, next) => {
  try {
    const out = await (write ? withTenant : withTenantRead)(req.tenant.schema_name, (c) => fn(c, req, res));
    if (out !== undefined) res.status(status).json(out);
  } catch (e) { next(e); }
}];

const CLIENT_FIELDS = {
  encodedKey: { sql: 'm.id::text', type: 'text' }, id: { sql: 'm.member_no', type: 'text' },
  firstName: { sql: 'm.first_name', type: 'text' }, middleName: { sql: 'm.middle_name', type: 'text' }, lastName: { sql: 'm.last_name', type: 'text' },
  fullName: { sql: "(m.first_name || ' ' || m.last_name)", type: 'text' },
  clientState: { sql: 'm.status', type: 'text' }, state: { sql: 'm.status', type: 'text' },
  clientRoleKey: { sql: 'm.client_type_id', type: 'text' }, branchKey: { sql: 'm.branch_id::text', type: 'text' },
  centreKey: { sql: 'm.centre_id::text', type: 'text' },
  creditOfficerKey: { sql: `(SELECT u.id::text FROM platform.users u JOIN platform.tenants t ON t.id = u.tenant_id
                             WHERE t.schema_name = current_schema() AND lower(u.email) = lower(m.credit_officer))`, type: 'text' },
  groupKey: { sql: '(SELECT string_agg(gm.group_id::text, \',\') FROM group_members gm WHERE gm.member_id = m.id)', type: 'text' },
  groupId: { sql: '(SELECT string_agg(g.member_no, \',\') FROM group_members gm JOIN members g ON g.id = gm.group_id WHERE gm.member_id = m.id)', type: 'text' },
  emailAddress: { sql: 'm.email', type: 'text' }, mobilePhoneNumber: { sql: 'm.phone', type: 'text' },
  mobilePhoneNumber2: { sql: 'm.phone2', type: 'text' }, homePhoneNumber: { sql: 'm.phone2', type: 'text' },
  birthdate: { sql: 'm.date_of_birth', type: 'date' }, birthDate: { sql: 'm.date_of_birth', type: 'date' },
  gender: { sql: 'm.gender', type: 'text' }, preferredLanguage: { sql: 'm.preferred_language', type: 'text' },
  creationDate: { sql: 'm.created_at', type: 'timestamp' }, lastModifiedDate: { sql: 'm.updated_at', type: 'timestamp' },
  approvedDate: { sql: 'm.approved_at', type: 'timestamp' }, activationDate: { sql: 'm.activated_at', type: 'timestamp' },
  closedDate: { sql: 'm.exited_on', type: 'date' }, nationalId: { sql: 'm.national_id', type: 'text' },
  loanCycle: { sql: "((SELECT count(*) FROM loan_accounts l WHERE l.member_id = m.id AND l.status = 'CLOSED_REPAID') + m.prior_loan_cycles)", type: 'number' },
  loansBalance: { sql: "(SELECT COALESCE(sum(l.principal_disbursed - l.principal_paid), 0) FROM loan_accounts l WHERE l.member_id = m.id AND l.status NOT LIKE 'CLOSED%')", type: 'number' },
  depositsBalance: { sql: "(SELECT COALESCE(sum(a.balance), 0) FROM savings_accounts a WHERE a.member_id = m.id AND a.status <> 'CLOSED')", type: 'number' },
};
const GROUP_FIELDS = {
  encodedKey: CLIENT_FIELDS.encodedKey, id: CLIENT_FIELDS.id, groupName: { sql: 'm.first_name', type: 'text' },
  groupRoleKey: { sql: 'm.client_type_id', type: 'text' }, branchKey: CLIENT_FIELDS.branchKey, centreKey: CLIENT_FIELDS.centreKey,
  creditOfficerKey: CLIENT_FIELDS.creditOfficerKey, creationDate: CLIENT_FIELDS.creationDate, lastModifiedDate: CLIENT_FIELDS.lastModifiedDate,
  preferredLanguage: CLIENT_FIELDS.preferredLanguage, state: CLIENT_FIELDS.state, emailAddress: CLIENT_FIELDS.emailAddress,
  numberOfMembers: { sql: '(SELECT count(*) FROM group_members gm WHERE gm.group_id = m.id)', type: 'number' },
  loanCycle: CLIENT_FIELDS.loanCycle, loansBalance: CLIENT_FIELDS.loansBalance, depositsBalance: CLIENT_FIELDS.depositsBalance,
};

function paged(res, req, rows, total) {
  const { offset, limit } = pageParams(req.query);
  if (String(req.query.paginationDetails || '').toUpperCase() === 'ON') {
    res.set('items-offset', String(offset)); res.set('items-limit', String(limit)); res.set('items-total', String(total));
  }
  return rows;
}

async function list(c, req, res, holderType, body = {}) {
  const { offset, limit } = pageParams(req.method === 'POST' ? { ...req.query, ...body } : req.query);
  const fields = holderType === 'GROUP' ? GROUP_FIELDS : CLIENT_FIELDS;
  const criteria = { filterCriteria: body.filterCriteria || [], sortingCriteria: body.sortingCriteria };
  // GET lists take the simple the reference platform filters as query parameters.
  if (req.method === 'GET') {
    const q = req.query;
    const add = (field, value) => value !== undefined && criteria.filterCriteria.push({ field, operator: 'EQUALS', value });
    add(holderType === 'GROUP' ? 'state' : 'clientState', q.state);
    add('branchKey', q.branchId); add('centreKey', q.centreId); add('creditOfficerKey', q.creditOfficerKey);
    if (q.firstName) criteria.filterCriteria.push({ field: 'firstName', operator: 'STARTS_WITH', value: q.firstName });
    if (q.lastName) criteria.filterCriteria.push({ field: 'lastName', operator: 'STARTS_WITH', value: q.lastName });
    if (q.sortBy) {
      const [field, order] = String(q.sortBy).split(':');
      criteria.sortingCriteria = { field, order };
    }
  }
  const s = SEARCH.build(criteria, fields, { params: [holderType], today: await orgToday(c) });
  const { rows } = await c.query(
    `SELECT m.*, count(*) OVER () AS total_count FROM members m WHERE m.holder_type = $1 AND (${s.where})
     ORDER BY ${s.order ? `${s.order}, ` : ''}m.last_name, m.first_name, m.id LIMIT ${limit} OFFSET ${offset}`, s.params);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  const shaped = holderType === 'GROUP' ? await CL.groupsOut(c, rows, { user: req.auth }) : await CL.clientsOut(c, rows, { user: req.auth });
  return paged(res, req, shaped, total);
}

const one = async (c, req, ref, holderType) => {
  const m = await CL.find(c, ref, { holderType });
  const [o] = holderType === 'GROUP' ? await CL.groupsOut(c, [m], { user: req.auth }) : await CL.clientsOut(c, [m], { user: req.auth });
  return o;
};

/** PATCH: a JSON Patch on the reference platform object, or a plain object of fields. */
async function patch(c, req, holderType) {
  const ref = req.params.id;
  const user = req.auth;
  const current = await one(c, req, ref, holderType);
  let changes;
  if (Array.isArray(req.body)) {
    const next = CL.applyJsonPatch(current, req.body);
    const keys = CL.changedKeys(current, next).filter((k) => !['encodedKey', 'lastModifiedDate', 'creationDate'].includes(k));
    if (keys.includes('state')) {
      await CL.changeState(c, current.encodedKey, CL.actionFor(current.state, next.state), { reason: next.stateReason ?? null, user });
      keys.splice(keys.indexOf('state'), 1);
    }
    changes = Object.fromEntries(keys.map((k) => [k, next[k]]));
    // A custom field set replaced by a patch is sent whole.
  } else changes = req.body || {};
  const b = holderType === 'GROUP' ? await CL.groupIn(c, changes) : await CL.clientIn(c, changes);
  delete b.status;
  if (Object.keys(b).length) await CL.update(c, current.encodedKey, b, { user, holderType });
  return one(c, req, current.encodedKey, holderType);
}

async function put(c, req, holderType) {
  const current = await CL.find(c, req.params.id, { holderType });
  const b = holderType === 'GROUP' ? await CL.groupIn(c, req.body || {}) : await CL.clientIn(c, req.body || {});
  delete b.status;
  const clear = CL.PERSONAL.filter((k) => b[k] === undefined && !(holderType === 'GROUP' && ['middleName', 'kraPin', 'employer', 'nationalId', 'dateOfBirth', 'gender'].includes(k)));
  if (b.memberNo === current.member_no) delete b.memberNo;
  if (b.clientTypeId === current.client_type_id) delete b.clientTypeId;
  for (const [k, col] of [['branchId', 'branch_id'], ['centreId', 'centre_id'], ['creditOfficer', 'credit_officer']]) {
    if (b[k] !== undefined && (b[k] || null) === (current[col] || null)) delete b[k];
  }
  await CL.update(c, current.id, b, { user: req.auth, holderType, clear });
  return one(c, req, current.id, holderType);
}

function holderRouter(holderType) {
  const r = express.Router();
  r.get('/', ...run((c, req, res) => list(c, req, res, holderType)));
  r.post('/', ...run(async (c, req) => {
    const b = holderType === 'GROUP' ? await CL.groupIn(c, req.body || {}) : await CL.clientIn(c, req.body || {});
    delete b.status;
    const out = await CL.create(c, b, { user: req.auth, holderType });
    const o = await one(c, req, out.member.id, holderType);
    if (out.duplicateWarnings.length) o.duplicateWarnings = out.duplicateWarnings;
    if (out.groupWarnings.length) o.groupWarnings = out.groupWarnings;
    return o;
  }, { write: true, status: 201 }));
  r.get('/:id', ...run((c, req) => one(c, req, req.params.id, holderType)));
  r.put('/:id', ...run((c, req) => put(c, req, holderType), { write: true }));
  r.patch('/:id', ...run((c, req) => patch(c, req, holderType), { write: true }));
  r.delete('/:id', ...run(async (c, req, res) => {
    await CL.remove(c, req.params.id, { user: req.auth, holderType });
    res.status(204).end();
  }, { write: true }));
  r.get('/:id/creditarrangements', ...run(async (c, req) => { await CL.find(c, req.params.id, { holderType }); return []; }));
  if (holderType === 'CLIENT') {
    r.get('/:id/role', ...run(async (c, req) => {
      const m = await CL.find(c, req.params.id, { holderType });
      return SETUP.typeOut(await SETUP.typeRow(c, m.client_type_id));
    }));
  } else {
    r.get('/:id/members', ...run(async (c, req) => (await one(c, req, req.params.id, 'GROUP')).groupMembers));
    r.post('/:id/members', ...run(async (c, req) => {
      const b = req.body || {};
      const out = await CL.addGroupMember(c, req.params.id, { memberId: b.clientKey ?? b.memberId, roles: (b.roles || []).map((x) => x.groupRoleNameKey ?? x) }, { user: req.auth });
      return { ...(await one(c, req, req.params.id, 'GROUP')), groupWarnings: out.warnings };
    }, { write: true, status: 201 }));
    r.delete('/:id/members/:memberId', ...run(async (c, req) => {
      await CL.removeGroupMember(c, req.params.id, req.params.memberId, { user: req.auth });
      return one(c, req, req.params.id, 'GROUP');
    }, { write: true }));
  }
  return r;
}

const search = (holderType) => run((c, req, res) => list(c, req, res, holderType, req.body || {}));

// Setup ----------------------------------------------------------------------

const types = express.Router();
types.get('/', ...run((c, req) => SETUP.types(c, { holderType: req.query.holderType ? String(req.query.holderType).toUpperCase() : null })));
types.get('/:id', ...run(async (c, req) => SETUP.typeOut(await SETUP.typeRow(c, req.params.id))));
types.post('/', ...run((c, req) => SETUP.createType(c, req.body || {}, { actor: req.auth.email }), { write: true, status: 201 }));
types.patch('/:id', ...run((c, req) => SETUP.updateType(c, req.params.id, req.body || {}, { actor: req.auth.email }), { write: true }));
types.delete('/:id', ...run((c, req) => SETUP.deleteType(c, req.params.id, { actor: req.auth.email }), { write: true }));

const roleNames = express.Router();
roleNames.get('/', ...run((c) => SETUP.roleNames(c)));
roleNames.post('/', ...run((c, req) => SETUP.createRoleName(c, req.body || {}, { actor: req.auth.email }), { write: true, status: 201 }));
roleNames.patch('/:id', ...run((c, req) => SETUP.updateRoleName(c, req.params.id, req.body || {}, { actor: req.auth.email }), { write: true }));
roleNames.delete('/:id', ...run((c, req) => SETUP.deleteRoleName(c, req.params.id, { actor: req.auth.email }), { write: true }));

const controls = express.Router();
controls.get('/', ...run((c) => SETUP.controls(c)));
controls.patch('/', ...run((c, req) => SETUP.updateControls(c, req.body || {}, { actor: req.auth.email }), { write: true }));

module.exports = {
  clients: holderRouter('CLIENT'), groups: holderRouter('GROUP'), searchClients: search('CLIENT'), searchGroups: search('GROUP'),
  types, roleNames, controls,
};
