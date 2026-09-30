/**
 * Groups and the client setup.
 */

import { $, S, api, esc, toast } from './base.js';
import { ask, card, pager, table, view, wirePager, wireRows } from './ui.js';
import { memberDetail, newHolder, stateBadge } from './members.js';
import { opt } from './products.js';
import { can } from './access.js';

// --------------------------------------------------------------------------
// Groups (the reference platform's groups: account holders with individual members in roles)
// --------------------------------------------------------------------------

const groupState = { offset: 0, limit: 25 };

export async function groupsView() {
  const r = await api('GET', `/api/groups?offset=${groupState.offset}&limit=${groupState.limit}&paginationDetails=ON`);
  if (!r.ok) throw new Error(r.error);
  view().innerHTML = `
    <div class="toolbar"><h1>Groups</h1>${can('CREATE_GROUP') ? '<button id="g-new">New group</button>' : ''}</div>
    <p class="hint">A group holds loans and deposit accounts of its own; its members are individual members, each with any group role names.
    A group is inactive until it has a running account.</p>
    ${table([
    { label: 'ID', key: 'id' }, { label: 'Name', key: 'groupName' }, { label: 'Type', key: 'groupRoleKey' },
    { label: 'State', html: true, value: (g) => stateBadge(g.state) }, { label: 'Members', num: true, value: (g) => g.groupMembers.length },
  ], r.body, { onRow: true, empty: 'No groups yet' })}
    ${pager(groupState, r.total)}`;
  wireRows(r.body, (g) => memberDetail({ id: g.encodedKey }));
  wirePager(groupState, groupsView);
  const nb = $('#g-new');
  if (nb) nb.addEventListener('click', () => newHolder('GROUP', groupsView));
}

/** Organization: client and group types, group role names and the client controls. */
export async function clientsSetup(box) {
  if (!box) return;
  const [types, roles, ctl] = await Promise.all([api('GET', '/api/client-types'), api('GET', '/api/group-role-names'), api('GET', '/api/client-controls')]);
  const setup = can('MANAGE_GENERAL_SETUP');
  const admin = S.user.role === 'TENANT_ADMIN';
  const c = ctl.body || {};
  const yes = (v) => (v ? 'yes' : '');
  box.innerHTML = `
    ${card('Client and group types', `${table([
    { label: 'ID', key: 'id' }, { label: 'Name', key: 'name' }, { label: 'For', value: (t) => (t.holderType === 'GROUP' ? 'groups' : 'members') },
    { label: 'ID pattern', key: 'idPattern' }, { label: 'Opens accounts', value: (t) => yes(t.canOpenAccounts) },
    { label: 'Guarantees', value: (t) => yes(t.canGuarantee) }, { label: 'ID documents', value: (t) => yes(t.requireIdentificationDocuments) },
    { label: 'In use', num: true, key: 'inUse' },
    { label: '', html: true, value: (t) => (setup ? `<button class="link" data-ctype="${esc(t.id)}">edit</button>${t.isDefault || t.inUse ? '' : ` <button class="link" data-ctype-drop="${esc(t.id)}">delete</button>`}` : '') },
  ], types.body || [], { empty: 'No types' })}
    <p class="hint">ID pattern: # a digit (the run of # counts up and widens past its length), @ a letter, $ either.</p>
    ${setup ? '<button class="secondary" id="ctype-add">New type</button>' : ''}`)}
    <div class="grid">
    ${card('Group role names', `${table([{ label: 'ID', key: 'id' }, { label: 'Name', key: 'name' }, { label: 'Held', num: true, key: 'inUse' },
    { label: '', html: true, value: (r) => (setup ? `<button class="link" data-grn="${esc(r.id)}">rename</button>${r.inUse ? '' : ` <button class="link" data-grn-drop="${esc(r.id)}">delete</button>`}` : '') },
  ], roles.body || [], { empty: 'No role names' })}
    ${setup ? '<button class="secondary" id="grn-add">New role name</button>' : ''}`)}
    ${card('Client controls', `<dl class="kv" id="client-controls">
      <dt>New members start</dt><dd>${esc(String(c.initialState || '').replace(/_/g, ' ').toLowerCase())}</dd>
      <dt>Duplicate checks</dt><dd>${esc(Object.entries(c.duplicateChecks || {}).map(([k, v]) => `${k.replace(/_/g, ' ').toLowerCase()}: ${v.toLowerCase()}`).join(', '))}</dd>
      <dt>Required</dt><dd>${esc((c.requiredAssignments || []).map((x) => x.replace(/_/g, ' ').toLowerCase()).join(', ') || 'nothing')}</dd>
      <dt>In more than one group</dt><dd>${c.multipleGroups ? 'allowed' : 'not allowed'}</dd>
      <dt>Group size limit</dt><dd>${c.groupSizeLimitType === 'NONE' ? 'none' : `${esc(c.groupSizeLimit)} (${esc(String(c.groupSizeLimitType).toLowerCase())})`}</dd>
      <dt>Anonymize after exit</dt><dd>${c.anonymizeAfterDays === null || c.anonymizeAfterDays === undefined ? 'not set (anonymizing is off)' : `${esc(c.anonymizeAfterDays)} days`}</dd>
      <dt>New credit arrangements start</dt><dd>${esc(String(c.creditArrangementInitialState || 'PENDING_APPROVAL').replace(/_/g, ' ').toLowerCase())}</dd></dl>
      ${admin ? '<button class="secondary" id="cc-edit">Edit</button>' : ''}`)}
  </div>`;
  const done = (res, msg) => { toast(res.ok ? msg : res.error, !res.ok); if (res.ok) clientsSetup(box); };
  const bool = (v) => v === 'true';
  const typeForm = (t = {}) => ask([
    ...(t.id ? [] : [{ label: 'For', name: 'holderType', options: ['CLIENT', 'GROUP'] }, opt({ label: 'ID (blank: generated)', name: 'id' })]),
    { label: 'Name', name: 'name', value: t.name || '' }, opt({ label: 'Description', name: 'description', value: t.description || '' }),
    opt({ label: 'ID pattern', name: 'idPattern', value: t.idPattern || '', hint: 'e.g. M######; blank: the default' }),
    { label: 'May open accounts', name: 'canOpenAccounts', options: ['true', 'false'], value: String(t.canOpenAccounts ?? true) },
    { label: 'May guarantee', name: 'canGuarantee', options: ['true', 'false'], value: String(t.canGuarantee ?? true) },
    { label: 'Must bring the mandatory ID documents (members)', name: 'requireIdentificationDocuments', options: ['true', 'false'], value: String(t.requireIdentificationDocuments ?? true) },
    { label: 'Show the address fields', name: 'useDefaultAddress', options: ['true', 'false'], value: String(t.useDefaultAddress ?? true) },
  ], t.id ? `Type ${t.id}` : 'New type');
  const typeBody = (d) => ({ ...d, id: d.id || undefined, idPattern: d.idPattern || null, description: d.description || null, canOpenAccounts: bool(d.canOpenAccounts),
    canGuarantee: bool(d.canGuarantee), requireIdentificationDocuments: bool(d.requireIdentificationDocuments), useDefaultAddress: bool(d.useDefaultAddress) });
  const on = (sel, fn) => { const b = $(sel, box); if (b) b.addEventListener('click', fn); };
  const each = (attr, fn) => box.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', () => fn(b.getAttribute(`data-${attr}`))));
  on('#ctype-add', async () => { const d = await typeForm(); if (d) done(await api('POST', '/api/client-types', typeBody(d)), 'Type created'); });
  each('ctype', async (id) => { const d = await typeForm((types.body || []).find((t) => t.id === id)); if (d) done(await api('PATCH', `/api/client-types/${id}`, typeBody(d)), 'Type saved'); });
  each('ctype-drop', async (id) => done(await api('DELETE', `/api/client-types/${id}`), 'Type deleted'));
  on('#grn-add', async () => { const d = await ask([{ label: 'Name', name: 'name' }, opt({ label: 'ID (blank: generated)', name: 'id' })], 'New group role name'); if (d) done(await api('POST', '/api/group-role-names', { name: d.name, id: d.id || undefined }), 'Role name created'); });
  each('grn', async (id) => { const d = await ask([{ label: 'Name', name: 'name', value: (roles.body || []).find((r) => r.id === id)?.name }], `Role name ${id}`); if (d) done(await api('PATCH', `/api/group-role-names/${id}`, d), 'Saved'); });
  each('grn-drop', async (id) => done(await api('DELETE', `/api/group-role-names/${id}`), 'Role name deleted'));
  on('#cc-edit', async () => {
    const lv = ['NONE', 'WARNING', 'ERROR'];
    const dc = c.duplicateChecks || {};
    const d = await ask([
      { label: 'New members start', name: 'initialState', options: ['INACTIVE', 'PENDING_APPROVAL'], value: c.initialState },
      { label: 'Duplicate document number', name: 'DOCUMENT_ID', options: lv, value: dc.DOCUMENT_ID },
      { label: 'Duplicate name and birth date', name: 'NAME_AND_BIRTH_DATE', options: lv, value: dc.NAME_AND_BIRTH_DATE },
      { label: 'Duplicate phone', name: 'PHONE', options: lv, value: dc.PHONE }, { label: 'Duplicate email', name: 'EMAIL', options: lv, value: dc.EMAIL },
      opt({ label: 'Required (comma separated: BRANCH, CENTRE, CREDIT_OFFICER)', name: 'requiredAssignments', value: (c.requiredAssignments || []).join(', ') }),
      { label: 'Members may be in more than one group', name: 'multipleGroups', options: ['true', 'false'], value: String(c.multipleGroups) },
      { label: 'Group size limit', name: 'groupSizeLimitType', options: ['NONE', 'WARNING', 'HARD'], value: c.groupSizeLimitType },
      opt({ label: 'Most members in a group', name: 'groupSizeLimit', type: 'number', value: c.groupSizeLimit ?? '' }),
      opt({ label: 'Days after exit before anonymizing (blank: not set)', name: 'anonymizeAfterDays', type: 'number', value: c.anonymizeAfterDays ?? '' }),
      { label: 'New credit arrangements start', name: 'creditArrangementInitialState', options: ['PENDING_APPROVAL', 'APPROVED'], value: c.creditArrangementInitialState || 'PENDING_APPROVAL' },
    ], 'Client controls');
    if (!d) return;
    done(await api('PATCH', '/api/client-controls', {
      initialState: d.initialState, duplicateChecks: { DOCUMENT_ID: d.DOCUMENT_ID, NAME_AND_BIRTH_DATE: d.NAME_AND_BIRTH_DATE, PHONE: d.PHONE, EMAIL: d.EMAIL },
      requiredAssignments: String(d.requiredAssignments || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
      multipleGroups: bool(d.multipleGroups), groupSizeLimitType: d.groupSizeLimitType,
      groupSizeLimit: d.groupSizeLimit === '' ? null : Number(d.groupSizeLimit),
      anonymizeAfterDays: d.anonymizeAfterDays === '' ? null : Number(d.anonymizeAfterDays),
      creditArrangementInitialState: d.creditArrangementInitialState,
    }), 'Client controls saved');
  });
}
