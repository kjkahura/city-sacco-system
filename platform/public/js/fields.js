/**
 * Administration > Fields, after the reference platform's custom field
 * administration: one entity at a time, its sets in order with their fields
 * in order, a form per definition (General, Display, Usage, Rights,
 * Description), and edit, deactivate, delete and rearrange. On a record,
 * the grouped-set editor edits entries as rows.
 */

import { api, esc, toast } from './base.js';
import { card, table } from './ui.js';

const ENTITIES = [
  ['MEMBER', 'Clients'], ['GROUP', 'Groups'], ['LOAN_ACCOUNT', 'Loan accounts'], ['SAVINGS_ACCOUNT', 'Deposit accounts'],
  ['SAVINGS_PRODUCT', 'Deposit products'], ['CREDIT_ARRANGEMENT', 'Credit arrangements'], ['GUARANTOR', 'Guarantors'],
  ['COLLATERAL', 'Assets'], ['BRANCH', 'Branches'], ['CENTRE', 'Centres'], ['USER', 'Users'],
  ['TRANSACTION_CHANNEL', 'Transactions by channel'], ['TRANSACTION_TYPE', 'Transactions by type'],
];
const NO_SETS = ['GUARANTOR', 'COLLATERAL'];
const TYPES = ['FREE_TEXT', 'SELECTION', 'NUMBER', 'CHECKBOX', 'DATE', 'DATE_TIME', 'CLIENT_LINK', 'GROUP_LINK', 'USER_LINK'];
const LEVELS = ['UNAVAILABLE', 'AVAILABLE', 'DEFAULT', 'REQUIRED'];
const DEPOSIT_TYPES = ['CURRENT_ACCOUNT', 'SAVINGS_ACCOUNT', 'FIXED_DEPOSIT', 'SAVINGS_PLAN', 'INVESTOR_ACCOUNT'];

export const fieldsState = { entity: 'MEMBER', showDisabled: false, item: '' };

/** The items an entity's fields are set per (products, types, channels), as [id, label]. */
async function itemsOf(entity) {
  const list = async (path, id, label, keep = () => true) => {
    const r = await api('GET', path);
    return r.ok ? (Array.isArray(r.body) ? r.body : r.body.items || []).filter(keep).map((x) => [String(x[id]), `${x[label] ?? x[id]} (${x[id]})`]) : [];
  };
  switch (entity) {
    case 'MEMBER': return list('/api/client-types', 'id', 'name', (x) => (x.holderType || x.holder_type) !== 'GROUP');
    case 'GROUP': return list('/api/client-types', 'id', 'name', (x) => (x.holderType || x.holder_type) === 'GROUP');
    case 'LOAN_ACCOUNT': return list('/api/loan-products', 'id', 'name');
    case 'SAVINGS_ACCOUNT': return list('/api/deposit-products', 'id', 'name');
    case 'TRANSACTION_CHANNEL': return list('/api/transaction-channels', 'id', 'name');
    case 'SAVINGS_PRODUCT': return DEPOSIT_TYPES.map((t) => [t, t.replace(/_/g, ' ').toLowerCase()]);
    case 'TRANSACTION_TYPE': return [['TRANSFER', 'Transfer']];
    default: return null;
  }
}

const levelOf = (f) => (!f ? 'UNAVAILABLE' : f.required ? 'REQUIRED' : f.default ? 'DEFAULT' : 'AVAILABLE');
const flagsOf = (level) => ({ available: level !== 'UNAVAILABLE', default: ['DEFAULT', 'REQUIRED'].includes(level), required: level === 'REQUIRED' });
const rolesText = (r) => (r ? r.join(', ') : 'all');
const rolesIn = (v) => { const t = String(v || '').trim(); return !t || t.toLowerCase() === 'all' ? null : t.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean); };

function usageText(d) {
  if (d.usage.items && !d.available_for_all) {
    const e = Object.entries(d.usage.items);
    return e.length ? e.map(([k, f]) => `${k}: ${levelOf(f).toLowerCase()}`).join(', ') : 'unavailable everywhere';
  }
  return `all: ${levelOf({ default: d.usage.default, required: d.usage.required }).toLowerCase()}`;
}

/** The Fields card for the Organization page. */
export async function fieldsCard(manage) {
  const st = fieldsState;
  const [sets, defs] = await Promise.all([
    api('GET', `/api/custom-fields/sets?entity=${st.entity}`), api('GET', `/api/custom-fields/definitions?entity=${st.entity}`),
  ]);
  const items = await itemsOf(st.entity);
  const all = (defs.body || []).filter((d) => st.showDisabled || d.is_active)
    .filter((d) => !st.item || d.available_for_all || !d.usage.items || d.usage.items[st.item]);
  const groups = NO_SETS.includes(st.entity) ? [{ id: '', name: 'Fields', set_type: 'STANDARD' }] : (sets.body || []);
  const rowButtons = (d) => (manage ? [
    `<button class="link" data-cf-def-edit="${esc(d.id)}">edit</button>`,
    `<button class="link" data-cf-def-active="${esc(d.id)}">${d.is_active ? 'deactivate' : 'activate'}</button>`,
    `<button class="link" data-cf-def-del="${esc(d.id)}">delete</button>`,
    `<button class="link" data-cf-def-up="${esc(d.id)}" title="Move up">↑</button>`,
    `<button class="link" data-cf-def-down="${esc(d.id)}" title="Move down">↓</button>`,
  ].join(' ') : '');
  const body = groups.map((s) => {
    const fields = all.filter((d) => (d.set_id || '') === (s.id || ''));
    const head = s.id ? `<h3>${esc(s.name)} <span class="badge">${esc(s.set_type.toLowerCase())}</span> <span class="hint mono">${esc(s.id)}</span>
      ${manage ? `<button class="link" data-cf-set-edit="${esc(s.id)}">edit set</button> <button class="link" data-cf-set-del="${esc(s.id)}">delete set</button>
      <button class="link" data-cf-set-up="${esc(s.id)}" title="Move up">↑</button> <button class="link" data-cf-set-down="${esc(s.id)}" title="Move down">↓</button>
      <button class="link" data-cf-def-add="${esc(s.id)}">add field</button>` : ''}</h3>` : (manage ? '<button class="link" data-cf-def-add="">add field</button>' : '');
    return `${head}${table([
      { label: 'Name', value: (d) => `${d.name}${d.is_active ? '' : ' (disabled)'}` }, { label: 'ID', key: 'id' },
      { label: 'Type', value: (d) => `${d.field_type}${d.dependent_on ? ` ← ${d.dependent_on}` : ''}` },
      { label: 'Usage', value: usageText }, { label: 'View', value: (d) => rolesText(d.view_roles) }, { label: 'Edit', value: (d) => rolesText(d.edit_roles) },
      { label: '', html: true, value: rowButtons },
    ], fields, { empty: 'No fields' })}`;
  }).join('');
  return card('Fields', `<div id="org-cf">
    <div class="toolbar">
      <label>Entity <select id="cf-entity">${ENTITIES.map(([k, l]) => `<option value="${k}" ${k === st.entity ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      ${items ? `<label>Available for <select id="cf-item"><option value="">any</option>${items.map(([k, l]) => `<option value="${esc(k)}" ${k === st.item ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>` : ''}
      <label><input type="checkbox" id="cf-disabled" ${st.showDisabled ? 'checked' : ''}> Show disabled fields</label>
      ${manage && !NO_SETS.includes(st.entity) ? '<button class="secondary" id="cf-set-add">New set</button>' : ''}
    </div>
    ${body || '<p class="hint">No sets yet.</p>'}
  </div>`);
}

/**
 * A dialog of fieldsets: [{ legend, fields: [{ label, name, type, options, value, hint, required, rows }] }].
 * Resolves to the values by name, or null.
 */
function formDialog(title, sections) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    const input = (f) => {
      if (f.options) return `<select name="${esc(f.name)}">${f.options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(f.value ?? '') ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
      if (f.type === 'textarea') return `<textarea name="${esc(f.name)}" rows="${f.rows || 4}">${esc(f.value ?? '')}</textarea>`;
      if (f.type === 'checkbox') return `<input type="checkbox" name="${esc(f.name)}" ${f.value ? 'checked' : ''}>`;
      return `<input name="${esc(f.name)}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${f.required ? 'required' : ''} ${f.readonly ? 'readonly' : ''}>`;
    };
    dlg.innerHTML = `<form method="dialog" class="card wide"><h2>${esc(title)}</h2>
      ${sections.filter((s) => s.fields.length).map((s) => `<fieldset><legend>${esc(s.legend)}</legend>
        ${s.fields.map((f) => `<label>${esc(f.label)} ${input(f)}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</label>`).join('')}</fieldset>`).join('')}
      <menu class="dialog-actions"><button value="cancel" class="secondary" formnovalidate>Cancel</button><button value="ok">Save</button></menu></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => {
      const form = dlg.querySelector('form');
      const data = Object.fromEntries(new FormData(form).entries());
      form.querySelectorAll('input[type=checkbox]').forEach((c) => { data[c.name] = c.checked; });
      dlg.remove();
      resolve(dlg.returnValue === 'ok' ? data : null);
    });
    dlg.showModal();
  });
}

const optionsText = (d) => (d?.options || []).map((o) => [o.id, o.label, o.score ?? '', o.parent ?? ''].join('|').replace(/\|+$/, '')).join('\n');
const optionsIn = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const [id, label, score, parent] = l.split('|').map((x) => (x || '').trim());
  return { id: id || undefined, label: label || id, ...(score !== '' && score !== undefined ? { score: Number(score) } : {}), ...(parent ? { parent } : {}) };
});

/** The definition form: new (with a set) or an existing definition. */
async function definitionForm(entity, setId, d, items) {
  const isNew = !d;
  const u = d?.usage || {};
  const perItem = items && d && !d.available_for_all && u.items;
  const sections = [
    { legend: 'General', fields: [
      { label: 'Name', name: 'name', value: d?.name, required: true },
      ...(isNew ? [{ label: 'ID (blank: from the name)', name: 'id' }] : [{ label: 'ID', name: 'id', value: d.id, readonly: true }]),
      ...(setId ? [{ label: 'Set', name: 'set', value: setId, readonly: true }] : []),
    ] },
    { legend: 'Display', fields: [
      ...(isNew ? [{ label: 'Type', name: 'type', options: TYPES }] : [{ label: 'Type', name: 'type', value: d.field_type, readonly: true }]),
      { label: 'Long field', name: 'longField', type: 'checkbox', value: d?.long_field },
      { label: 'Format (free text: # digit, @ letter, $ either)', name: 'format', value: d?.format || '' },
      { label: 'Unique value (free text and number)', name: 'uniqueValue', type: 'checkbox', value: d?.unique_value },
      { label: 'Selection options, one per line: id|label|score|parent option', name: 'options', type: 'textarea', value: optionsText(d) },
      { label: 'Depends on (a selection field in the same set)', name: 'dependentOn', value: d?.dependent_on || '' },
    ] },
    { legend: 'Usage', fields: [
      ...(items ? [{ label: 'Available for all', name: 'availableForAll', type: 'checkbox', value: !perItem }] : []),
      { label: items ? 'For all: usage' : 'Usage', name: 'allLevel', options: LEVELS.slice(1), value: levelOf({ default: u.default, required: u.required }) },
      ...(items || []).map(([k, l]) => ({ label: `For ${l}`, name: `item|${k}`, options: LEVELS, value: perItem ? levelOf(u.items[k]) : 'UNAVAILABLE' })),
    ] },
    { legend: 'Rights', fields: [
      { label: 'Roles that may view (comma separated, or all)', name: 'viewRoles', value: rolesText(d?.view_roles ?? null) },
      { label: 'Roles that may edit (comma separated, or all); edit rights carry view rights', name: 'editRoles', value: rolesText(d?.edit_roles ?? null) },
    ] },
    { legend: 'Description', fields: [{ label: 'Description', name: 'description', type: 'textarea', rows: 2, value: d?.description || '' }] },
  ];
  const f = await formDialog(isNew ? 'New field' : `Field ${d.id}`, sections);
  if (!f) return null;
  const type = isNew ? f.type : d.field_type;
  const body = {
    name: f.name, description: f.description || null, longField: f.longField,
    viewRoles: rolesIn(f.viewRoles), editRoles: rolesIn(f.editRoles),
  };
  if (type === 'FREE_TEXT') body.format = f.format || null;
  if (['FREE_TEXT', 'NUMBER'].includes(type)) body.uniqueValue = f.uniqueValue;
  if (type === 'SELECTION') { body.options = optionsIn(f.options); body.dependentOn = f.dependentOn || null; }
  const all = !items || f.availableForAll;
  if (items) body.availableForAll = all;
  body.usage = all ? (({ available, ...x }) => x)(flagsOf(f.allLevel))
    : { items: Object.fromEntries(items.map(([k]) => [k, flagsOf(f[`item|${k}`])]).filter(([, x]) => x.available)) };
  if (isNew) Object.assign(body, { entity, type, id: f.id || undefined, ...(setId ? { setId } : {}) });
  return body;
}

/** Wire the Fields card; `reload` redraws the page. */
export function wireFields(reload) {
  const st = fieldsState;
  const box = document.getElementById('org-cf');
  if (!box) return;
  const done = (res, msg) => { toast(res.ok ? msg : res.error, !res.ok); if (res.ok) reload(); };
  const on = (sel, ev, fn) => { const n = box.querySelector(sel); if (n) n.addEventListener(ev, fn); };
  const each = (attr, fn) => box.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', () => fn(b.getAttribute(`data-${attr}`))));
  on('#cf-entity', 'change', (e) => { st.entity = e.target.value; st.item = ''; reload(); });
  on('#cf-item', 'change', (e) => { st.item = e.target.value; reload(); });
  on('#cf-disabled', 'change', (e) => { st.showDisabled = e.target.checked; reload(); });
  // The version a record was read at (lib/versioning), sent back so a change made meanwhile is not overwritten.
  const versionOf = (x) => (x && x.row_version ? `"v${x.row_version}"` : null);
  const defsOf = async () => (await api('GET', `/api/custom-fields/definitions?entity=${st.entity}`)).body || [];
  on('#cf-set-add', 'click', async () => {
    const d = await formDialog('New set', [{ legend: 'Set', fields: [
      { label: 'Name', name: 'name', required: true }, { label: 'ID (blank: from the name)', name: 'id' },
      { label: 'Type', name: 'type', options: [['STANDARD', 'Standard (one value per field)'], ['GROUPED', 'Grouped (repeating entries)']] },
      { label: 'Notes', name: 'notes', type: 'textarea', rows: 2 }] }]);
    if (d) done(await api('POST', '/api/custom-fields/sets', { entity: st.entity, name: d.name, id: d.id || undefined, type: d.type, notes: d.notes || null }), 'Set created');
  });
  each('cf-set-edit', async (id) => {
    const s = ((await api('GET', `/api/custom-fields/sets?entity=${st.entity}`)).body || []).find((x) => x.id === id);
    const d = await formDialog(`Set ${id}`, [{ legend: 'Set', fields: [{ label: 'Name', name: 'name', value: s?.name, required: true },
      { label: 'Notes', name: 'notes', type: 'textarea', rows: 2, value: s?.notes || '' }] }]);
    if (d) done(await api('PATCH', `/api/custom-fields/sets/${id}`, { name: d.name, notes: d.notes || null }, { ifMatch: versionOf(s) }), 'Set saved');
  });
  each('cf-set-del', async (id) => done(await api('DELETE', `/api/custom-fields/sets/${id}`), 'Set deleted'));
  const moveSet = async (id, by) => {
    const ids = ((await api('GET', `/api/custom-fields/sets?entity=${st.entity}`)).body || []).map((x) => x.id);
    const k = ids.indexOf(id); const j = k + by;
    if (k < 0 || j < 0 || j >= ids.length) return;
    [ids[k], ids[j]] = [ids[j], ids[k]];
    done(await api('PUT', '/api/custom-fields/sets/order', { entity: st.entity, order: ids }), 'Order saved');
  };
  each('cf-set-up', (id) => moveSet(id, -1));
  each('cf-set-down', (id) => moveSet(id, 1));
  each('cf-def-add', async (setId) => {
    const body = await definitionForm(st.entity, setId || null, null, await itemsOf(st.entity));
    if (body) done(await api('POST', '/api/custom-fields/definitions', body), 'Field created');
  });
  each('cf-def-edit', async (id) => {
    const d = (await defsOf()).find((x) => x.id === id);
    const body = await definitionForm(st.entity, d?.set_id, d, await itemsOf(st.entity));
    if (body) done(await api('PATCH', `/api/custom-fields/definitions/${id}`, body, { ifMatch: versionOf(d) }), 'Field saved');
  });
  each('cf-def-active', async (id) => {
    const d = (await defsOf()).find((x) => x.id === id);
    done(await api('PATCH', `/api/custom-fields/definitions/${id}`, { isActive: !d.is_active }, { ifMatch: versionOf(d) }), d.is_active ? 'Field deactivated' : 'Field activated');
  });
  each('cf-def-del', async (id) => done(await api('DELETE', `/api/custom-fields/definitions/${id}`), 'Field deleted'));
  const moveDef = async (id, by) => {
    const defs = await defsOf();
    const d = defs.find((x) => x.id === id);
    const same = defs.filter((x) => (x.set_id || '') === (d.set_id || ''));
    const k = same.indexOf(d); const j = k + by;
    if (j < 0 || j >= same.length) return;
    const ids = defs.map((x) => x.id);
    const a = ids.indexOf(same[k].id); const b = ids.indexOf(same[j].id);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    done(await api('PUT', '/api/custom-fields/definitions/order', { entity: st.entity, order: ids }), 'Order saved');
  };
  each('cf-def-up', (id) => moveDef(id, -1));
  each('cf-def-down', (id) => moveDef(id, 1));
}

/**
 * A grouped set's entries as rows: one input per field, a row per entry,
 * with add and remove. Resolves to the list of entries, or null.
 */
export function groupedEditor(title, defs, entries) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    const cell = (d, v) => {
      if (d.type === 'SELECTION') return `<select data-f="${esc(d.id)}"><option value=""></option>${(d.options || []).map((o) => `<option value="${esc(o.id)}" ${o.id === v ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      if (d.type === 'CHECKBOX') return `<select data-f="${esc(d.id)}"><option value=""></option><option value="true" ${v === true ? 'selected' : ''}>yes</option><option value="false" ${v === false ? 'selected' : ''}>no</option></select>`;
      const t = d.type === 'NUMBER' ? 'number' : d.type === 'DATE' ? 'date' : 'text';
      return `<input data-f="${esc(d.id)}" type="${t}" ${t === 'number' ? 'step="any"' : ''} value="${esc(v ?? '')}">`;
    };
    const row = (g = {}) => `<tr>${defs.map((d) => `<td>${cell(d, g[d.id])}</td>`).join('')}<td><button type="button" class="link" data-remove>remove</button></td></tr>`;
    dlg.innerHTML = `<form method="dialog" class="card wide"><h2>${esc(title)}</h2>
      <table class="grouped-editor"><thead><tr>${defs.map((d) => `<th>${esc(d.name)}${d.usage?.required ? ' *' : ''}</th>`).join('')}<th></th></tr></thead>
      <tbody>${(entries || []).map(row).join('')}</tbody></table>
      <button type="button" class="secondary" data-add>Add row</button>
      <menu class="dialog-actions"><button value="cancel" class="secondary">Cancel</button><button value="ok">Save</button></menu></form>`;
    document.body.appendChild(dlg);
    const tbody = dlg.querySelector('tbody');
    dlg.querySelector('[data-add]').addEventListener('click', () => tbody.insertAdjacentHTML('beforeend', row()));
    tbody.addEventListener('click', (e) => { if (e.target.matches('[data-remove]')) e.target.closest('tr').remove(); });
    dlg.addEventListener('close', () => {
      const out = [...tbody.querySelectorAll('tr')].map((tr) => Object.fromEntries([...tr.querySelectorAll('[data-f]')]
        .filter((x) => x.value !== '').map((x) => [x.dataset.f, x.value])))
        .filter((g) => Object.keys(g).length);
      dlg.remove();
      resolve(dlg.returnValue === 'ok' ? out : null);
    });
    dlg.showModal();
  });
}

