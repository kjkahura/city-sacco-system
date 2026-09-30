'use strict';

const { orgToday } = require('../lib/orgDate');
const { pageQuery } = require('../lib/page');
const PERMS = require('../lib/permissions');
const { err } = require('../lib/errors');

/**
 * Tasks (the reference platform's Tasks): a to-do with a title, notes and a due date,
 * assigned to a user and optionally linked to a member. The body takes
 * The reference platform's API v2 names (title, description, dueDate, assignedUserKey,
 * taskLinkType CLIENT with taskLinkKey) and the platform's (memberId,
 * assignedTo). A task is OPEN or COMPLETED; an open task past its due date
 * is overdue. Task templates fill in a title and notes from placeholders
 * for a member.
 *
 * Who sees what: a user sees the tasks assigned to them or created by them;
 * a user who may edit tasks (EDIT_TASK) and works in a branch sees that
 * branch's too; an administrator sees all.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const PLACEHOLDERS = {
  '{MEMBER_NAME}': (m) => [m.first_name, m.last_name].filter(Boolean).join(' '),
  '{MEMBER_FIRST_NAME}': (m) => m.first_name || '',
  '{MEMBER_NO}': (m) => m.member_no || '',
  '{MEMBER_PHONE}': (m) => m.phone || '',
  '{MEMBER_EMAIL}': (m) => m.email || '',
  '{BRANCH_NAME}': (m) => m.branch_name || '',
  '{CREDIT_OFFICER}': (m) => m.credit_officer || '',
};

const fill = (text, m) => (text ? Object.entries(PLACEHOLDERS).reduce((s, [k, f]) => s.split(k).join(m ? f(m) : ''), String(text)) : text);

async function memberOf(c, key) {
  if (!key) return null;
  const { rows: [m] } = await c.query(
    `SELECT m.*, b.name AS branch_name FROM members m LEFT JOIN branches b ON b.id = m.branch_id
     WHERE m.id::text = $1 OR m.member_no = $1`, [String(key)]);
  if (!m) throw err(`MEMBER_NOT_FOUND: ${key}`, 404);
  return m;
}

async function userOf(c, key) {
  if (!key) return null;
  const { rows: [u] } = await c.query(
    `SELECT id, email, full_name, status, branch_id FROM platform.users
     WHERE tenant_id = (SELECT id FROM platform.tenants WHERE schema_name = current_schema())
       AND (id::text = $1 OR lower(email) = lower($1))`, [String(key)]);
  if (!u) throw err(`USER_NOT_FOUND: ${key}`, 404);
  if (u.status !== 'ACTIVE') throw err('THE_ASSIGNEE_IS_NOT_ACTIVE', 409);
  return u;
}

function shape(t, today) {
  const overdue = t.status === 'OPEN' && t.due_date && t.due_date < today;
  return {
    id: t.id, encodedKey: t.id, title: t.title, description: t.description,
    status: t.status, state: overdue ? 'OVERDUE' : t.status,
    dueDate: t.due_date, assignedTo: t.assigned_email, assignedUserKey: t.assigned_to,
    member: t.member_id ? { id: t.member_id, memberNo: t.member_no, name: [t.first_name, t.last_name].filter(Boolean).join(' ') } : null,
    taskLinkType: t.member_id ? 'CLIENT' : null, taskLinkKey: t.member_id,
    branchId: t.branch_id, templateId: t.template_id,
    completedAt: t.completed_at, completedBy: t.completed_by, createdBy: t.created_by, createdAt: t.created_at, updatedAt: t.updated_at,
  };
}

const SELECT = `SELECT t.*, m.member_no, m.first_name, m.last_name FROM tasks t LEFT JOIN members m ON m.id = t.member_id`;

/** SQL for the tasks a user may see ($1 email, $2 branch or NULL, $3 all). */
const VISIBLE = `($3::boolean OR lower(t.assigned_email) = lower($1) OR lower(t.created_by) = lower($1)
  OR ($2::uuid IS NOT NULL AND t.branch_id = $2::uuid))`;
function scope(user) {
  const all = user.role === 'TENANT_ADMIN';
  const branch = PERMS.can(user, 'EDIT_TASK') && user.branchId ? user.branchId : null;
  return [user.email, branch, all];
}

/**
 * Tasks for a user. Filters: assignedTo (an email, or "me"), status (OPEN,
 * COMPLETED), due (OVERDUE, TODAY, UPCOMING), memberId.
 */
async function list(c, user, { assignedTo = null, status = null, due = null, memberId = null, offset = 0, limit = 50 } = {}) {
  const today = await orgToday(c);
  const who = assignedTo === 'me' ? user.email : assignedTo;
  const member = memberId ? await memberOf(c, memberId) : null;
  const d = due ? String(due).toUpperCase() : null;
  if (d && !['OVERDUE', 'TODAY', 'UPCOMING'].includes(d)) throw err('DUE_MUST_BE_OVERDUE_TODAY_OR_UPCOMING');
  const st = status ? String(status).toUpperCase() : null;
  if (st && !['OPEN', 'COMPLETED'].includes(st)) throw err('STATUS_MUST_BE_OPEN_OR_COMPLETED');
  const page = await pageQuery(c,
    `${SELECT} WHERE ${VISIBLE}
       AND ($4::text IS NULL OR lower(t.assigned_email) = lower($4))
       AND ($5::text IS NULL OR t.status = $5)
       AND ($6::uuid IS NULL OR t.member_id = $6::uuid)
       AND ($7::text IS NULL
         OR ($7 = 'OVERDUE' AND t.status = 'OPEN' AND t.due_date < current_date)
         OR ($7 = 'TODAY' AND t.status = 'OPEN' AND t.due_date = current_date)
         OR ($7 = 'UPCOMING' AND t.status = 'OPEN' AND (t.due_date > current_date OR t.due_date IS NULL)))
     ORDER BY (t.status = 'OPEN') DESC, t.due_date NULLS LAST, t.created_at`,
    [...scope(user), who, st, member ? member.id : null, d], { offset, limit });
  return { ...page, items: page.items.map((t) => shape(t, today)) };
}

/** The Your Tasks widget: counts of a user's open tasks, and the tasks. */
async function mine(c, user) {
  const today = await orgToday(c);
  const { rows } = await c.query(`${SELECT} WHERE lower(t.assigned_email) = lower($1) AND t.status = 'OPEN' ORDER BY t.due_date NULLS LAST, t.created_at LIMIT 200`, [user.email]);
  const tasks = rows.map((t) => shape(t, today));
  return {
    date: today,
    overdue: tasks.filter((t) => t.dueDate && t.dueDate < today).length,
    today: tasks.filter((t) => t.dueDate === today).length,
    upcoming: tasks.filter((t) => !t.dueDate || t.dueDate > today).length,
    tasks,
  };
}

async function find(c, id, user) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw err('TASK_NOT_FOUND', 404);
  const { rows: [t] } = await c.query(`${SELECT} WHERE t.id = $4::uuid AND ${VISIBLE}`, [...scope(user), id]);
  if (!t) throw err('TASK_NOT_FOUND', 404);
  return t;
}

async function get(c, id, user) {
  return shape(await find(c, id, user), await orgToday(c));
}

async function templateOf(c, id) {
  if (!id) return null;
  const { rows: [t] } = await c.query('SELECT * FROM task_templates WHERE id::text = $1 OR lower(name) = lower($1)', [String(id)]);
  if (!t) throw err(`TASK_TEMPLATE_NOT_FOUND: ${id}`, 404);
  return t;
}

function dueOf(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const d = String(v).slice(0, 10);
  if (!ISO.test(d)) throw err(`INVALID_DATE: ${v} (use yyyy-MM-dd)`);
  return d;
}

async function create(c, body = {}, user) {
  const tpl = await templateOf(c, body.templateId || body.template);
  // A task links to a member or a group (the reference platform's CLIENT and GROUP links); both are account holders here.
  const linkType = String(body.taskLinkType || '').toUpperCase();
  const linkKey = body.memberId || (['CLIENT', 'GROUP'].includes(linkType) ? body.taskLinkKey : null);
  const m = await memberOf(c, linkKey);
  if (m && linkType && m.holder_type !== (linkType === 'GROUP' ? 'GROUP' : 'CLIENT')) throw err(`NOT_A_${linkType}: ${linkKey}`, 400);
  const title = String(body.title || body.summary || fill(tpl?.title, m) || '').trim();
  if (!title) throw err('TASK_TITLE_REQUIRED');
  if (title.length > 255) throw err('TASK_TITLE_TOO_LONG: at most 255 characters');
  const assignee = await userOf(c, body.assignedTo || body.assignedUserKey || user.email);
  const description = body.description ?? body.notes ?? fill(tpl?.content, m) ?? null;
  const { rows: [t] } = await c.query(
    `INSERT INTO tasks (title, description, member_id, assigned_to, assigned_email, branch_id, due_date, template_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,lower($9)) RETURNING id`,
    [title, description, m ? m.id : null, assignee.id, assignee.email.toLowerCase(), m?.branch_id || assignee.branch_id || null,
      dueOf(body.dueDate) ?? null, tpl ? tpl.id : null, user.email]);
  return get(c, t.id, { ...user, role: 'TENANT_ADMIN' });
}

async function update(c, id, body = {}, user) {
  const before = await find(c, id, user);
  const sets = {};
  if (body.title !== undefined || body.summary !== undefined) {
    const title = String(body.title ?? body.summary ?? '').trim();
    if (!title || title.length > 255) throw err('TASK_TITLE_REQUIRED: 1 to 255 characters');
    sets.title = title;
  }
  if (body.description !== undefined || body.notes !== undefined) sets.description = body.description ?? body.notes ?? null;
  const due = dueOf(body.dueDate);
  if (due !== undefined) sets.due_date = due;
  if (body.assignedTo !== undefined || body.assignedUserKey !== undefined) {
    const u = await userOf(c, body.assignedTo ?? body.assignedUserKey);
    sets.assigned_to = u.id; sets.assigned_email = u.email.toLowerCase();
  }
  if (body.memberId !== undefined || body.taskLinkKey !== undefined) {
    const m = await memberOf(c, body.memberId ?? body.taskLinkKey);
    sets.member_id = m ? m.id : null;
  }
  if (body.status !== undefined) {
    const st = String(body.status).toUpperCase();
    if (!['OPEN', 'COMPLETED'].includes(st)) throw err('STATUS_MUST_BE_OPEN_OR_COMPLETED');
    sets.status = st;
    sets.completed_at = st === 'COMPLETED' ? new Date().toISOString() : null;
    sets.completed_by = st === 'COMPLETED' ? user.email : null;
  }
  const keys = Object.keys(sets);
  if (!keys.length) throw err('NOTHING_TO_CHANGE');
  await c.query(`UPDATE tasks SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [before.id, ...keys.map((k) => sets[k])]);
  return get(c, before.id, user);
}

const complete = (c, id, user) => update(c, id, { status: 'COMPLETED' }, user);
const reopen = (c, id, user) => update(c, id, { status: 'OPEN' }, user);

async function remove(c, id, user) {
  const t = await find(c, id, user);
  await c.query('DELETE FROM tasks WHERE id = $1', [t.id]);
  return { deleted: t.id };
}

// --- templates -------------------------------------------------------------------

async function templates(c) {
  const { rows } = await c.query('SELECT * FROM task_templates ORDER BY lower(name)');
  return rows.map((t) => ({ id: t.id, name: t.name, target: t.target, title: t.title, content: t.content, createdBy: t.created_by, updatedAt: t.updated_at }));
}

async function saveTemplate(c, id, body = {}, user) {
  const name = body.name !== undefined ? String(body.name || '').trim() : undefined;
  if (!id && !name) throw err('TEMPLATE_NAME_REQUIRED');
  if (name !== undefined && (!name || name.length > 255)) throw err('TEMPLATE_NAME_REQUIRED: 1 to 255 characters');
  const target = String(body.target || 'MEMBER').toUpperCase();
  if (target !== 'MEMBER') throw err('TEMPLATE_TARGET_IS_MEMBER: the platform has no groups');
  try {
    if (!id) {
      const { rows: [t] } = await c.query(
        'INSERT INTO task_templates (name, target, title, content, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [name, target, body.title || null, body.content || null, user.email]);
      return t;
    }
    const before = await templateOf(c, id);
    const { rows: [t] } = await c.query(
      'UPDATE task_templates SET name = $2, title = $3, content = $4 WHERE id = $1 RETURNING *',
      [before.id, name ?? before.name, body.title !== undefined ? body.title : before.title, body.content !== undefined ? body.content : before.content]);
    return t;
  } catch (e) {
    if (e.code === '23505') throw err(`TEMPLATE_NAME_TAKEN: ${name}`, 409);
    throw e;
  }
}

async function removeTemplate(c, id) {
  const t = await templateOf(c, id);
  await c.query('DELETE FROM task_templates WHERE id = $1', [t.id]);
  return { deleted: t.id };
}

module.exports = { PLACEHOLDERS: Object.keys(PLACEHOLDERS), list, mine, get, create, update, complete, reopen, remove, templates, saveTemplate, removeTemplate };
