/**
 * Menu items.
 */

import { $, S, api, esc, toast } from './base.js';
import { ask, card, table, view } from './ui.js';
import { viewState, viewsView } from './views.js';
import { loadMenu, roleCodes, usageRightsDialog } from './access.js';
import { go } from './nav.js';

// --------------------------------------------------------------------------
// Menu items (the reference platform's Menu Items)
// --------------------------------------------------------------------------

/** The page of one menu item: the views filed under it. */
export async function menuView() {
  await loadMenu();
  const item = S.menu.items.find((i) => i.id === S.menuItem);
  if (!item) { S.view = 'views'; return viewsView(); }
  view().innerHTML = `<div class="toolbar"><h1>${esc(item.name)}</h1><span class="hint">${esc(item.type.toLowerCase().replace(/_/g, ' '))}</span></div>
    ${card('Views', item.views.length ? `<ul id="mi-views">${item.views.map((v) => `<li><button class="link" data-open-view="${esc(v.id)}">${esc(v.name)}</button>${v.favourite ? ' <span class="hint">favourite</span>' : ''}</li>`).join('')}</ul>`
    : '<p class="hint">No views are filed here yet. Make one under Views and choose this menu item for it.</p>')}`;
  view().querySelectorAll('[data-open-view]').forEach((b) => b.addEventListener('click', () => {
    viewState.open = b.dataset.openView; viewState.offset = 0; go('views');
  }));
}

/** Menu items, managed on the Views page: add, rename, share, move and delete. */
export async function menuItemsCard(ents) {
  const admin = S.user.role === 'TENANT_ADMIN';
  const items = (S.menu?.items || []);
  const rows = items.map((i, k) => ({ ...i, k }));
  return card('Menu items', `<p class="hint">Views are filed under menu items, which show as the second row of the navigation.
    ${admin ? 'An administrator shares items with roles and puts them in order.' : 'Items you make are yours until an administrator shares them.'}</p>
    <div id="mi-list">${table([
    { label: 'Name', key: 'name' }, { label: 'Kind', value: (i) => (ents.find((e) => e.entity === i.type)?.label || i.type) },
    { label: 'Views', num: true, value: (i) => i.views.length },
    { label: 'Shared', value: (i) => (i.usageRights.allUsers ? 'all users' : i.usageRights.roles.join(', ')) },
    { label: '', html: true, value: (i) => [
      admin && i.k > 0 ? `<button class="link" data-mi-up="${esc(i.id)}">up</button>` : '',
      admin && i.k < rows.length - 1 ? `<button class="link" data-mi-down="${esc(i.id)}">down</button>` : '',
      i.canEdit ? `<button class="link" data-mi-edit="${esc(i.id)}">rename</button>` : '',
      admin ? `<button class="link" data-mi-share="${esc(i.id)}">share</button>` : '',
      i.canEdit && !i.predefined ? `<button class="link" data-mi-del="${esc(i.id)}">delete</button>` : ''].filter(Boolean).join(' ') },
  ], rows, { empty: 'No menu items' })}</div>
    <button class="secondary" id="mi-new">New menu item</button>`);
}

export function wireMenuItems(ents, reload) {
  const items = S.menu?.items || [];
  const on = (attr, fn) => view().querySelectorAll(`[${attr}]`).forEach((b) => b.addEventListener('click', () => fn(b.getAttribute(attr))));
  const done = async (r, msg) => { toast(r.ok ? msg : r.error, !r.ok); if (r.ok) { await loadMenu(); reload(); } };
  $('#mi-new')?.addEventListener('click', async () => {
    const d = await ask([{ name: 'name', label: 'Name (at most 32 characters)' },
      { name: 'type', label: 'Kind of record', options: ents.map((e) => e.entity), value: ents[0]?.entity }], 'New menu item');
    if (!d) return;
    done(await api('POST', '/api/menu-items', d), 'Menu item added');
  });
  on('data-mi-edit', async (id) => {
    const i = items.find((x) => x.id === id);
    const d = await ask([{ name: 'name', label: 'Name', value: i.name }], `Rename ${i.name}`);
    if (d) done(await api('PATCH', `/api/menu-items/${id}`, d), 'Renamed');
  });
  on('data-mi-share', async (id) => {
    const i = items.find((x) => x.id === id);
    const rights = await usageRightsDialog(`Who sees ${i.name}`, i.usageRights, await roleCodes());
    if (rights) done(await api('PATCH', `/api/menu-items/${id}`, { usageRights: rights }), 'Usage rights saved');
  });
  on('data-mi-del', async (id) => {
    if (!window.confirm('Delete this menu item? Its views stay.')) return;
    done(await api('DELETE', `/api/menu-items/${id}`), 'Menu item deleted');
  });
  const move = async (id, by) => {
    const ids = items.map((x) => x.id);
    const k = ids.indexOf(id);
    [ids[k], ids[k + by]] = [ids[k + by], ids[k]];
    done(await api('PUT', '/api/menu-items/order', { ids }), 'Moved');
  };
  on('data-mi-up', (id) => move(id, -1));
  on('data-mi-down', (id) => move(id, 1));
}
