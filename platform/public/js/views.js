/**
 * Custom views: running and editing them.
 */

import { $, S, api, esc, money, openFile, toast } from './base.js';
import { card, pager, table, view, wirePager } from './ui.js';
import { loadMenu, roleCodes } from './access.js';
import { menuItemsCard, wireMenuItems } from './menu.js';

// --------------------------------------------------------------------------
// Custom views
// --------------------------------------------------------------------------

export const viewState = { open: null, offset: 0, limit: 50, editing: null };

export async function viewsView() {
  if (viewState.editing) return viewEditor();
  if (viewState.open) return viewRun();
  const [list, ents] = await Promise.all([api('GET', '/api/views'), api('GET', '/api/views/entities'), loadMenu()]);
  if (!list.ok) throw new Error(list.error);
  const menuCard = await menuItemsCard(ents.body);
  view().innerHTML = `<h1>Views</h1>
    <div class="toolbar"><button id="v-new">New view</button></div>
    ${ents.body.map((e) => {
    const vs = list.body.filter((v) => v.entity === e.entity);
    return card(e.label, table([
      { label: 'Name', html: true, value: (v) => `<button class="link" data-v-open="${esc(v.id)}">${esc(v.name)}</button>` },
      { label: 'Owner', key: 'owner' },
      { label: 'Shared', value: (v) => (v.usageRights.allUsers ? 'all users' : v.usageRights.roles.join(', ')) },
      { label: '', html: true, value: (v) => `<button class="link" data-v-fav="${esc(v.id)}" data-on="${v.favourite ? '' : '1'}">${v.favourite ? 'unfavourite' : 'favourite'}</button>
        <button class="link" data-v-copy="${esc(v.id)}">copy</button>${v.canEdit ? ` <button class="link" data-v-edit="${esc(v.id)}">edit</button> <button class="link" data-v-del="${esc(v.id)}">delete</button>` : ''}` },
    ], vs, { empty: 'No views' }));
  }).join('')}
    ${menuCard}`;
  wireMenuItems(ents.body, viewsView);
  $('#v-new').addEventListener('click', () => { viewState.editing = { entity: ents.body[0].entity }; viewsView(); });
  const on = (attr, fn) => view().querySelectorAll(`[${attr}]`).forEach((b) => b.addEventListener('click', () => fn(b.getAttribute(attr), b)));
  on('data-v-open', (id) => { viewState.open = id; viewState.offset = 0; viewsView(); });
  on('data-v-edit', (id) => { viewState.editing = list.body.find((v) => v.id === id); viewsView(); });
  on('data-v-fav', async (id, b) => { const r = await api(b.dataset.on ? 'PUT' : 'DELETE', `/api/views/${id}/favourite`); toast(r.ok ? 'Saved' : r.error, !r.ok); viewsView(); });
  on('data-v-copy', async (id) => { const r = await api('POST', `/api/views/${id}/copy`, {}); toast(r.ok ? `Copied as ${r.body.name}` : r.error, !r.ok); viewsView(); });
  on('data-v-del', async (id) => {
    if (!window.confirm('Delete this view?')) return;
    const r = await api('DELETE', `/api/views/${id}`); toast(r.ok ? 'Deleted' : r.error, !r.ok); viewsView();
  });
}

async function viewRun() {
  const qs = new URLSearchParams({ offset: viewState.offset, limit: viewState.limit });
  const r = await api('GET', `/api/views/${viewState.open}/run?${qs}`);
  if (!r.ok) { viewState.open = null; toast(r.error, true); return viewsView(); }
  const x = r.body;
  const cols = x.columns.map((c) => ({ label: c.label, num: ['NUMBER', 'MONEY'].includes(c.type), value: (row) => (c.type === 'MONEY' ? money(row[c.key]) : row[c.key]) }));
  const totals = x.totals ? `<table><tbody><tr class="total">${x.columns.map((c, i) => `<td class="${x.totals[c.key] !== undefined ? 'num' : ''}">${x.totals[c.key] !== undefined ? money(x.totals[c.key]) : i === 0 ? 'Total' : ''}</td>`).join('')}</tr></tbody></table>` : '';
  const detail = x.view.display === 'DETAIL';
  view().innerHTML = `<h1>${esc(x.view.name)}</h1>
    <div class="toolbar"><button class="secondary" id="v-back">All views</button>
      <button class="secondary" id="v-toggle">${detail ? 'List' : 'Detail'}</button>
      <button class="secondary" id="v-csv">CSV</button><button class="secondary" id="v-xlsx">Excel</button></div>
    <div id="v-out">${detail
    ? x.items.map((row) => card(String(row[x.columns[0].key] ?? ''), `<dl class="kv">${x.columns.map((c) => `<dt>${esc(c.label)}</dt><dd>${esc(c.type === 'MONEY' ? money(row[c.key]) : row[c.key] ?? '')}</dd>`).join('')}</dl>`)).join('')
    : table(cols, x.items, { empty: 'Nothing matches this view' }) + totals}</div>
    ${pager(viewState, x.total)}`;
  wirePager(viewState, viewsView);
  $('#v-back').addEventListener('click', () => { viewState.open = null; viewsView(); });
  $('#v-toggle').addEventListener('click', () => { x.view.display = detail ? 'LIST' : 'DETAIL'; api('PATCH', `/api/views/${x.view.id}`, { display: x.view.display }).then(() => viewsView()); });
  $('#v-csv').addEventListener('click', () => openFile(`/api/views/${x.view.id}/export?format=csv`, `${x.view.name}.csv`, { save: true }));
  $('#v-xlsx').addEventListener('click', () => openFile(`/api/views/${x.view.id}/export?format=xlsx`, `${x.view.name}.xlsx`, { save: true }));
}

async function viewEditor() {
  const v = viewState.editing;
  const admin = S.user.role === 'TENANT_ADMIN';
  const ents = (await api('GET', '/api/views/entities')).body;
  const meta = (await api('GET', `/api/views/fields/${v.entity}`)).body;
  const codes = admin ? await roleCodes() : [];
  if (!S.menu) await loadMenu();
  const menuItems = (S.menu?.items || []).filter((i) => i.type === v.entity);
  const cols = v.columns || meta.defaultColumns;
  const filters = v.filters || [];
  const fieldOpts = (sel) => meta.fields.map((f) => `<option value="${esc(f.key)}" ${f.key === sel ? 'selected' : ''}>${esc(f.label)}</option>`).join('');
  const filterRow = (x, i) => {
    const f = meta.fields.find((y) => y.key === x.field) || meta.fields[0];
    return `<div class="toolbar" data-filter="${i}">
      <select data-f="field">${fieldOpts(f.key)}</select>
      <select data-f="operator">${f.operators.map((o) => `<option ${o === x.operator ? 'selected' : ''}>${o}</option>`).join('')}</select>
      <input data-f="value" value="${esc(Array.isArray(x.values) ? x.values.join(',') : x.value ?? '')}" placeholder="value">
      <input data-f="secondValue" value="${esc(x.secondValue ?? '')}" placeholder="to (BETWEEN)">
      <button class="link" data-drop-filter="${i}">remove</button></div>`;
  };
  view().innerHTML = `<h1>${v.id ? 'Edit view' : 'New view'}</h1>
    <section class="card"><form id="v-form">
      <label>Records<select name="entity" ${v.id ? 'disabled' : ''}>${ents.map((e) => `<option value="${e.entity}" ${e.entity === v.entity ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}</select></label>
      <label>Name<input name="name" value="${esc(v.name || '')}" required maxlength="255"></label>
      <label>Match<select name="match"><option value="ALL" ${v.match !== 'ANY' ? 'selected' : ''}>All filters</option><option value="ANY" ${v.match === 'ANY' ? 'selected' : ''}>Any filter</option></select></label>
      <h2>Filters</h2><div id="v-filters">${filters.map(filterRow).join('')}</div>
      <button type="button" class="secondary" id="v-add-filter">Add filter</button>
      <h2>Columns</h2><select name="columns" multiple size="10">${meta.fields.map((f) => `<option value="${esc(f.key)}" ${cols.includes(f.key) ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>
      <label>Sort by<select name="sortBy"><option value="">(none)</option>${fieldOpts(v.sortBy)}</select></label>
      <label>Direction<select name="sortDir"><option ${v.sortDir !== 'DESC' ? 'selected' : ''}>ASC</option><option ${v.sortDir === 'DESC' ? 'selected' : ''}>DESC</option></select></label>
      <label class="check"><input type="checkbox" name="includeTotals" ${v.includeTotals ? 'checked' : ''}> Include totals</label>
      <label class="check"><input type="checkbox" name="includeTimestamp" ${v.includeTimestamp ? 'checked' : ''}> Include timestamp</label>
      <label>Menu item<select name="menuItemId"><option value="">(the ${esc(ents.find((e) => e.entity === v.entity)?.label || '')} item)</option>
        ${menuItems.filter((i) => !i.predefined).map((i) => `<option value="${esc(i.id)}" ${i.id === v.menuItemId ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select></label>
      <label>Opens in<select name="display"><option ${v.display !== 'DETAIL' ? 'selected' : ''}>LIST</option><option ${v.display === 'DETAIL' ? 'selected' : ''}>DETAIL</option></select></label>
      ${admin ? `<h2>Usage rights</h2><label class="check"><input type="checkbox" name="allUsers" ${v.usageRights?.allUsers ? 'checked' : ''}> All users</label>
        <select name="roles" multiple size="5">${codes.map((x) => `<option ${(v.usageRights?.roles || []).includes(x) ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>` : ''}
      <div class="toolbar"><button type="submit">Save</button><button type="button" class="secondary" id="v-cancel">Cancel</button></div>
    </form></section>`;
  const form = $('#v-form');
  const readFilters = () => [...view().querySelectorAll('[data-filter]')].map((row) => {
    const g = (k) => row.querySelector(`[data-f=${k}]`).value;
    const op = g('operator');
    return { field: g('field'), operator: op, ...(op === 'IN' ? { values: g('value').split(',').map((s) => s.trim()).filter(Boolean) } : { value: g('value') }), ...(op === 'BETWEEN' ? { secondValue: g('secondValue') } : {}) };
  });
  const keep = () => {
    v.filters = readFilters();
    v.name = form.name.value;
    v.columns = [...form.columns.selectedOptions].map((o) => o.value);
  };
  form.entity.addEventListener('change', (e) => { viewState.editing = { entity: e.target.value, name: form.name.value }; viewsView(); });
  $('#v-add-filter').addEventListener('click', () => { keep(); v.filters.push({ field: meta.fields[0].key, operator: meta.fields[0].operators[0] }); viewsView(); });
  view().querySelectorAll('[data-drop-filter]').forEach((b) => b.addEventListener('click', () => { keep(); v.filters.splice(Number(b.dataset.dropFilter), 1); viewsView(); }));
  view().querySelectorAll('[data-f=field]').forEach((s) => s.addEventListener('change', () => { keep(); viewsView(); }));
  $('#v-cancel').addEventListener('click', () => { viewState.editing = null; viewsView(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      entity: v.entity, name: form.name.value, match: form.match.value, filters: readFilters(),
      columns: [...form.columns.selectedOptions].map((o) => o.value), sortBy: form.sortBy.value || null, sortDir: form.sortDir.value,
      includeTotals: form.includeTotals.checked, includeTimestamp: form.includeTimestamp.checked, display: form.display.value,
      menuItemId: form.menuItemId.value || null,
      ...(admin ? { usageRights: { allUsers: form.allUsers.checked, roles: [...form.roles.selectedOptions].map((o) => o.value) } } : {}),
    };
    const r = v.id ? await api('PATCH', `/api/views/${v.id}`, body) : await api('POST', '/api/views', body);
    if (!r.ok) return toast(r.error, true);
    toast('View saved');
    loadMenu();
    viewState.editing = null; viewState.open = r.body.id; viewState.offset = 0;
    return viewsView();
  });
}
