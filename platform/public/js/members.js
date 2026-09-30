/**
 * Members: the list, the holder forms, a member's page, its activity and its
 * identification files.
 */

import { $, S, api, apiRaw, day, el, esc, money, openFile, toast } from './base.js';
import { ask, card, pager, table, view, wirePager, wireRows } from './ui.js';
import { creditArrangementDetail, depositDetail } from './accounts.js';
import { groupsView } from './groups.js';
import { loanDetail } from './loans.js';
import { opt } from './products.js';
import { customFieldsCard, fileBase64, wireCustomFields } from './organization.js';
import { showDialog } from './users.js';
import { can } from './access.js';
import { memberTasks } from './tasks.js';
import { entityReports } from './templates.js';

// --------------------------------------------------------------------------
// Members
// --------------------------------------------------------------------------

const memberState = { offset: 0, limit: 25, q: '', status: '' };
const MEMBER_STATES = ['PENDING_APPROVAL', 'INACTIVE', 'ACTIVE', 'EXITED', 'BLACKLISTED', 'REJECTED'];
const LANGUAGES = ['ENGLISH', 'SWAHILI', 'FRENCH', 'PORTUGESE', 'SPANISH', 'GERMAN', 'ITALIAN', 'CHINESE', 'RUSSIAN', 'NORWEGIAN'];
export const stateBadge = (s) => `<span class="badge ${['ACTIVE', 'INACTIVE'].includes(s) ? '' : 'bad'}" data-state="${esc(s)}">${esc(String(s).replace(/_/g, ' ').toLowerCase())}</span>`;

export async function membersView() {
  const qs = new URLSearchParams({ offset: memberState.offset, limit: memberState.limit });
  if (memberState.q) qs.set('q', memberState.q);
  if (memberState.status) qs.set('status', memberState.status);
  const r = await api('GET', `/api/members?${qs}`);
  if (!r.ok) throw new Error(r.error);
  const assoc = can('MANAGE_CLIENT_ASSOCIATION');

  view().innerHTML = `
    <div class="toolbar">
      <label>Search<input id="m-q" value="${esc(memberState.q)}" placeholder="name, number, phone, email or national ID"></label>
      <label>State<select id="m-status">
        ${['', ...MEMBER_STATES].map((s) =>
    `<option ${s === memberState.status ? 'selected' : ''} value="${s}">${s ? s.replace(/_/g, ' ').toLowerCase() : 'Any'}</option>`).join('')}
      </select></label>
      ${can('CREATE_CLIENT') ? '<button id="m-new">New member</button>' : ''}
      ${assoc ? '<button class="secondary" id="m-reassign">Reassign selected</button>' : ''}
    </div>
    ${table([
    ...(assoc ? [{ label: '', html: true, value: (m) => `<input type="checkbox" data-pick="${esc(m.id)}" aria-label="select ${esc(m.member_no)}">` }] : []),
    { label: 'No.', key: 'member_no' },
    { label: 'Name', value: (m) => [m.first_name, m.middle_name, m.last_name].filter(Boolean).join(' ') },
    { label: 'Phone', key: 'phone' },
    { label: 'State', html: true, value: (m) => stateBadge(m.status) },
    { label: 'Type', key: 'client_type_id' },
    { label: 'Joined', value: (m) => day(m.joined_on) },
  ], r.body, { onRow: true, empty: 'No members match' })}
    ${pager(memberState, r.total)}`;

  wireRows(r.body, memberDetail);
  view().querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', (e) => e.stopPropagation()));
  wirePager(memberState, membersView);
  $('#m-q').addEventListener('change', (e) => {
    memberState.q = e.target.value; memberState.offset = 0; membersView();
  });
  $('#m-status').addEventListener('change', (e) => {
    memberState.status = e.target.value; memberState.offset = 0; membersView();
  });
  const nb = $('#m-new');
  if (nb) nb.addEventListener('click', () => newHolder('CLIENT', membersView));
  const rb = $('#m-reassign');
  if (rb) rb.addEventListener('click', async () => {
    const ids = [...view().querySelectorAll('[data-pick]:checked')].map((x) => x.dataset.pick);
    if (!ids.length) return toast('Select the members to reassign first', true);
    const d = await associationForm(`Reassign ${ids.length} member(s)`, { bulk: true });
    if (!d) return;
    const res = await api('POST', '/api/members:reassign', { members: ids, ...d });
    toast(res.ok ? `${res.body.reassigned} member(s) reassigned` : res.error, !res.ok);
    if (res.ok) membersView();
  });
}

/** Branch, centre, credit officer and whether the accounts move (the reference platform's Reassign). */
async function associationForm(title, { bulk = false, m = null } = {}) {
  const [br, ce] = await Promise.all([api('GET', '/api/branches'), api('GET', '/api/centres')]);
  const code = (list, id) => (list || []).find((x) => x.id === id)?.code || '';
  const d = await ask([
    opt({ label: 'Branch', name: 'branchId', options: ['', ...(br.body || []).filter((b) => b.status === 'ACTIVE').map((b) => b.code)], value: m ? code(br.body, m.branch_id) : '' }),
    opt({ label: 'Centre', name: 'centreId', options: ['', ...(ce.body || []).filter((x) => x.status === 'ACTIVE').map((x) => x.code)], value: m ? code(ce.body, m.centre_id) : '',
      hint: bulk ? 'Blank keeps each member\'s centre' : 'In the branch chosen' }),
    opt({ label: 'Credit officer (email)', name: 'creditOfficer', value: m?.credit_officer || '', hint: bulk ? 'Blank keeps each member\'s credit officer' : '' }),
    { label: 'Move the accounts too', name: 'moveAccounts', options: ['false', 'true'] },
  ], title);
  if (!d) return null;
  const out = { moveAccounts: d.moveAccounts === 'true' };
  if (d.branchId) out.branchId = d.branchId;
  if (bulk) { if (d.centreId) out.centreId = d.centreId; if (d.creditOfficer) out.creditOfficer = d.creditOfficer; }
  else { out.centreId = d.centreId || null; out.creditOfficer = d.creditOfficer || null; }
  return out;
}

/** The fields of the create and edit forms, as the holder's type shows them. */
function holderFields(type, m = null, holderType = 'CLIENT') {
  const f = [];
  if (holderType === 'GROUP') f.push({ label: 'Group name', name: 'groupName', value: m?.first_name || '' });
  else {
    f.push({ label: 'First name', name: 'firstName', value: m?.first_name || '' }, opt({ label: 'Middle name', name: 'middleName', value: m?.middle_name || '' }),
      { label: 'Last name', name: 'lastName', value: m?.last_name || '' },
      opt({ label: 'Gender', name: 'gender', options: ['', 'FEMALE', 'MALE', 'OTHER'], value: m?.gender || '' }),
      opt({ label: 'Date of birth', name: 'dateOfBirth', type: 'date', value: m?.date_of_birth || '' }),
      opt({ label: 'National ID', name: 'nationalId', value: m?.national_id || '' }), opt({ label: 'KRA PIN', name: 'kraPin', value: m?.kra_pin || '' }),
      opt({ label: 'Employer', name: 'employer', value: m?.employer || '' }));
  }
  f.push(opt({ label: 'Mobile phone', name: 'phone', value: m?.phone || '' }), opt({ label: 'Other phone', name: 'phone2', value: m?.phone2 || '' }),
    opt({ label: 'Email', name: 'email', type: 'email', value: m?.email || '' }),
    opt({ label: 'Preferred language', name: 'preferredLanguage', options: ['', ...LANGUAGES], value: m?.preferred_language || '' }));
  if (!type || type.useDefaultAddress !== false) {
    f.push(opt({ label: 'Address', name: 'addressLine1', value: m?.address_line1 || '' }), opt({ label: 'Address, second line', name: 'addressLine2', value: m?.address_line2 || '' }),
      opt({ label: 'City', name: 'city', value: m?.city || '' }), opt({ label: 'Postcode', name: 'postcode', value: m?.postcode || '' }),
      opt({ label: 'Region', name: 'region', value: m?.region || '' }), opt({ label: 'Country', name: 'country', value: m?.country || '' }));
  }
  f.push(opt({ label: 'Notes', name: 'notes', type: 'textarea', rows: 3, value: m?.notes || '' }));
  return f;
}

/**
 * Create a member or a group (the reference platform's Create): the type first, then its
 * form, with the association, the mandatory ID documents and the required
 * custom fields of that type. A member's duplicate checks are asked before
 * it is saved; warnings are shown and confirmed.
 */
export async function newHolder(holderType, after) {
  const word = holderType === 'GROUP' ? 'group' : 'member';
  const tr = await api('GET', `/api/client-types?holderType=${holderType}`);
  const types = tr.body || [];
  let type = types.find((t) => t.isDefault) || types[0];
  if (types.length > 1) {
    const d = await ask([{ label: holderType === 'GROUP' ? 'Group type' : 'Client type', name: 'type', options: types.map((t) => t.id), value: type?.id,
      hint: types.map((t) => `${t.id}: ${t.name}`).join('; ') }], `New ${word}`);
    if (!d) return;
    type = types.find((t) => t.id === d.type);
  }
  const [br, ce, idt, defs] = await Promise.all([api('GET', '/api/branches'), api('GET', '/api/centres'), api('GET', '/api/id-templates'),
    api('GET', `/api/custom-fields/definitions?entity=${holderType === 'GROUP' ? 'GROUP' : 'MEMBER'}`)]);
  const fields = holderFields(type, null, holderType);
  fields.push(opt({ label: 'Branch', name: 'branchId', options: ['', ...(br.body || []).filter((b) => b.status === 'ACTIVE').map((b) => b.code)], hint: 'Blank: your own branch' }),
    opt({ label: 'Centre', name: 'centreId', options: ['', ...(ce.body || []).filter((x) => x.status === 'ACTIVE').map((x) => x.code)] }),
    opt({ label: 'Credit officer (email)', name: 'creditOfficer' }));
  if (can(holderType === 'GROUP' ? 'EDIT_GROUP_ID' : 'EDIT_CLIENT_ID')) fields.push(opt({ label: 'ID (blank: the next from the type)', name: 'memberNo' }));
  const mandatory = holderType === 'CLIENT' && type?.requireIdentificationDocuments ? (idt.body?.templates || []).filter((t) => t.mandatory) : [];
  for (const t of mandatory) fields.push({ label: `${t.id_type} number`, name: `doc:${t.id}`, hint: `Template ${t.mask}` });
  const required = (defs.body || []).filter((d) => d.is_active && d.set_id && d.set_type !== 'GROUPED'
    && (d.available_for_all ? d.usage?.required : d.usage?.items?.[type?.id]?.required));
  for (const d of required) {
    const f = { label: `${d.set_name || d.set_id}: ${d.name}`, name: `cf:${d.set_id}|${d.id}` };
    if (d.field_type === 'SELECTION') f.options = (d.options || []).map((o) => o.id);
    if (d.field_type === 'DATE') f.type = 'date';
    if (d.field_type === 'NUMBER') { f.type = 'number'; f.step = 'any'; }
    fields.push(f);
  }
  const d = await ask(fields, `New ${type ? type.name.toLowerCase() : word}`);
  if (!d) return;
  const body = { holderType, clientTypeId: type?.id, identificationDocuments: [], customFields: {} };
  for (const [k, v] of Object.entries(d)) {
    if (v === '' || v === undefined) continue;
    if (k.startsWith('doc:')) body.identificationDocuments.push({ templateId: k.slice(4), documentId: v });
    else if (k.startsWith('cf:')) {
      const [sid, fid] = k.slice(3).split('|');
      const def = required.find((x) => x.set_id === sid && x.id === fid);
      body.customFields[sid] = { ...(body.customFields[sid] || {}), [fid]: def?.field_type === 'NUMBER' ? Number(v) : v };
    } else body[k] = v;
  }
  if (holderType === 'CLIENT') {
    const dup = await api('POST', '/api/members:duplicates', body);
    const hard = (dup.body || []).filter((x) => x.level === 'ERROR');
    if (hard.length) return toast(`Duplicate: ${hard.map((x) => `${x.check.replace(/_/g, ' ').toLowerCase()} matches ${x.memberNo} (${x.state.toLowerCase()})`).join('; ')}`, true);
    const soft = (dup.body || []).filter((x) => x.level === 'WARNING');
    if (soft.length && !(await ask([], `Possible duplicate: ${soft.map((x) => `${x.check.replace(/_/g, ' ').toLowerCase()} matches ${x.memberNo}`).join('; ')}. Create anyway?`))) return;
  }
  const res = await api('POST', '/api/members', body);
  toast(res.ok ? `${holderType === 'GROUP' ? 'Group' : 'Member'} ${res.body.member_no} created` : res.error, !res.ok);
  if (res.ok) memberDetail(res.body);
  else if (after) after();
}

/** The state actions a member's state allows and the user may take (the reference platform's life cycle). */
const STATE_ACTIONS = [
  ['APPROVE', 'Approve', ['PENDING_APPROVAL'], 'APPROVE_CLIENT'], ['REJECT', 'Reject', ['PENDING_APPROVAL'], 'REJECT_CLIENT'],
  ['UNDO_APPROVE', 'Undo approve', ['INACTIVE'], 'UNDO_CLIENT_STATE_CHANGED'], ['UNDO_REJECT', 'Undo reject', ['REJECTED'], 'UNDO_CLIENT_STATE_CHANGED'],
  ['EXIT', 'Exit', ['INACTIVE'], 'EXIT_CLIENT'], ['UNDO_EXIT', 'Undo exit', ['EXITED'], 'UNDO_CLIENT_STATE_CHANGED'],
  ['BLACKLIST', 'Blacklist', ['PENDING_APPROVAL', 'INACTIVE', 'ACTIVE'], 'BLACKLIST_CLIENT'],
  ['UNDO_BLACKLIST', 'Undo blacklist', ['BLACKLISTED'], 'UNDO_CLIENT_STATE_CHANGED'],
];

// --------------------------------------------------------------------------
// Activity on a record (GET /api/{kind}/:id/activities), ten at a time
// --------------------------------------------------------------------------

export const activityCard = () => card('Activity', '<div id="activity-list"><p class="hint">Loading…</p></div><button class="link" id="activity-more" hidden>Show more</button>');

const ACTIVITY_COLUMNS = [
  { label: 'When', value: (x) => String(x.timestamp).replace('T', ' ').slice(0, 16) },
  { label: 'What', value: (x) => x.type.replace(/_/g, ' ').toLowerCase() },
  { label: 'By', key: 'userKey' },
  { label: 'Changes', value: (x) => x.fieldChanges.slice(0, 3).map((f) => `${f.fieldChangeName}: ${f.originalValue ?? '—'} → ${f.newValue ?? '—'}`).join('; ') },
  { label: 'Notes', key: 'notes' },
];

export async function loadActivity(kind, id, shown = []) {
  const list = el('activity-list');
  if (!list) return;
  const r = await api('GET', `/api/${kind}/${encodeURIComponent(id)}/activities?limit=10&offset=${shown.length}`);
  if (!el('activity-list')) return;
  if (!r.ok) { list.innerHTML = `<p class="hint">${esc(r.error)}</p>`; return; }
  const all = [...shown, ...r.body];
  list.innerHTML = table(ACTIVITY_COLUMNS, all, { empty: 'No activity yet' });
  const more = el('activity-more');
  more.hidden = all.length >= r.total;
  more.onclick = () => loadActivity(kind, id, all);
}

export async function memberDetail(m0) {
  const fresh = await api('GET', `/api/members/${m0.id}`);
  if (!fresh.ok) throw new Error(fresh.error);
  const m = fresh.body;
  const isGroup = m.holder_type === 'GROUP';
  const P = isGroup ? { edit: 'EDIT_GROUP', assoc: 'MANAGE_GROUP_ASSOCIATION', del: 'DELETE_GROUP' } : { edit: 'EDIT_CLIENT', assoc: 'MANAGE_CLIENT_ASSOCIATION', del: 'DELETE_CLIENTS' };
  const [savings, loans, shares, history, ids, cf, types, br, ce, roleNames] = await Promise.all([
    api('GET', `/api/savings?memberId=${m.id}&limit=50`),
    api('GET', `/api/loans?memberId=${m.id}&limit=50`),
    api('GET', `/api/shares?memberId=${m.id}&limit=50`),
    api('GET', `/api/members/${m.id}/loan-history`),
    isGroup ? Promise.resolve({ ok: true, body: [] }) : api('GET', `/api/members/${m.id}/identifications`),
    api('GET', `/api/custom-fields/values/${isGroup ? 'GROUP' : 'MEMBER'}/${m.id}`),
    api('GET', '/api/client-types'), api('GET', '/api/branches'), api('GET', '/api/centres'),
    isGroup ? api('GET', '/api/group-role-names') : Promise.resolve({ body: [] }),
  ]);
  const [arrangements, solidarity] = await Promise.all([
    can('VIEW_LINE_OF_CREDIT_DETAILS') ? api('GET', `/api/${isGroup ? 'groups' : 'clients'}/${m.id}/creditarrangements`) : Promise.resolve({ ok: false }),
    isGroup ? api('GET', `/api/groups/${m.id}/solidarity-loans`) : Promise.resolve({ ok: false }),
  ]);
  const h = history.body || {};
  const myShares = (shares.body || []).filter((s) => s.member_id === m.id);
  const type = (types.body || []).find((t) => t.id === m.client_type_id);
  const code = (list, id) => (list || []).find((x) => x.id === id)?.code || '—';
  const name = isGroup ? m.first_name : [m.first_name, m.middle_name, m.last_name].filter(Boolean).join(' ');
  const actions = isGroup || m.anonymized_at ? [] : STATE_ACTIONS.filter(([, , from, perm]) => from.includes(m.status) && can(perm));
  const editable = m.status !== 'BLACKLISTED' && !m.anonymized_at;
  const roleName = new Map((roleNames.body || []).map((r) => [r.id, r.name]));

  view().innerHTML = `
    <button class="secondary" id="back">← ${isGroup ? 'Groups' : 'Members'}</button>
    <h1>${esc(name)} <span class="badge">${esc(m.member_no)}</span> ${stateBadge(m.status)}</h1>
    <div class="toolbar" id="member-actions">
      ${editable && can(P.edit) ? '<button class="secondary" id="m-edit">Edit</button>' : ''}
      ${editable && can(P.assoc) ? '<button class="secondary" id="m-assoc">Change association</button>' : ''}
      ${actions.map(([a, label]) => `<button class="secondary" data-state-action="${a}">${esc(label)}</button>`).join('')}
      ${!isGroup ? '<button class="secondary" id="m-history">State history</button>' : ''}
      ${!isGroup && m.status === 'EXITED' && !m.anonymized_at && can('ANONYMIZE_CLIENT') ? '<button class="secondary" id="m-anon">Anonymize</button>' : ''}
      ${can(P.del) ? '<button class="secondary" id="m-delete">Delete</button>' : ''}
    </div>
    <div class="grid">
      ${card('Details', `<dl class="kv" id="member-details">
        <dt>State</dt><dd>${esc(m.status)}${m.state_reason ? ` (${esc(m.state_reason)})` : ''}${m.exit_reason ? ` (${esc(m.exit_reason)})` : ''}</dd>
        <dt>Type</dt><dd>${esc(type ? type.name : m.client_type_id)}</dd>
        ${isGroup ? '' : `<dt>Gender</dt><dd>${esc(m.gender || '—')}</dd><dt>Date of birth</dt><dd>${day(m.date_of_birth) || '—'}</dd>
        <dt>National ID</dt><dd>${esc(m.national_id || '—')}</dd><dt>KRA PIN</dt><dd>${esc(m.kra_pin || '—')}</dd>`}
        <dt>Phone</dt><dd>${esc(m.phone || '—')}${m.phone2 ? `, ${esc(m.phone2)}` : ''}</dd>
        <dt>Email</dt><dd>${esc(m.email || '—')}</dd>
        <dt>Branch</dt><dd>${esc(code(br.body, m.branch_id))}</dd><dt>Centre</dt><dd>${esc(code(ce.body, m.centre_id))}</dd>
        <dt>Credit officer</dt><dd>${esc(m.credit_officer || '—')}</dd>
        <dt>Joined</dt><dd>${day(m.joined_on)}</dd>${m.exited_on ? `<dt>Exited</dt><dd>${day(m.exited_on)}</dd>` : ''}
        ${!isGroup ? `<dt>Groups</dt><dd>${(m.groups || []).map((g) => esc(`${g.group_name} (${g.member_no})`)).join(', ') || '—'}</dd>` : ''}
      </dl>`)}
      ${card('Savings', `${table([
    { label: 'Account', key: 'account_no' },
    { label: 'Product', key: 'product_id' },
    { label: 'State', key: 'status' },
    { label: 'Balance', num: true, value: (a) => money(a.balance) },
    { label: '', html: true, value: (a) => (can('CLOSE_SAVINGS_ACCOUNTS') && ['ACTIVE', 'DORMANT'].includes(a.status) && Number(a.balance) === 0
      ? `<button class="link" data-close-acc="${esc(a.id)}">close</button>` : '') },
  ], savings.body || [], { onRow: 'dep', empty: 'No savings accounts' })}`)}
      ${card('Shares', table([
    { label: 'Account', key: 'account_no' },
    { label: 'Units', num: true, value: (a) => Number(a.units).toLocaleString() },
  ], myShares, { empty: 'No share account' }))}
    </div>
    ${isGroup ? '' : `<div id="member-media">${card('Picture and signature', `<div class="grid">
      <figure><figcaption>Picture</figcaption>${m.media?.picture ? '<img id="media-picture" alt="picture" style="max-width:200px;max-height:200px">' : '<p class="hint">None</p>'}
        ${can('EDIT_CLIENT') && !m.anonymized_at ? `<button class="secondary" data-media-up="picture">Upload</button>${m.media?.picture ? ' <button class="link" data-media-drop="picture">remove</button>' : ''}` : ''}</figure>
      <figure><figcaption>Signature</figcaption>${m.media?.signature ? '<img id="media-signature" alt="signature" style="max-width:300px;max-height:120px">' : '<p class="hint">None</p>'}
        ${can('EDIT_CLIENT') && !m.anonymized_at ? `<button class="secondary" data-media-up="signature">Upload</button>${m.media?.signature ? ' <button class="link" data-media-drop="signature">remove</button>' : ''}` : ''}</figure>
      </div><p class="hint">PNG, JPEG or GIF, up to 50 MB.</p>`)}</div>`}
    ${isGroup ? `<div id="group-members">${card('Group members', `${table([
    { label: 'No.', key: 'member_no' }, { label: 'Name', value: (x) => `${x.first_name} ${x.last_name}` },
    { label: 'Roles', value: (x) => (x.roles || []).map((r) => roleName.get(r) || r).join(', ') },
    { label: 'State', key: 'status' },
    { label: '', html: true, value: (x) => (can('EDIT_GROUP') ? `<button class="link" data-gm-drop="${esc(x.member_id)}">remove</button>` : '') },
  ], m.groupMembers || [], { empty: 'No members yet' })}
      ${can('EDIT_GROUP') ? '<button class="secondary" id="gm-add">Add member</button>' : ''}`)}</div>` : ''}
    ${solidarity.ok ? `<div id="solidarity-loans">${card('Solidarity loans', `${table([
    { label: 'Loan', key: 'id' }, { label: 'Member', value: (x) => `${x.memberName} (${x.memberId})` }, { label: 'State', key: 'accountState' },
    { label: 'Amount', num: true, value: (x) => money(x.loanAmount) }, { label: 'Outstanding', num: true, value: (x) => money(x.principalBalance) },
  ], solidarity.body.loans, { onRow: 'sol', empty: 'No solidarity loans' })}
      <p class="hint">${solidarity.body.totals.running} running of ${solidarity.body.totals.loans}; principal outstanding ${money(solidarity.body.totals.principalBalance)}.</p>
      ${can('CREATE_LOAN_ACCOUNT') && (m.groupMembers || []).length ? '<button class="secondary" id="sol-open">Open solidarity loans</button>' : ''}`)}</div>` : ''}
    ${arrangements.ok ? `<div id="credit-arrangements">${card('Credit arrangements', `${table([
    { label: 'ID', key: 'id' }, { label: 'State', key: 'state' }, { label: 'Amount', num: true, value: (x) => money(x.amount) },
    { label: 'Consumed', num: true, value: (x) => money(x.consumedCreditAmount) }, { label: 'Available', num: true, value: (x) => money(x.availableCreditAmount) },
    { label: 'Expires', value: (x) => day(x.expireDate) },
  ], arrangements.body || [], { onRow: 'ca', empty: 'No credit arrangements' })}
      ${can('CREATE_LINES_OF_CREDIT') ? '<button class="secondary" id="ca-new">New credit arrangement</button>' : ''}`)}</div>` : ''}
    ${card('Loans', table([
    { label: 'Account', key: 'account_no' },
    { label: 'Status', key: 'status' },
    { label: 'Principal', num: true, value: (l) => money(l.principal) },
    { label: 'Outstanding', num: true, value: (l) => money(Number(l.principal_disbursed) + Number(l.principal_capitalized || 0) - l.principal_paid) },
  ], loans.body || [], { onRow: true, empty: 'No loans' }))}
    ${history.ok ? `<div id="loan-history">${card('Loan history', `<dl class="kv">
        <dt>Completed loan cycles</dt><dd id="cycles">${h.completedLoanCycles}</dd>
        <dt>Largest loan approved</dt><dd>${h.maxLoanSize === null ? '—' : money(h.maxLoanSize)}</dd>
        <dt>On-time repayment rate</dt><dd id="on-time">${h.overallOnTimeRate === null ? '—' : `${h.overallOnTimeRate}%`}</dd></dl>
      ${table([
    { label: 'Account', value: (x) => `${x.accountNo}${x.maxLoanSize ? ' (largest)' : ''}` },
    { label: 'Amount', num: true, value: (x) => money(x.amount) },
    { label: 'Closed', value: (x) => day(x.closedOn) },
    { label: 'How', value: (x) => String(x.closedAs).toLowerCase().replace(/_/g, ' ') },
    { label: 'On time', num: true, value: (x) => (x.onTimeRate === null ? '' : `${x.onTimeRate}%`) },
  ], h.closedLoans || [], { empty: 'No closed loans' })}`)}</div>` : ''}
    ${isGroup ? '' : `<div id="identifications">${card('Identification documents', `${table([
    { label: 'Type', key: 'id_type' }, { label: 'Number', key: 'document_id' }, { label: 'Issued by', key: 'issuing_authority' },
    { label: 'Valid until', html: true, value: (x) => `${day(x.valid_until)}${x.expired ? ' <span class="badge bad" data-expired>expired</span>' : x.expiresInDays !== null && x.expiresInDays <= 30 ? ` <span class="badge">in ${x.expiresInDays} days</span>` : ''}` },
    { label: '', html: true, value: (x) => `<button class="link" data-id-files="${esc(x.id)}">files</button> <button class="link" data-id-drop="${esc(x.id)}">remove</button>` },
  ], ids.body || [], { empty: 'No identification documents' })}
      ${m.expiredIdDocuments ? `<p class="notice">${m.expiredIdDocuments} document(s) past their valid-until date.</p>` : ''}
      <button class="secondary" id="id-add">Add document</button>`)}</div>`}
    ${cf.ok ? customFieldsCard(cf.body) : ''}${activityCard()}`;
  loadActivity(isGroup ? 'groups' : 'members', m.id);

  $('#back').addEventListener('click', isGroup ? groupsView : membersView);
  memberTasks(m);
  entityReports('MEMBER', m.member_no);
  wireRows(loans.body || [], loanDetail);
  wireRows(savings.body || [], (a) => depositDetail(a, m), 'dep');
  if (solidarity.ok) wireRows(solidarity.body.loans, (x) => loanDetail({ id: x.encodedKey }), 'sol');
  if (arrangements.ok) wireRows(arrangements.body || [], (x) => creditArrangementDetail(x.encodedKey, m), 'ca');
  view().querySelectorAll('tr[data-tbl="dep"] button').forEach((b) => b.addEventListener('click', (e) => e.stopPropagation()));
  const reload = () => memberDetail(m);
  const on = (sel, fn) => { const b = $(sel); if (b) b.addEventListener('click', fn); };
  if (cf.ok) wireCustomFields(cf.body, isGroup ? 'GROUP' : 'MEMBER', m.id, reload);
  on('#m-edit', async () => {
    const fields = holderFields(type, m, m.holder_type);
    if (can(isGroup ? 'CHANGE_GROUP_TYPE' : 'CHANGE_CLIENT_TYPE')) {
      fields.push({ label: 'Type', name: 'clientTypeId', options: (types.body || []).filter((t) => t.holderType === m.holder_type).map((t) => t.id), value: m.client_type_id });
    }
    if (can(isGroup ? 'EDIT_GROUP_ID' : 'EDIT_CLIENT_ID')) fields.push({ label: 'ID', name: 'memberNo', value: m.member_no });
    const d = await ask(fields, `Edit ${m.member_no}`);
    if (!d) return;
    const cols = { firstName: 'first_name', middleName: 'middle_name', lastName: 'last_name', groupName: 'first_name', gender: 'gender', dateOfBirth: 'date_of_birth',
      nationalId: 'national_id', kraPin: 'kra_pin', employer: 'employer', phone: 'phone', phone2: 'phone2', email: 'email', preferredLanguage: 'preferred_language',
      addressLine1: 'address_line1', addressLine2: 'address_line2', city: 'city', postcode: 'postcode', region: 'region', country: 'country', notes: 'notes',
      clientTypeId: 'client_type_id', memberNo: 'member_no' };
    const patch = {};
    for (const [k, v] of Object.entries(d)) if ((m[cols[k]] ?? '') !== v) patch[k] = v === '' ? null : v;
    if (!Object.keys(patch).length) return toast('Nothing changed');
    const res = await api('PATCH', `/api/members/${m.id}`, patch);
    const warn = res.body?.duplicateWarnings?.length ? ` (possible duplicate of ${res.body.duplicateWarnings.map((x) => x.memberNo).join(', ')})` : '';
    toast(res.ok ? `Saved${warn}` : res.error, !res.ok);
    if (res.ok) reload();
  });
  on('#m-assoc', async () => {
    const d = await associationForm(`Association of ${m.member_no}`, { m });
    if (!d) return;
    const res = await api('POST', `/api/members/${m.id}/association`, d);
    toast(res.ok ? `Reassigned${res.body.accountsMoved.length ? `, ${res.body.accountsMoved.length} account(s) moved` : ''}` : res.error, !res.ok);
    if (res.ok) reload();
  });
  view().querySelectorAll('[data-state-action]').forEach((b) => b.addEventListener('click', async () => {
    const a = b.dataset.stateAction;
    const needsReason = ['REJECT', 'BLACKLIST', 'EXIT'].includes(a);
    const d = await ask(needsReason ? [opt({ label: 'Reason', name: 'reason', type: 'textarea', rows: 3 })] : [], `${b.textContent} ${m.member_no}?`);
    if (!d) return;
    const res = await api('POST', `/api/members/${m.id}/state`, { action: a, reason: d.reason || undefined });
    toast(res.ok ? `Now ${res.body.status.replace(/_/g, ' ').toLowerCase()}` : res.error, !res.ok);
    if (res.ok) reload();
  }));
  on('#m-history', async () => {
    const r = await api('GET', `/api/members/${m.id}/state-history`);
    showDialog(`State history of ${m.member_no}`, table([
      { label: 'When', value: (x) => String(x.changed_at).replace('T', ' ').slice(0, 16) }, { label: 'Action', key: 'action' },
      { label: 'From', key: 'from_state' }, { label: 'To', key: 'to_state' }, { label: 'By', key: 'actor' }, { label: 'Reason', key: 'reason' },
    ], r.body || [], { empty: 'No changes' }));
  });
  on('#m-anon', async () => {
    if (!(await ask([], `Anonymize ${m.member_no}? Personal details, ID documents and portal access are removed for good; the number and the accounts stay.`))) return;
    const res = await api('POST', `/api/members/${m.id}/anonymize`);
    toast(res.ok ? 'Anonymized' : res.error, !res.ok);
    if (res.ok) reload();
  });
  on('#m-delete', async () => {
    if (!(await ask([], `Delete ${m.member_no}? Only a ${isGroup ? 'group' : 'member'} that never had an account can be deleted, and it cannot be undone.`))) return;
    const res = await api('DELETE', `/api/members/${m.id}`);
    toast(res.ok ? `Deleted ${m.member_no}` : res.error, !res.ok);
    if (res.ok) (isGroup ? groupsView : membersView)();
  });
  view().querySelectorAll('[data-close-acc]').forEach((b) => b.addEventListener('click', async () => {
    const res = await api('POST', `/api/savings/${b.dataset.closeAcc}/close`, {});
    toast(res.ok ? 'Account closed' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  on('#ca-new', async () => {
    const d = await ask([{ label: 'Amount', name: 'amount', type: 'number', step: '0.01' },
      opt({ label: 'Start date (blank: today)', name: 'startDate', type: 'date' }), { label: 'Expire date', name: 'expireDate', type: 'date' },
      { label: 'Exposure counted as', name: 'exposureLimitType', options: ['APPROVED_AMOUNT', 'OUTSTANDING_AMOUNT'],
        hint: 'APPROVED_AMOUNT: loan amounts and overdraft limits. OUTSTANDING_AMOUNT: what is owed.' },
      opt({ label: 'Notes', name: 'notes', type: 'textarea', rows: 2 })], `New credit arrangement for ${m.member_no}`);
    if (!d) return;
    const res = await api('POST', '/api/creditarrangements', { holderKey: m.id, holderType: isGroup ? 'GROUP' : 'CLIENT', amount: Number(d.amount),
      startDate: d.startDate || undefined, expireDate: d.expireDate, exposureLimitType: d.exposureLimitType, notes: d.notes || undefined });
    toast(res.ok ? `Created ${res.body.id} (${res.body.state.replace(/_/g, ' ').toLowerCase()})` : res.error, !res.ok);
    if (res.ok) reload();
  });
  on('#sol-open', async () => {
    const lp = await api('GET', '/api/loan-products');
    const products = (lp.body || []).filter((p) => (p.availableFor || []).includes('SOLIDARITY_GROUPS'));
    if (!products.length) return toast('No loan product is available for solidarity groups', true);
    const members = m.groupMembers || [];
    const d = await ask([{ label: 'Product', name: 'productId', options: products.map((p) => p.id) },
      opt({ label: 'Installments (blank: the product default)', name: 'termMonths', type: 'number' }),
      ...members.map((x) => opt({ label: `Amount for ${x.first_name} ${x.last_name} (${x.member_no}); blank: none`, name: `amt_${x.member_id}`, type: 'number', step: '0.01' }))],
    `Solidarity loans for ${m.member_no}`);
    if (!d) return;
    const lines = members.filter((x) => d[`amt_${x.member_id}`]).map((x) => ({ memberId: x.member_id, principal: Number(d[`amt_${x.member_id}`]) }));
    if (!lines.length) return toast('Give at least one member an amount', true);
    const res = await api('POST', `/api/groups/${m.id}/solidarity-loans`, { productId: d.productId, termMonths: d.termMonths ? Number(d.termMonths) : undefined, members: lines });
    toast(res.ok ? `Opened ${lines.length} loan(s)` : res.error, !res.ok);
    if (res.ok) reload();
  });
  on('#gm-add', async () => {
    const d = await ask([{ label: 'Member number', name: 'memberId' },
      opt({ label: 'Role names (IDs, comma separated)', name: 'roles', hint: (roleNames.body || []).map((r) => `${r.id}: ${r.name}`).join('; ') || 'No role names are set up' })], `Add a member to ${m.member_no}`);
    if (!d) return;
    const res = await api('POST', `/api/groups/${m.id}/members`, { memberId: d.memberId, roles: String(d.roles || '').split(',').map((x) => x.trim()).filter(Boolean) });
    toast(res.ok ? `Added${res.body.groupWarnings?.length ? ` (${res.body.groupWarnings.join('; ')})` : ''}` : res.error, !res.ok);
    if (res.ok) reload();
  });
  view().querySelectorAll('[data-gm-drop]').forEach((b) => b.addEventListener('click', async () => {
    const res = await api('DELETE', `/api/groups/${m.id}/members/${b.dataset.gmDrop}`);
    toast(res.ok ? 'Removed from the group' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  view().querySelectorAll('[data-id-files]').forEach((b) => b.addEventListener('click', () => idFiles(m, b.dataset.idFiles, reload)));
  for (const kind of ['picture', 'signature']) {
    const img = $(`#media-${kind}`);
    if (img) blobUrl(`/api/members/${m.id}/${kind}`).then((u) => { if (u) img.src = u; });
  }
  view().querySelectorAll('[data-media-up]').forEach((b) => b.addEventListener('click', async () => {
    const d = await ask([{ label: 'Image (PNG, JPEG or GIF)', name: 'file', type: 'file' }], `Upload ${b.dataset.mediaUp}`);
    if (!d || !d.file || !d.file.size) return;
    const res = await apiRaw('PUT', `/api/members/${m.id}/${b.dataset.mediaUp}?fileName=${encodeURIComponent(d.file.name)}`, d.file, d.file.type);
    toast(res.ok ? 'Uploaded' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  view().querySelectorAll('[data-media-drop]').forEach((b) => b.addEventListener('click', async () => {
    const res = await api('DELETE', `/api/members/${m.id}/${b.dataset.mediaDrop}`);
    toast(res.ok ? 'Removed' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  view().querySelectorAll('[data-id-drop]').forEach((b) => b.addEventListener('click', async () => {
    const res = await api('DELETE', `/api/members/${m.id}/identifications/${b.dataset.idDrop}`);
    toast(res.ok ? 'Document removed' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  on('#id-add', async () => {
    const t = await api('GET', '/api/id-templates');
    const opts = (t.body?.templates || []).map((x) => x.id);
    if (t.body?.allowOther) opts.push('OTHER');
    if (!opts.length) return toast('No ID templates are set up', true);
    const d = await ask([
      { label: 'Template', name: 'templateId', options: opts, hint: (t.body?.templates || []).map((x) => `${x.id}: ${x.id_type} ${x.mask}`).join('; ') },
      { label: 'Document number', name: 'documentId' }, opt({ label: 'Valid until', name: 'validUntil', type: 'date' }),
      opt({ label: 'ID type (Other documents)', name: 'idType' }), opt({ label: 'Issuing authority (Other documents)', name: 'issuingAuthority' }),
      opt({ label: 'Attachment (where the template allows it)', name: 'file', type: 'file' }),
    ], 'Add identification document');
    if (!d) return;
    const body = { templateId: d.templateId, documentId: d.documentId, validUntil: d.validUntil || undefined, idType: d.idType || undefined, issuingAuthority: d.issuingAuthority || undefined };
    if (d.file && d.file.size) body.attachment = { name: d.file.name, type: d.file.type, data: await fileBase64(d.file) };
    const res = await api('POST', `/api/members/${m.id}/identifications`, body);
    toast(res.ok ? 'Document added' : res.error, !res.ok);
    if (res.ok) reload();
  });
}

/** A file fetched with the session's headers, as an object URL (for an <img>), or null. */
async function blobUrl(path) {
  const headers = {};
  if (S.tenant) headers['x-tenant'] = S.tenant;
  if (S.access) headers.authorization = `Bearer ${S.access}`;
  const res = await fetch(path, { headers });
  return res.ok ? URL.createObjectURL(await res.blob()) : null;
}

/** The files on an identification document: up to five, each up to 50 MB. */
async function idFiles(m, docId, reload) {
  const r = await api('GET', `/api/members/${m.id}/identifications/${docId}/files`);
  if (!r.ok) return toast(r.error, true);
  const dlg = showDialog('Document files', `${table([
    { label: 'File', key: 'fileName' }, { label: 'Type', key: 'contentType' }, { label: 'Size', num: true, value: (f) => `${Math.ceil(f.sizeBytes / 1024)} KB` },
    { label: '', html: true, value: (f) => `<button class="link" data-f-get="${esc(f.id)}">download</button>${can('DELETE_DOCUMENTS') ? ` <button class="link" data-f-drop="${esc(f.id)}">remove</button>` : ''}` },
  ], r.body, { empty: 'No files' })}
    ${can('CREATE_DOCUMENTS') && r.body.length < 5 ? '<button class="secondary" id="f-add">Add file</button>' : ''}<p class="hint">PNG, JPEG or PDF, up to 50 MB each, five at most.</p>`);
  dlg.querySelectorAll('[data-f-get]').forEach((b) => b.addEventListener('click', () =>
    openFile(`/api/members/${m.id}/identifications/${docId}/files/${b.dataset.fGet}`, 'document', { save: true })));
  dlg.querySelectorAll('[data-f-drop]').forEach((b) => b.addEventListener('click', async () => {
    const res = await api('DELETE', `/api/members/${m.id}/identifications/${docId}/files/${b.dataset.fDrop}`);
    toast(res.ok ? 'File removed' : res.error, !res.ok);
    dlg.close(); dlg.remove();
    if (res.ok) idFiles(m, docId, reload);
  }));
  const add = $('#f-add', dlg);
  if (add) add.addEventListener('click', async () => {
    dlg.close(); dlg.remove();
    const d = await ask([{ label: 'File (PNG, JPEG or PDF)', name: 'file', type: 'file' }], 'Add a file to the document');
    if (!d || !d.file || !d.file.size) return;
    const res = await apiRaw('POST', `/api/members/${m.id}/identifications/${docId}/files?fileName=${encodeURIComponent(d.file.name)}`, d.file, d.file.type || 'application/octet-stream');
    toast(res.ok ? 'File added' : res.error, !res.ok);
    idFiles(m, docId, reload);
  });
}
