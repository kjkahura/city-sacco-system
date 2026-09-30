/**
 * Users, their limits and their sign-ins.
 */

import { $, S, api, el, esc, toast } from './base.js';
import { ask, table, view } from './ui.js';
import { can } from './access.js';
import { rolesCard } from './roles.js';
import { render } from './nav.js';

// --------------------------------------------------------------------------
// Users (the reference platform's Users and Access Control)
// --------------------------------------------------------------------------

/** A read-only table in a dialog (sign-in history, key shown once and the like). */
export function showDialog(title, inner) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<div class="card wide"><h2>${esc(title)}</h2>${inner}<menu class="dialog-actions"><button id="dlg-close">Close</button></menu></div>`;
  document.body.appendChild(dlg);
  $('#dlg-close', dlg).addEventListener('click', () => { dlg.close(); dlg.remove(); });
  dlg.showModal();
  return dlg;
}

const LIMIT_FIELDS = [['approvalLimit', 'approval_limit', 'Loan approval'], ['disbursementLimit', 'disbursement_limit', 'Loan disbursement'],
  ['feeLimit', 'fee_limit', 'Fee application'], ['depositLimit', 'deposit_limit', 'Deposits'], ['withdrawalLimit', 'withdrawal_limit', 'Withdrawals'],
  ['repaymentLimit', 'repayment_limit', 'Repayments']];

export async function usersView() {
  const [users, roles, branches, rc] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/users/roles'), api('GET', '/api/branches'), rolesCard()]);
  if (!users.ok) throw new Error(users.error);
  const branchCode = new Map((branches.body || []).map((b) => [b.id, b.code]));
  const edit = can('EDIT_USER');
  view().innerHTML = `
    <div class="toolbar"><h1>Users</h1>${can('CREATE_USER') ? '<button id="user-add">New user</button>' : ''}</div>
    <p class="hint">Staff who sign in to the back office. A new user, and one whose password is reset, gets a temporary password shown once
    that must be changed at the first sign-in. Deactivating a user ends their sessions at once; a user locked out by failed sign-ins is unlocked here.
    A teller or credit officer belongs to a branch; a user sees every branch or only the ones given.</p>
    <div id="users-list">${table([
    { label: 'Email', key: 'email' }, { label: 'Name', key: 'full_name' }, { label: 'Role', value: (u) => (u.role_code ? `${u.role_code} (${u.role})` : u.role) },
    { label: 'Type', value: (u) => (u.user_type || '').toLowerCase().replace('_', ' ') },
    { label: 'State', html: true, value: (u) => `<span class="badge ${u.state === 'ACTIVE' ? '' : 'bad'}">${esc(u.state)}</span>` },
    { label: 'Branch', value: (u) => branchCode.get(u.branch_id) || '' },
    { label: 'Access', value: (u) => (u.all_branches ? 'all branches' : [u.branch_id, ...(u.branch_access || [])].filter(Boolean).map((id) => branchCode.get(id)).join(', ')) },
    { label: 'Extra permissions', value: (u) => (u.permissions || []).join(', ') },
    { label: 'Second factor', value: (u) => (u.mfa_enabled ? 'on' : '') },
    { label: 'Last sign-in', value: (u) => (u.last_login_at ? String(u.last_login_at).slice(0, 16).replace('T', ' ') : '') },
    { label: '', html: true, value: (u) => [
      edit ? `<button class="link" data-user="${esc(u.id)}">edit</button> <button class="link" data-limits-u="${esc(u.id)}">limits</button>` : '',
      edit && u.locked ? `<button class="link" data-unlock="${esc(u.id)}">unlock</button>` : '',
      S.user.role === 'TENANT_ADMIN' ? `<button class="link" data-reset="${esc(u.id)}">reset password</button>` : '',
      u.mfa_enabled && can('MANAGE_TWO_FACTOR_AUTHENTICATION') ? `<button class="link" data-mfa="${esc(u.id)}">reset second factor</button>` : '',
      `<button class="link" data-logins="${esc(u.id)}">sign-ins</button>`].filter(Boolean).join(' ') },
  ], users.body)}</div>
    ${rc.html}`;
  rc.wire(usersView);
  const roleList = [...new Set([...(roles.body || []), ...(rc.roles || []).map((r) => r.code)])];
  const branchList = ['', ...(branches.body || []).filter((b) => b.status === 'ACTIVE').map((b) => b.code)];
  const shown = (title, secret) => ask([{ name: 'p', label: 'Temporary password (shown once; give it to the user)', value: secret }], title);
  const codes = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  el('user-add')?.addEventListener('click', async () => {
    const d = await ask([
      { name: 'email', label: 'Email', type: 'email' }, { name: 'fullName', label: 'Name', required: false },
      { name: 'role', label: 'Role', options: roleList, value: 'TELLER' },
      { name: 'userType', label: 'User type', options: ['', 'TELLER', 'CREDIT_OFFICER'], value: '', hint: 'Blank: the role\'s. A teller or credit officer needs a branch.' },
      { name: 'branchId', label: 'Branch', options: branchList, value: '' },
    ], 'New user');
    if (!d) return;
    const r = await api('POST', '/api/users', { ...d, branchId: d.branchId || null, userType: d.userType || undefined });
    if (!r.ok) return toast(r.error, true);
    await shown(`${r.body.email} created`, r.body.temporaryPassword);
    render();
  });
  view().querySelectorAll('[data-user]').forEach((b) => b.addEventListener('click', async () => {
    const u = users.body.find((x) => x.id === b.dataset.user);
    const d = await ask([
      { name: 'fullName', label: 'Name', value: u.full_name || '', required: false },
      { name: 'title', label: 'Title', value: u.title || '', required: false },
      { name: 'role', label: 'Role', options: roleList, value: u.role_code || u.role },
      { name: 'userType', label: 'User type', options: ['', 'TELLER', 'CREDIT_OFFICER'], value: u.user_type === 'ADMINISTRATOR' ? '' : u.user_type || '' },
      { name: 'permissions', label: 'Extra permissions (codes, comma separated)', value: (u.permissions || []).join(', '), required: false },
      { name: 'status', label: 'Status', options: ['ACTIVE', 'SUSPENDED'], value: u.status },
      { name: 'branchId', label: 'Branch', options: branchList, value: branchCode.get(u.branch_id) || '' },
      { name: 'allBranches', label: 'Can access every branch', options: ['yes', 'no'], value: u.all_branches ? 'yes' : 'no' },
      { name: 'branches', label: 'Other branches (codes, comma separated)', value: (u.branch_access || []).map((id) => branchCode.get(id)).filter(Boolean).join(', '), required: false },
      { name: 'others', label: 'A credit officer sees other credit officers\' members', options: ['yes', 'no'], value: u.other_officers_clients ? 'yes' : 'no' },
    ], `Edit ${u.email}`);
    if (!d) return;
    const body = {
      fullName: d.fullName, title: d.title, role: d.role, status: d.status, branchId: d.branchId || null,
      permissions: codes(d.permissions).map((x) => x.toUpperCase()),
      accessRights: { allBranches: d.allBranches === 'yes', branches: codes(d.branches), otherCreditOfficersClients: d.others === 'yes' },
    };
    if ((d.userType || null) !== (u.user_type === 'ADMINISTRATOR' ? null : u.user_type || null)) body.userType = d.userType || null;
    let r = await api('PATCH', `/api/users/${u.id}`, body);
    if (!r.ok && /CREDIT_OFFICER_HAS_MEMBERS/.test(r.error) && window.confirm(`${r.error}\n\nDeactivate anyway?`)) {
      r = await api('PATCH', `/api/users/${u.id}`, { ...body, confirmCreditOfficerMembers: true });
    }
    toast(r.ok ? 'Saved' : r.error, !r.ok);
    if (r.ok) render();
  }));
  view().querySelectorAll('[data-limits-u]').forEach((b) => b.addEventListener('click', async () => {
    const u = users.body.find((x) => x.id === b.dataset.limitsU);
    const d = await ask(LIMIT_FIELDS.map(([k, col, label]) => ({ name: k, label: `${label} limit (blank: none)`, type: 'number', step: '0.01', value: u[col] ?? '', required: false })),
      `Transaction limits of ${u.email}`);
    if (!d) return;
    const r = await api('PATCH', `/api/users/${u.id}`, Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === '' ? null : Number(v)])));
    toast(r.ok ? 'Limits saved' : r.error, !r.ok);
    if (r.ok) render();
  }));
  view().querySelectorAll('[data-unlock]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api('POST', `/api/users/${b.dataset.unlock}/unlock`);
    toast(r.ok ? `${r.body.email} unlocked` : r.error, !r.ok);
    if (r.ok) render();
  }));
  view().querySelectorAll('[data-logins]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api('GET', `/api/users/${b.dataset.logins}/logins?limit=50`);
    if (!r.ok) return toast(r.error, true);
    showDialog('Sign-in history', loginsTable(r.body));
    return null;
  }));
  view().querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api('POST', `/api/users/${b.dataset.reset}/reset-password`);
    if (!r.ok) return toast(r.error, true);
    await shown(`Password reset for ${r.body.email}`, r.body.temporaryPassword);
    return render();
  }));
  view().querySelectorAll('[data-mfa]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api('POST', `/api/users/${b.dataset.mfa}/reset-mfa`);
    toast(r.ok ? 'Second factor reset; the user enrols again at the next sign-in' : r.error, !r.ok);
    if (r.ok) render();
  }));
}

export const loginsTable = (rows) => table([{ label: 'When', value: (x) => String(x.created_at).replace('T', ' ').slice(0, 19) },
  { label: 'Result', value: (x) => (x.succeeded ? 'signed in' : (x.reason || 'refused').toLowerCase().replace(/_/g, ' ')) },
  { label: 'From', key: 'ip' }, { label: 'Browser', value: (x) => String(x.user_agent || '').slice(0, 60) }], rows, { empty: 'No sign-ins recorded' });
