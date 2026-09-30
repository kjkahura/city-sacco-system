/**
 * Roles, managed on the Users page.
 */

import { $, api, esc, toast } from './base.js';
import { card, table, view } from './ui.js';
import { can } from './access.js';

// --------------------------------------------------------------------------
// Roles (the reference platform's Roles), managed on the Users page
// --------------------------------------------------------------------------

async function roleEditor(role, catalog) {
  return new Promise((resolve) => {
    const has = new Set(role.permissions || []);
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog" class="card wide" id="role-form"><h2>${esc(role.code ? `Role ${role.code}` : 'New role')}</h2>
      ${role.code ? '' : '<label>Code<input name="code" required pattern="[A-Z][A-Z0-9_]{1,31}" placeholder="LOAN_OFFICER"></label>'}
      <label>Name<input name="name" value="${esc(role.name || '')}" required></label>
      <label>Base role<select name="baseRole" ${role.builtin ? 'disabled' : ''}>${['MANAGER', 'ACCOUNTANT', 'TELLER', 'AUDITOR', 'TENANT_ADMIN'].map((b) => `<option ${b === (role.baseRole || 'TELLER') ? 'selected' : ''}>${b}</option>`).join('')}</select>
        <span class="hint">Its starting permissions, and the role lists that name built-in roles.</span></label>
      <label>User type<select name="userType" ${role.builtin ? 'disabled' : ''}>${['', 'ADMINISTRATOR', 'TELLER', 'CREDIT_OFFICER'].map((u) => `<option value="${u}" ${u === (role.userType || '') ? 'selected' : ''}>${u || '(none)'}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="console" ${role.accessRights?.console === false ? '' : 'checked'} ${role.code === 'TENANT_ADMIN' ? 'disabled' : ''}> Back office access (sign in with a password)</label>
      <label class="check"><input type="checkbox" name="api" ${role.accessRights?.api === false ? '' : 'checked'}> API access (may be given to an API consumer)</label>
      <div class="perm-groups">${catalog.map((g) => `<fieldset><legend>${esc(g.group)}</legend>${g.permissions.map((p) => `<label class="check" title="${esc(p.code)}">
        <input type="checkbox" name="perm" value="${esc(p.code)}" ${has.has(p.code) ? 'checked' : ''} ${role.code === 'TENANT_ADMIN' ? 'disabled' : ''}> ${esc(p.label)}${p.platform ? ' <span class="hint">(this platform)</span>' : ''}</label>`).join('')}</fieldset>`).join('')}</div>
      <label>Notes<input name="notes" value="${esc(role.notes || '')}"></label>
      <menu class="dialog-actions"><button value="cancel" class="secondary">Cancel</button><button value="ok">Save role</button></menu></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => {
      const f = $('form', dlg);
      const out = {
        ...(role.code ? {} : { code: f.code.value.trim().toUpperCase() }), name: f.name.value, notes: f.notes.value || null,
        ...(role.builtin ? {} : { baseRole: f.baseRole.value, userType: f.userType.value || null }),
        ...(role.code === 'TENANT_ADMIN' ? {} : { permissions: [...f.querySelectorAll('input[name=perm]:checked')].map((i) => i.value) }),
        accessRights: { console: role.code === 'TENANT_ADMIN' ? true : f.console.checked, api: f.api.checked },
      };
      dlg.remove();
      resolve(dlg.returnValue === 'ok' ? out : null);
    });
    dlg.showModal();
  });
}

export async function rolesCard() {
  if (!can('VIEW_ROLE')) return { html: '', wire: () => {} };
  const [roles, cat] = await Promise.all([api('GET', '/api/roles'), api('GET', '/api/roles/permissions')]);
  if (!roles.ok) return { html: '', wire: () => {} };
  const html = card('Roles', `<p class="hint">A role is a set of permissions. The five built-in roles can be edited, not deleted; a SACCO's own roles sit on a base role.
    A user's own extra permissions are added to their role's.</p>
    <div id="roles-list">${table([{ label: 'Code', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Base role', key: 'baseRole' },
    { label: 'User type', key: 'userType' }, { label: 'Permissions', num: true, value: (r) => r.permissions.length }, { label: 'Users', num: true, key: 'users' },
    { label: '', html: true, value: (r) => `${can('EDIT_ROLE') ? `<button class="link" data-role="${esc(r.code)}">edit</button>` : ''}${can('DELETE_ROLE') && !r.builtin && !r.users ? ` <button class="link" data-role-del="${esc(r.code)}">delete</button>` : ''}` }], roles.body)}</div>
    ${can('CREATE_ROLE') ? '<button class="secondary" id="role-add">New role</button>' : ''}`);
  const wire = (reload) => {
    $('#role-add')?.addEventListener('click', async () => {
      const d = await roleEditor({ permissions: [] }, cat.body);
      if (!d) return;
      const r = await api('POST', '/api/roles', d);
      toast(r.ok ? `Role ${r.body.code} added` : r.error, !r.ok);
      if (r.ok) reload();
    });
    view().querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', async () => {
      const role = roles.body.find((x) => x.code === b.dataset.role);
      const d = await roleEditor(role, cat.body);
      if (!d) return;
      const r = await api('PATCH', `/api/roles/${role.code}`, d);
      toast(r.ok ? 'Role saved' : r.error, !r.ok);
      if (r.ok) reload();
    }));
    view().querySelectorAll('[data-role-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!window.confirm(`Delete role ${b.dataset.roleDel}?`)) return;
      const r = await api('DELETE', `/api/roles/${b.dataset.roleDel}`);
      toast(r.ok ? 'Role deleted' : r.error, !r.ok);
      if (r.ok) reload();
    }));
  };
  return { html, wire, roles: roles.body };
}
