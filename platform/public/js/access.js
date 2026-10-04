/**
 * What the signed-in user may do (GET /api/auth/me), the menu, and usage
 * rights.
 */

import { $, S, api, el, esc } from './base.js';
import { drawTopbar } from './topbar.js';
import { go } from './nav.js';

// --------------------------------------------------------------------------
// Access: what the signed-in user may do, from GET /api/auth/me
// --------------------------------------------------------------------------

/** True when the user holds any of the permission codes (an administrator holds them all). */
export const can = (...codes) => S.user?.role === 'TENANT_ADMIN' || codes.some((c) => (S.user?.permissions || []).includes(c));

/** Load the user's permissions, draw the top bar with what they may open, and build their menu items. */
export async function loadAccess() {
  const me = await api('GET', '/api/auth/me');
  if (me.ok) S.user = { ...S.user, ...me.body };
  drawTopbar(go);
  await loadMenu();
}

/** The menu items with views (GET /api/menu), as a second row of the navigation. */
export async function loadMenu() {
  const m = await api('GET', '/api/menu');
  S.menu = m.ok ? m.body : { fixed: [], items: [] };
  el('menu-nav').innerHTML = S.menu.items.map((i) => `<button data-menu-item="${esc(i.id)}" class="${S.view === 'menu' && S.menuItem === i.id ? 'active' : ''}">${esc(i.name)}</button>`).join('');
}

/** The tenant's role codes (built-in and its own), for usage rights. */
export async function roleCodes() {
  const r = await api('GET', '/api/roles');
  return r.ok ? r.body.map((x) => x.code) : ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'TELLER', 'AUDITOR'];
}

/** A usage rights editor inside a dialog of its own: all users, or the roles picked. */
export async function usageRightsDialog(title, rights, codes) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog" class="card"><h2>${esc(title)}</h2>
      <label class="check"><input type="checkbox" name="allUsers" ${rights.allUsers ? 'checked' : ''}> All users</label>
      <label>Or the roles<select name="roles" multiple size="${Math.min(8, codes.length)}">${codes.map((c) => `<option ${rights.roles.includes(c) ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <menu class="dialog-actions"><button value="cancel" class="secondary">Cancel</button><button value="ok">Save</button></menu></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => {
      const f = $('form', dlg);
      const out = { allUsers: f.allUsers.checked, roles: [...f.roles.selectedOptions].map((o) => o.value) };
      dlg.remove();
      resolve(dlg.returnValue === 'ok' ? out : null);
    });
    dlg.showModal();
  });
}
