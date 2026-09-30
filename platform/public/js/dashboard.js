/**
 * The dashboard and its indicators.
 */

import { $, S, api, esc, money, toast, today } from './base.js';
import { card, table, view } from './ui.js';
import { indicatorCards } from './reports.js';
import { viewState } from './views.js';
import { showDialog } from './users.js';
import { can } from './access.js';
import { TASK_COLUMNS, newTask, taskButtons, wireTasks } from './tasks.js';
import { TILL_COLUMNS, openTill, telleringCard, wireTills } from './tills.js';
import { go } from './nav.js';

// --------------------------------------------------------------------------
// Dashboard (the reference platform's dashboard widgets)
// --------------------------------------------------------------------------

const DASHBOARD_INDICATORS = ['ACTIVE_CLIENTS', 'ACTIVE_BORROWERS', 'GROSS_LOAN_PORTFOLIO', 'DEPOSIT_BALANCE', 'PAR_OVER_30',
  'LOANS_IN_ARREARS', 'LOANS_PENDING_APPROVAL', 'DISBURSED_THIS_MONTH'];

export async function dashboardView() {
  const reader = can('VIEW_INTELLIGENCE');
  const inWeek = new Date(Date.parse(`${today()}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
  const [tasks, tills, myTill] = await Promise.all([
    can('VIEW_TASK') ? api('GET', '/api/tasks/mine') : Promise.resolve(null),
    can('OPEN_TILL') ? api('GET', '/api/tills') : Promise.resolve(null),
    can('VIEW_SAVINGS_ACCOUNT_DETAILS', 'VIEW_LOAN_ACCOUNT_DETAILS') ? api('GET', '/api/tills/mine') : Promise.resolve(null),
  ]);
  const own = myTill && myTill.ok && (myTill.body.till || myTill.body.mustUseTill || S.user.role === 'TELLER') ? myTill.body : null;
  const [ind, act, favs, upcoming, mine] = await Promise.all([
    reader ? api('GET', `/api/reports/indicators?indicators=${DASHBOARD_INDICATORS.join(',')}`) : Promise.resolve(null),
    api('GET', '/api/activities/feed?limit=10'),
    api('GET', '/api/views?favourites=true'),
    api('POST', '/api/views/run?limit=10', {
      entity: 'LOANS', columns: ['accountNo', 'memberName', 'nextDueDate', 'nextDueAmount'], sortBy: 'nextDueDate',
      filters: [{ field: 'nextDueDate', operator: 'BETWEEN', value: today(), secondValue: inWeek }, { field: 'status', operator: 'IN', values: ['ACTIVE', 'IN_ARREARS'] }],
    }),
    api('POST', '/api/views/run?limit=10', {
      entity: 'MEMBERS', columns: ['memberNo', 'fullName', 'runningLoans', 'loanBalance'],
      filters: [{ field: 'creditOfficer', operator: 'EQUALS', value: S.user.email }],
    }),
  ]);
  view().innerHTML = `<h1>Dashboard</h1>
    ${ind && ind.ok ? card('Indicators', indicatorCards(ind.body.indicators)) : ''}
    <div class="grid">
      ${tasks && tasks.ok ? card('Your tasks', `<p id="your-tasks-counts"><span class="badge ${tasks.body.overdue ? 'bad' : ''}">${tasks.body.overdue} overdue</span>
        <span class="badge">${tasks.body.today} due today</span> <span class="badge">${tasks.body.upcoming} upcoming</span></p>
        <div id="your-tasks">${table(TASK_COLUMNS(taskButtons).filter((c) => c.label !== 'Assigned to'), tasks.body.tasks.slice(0, 10), { empty: 'No open tasks' })}</div>
        <div class="toolbar">${can('CREATE_TASK') ? '<button class="secondary" id="dash-task-new">New task</button>' : ''}<button class="link" id="dash-tasks">All tasks</button></div>`) : ''}
      ${telleringCard(own)}
      ${tills && tills.ok ? card('Tellers', `<div id="tellers">${table(TILL_COLUMNS().filter((c) => !['Difference', 'Opening'].includes(c.label)), tills.body, { empty: 'No open tills' })}</div>
        <div class="toolbar"><button class="secondary" id="dash-till-open">Open a till</button><button class="link" id="dash-tills">All tills</button></div>`) : ''}
      ${card('Upcoming repayments (next 7 days)', upcoming.ok ? table([
    { label: 'Loan', key: 'accountNo' }, { label: 'Member', key: 'memberName' }, { label: 'Due', key: 'nextDueDate' },
    { label: 'Amount', num: true, value: (x) => money(x.nextDueAmount) }], upcoming.body.items, { empty: 'Nothing due this week' }) : `<p class="error">${esc(upcoming.error)}</p>`)}
      ${card('Your clients', mine.ok ? table([{ label: 'Member', key: 'memberNo' }, { label: 'Name', key: 'fullName' },
    { label: 'Loans', num: true, key: 'runningLoans' }, { label: 'Owed', num: true, value: (x) => money(x.loanBalance) }], mine.body.items, { empty: 'No members assigned to you' }) : '')}
      ${card('Your favourite views', favs.ok && favs.body.length ? `<ul id="fav-views">${favs.body.map((v) => `<li><button class="link" data-open-view="${esc(v.id)}">${esc(v.name)}</button> <span class="hint">${esc(v.entity.toLowerCase())}</span></li>`).join('')}</ul>`
    : '<p class="hint">Mark a view as a favourite under Views and it appears here.</p>')}
      ${act && act.ok ? card('Latest activity', `<div id="latest-activity">${table([{ label: 'When', value: (x) => String(x.timestamp).replace('T', ' ').slice(0, 16) },
    { label: 'Who', key: 'userKey' }, { label: 'What', value: (x) => x.type.replace(/_/g, ' ').toLowerCase() },
    { label: 'Record', value: (x) => x.loanAccountId || x.savingsAccountId || x.memberNo || x.entityId || '' }, { label: 'Branch', key: 'branchId' }], act.body || [], { empty: 'No activity in your branches yet' })}</div>
        <button class="link" id="dash-activity-types">Choose activity types</button>`) : ''}
    </div>`;
  view().querySelectorAll('[data-open-view]').forEach((b) => b.addEventListener('click', () => {
    viewState.open = b.dataset.openView; viewState.offset = 0; go('views');
  }));
  if (tasks && tasks.ok) wireTasks(tasks.body.tasks, dashboardView);
  wireTills([...(tills?.body && tills.ok ? tills.body : []), ...(own?.till ? [own.till] : [])], dashboardView);
  $('#dash-task-new')?.addEventListener('click', async () => { if (await newTask()) dashboardView(); });
  $('#dash-tasks')?.addEventListener('click', () => go('tasks'));
  $('#dash-till-open')?.addEventListener('click', () => openTill(dashboardView));
  $('#dash-tills')?.addEventListener('click', () => go('tills'));
  $('#dash-activity-types')?.addEventListener('click', chooseActivityTypes);
}

/** The activity types the dashboard's Latest Activity shows (kept with the user's profile). */
async function chooseActivityTypes() {
  const [types, me] = await Promise.all([api('GET', '/api/activities/types'), api('GET', '/api/profile')]);
  if (!types.ok) return toast(types.error, true);
  const chosen = new Set(me.body?.activityTypes || []);
  const dlg = showDialog('Latest activity: types to show', `<p class="hint">None ticked shows every type.</p>
    <div id="activity-types">${types.body.map((t) => `<label class="check"><input type="checkbox" value="${esc(t)}" ${chosen.has(t) ? 'checked' : ''}> ${esc(t.replace(/_/g, ' ').toLowerCase())}</label>`).join('')}</div>
    <div class="toolbar"><button id="activity-types-save">Save</button></div>`);
  $('#activity-types-save', dlg).addEventListener('click', async () => {
    const picked = [...dlg.querySelectorAll('#activity-types input:checked')].map((i) => i.value);
    const r = await api('PATCH', '/api/profile', { activityTypes: picked.length ? picked : null });
    toast(r.ok ? 'Saved' : r.error, !r.ok);
    if (r.ok) { dlg.close(); dlg.remove(); dashboardView(); }
  });
  return null;
}
