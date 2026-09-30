/**
 * Tasks, and a member's tasks.
 */

import { $, S, api, esc, toast, today } from './base.js';
import { ask, card, pager, table, view, wirePager } from './ui.js';
import { memberDetail } from './members.js';
import { can } from './access.js';

// --------------------------------------------------------------------------
// Tasks (the reference platform's Tasks and the Your Tasks widget)
// --------------------------------------------------------------------------

const taskState = { status: 'OPEN', due: '', mine: true, offset: 0, limit: 25 };

export async function newTask(prefill = {}) {
  const [tpl, users] = await Promise.all([api('GET', '/api/tasks/templates'),
    can('VIEW_USER_DETAILS') ? api('GET', '/api/users') : Promise.resolve({ ok: false })]);
  const templates = tpl.ok ? tpl.body : [];
  const emails = users.ok ? users.body.filter((u) => u.status === 'ACTIVE').map((u) => u.email) : [S.user.email];
  if (!emails.includes(S.user.email)) emails.unshift(S.user.email);
  const d = await ask([
    ...(templates.length ? [{ name: 'template', label: 'Template', options: ['', ...templates.map((t) => t.name)], value: '' }] : []),
    { name: 'title', label: 'Title', hint: 'Leave blank to take the template\'s title', required: !templates.length },
    { name: 'description', label: 'Description', type: 'textarea', rows: 3, required: false },
    { name: 'memberId', label: 'Member number', value: prefill.memberNo || '', required: false },
    { name: 'assignedTo', label: 'Assigned to', options: emails, value: S.user.email },
    { name: 'dueDate', label: 'Due', type: 'date', value: today() },
  ], 'New task');
  if (!d) return false;
  const body = { ...d };
  for (const k of ['template', 'title', 'description', 'memberId']) if (!body[k]) delete body[k];
  const r = await api('POST', '/api/tasks', body);
  toast(r.ok ? `Task added: ${r.body.title}` : r.error, !r.ok);
  return r.ok;
}

async function taskAction(t, action) {
  const r = action === 'delete' ? await api('DELETE', `/api/tasks/${t.id}`) : await api('POST', `/api/tasks/${t.id}/${action}`);
  toast(r.ok ? (action === 'complete' ? 'Task completed' : action === 'reopen' ? 'Task reopened' : 'Task deleted') : r.error, !r.ok);
  return r.ok;
}

export const TASK_COLUMNS = (actions) => [
  { label: 'Task', key: 'title' }, { label: 'Member', value: (t) => (t.member ? `${t.member.memberNo} ${t.member.name}` : '') },
  { label: 'Assigned to', key: 'assignedTo' }, { label: 'Due', key: 'dueDate' },
  { label: 'State', html: true, value: (t) => `<span class="badge ${t.state === 'OVERDUE' ? 'bad' : ''}">${esc(t.state)}</span>` },
  { label: '', html: true, value: actions },
];

export function wireTasks(list, reload) {
  view().querySelectorAll('[data-task]').forEach((b) => b.addEventListener('click', async () => {
    const t = list.find((x) => x.id === b.dataset.task);
    if (b.dataset.act === 'delete' && !window.confirm('Delete this task?')) return;
    if (await taskAction(t, b.dataset.act)) reload();
  }));
}

export const taskButtons = (t) => [
  can('EDIT_TASK') && t.status === 'OPEN' ? `<button class="link" data-task="${esc(t.id)}" data-act="complete">complete</button>` : '',
  can('EDIT_TASK') && t.status === 'COMPLETED' ? `<button class="link" data-task="${esc(t.id)}" data-act="reopen">reopen</button>` : '',
  can('DELETE_TASK') ? `<button class="link" data-task="${esc(t.id)}" data-act="delete">delete</button>` : ''].filter(Boolean).join(' ');

export async function tasksView() {
  const T = taskState;
  const qs = new URLSearchParams({ offset: T.offset, limit: T.limit });
  if (T.status) qs.set('status', T.status);
  if (T.due) qs.set('due', T.due);
  if (T.mine) qs.set('assignedTo', S.user.email);
  const [list, tpl] = await Promise.all([api('GET', `/api/tasks?${qs}`), api('GET', '/api/tasks/templates')]);
  if (!list.ok) throw new Error(list.error);
  const total = list.total;
  const templates = tpl.ok ? tpl.body : [];
  view().innerHTML = `<div class="toolbar"><h1>Tasks</h1>${can('CREATE_TASK') ? '<button id="task-new">New task</button>' : ''}</div>
    <div class="toolbar">
      <label>Status<select id="task-status">${['', 'OPEN', 'COMPLETED'].map((s) => `<option value="${s}" ${T.status === s ? 'selected' : ''}>${s || 'Any'}</option>`).join('')}</select></label>
      <label>Due<select id="task-due">${['', 'OVERDUE', 'TODAY', 'UPCOMING'].map((s) => `<option value="${s}" ${T.due === s ? 'selected' : ''}>${s || 'Any time'}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" id="task-mine" ${T.mine ? 'checked' : ''}> Assigned to me</label>
    </div>
    <div id="task-list">${table(TASK_COLUMNS(taskButtons), list.body, { empty: 'No tasks' })}</div>
    ${pager(T, total)}
    ${card('Task templates', `<p class="hint">A template fills a task's title and description. Placeholders such as {MEMBER_NAME} take the linked member's details.</p>
      ${table([{ label: 'Name', key: 'name' }, { label: 'Title', key: 'title' }, { label: 'Content', key: 'content' },
    { label: '', html: true, value: (t) => (can('EDIT_COMMUNICATION_TEMPLATES') ? `<button class="link" data-tpl-edit="${esc(t.id)}">edit</button> <button class="link" data-tpl-del="${esc(t.id)}">delete</button>` : '') }], templates, { empty: 'No templates' })}
      ${can('CREATE_COMMUNICATION_TEMPLATES') ? '<button class="secondary" id="tpl-new">New template</button>' : ''}`)}`;
  wirePager(T, tasksView);
  wireTasks(list.body, tasksView);
  $('#task-status').addEventListener('change', (e) => { T.status = e.target.value; T.offset = 0; tasksView(); });
  $('#task-due').addEventListener('change', (e) => { T.due = e.target.value; T.offset = 0; tasksView(); });
  $('#task-mine').addEventListener('change', (e) => { T.mine = e.target.checked; T.offset = 0; tasksView(); });
  $('#task-new')?.addEventListener('click', async () => { if (await newTask()) tasksView(); });
  const tplForm = async (t = {}) => ask([{ name: 'name', label: 'Name', value: t.name || '' }, { name: 'title', label: 'Task title', value: t.title || '' },
    { name: 'content', label: 'Task description', type: 'textarea', rows: 4, value: t.content || '', required: false }], t.id ? `Edit ${t.name}` : 'New task template');
  $('#tpl-new')?.addEventListener('click', async () => {
    const d = await tplForm();
    if (!d) return;
    const r = await api('POST', '/api/tasks/templates', d);
    toast(r.ok ? 'Template saved' : r.error, !r.ok);
    if (r.ok) tasksView();
  });
  view().querySelectorAll('[data-tpl-edit]').forEach((b) => b.addEventListener('click', async () => {
    const d = await tplForm(templates.find((t) => t.id === b.dataset.tplEdit));
    if (!d) return;
    const r = await api('PATCH', `/api/tasks/templates/${b.dataset.tplEdit}`, d);
    toast(r.ok ? 'Template saved' : r.error, !r.ok);
    if (r.ok) tasksView();
  }));
  view().querySelectorAll('[data-tpl-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!window.confirm('Delete this template?')) return;
    const r = await api('DELETE', `/api/tasks/templates/${b.dataset.tplDel}`);
    toast(r.ok ? 'Template deleted' : r.error, !r.ok);
    if (r.ok) tasksView();
  }));
}

/** The member page's tasks: open tasks linked to the member, and a new one. */
export async function memberTasks(m) {
  if (!can('VIEW_TASK')) return;
  const r = await api('GET', `/api/tasks?memberId=${encodeURIComponent(m.id)}&status=OPEN&limit=20`);
  if (!r.ok) return;
  const box = document.createElement('div');
  box.id = 'member-tasks';
  box.innerHTML = card('Tasks', `${table(TASK_COLUMNS(taskButtons).filter((c) => c.label !== 'Member'), r.body, { empty: 'No open tasks' })}
    ${can('CREATE_TASK') ? '<button class="secondary" id="mt-new">New task</button>' : ''}`);
  view().appendChild(box);
  const again = () => memberDetail(m);
  wireTasks(r.body, again);
  $('#mt-new')?.addEventListener('click', async () => { if (await newTask({ memberNo: m.member_no })) again(); });
}
