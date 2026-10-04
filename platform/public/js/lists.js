/**
 * The lists the top menus open that have no page of their own elsewhere:
 * Deposits, Loan Transactions, Deposit Transactions, Activities and Credit
 * Arrangements. Each takes the menu entry's filter (a state or a type),
 * shows it in the title and in a select that can change it, and opens a
 * row's record.
 */

import { $, api, day, esc, money, navFilter } from './base.js';
import { pager, table, view, wirePager, wireRows } from './ui.js';
import { DEPOSIT_TX_TYPES, LOAN_TX_TYPES, TOP } from './menuDef.js';
import { creditArrangementDetail, depositDetail } from './accounts.js';
import { loanDetail } from './loans.js';
import { memberDetail, stateBadge } from './members.js';

const entriesOf = (menu) => TOP.find((m) => m.key === menu).entries;
const title = (menu, label) => `${TOP.find((m) => m.key === menu).label}${label ? `: ${label}` : ''}`;
const labelOf = (menu, field, value) => (value ? entriesOf(menu).find((e) => e.filter?.[field] === value)?.label || value : null);
const options = (menu, field, value) => ['', ...entriesOf(menu).filter((e) => e.filter?.[field]).map((e) => e.filter[field])]
  .map((v) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(labelOf(menu, field, v) || 'All')}</option>`).join('');
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString();

// --------------------------------------------------------------------------
// Deposits
// --------------------------------------------------------------------------

const depState = { offset: 0, limit: 25, state: '' };

export async function depositsView(filter) {
  const f = navFilter(filter);
  if (f) { depState.state = f.state || ''; depState.offset = 0; }
  const r = await api('GET', `/api/deposits?${qs({ offset: depState.offset, limit: depState.limit, paginationDetails: 'ON', accountState: depState.state })}`);
  if (!r.ok) throw new Error(r.error);
  view().innerHTML = `
    <div class="toolbar"><h1>${esc(title('deposits', labelOf('deposits', 'state', depState.state)))}</h1>
      <label>State<select id="dl-state">${options('deposits', 'state', depState.state)}</select></label></div>
    ${table([
    { label: 'Account', key: 'id' }, { label: 'Name', key: 'name' }, { label: 'Holder', key: 'accountHolderId' },
    { label: 'State', html: true, value: (a) => stateBadge(a.accountState) }, { label: 'Type', key: 'accountType' }, { label: 'Product', key: 'productTypeKey' },
    { label: 'Balance', num: true, value: (a) => money(a.balances?.totalBalance) },
  ], r.body, { onRow: true, empty: 'No deposit accounts match' })}
    ${pager(depState, r.total)}`;
  wireRows(r.body, (a) => depositDetail({ id: a.encodedKey }));
  wirePager(depState, depositsView);
  $('#dl-state').addEventListener('change', (e) => { depState.state = e.target.value; depState.offset = 0; depositsView(); });
}

// --------------------------------------------------------------------------
// Loan and deposit transactions
// --------------------------------------------------------------------------

function transactionsPage(menu, side, TYPES) {
  const st = { offset: 0, limit: 25, type: '', from: '', to: '' };
  const self = async (filter) => {
    const f = navFilter(filter);
    if (f) { st.type = f.type || ''; st.offset = 0; }
    const criteria = [];
    if (st.type) criteria.push({ field: 'type', operator: 'IN', values: TYPES[st.type] });
    if (st.from) criteria.push({ field: 'valueDate', operator: 'AFTER_INCLUSIVE', value: st.from });
    if (st.to) criteria.push({ field: 'valueDate', operator: 'BEFORE_INCLUSIVE', value: st.to });
    const r = await api('POST', `/api/${side}/transactions:search?${qs({ offset: st.offset, limit: st.limit, paginationDetails: 'ON' })}`, { filterCriteria: criteria });
    if (!r.ok) throw new Error(r.error);
    view().innerHTML = `
      <div class="toolbar"><h1>${esc(title(menu, labelOf(menu, 'type', st.type)))}</h1>
        <label>Type<select id="tx-type">${options(menu, 'type', st.type)}</select></label>
        <label>From<input id="tx-from" type="date" value="${esc(st.from)}"></label>
        <label>To<input id="tx-to" type="date" value="${esc(st.to)}"></label></div>
      ${table([
    { label: 'Value date', key: 'valueDate' }, { label: 'Reference', key: 'reference' },
    { label: 'Type', value: (t) => t.type.replace(/_/g, ' ').toLowerCase() + (t.reversalOf ? ` of ${t.reversalOf}` : '') },
    { label: 'Account', key: 'accountId' }, { label: 'Member', value: (t) => `${t.memberId} ${t.memberName}` },
    { label: 'Amount', num: true, value: (t) => money(t.amount) }, { label: 'By', key: 'user' },
    { label: '', html: true, value: (t) => (t.reversed ? '<span class="badge bad">reversed</span>' : '') },
  ], r.body, { onRow: true, empty: 'No transactions match' })}
      ${pager(st, r.total)}`;
    wireRows(r.body, (t) => (side === 'loans' ? loanDetail({ account_no: t.accountId }) : depositDetail({ id: t.accountKey })));
    wirePager(st, self);
    $('#tx-type').addEventListener('change', (e) => { st.type = e.target.value; st.offset = 0; self(); });
    $('#tx-from').addEventListener('change', (e) => { st.from = e.target.value; st.offset = 0; self(); });
    $('#tx-to').addEventListener('change', (e) => { st.to = e.target.value; st.offset = 0; self(); });
  };
  return self;
}

export const loanTransactionsView = transactionsPage('loanTransactions', 'loans', LOAN_TX_TYPES);
export const depositTransactionsView = transactionsPage('depositTransactions', 'deposits', DEPOSIT_TX_TYPES);

// --------------------------------------------------------------------------
// Activities
// --------------------------------------------------------------------------

const ENTITIES = [['', 'Any record'], ['memberID', 'Client or group'], ['loanAccountID', 'Loan account'], ['savingsAccountID', 'Deposit account'],
  ['creditArrangementID', 'Credit arrangement']];
const actState = { offset: 0, limit: 25, from: '', to: '', user: '', entity: '', ref: '', branch: '' };

export async function activitiesView() {
  const s = actState;
  const [r, br] = await Promise.all([
    api('GET', `/api/activities?${qs({ offset: s.offset, limit: s.limit, from: s.from, to: s.to, userID: s.user, branchID: s.branch, ...(s.entity && s.ref ? { [s.entity]: s.ref } : {}) })}`),
    api('GET', '/api/branches'),
  ]);
  if (!r.ok) throw new Error(r.error);
  view().innerHTML = `
    <div class="toolbar"><h1>Activities</h1>
      <label>From<input id="act-from" type="date" value="${esc(s.from)}"></label>
      <label>To<input id="act-to" type="date" value="${esc(s.to)}"></label>
      <label>User<input id="act-user" value="${esc(s.user)}" placeholder="email"></label>
      <label>Entity<select id="act-entity">${ENTITIES.map(([v, l]) => `<option value="${v}" ${v === s.entity ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label>Its ID<input id="act-ref" value="${esc(s.ref)}" placeholder="number or ID" ${s.entity ? '' : 'disabled'}></label>
      <label>Branch<select id="act-branch"><option value="">All branches</option>${(br.body || []).map((b) => `<option value="${esc(b.code)}" ${b.code === s.branch ? 'selected' : ''}>${esc(b.code)} ${esc(b.name)}</option>`).join('')}</select></label>
    </div>
    ${table([
    { label: 'When', value: (a) => String(a.timestamp || '').replace('T', ' ').slice(0, 19) },
    { label: 'Activity', value: (a) => String(a.type || '').replace(/_/g, ' ').toLowerCase() },
    { label: 'Record', value: (a) => a.loanAccountId || a.savingsAccountId || a.memberNo || a.entityId || '' },
    { label: 'Branch', key: 'branchId' }, { label: 'By', key: 'userKey' },
  ], r.body, { onRow: true, empty: 'No activity matches' })}
    ${pager(s, r.total)}`;
  wireRows(r.body, (a) => {
    if (a.loanAccountId) return loanDetail({ account_no: a.loanAccountId });
    if (a.savingsAccountKey) return depositDetail({ id: a.savingsAccountKey });
    if (a.creditArrangementKey) return creditArrangementDetail(a.creditArrangementKey);
    const member = a.clientKey || a.groupKey;
    if (member) return memberDetail({ id: member });
    return null;
  });
  wirePager(s, activitiesView);
  const on = (id, key) => $(id).addEventListener('change', (e) => { s[key] = e.target.value.trim(); s.offset = 0; activitiesView(); });
  on('#act-from', 'from'); on('#act-to', 'to'); on('#act-user', 'user'); on('#act-entity', 'entity'); on('#act-ref', 'ref'); on('#act-branch', 'branch');
}

// --------------------------------------------------------------------------
// Credit arrangements
// --------------------------------------------------------------------------

const caState = { offset: 0, limit: 25, state: '' };

export async function creditArrangementsView(filter) {
  const f = navFilter(filter);
  if (f) { caState.state = f.state || ''; caState.offset = 0; }
  const r = await api('GET', `/api/creditarrangements?${qs({ offset: caState.offset, limit: caState.limit, paginationDetails: 'ON', state: caState.state })}`);
  if (!r.ok) throw new Error(r.error);
  view().innerHTML = `
    <div class="toolbar"><h1>${esc(title('creditArrangements', labelOf('creditArrangements', 'state', caState.state)))}</h1>
      <label>State<select id="ca-state">${options('creditArrangements', 'state', caState.state)}</select></label></div>
    ${table([
    { label: 'ID', key: 'id' }, { label: 'Holder', value: (a) => `${a.holderId} ${a.holderName}` },
    { label: 'State', html: true, value: (a) => stateBadge(a.state) },
    { label: 'Amount', num: true, value: (a) => money(a.amount) }, { label: 'Available', num: true, value: (a) => money(a.availableCreditAmount) },
    { label: 'Starts', value: (a) => day(a.startDate) }, { label: 'Expires', value: (a) => day(a.expireDate) },
  ], r.body, { onRow: true, empty: 'No credit arrangements match' })}
    ${pager(caState, r.total)}`;
  wireRows(r.body, (a) => creditArrangementDetail(a.encodedKey));
  wirePager(caState, creditArrangementsView);
  $('#ca-state').addEventListener('change', (e) => { caState.state = e.target.value; caState.offset = 0; creditArrangementsView(); });
}
