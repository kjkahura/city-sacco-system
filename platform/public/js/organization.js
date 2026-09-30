/**
 * Organization: details, branding, the end of day, branches and centres,
 * holidays, channels, ID templates, rates, currencies, custom fields and
 * product documents.
 */

import { $, S, api, day, el, esc, toast, today } from './base.js';
import { ask, card, table, view } from './ui.js';
import { branchDetail } from './accounts.js';
import { clientsSetup } from './groups.js';
import { opt } from './products.js';
import { fieldsCard, groupedEditor, wireFields } from './fields.js';

// --------------------------------------------------------------------------
// Organization (the reference platform's Administration: organization details, branding,
// end of day, branches and centres, holidays, channels, ID templates, rates,
// currencies, custom fields and product documents)
// --------------------------------------------------------------------------

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const listOf = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);
const rolesOf = (v) => { const l = listOf(v).map((x) => x.toUpperCase()); return l.length ? l : null; };

export async function fileBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let k = 0; k < bytes.length; k += 1) bin += String.fromCharCode(bytes[k]);
  return btoa(bin);
}

/** The logo on the login screen, for the SACCO typed or remembered. */
export async function showLoginLogo(tenant) {
  const img = el('login-logo');
  if (!img || !tenant) return;
  const r = await fetch('/api/organization/branding/logo', { headers: { 'x-tenant': tenant } }).catch(() => null);
  if (!r || !r.ok) { img.hidden = true; return; }
  img.src = URL.createObjectURL(await r.blob());
  img.hidden = false;
}

export async function showHeaderIcon() {
  const img = el('sacco-icon');
  if (!img) return;
  const r = await fetch('/api/organization/branding/icon', { headers: { 'x-tenant': S.tenant } }).catch(() => null);
  if (!r || !r.ok) { img.hidden = true; return; }
  img.src = URL.createObjectURL(await r.blob());
  img.hidden = false;
}

/**
 * A record's custom fields as a card, with an editor: one field per
 * definition in a standard set, a JSON list for a grouped set.
 */
export function customFieldsCard(cf) {
  if (!cf || !cf.definitions || !cf.definitions.length) return '';
  const sets = [...new Set(cf.definitions.map((d) => d.setId || ''))];
  const show = (d, v) => {
    if (v === undefined || v === null) return '—';
    if (d.type === 'SELECTION') return (d.options || []).find((o) => o.id === v)?.label || v;
    if (d.type === 'CHECKBOX') return v ? 'yes' : 'no';
    return v;
  };
  const body = sets.map((sid) => {
    const defs = cf.definitions.filter((d) => (d.setId || '') === sid);
    const vals = sid ? cf.values[sid] : cf.values;
    const title = defs[0].setName || 'Fields';
    if (Array.isArray(vals) || defs[0].setType === 'GROUPED') {
      const canEdit = defs.some((d) => d.isActive && d.usage.available && d.editable);
      return `<h3>${esc(title)}${canEdit ? ` <button class="link" data-cf-rows="${esc(sid)}">edit rows</button>` : ''}</h3>${table(defs.map((d) => ({ label: d.name, value: (g) => show(d, g[d.id]) })), vals || [], { empty: 'None' })}`;
    }
    return `<h3>${esc(title)}${cf.scores && cf.scores[sid] !== undefined ? ` <span class="badge">score ${cf.scores[sid]}</span>` : ''}</h3>
      <dl class="kv">${defs.map((d) => `<dt>${esc(d.name)}${d.usage.required ? ' *' : ''}</dt><dd>${esc(show(d, (vals || {})[d.id]))}</dd>`).join('')}</dl>`;
  }).join('');
  return `<div id="custom-fields">${card('Custom fields', `${body}<button class="secondary" id="cf-edit">Edit custom fields</button>`)}</div>`;
}

export function wireCustomFields(cf, entity, id, reload) {
  const b = $('#cf-edit');
  if (b) b.addEventListener('click', async () => {
    const defs = cf.definitions.filter((d) => d.isActive && d.usage.available && d.editable);
    const sets = [...new Set(defs.map((d) => d.setId || ''))];
    const fields = [];
    for (const sid of sets) {
      const sd = defs.filter((d) => (d.setId || '') === sid);
      const vals = sid ? cf.values[sid] : cf.values;
      // Grouped sets are edited as rows, from their own button on the card.
      if (sd[0].setType === 'GROUPED') continue;
      for (const d of sd) {
        const v = (vals || {})[d.id];
        const f = { label: `${d.setName ? `${d.setName}: ` : ''}${d.name}${d.usage.required ? ' (required)' : ''}`, name: `${sid}|${d.id}`, required: false };
        // More than 20 options: a searchable list, as the reference platform's form has.
        if (d.type === 'SELECTION' && (d.options || []).length > 20) { f.datalist = d.options.map((o) => [o.id, o.label]); f.value = v ?? ''; f.hint = 'Type to search the options'; }
        else if (d.type === 'SELECTION') { f.options = ['', ...(d.options || []).map((o) => o.id)]; f.value = v ?? ''; f.hint = (d.options || []).map((o) => `${o.id} = ${o.label}`).join(', '); }
        else if (d.type === 'CHECKBOX') { f.options = ['', 'true', 'false']; f.value = v === undefined ? '' : String(v); }
        else if (d.type === 'NUMBER') { f.type = 'number'; f.step = 'any'; f.value = v ?? ''; }
        else if (d.type === 'DATE') { f.type = 'date'; f.value = v ?? ''; }
        else { f.value = v ?? ''; if (d.format) f.hint = `Format ${d.format}`; }
        fields.push(f);
      }
    }
    if (!fields.length) return toast('No custom fields you may edit here', true);
    const d = await ask(fields, 'Custom fields');
    if (!d) return;
    const patch = {};
    for (const [k, v] of Object.entries(d)) {
      const [sid, fid] = k.split('|');
      if (!sid) { patch[fid] = v === '' ? null : v; continue; }
      patch[sid] = patch[sid] || {};
      patch[sid][fid] = v === '' ? null : v;
    }
    const res = await api('PUT', `/api/custom-fields/values/${entity}/${id}`, patch);
    toast(res.ok ? 'Custom fields saved' : res.error, !res.ok);
    if (res.ok) reload();
  });
  document.querySelectorAll('#custom-fields [data-cf-rows]').forEach((btn) => btn.addEventListener('click', async () => {
    const sid = btn.dataset.cfRows;
    const defs = cf.definitions.filter((x) => x.setId === sid && x.isActive && x.usage.available && x.editable);
    const rows = await groupedEditor(defs[0]?.setName || sid, defs, cf.values[sid] || []);
    if (!rows) return;
    const res = await api('PUT', `/api/custom-fields/values/${entity}/${id}`, { [sid]: rows });
    toast(res.ok ? 'Custom fields saved' : res.error, !res.ok);
    if (res.ok) reload();
  }));
}

export async function orgView() {
  const admin = S.user.role === 'TENANT_ADMIN';
  const manage = ['TENANT_ADMIN', 'MANAGER'].includes(S.user.role);
  const [org, eodS, branches, centres, cal, chans, idt, rates, curs] = await Promise.all([
    api('GET', '/api/organization'), api('GET', '/api/organization/eod'), api('GET', '/api/branches'), api('GET', '/api/centres'),
    api('GET', '/api/holidays'), api('GET', '/api/transaction-channels'), api('GET', '/api/id-templates'), api('GET', '/api/index-rates'),
    api('GET', '/api/currencies'),
  ]);
  const fieldsHtml = await fieldsCard(manage);
  if (!org.ok) throw new Error(org.error);
  const o = org.body;
  const e = eodS.body || {};
  const c = cal.body || { general: [], branches: [], currencies: [], nonWorkingDays: [] };
  const holidayRows = [...c.general, ...c.branches, ...c.currencies];
  const con = (x) => (!x ? 'unconstrained' : `${x.match}: ${x.filters.map((f) => (f.type === 'AMOUNT' ? `amount ${f.min ?? ''}–${f.max ?? ''}` : `${f.type.toLowerCase()} ${f.values.join('/')}`)).join(', ') || 'none'}`);
  view().innerHTML = `
    <div class="toolbar"><h1>Organization</h1></div>
    <p class="hint">The organization's setup, after the reference platform's Managing your Organization pages. Changes are audited.</p>
    <div class="grid">
      ${card('Organization details', `<dl class="kv" id="org-details">
        <dt>Institution name</dt><dd id="org-name">${esc(o.institutionName)}</dd>
        <dt>Base currency</dt><dd>${esc(o.currency)}</dd>
        <dt>Time zone</dt><dd id="org-tz">${esc(o.timeZone)}</dd>
        <dt>Date format</dt><dd>${esc(o.localDateFormat)} · ${esc(o.localDateTimeFormat)}</dd>
        <dt>Decimal mark</dt><dd>${esc(o.decimalMark)}</dd>
        <dt>Address</dt><dd>${esc([o.contact.streetAddress, o.contact.city, o.contact.region, o.contact.postcode, o.contact.country].filter(Boolean).join(', ') || '—')}</dd>
        <dt>Phone · email</dt><dd>${esc(o.contact.phone || '—')} · ${esc(o.contact.email || '—')}</dd></dl>
        ${admin ? '<button class="secondary" id="org-edit">Edit details</button>' : ''}`)}
      ${card('Branding', `<p class="hint">The logo shows on the sign-in screen (best 300 × 50, transparent PNG); the icon at the top left (16 × 16 or a larger square).</p>
        <dl class="kv"><dt>Logo</dt><dd id="brand-logo">${o.branding.logo ? 'set' : 'none'}</dd><dt>Icon</dt><dd>${o.branding.icon ? 'set' : 'none'}</dd></dl>
        ${admin ? '<button class="secondary" data-brand="logo">Upload logo</button> <button class="secondary" data-brand="icon">Upload icon</button>' : ''}`)}
      ${card('End of day', `<dl class="kv">
        <dt>Mode</dt><dd id="eod-mode">${esc(e.mode)}</dd>
        <dt>Runs at</dt><dd>${esc(e.eodHour)}:00 ${esc(e.timeZone)}${e.mode === 'MANUAL' ? ' (not while manual)' : ''}</dd>
        <dt>Accounting cutoff</dt><dd>${esc(e.accountingCutoff || 'none (the posting day)')}</dd>
        <dt>Retry loans left out hourly</dt><dd>${e.retryExcluded ? 'yes' : 'no'} (${esc(e.excludedLoans)} left out now)</dd></dl>
        ${admin ? '<button class="secondary" id="eod-edit">Edit</button>' : ''} ${admin && e.mode === 'MANUAL' ? '<button id="eod-run">Run now</button>' : ''}
        ${table([
    { label: 'Business date', value: (x) => day(x.business_date) },
    { label: 'Trigger', key: 'trigger' },
    { label: 'State', key: 'state' },
    { label: 'Failed jobs', num: true, key: 'failed_jobs' },
    { label: 'Loans left out', num: true, key: 'failed_loans' },
  ], (e.completions || []).slice(0, 5), { empty: 'No end of day recorded yet' })}`)}
    </div>
    <div id="org-clients"></div>
    ${card('Branches and centres', `<div id="org-branches">${table([
    { label: 'Code', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Status', key: 'status' },
    { label: 'Email', key: 'email' }, { label: 'Members', num: true, key: 'members' },
    { label: '', html: true, value: (b) => `<button class="link" data-branch-open="${esc(b.code)}">open</button>${manage ? ` <button class="link" data-branch="${esc(b.code)}">edit</button>` : ''}` },
  ], branches.body || [], { empty: 'No branches' })}</div>
    ${manage ? '<button class="secondary" id="branch-add">New branch</button>' : ''}
    <h3>Centres</h3><div id="org-centres">${table([
    { label: 'Code', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Branch', key: 'branch_code' }, { label: 'Status', key: 'status' },
    { label: 'Meeting day', value: (x) => (x.meeting_day === null ? '—' : DAYS[x.meeting_day]) }, { label: 'Members', num: true, key: 'members' },
    { label: '', html: true, value: (x) => (manage ? `<button class="link" data-centre="${esc(x.code)}">edit</button>` : '') },
  ], centres.body || [], { empty: 'No centres' })}</div>
    ${manage ? '<button class="secondary" id="centre-add">New centre</button>' : ''}`)}
    ${card('Holidays and non-working days', `<p id="non-working">Non-working days: <strong>${esc(c.nonWorkingDays.map((d) => DAYS[d]).join(', ') || 'none')}</strong></p>
    ${c.pendingSyncFrom ? `<p class="notice" id="calendar-pending">The calendar changed from ${esc(c.pendingSyncFrom)}: open loans are re-dated at the next end of day, or now with Sync.</p>` : ''}
    <div id="org-holidays">${table([
    { label: 'ID', key: 'id' }, { label: 'Description', key: 'description' }, { label: 'Date', key: 'date' },
    { label: 'Recurring', value: (h) => (h.recurring ? 'every year' : '') },
    { label: 'Scope', value: (h) => (h.scope === 'BRANCH' ? `branch ${h.branchCode}` : h.scope === 'CURRENCY' ? `currency ${h.currencyCode}` : 'organization') },
    { label: '', html: true, value: (h) => (manage ? `<button class="link" data-holiday="${esc(h.key)}">delete</button>` : '') },
  ], holidayRows, { empty: 'No holidays' })}</div>
    ${manage ? '<button class="secondary" id="holiday-add">Add holiday</button> <button class="secondary" id="nwd-edit">Non-working days</button> <button class="secondary" id="calendar-sync">Sync open loans</button>' : ''}`)}
    ${card('Transaction channels', `<div id="org-channels">${table([
    { label: '#', num: true, key: 'sort_order' }, { label: 'ID', key: 'id' }, { label: 'Name', key: 'name' }, { label: 'GL', key: 'gl_account_code' },
    { label: 'Roles', value: (x) => (x.usage_roles ? x.usage_roles.join(', ') : 'all users') },
    { label: 'Loans', value: (x) => con(x.loan_constraints) }, { label: 'Deposits', value: (x) => con(x.savings_constraints) },
    { label: 'Active', value: (x) => (x.is_active ? (x.is_default ? 'yes (default)' : 'yes') : 'no') },
    { label: '', html: true, value: (x) => (manage ? `<button class="link" data-channel="${esc(x.id)}">edit</button> <button class="link" data-channel-up="${esc(x.id)}">up</button>` : '') },
  ], chans.body || [], { empty: 'No channels' })}</div>
    ${manage ? '<button class="secondary" id="channel-add">New channel</button>' : ''}`)}
    <div class="grid">
      ${card('ID templates', `<div id="org-idt">${table([
    { label: 'ID', key: 'id' }, { label: 'Type', key: 'id_type' }, { label: 'Issued by', key: 'issuing_authority' }, { label: 'Template', key: 'mask' },
    { label: 'Mandatory', value: (t) => (t.mandatory ? 'yes' : '') }, { label: 'Attachments', value: (t) => (t.allow_attachments ? 'yes' : '') },
    { label: 'National ID', value: (t) => (t.national_id ? 'yes' : '') },
    { label: '', html: true, value: (t) => (manage ? `<button class="link" data-idt="${esc(t.id)}">edit</button>` : '') },
  ], idt.body?.templates || [], { empty: 'No ID templates' })}</div>
      <p class="hint">Other documents without a template: ${idt.body?.allowOther ? 'allowed' : 'not allowed'}. Template: # a digit, @ a letter, $ either.</p>
      ${manage ? '<button class="secondary" id="idt-add">New template</button> <button class="secondary" id="idt-other">Toggle Other</button>' : ''}`)}
      ${card('Rates', `<div id="org-rates">${table([
    { label: 'Source', key: 'id' }, { label: 'Name', key: 'name' }, { label: 'Kind', key: 'kind' }, { label: 'Current', num: true, key: 'current_rate' },
    { label: '', html: true, value: (x) => (manage ? `<button class="link" data-rate="${esc(x.id)}">add value</button>` : '') },
  ], rates.body || [], { empty: 'No rate sources' })}</div>
      ${manage ? '<button class="secondary" id="rate-add">New rate source</button>' : ''}`)}
      ${card('Currencies', `<div id="org-currencies">${table([
    { label: 'Code', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Symbol', key: 'symbol' }, { label: 'Decimals', num: true, key: 'decimals' },
    { label: 'Exchange rate', value: (x) => (x.is_base ? 'BASE' : x.exchange_rate ? `buy ${x.exchange_rate.buy_rate} · sell ${x.exchange_rate.sell_rate}` : 'not set') },
    { label: '', html: true, value: (x) => (!x.is_base && manage ? `<button class="link" data-fx="${esc(x.code)}">set rate</button>` : '') },
  ], curs.body || [], { empty: 'No currencies' })}</div>
      ${admin ? '<button class="secondary" id="currency-add">Add currency</button>' : ''}`)}
    </div>
    ${fieldsHtml}
    ${card('Product documents', `<p class="hint">Templates per product, for an account or a transaction. Placeholders such as {{member.fullName}}, {{account.totalBalance}},
      {{transaction.amount}}, blocks {{#statement}}…{{/statement}} and {{#schedule}}…{{/schedule}}; a page break is &lt;div class="page-break"&gt;&lt;/div&gt;.</p>
      ${manage ? '<button class="secondary" id="doc-list">Templates of a product</button> <button class="secondary" id="doc-add">New template</button>' : ''}
      <div id="org-docs"></div>`)}`;

  clientsSetup($('#org-clients'));
  const done = (res, msg) => { toast(res.ok ? msg : res.error, !res.ok); if (res.ok) orgView(); };
  const on = (sel, fn) => { const b = $(sel); if (b) b.addEventListener('click', fn); };
  const each = (attr, fn) => view().querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', () => fn(b.dataset[attr.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())])));

  on('#org-edit', async () => {
    const d = await ask([
      { label: 'Institution name', name: 'institutionName', value: o.institutionName },
      { label: 'Time zone', name: 'timeZone', value: o.timeZone },
      { label: 'Base currency (only while nothing is posted)', name: 'currency', value: o.currency },
      { label: 'Date format', name: 'localDateFormat', value: o.localDateFormat },
      { label: 'Date and time format', name: 'localDateTimeFormat', value: o.localDateTimeFormat },
      { label: 'Decimal mark', name: 'decimalMark', options: ['.', ','], value: o.decimalMark },
      ...['streetAddress', 'city', 'region', 'postcode', 'country', 'phone', 'email'].map((k) => opt({ label: k.replace(/[A-Z]/g, (x) => ` ${x.toLowerCase()}`), name: k, value: o.contact[k] || '' })),
    ], 'Organization details');
    if (!d) return;
    const contact = Object.fromEntries(['streetAddress', 'city', 'region', 'postcode', 'country', 'phone', 'email'].map((k) => [k, d[k]]));
    done(await api('PUT', '/api/organization', { institutionName: d.institutionName, timeZone: d.timeZone, currency: d.currency,
      localDateFormat: d.localDateFormat, localDateTimeFormat: d.localDateTimeFormat, decimalMark: d.decimalMark, contact }), 'Organization saved');
  });
  each('brand', async (kind) => {
    const d = await ask([{ label: `${kind} (PNG, JPEG, GIF or WebP, at most 512 KB)`, name: 'file', type: 'file' }], `Upload ${kind}`);
    if (!d || !d.file || !d.file.size) return;
    done(await api('PUT', `/api/organization/branding/${kind}`, { data: await fileBase64(d.file), type: d.file.type }), `${kind} uploaded`);
  });
  on('#eod-edit', async () => {
    const d = await ask([
      { label: 'Mode', name: 'mode', options: ['AUTOMATIC', 'MANUAL'], value: e.mode },
      opt({ label: 'Accounting cutoff (HH:MM, blank for none)', name: 'accountingCutoff', value: e.accountingCutoff || '' }),
      { label: 'Retry loans left out every hour', name: 'retryExcluded', options: ['true', 'false'], value: String(e.retryExcluded) },
    ], 'End of day');
    if (!d) return;
    done(await api('PUT', '/api/organization/eod', { mode: d.mode, accountingCutoff: d.accountingCutoff || null, retryExcluded: d.retryExcluded === 'true' }), 'End of day saved');
  });
  on('#eod-run', async () => {
    const d = await ask([opt({ label: 'Business date (blank: today)', name: 'businessDate', type: 'date' })], 'Run the end of day now');
    if (!d) return;
    const res = await api('POST', '/api/organization/eod/run', { businessDate: d.businessDate || undefined });
    done(res, res.ok ? `End of day ${res.body.completion ? res.body.completion.state.toLowerCase() : 'already run for that date'}` : '');
  });
  const branchForm = async (b = {}) => ask([
    ...(b.code ? [] : [{ label: 'ID (code)', name: 'code' }]),
    { label: 'Name', name: 'name', value: b.name || '' },
    opt({ label: 'Address', name: 'address', value: b.address || '' }), opt({ label: 'Phone', name: 'phone', value: b.phone || '' }),
    opt({ label: 'Email', name: 'email', value: b.email || '' }), opt({ label: 'Notes', name: 'notes', value: b.notes || '' }),
    ...(b.code ? [{ label: 'Status', name: 'status', options: ['ACTIVE', 'CLOSED'], value: b.status }] : []),
  ], b.code ? `Branch ${b.code}` : 'New branch');
  on('#branch-add', async () => { const d = await branchForm(); if (d) done(await api('POST', '/api/branches', d), 'Branch created'); });
  view().querySelectorAll('[data-branch-open]').forEach((b) => b.addEventListener('click', () => branchDetail(b.dataset.branchOpen)));
  each('branch', async (code) => {
    const b = (branches.body || []).find((x) => x.code === code);
    const d = await branchForm(b);
    if (d) done(await api('PATCH', `/api/branches/${code}`, d), 'Branch saved');
  });
  const centreForm = async (x = {}) => ask([
    ...(x.code ? [] : [{ label: 'ID (code)', name: 'code' }, { label: 'Branch code', name: 'branchId' }]),
    { label: 'Name', name: 'name', value: x.name || '' },
    { label: 'Weekly meeting day', name: 'meetingDay', options: ['', ...DAYS], value: x.meeting_day === null || x.meeting_day === undefined ? '' : DAYS[x.meeting_day] },
    opt({ label: 'Address', name: 'address', value: x.address || '' }),
    ...(x.code ? [{ label: 'Status', name: 'status', options: ['ACTIVE', 'INACTIVE'], value: x.status }] : []),
  ], x.code ? `Centre ${x.code}` : 'New centre');
  const md = (v) => (v === '' ? null : DAYS.indexOf(v));
  on('#centre-add', async () => { const d = await centreForm(); if (d) done(await api('POST', '/api/centres', { ...d, meetingDay: md(d.meetingDay) }), 'Centre created'); });
  each('centre', async (code) => {
    const x = (centres.body || []).find((y) => y.code === code);
    const d = await centreForm(x);
    if (d) done(await api('PATCH', `/api/centres/${code}`, { ...d, meetingDay: md(d.meetingDay) }), 'Centre saved');
  });
  on('#holiday-add', async () => {
    const d = await ask([
      { label: 'Description', name: 'description' }, { label: 'Date', name: 'date', type: 'date' },
      { label: 'Recurring every year', name: 'recurring', options: ['false', 'true'] },
      opt({ label: 'ID (blank: generated)', name: 'id' }),
      opt({ label: 'Branch code (a branch holiday)', name: 'branchId' }), opt({ label: 'Currency (a currency holiday)', name: 'currencyCode' }),
    ], 'Add holiday');
    if (!d) return;
    done(await api('POST', '/api/holidays', { ...d, recurring: d.recurring === 'true', id: d.id || null, branchId: d.branchId || null, currencyCode: d.currencyCode || null }), 'Holiday added');
  });
  each('holiday', async (key) => done(await api('DELETE', `/api/holidays/${key}`), 'Holiday deleted'));
  on('#nwd-edit', async () => {
    const d = await ask(DAYS.map((n, k) => ({ label: n, name: String(k), options: ['working', 'non-working'], value: c.nonWorkingDays.includes(k) ? 'non-working' : 'working' })), 'Non-working days');
    if (!d) return;
    done(await api('PUT', '/api/holidays/non-working-days', { days: Object.entries(d).filter(([, v]) => v === 'non-working').map(([k]) => Number(k)) }), 'Non-working days saved');
  });
  on('#calendar-sync', async () => { const res = await api('POST', '/api/holidays/sync', {}); done(res, res.ok ? `${res.body.installments || 0} installment(s) re-dated` : ''); });
  const channelForm = async (x = {}) => ask([
    ...(x.id ? [] : [{ label: 'ID (no spaces)', name: 'id' }]),
    { label: 'Name', name: 'name', value: x.name || '' },
    { label: 'Type', name: 'channelType', options: ['CASH', 'MOBILE', 'TRANSFER', 'CHEQUE', 'INTERNAL', 'PAYROLL'], value: x.channel_type || 'CASH' },
    { label: 'GL account', name: 'glAccount', value: x.gl_account_code || '' },
    opt({ label: 'Roles that may use it (comma separated; blank: all users)', name: 'usageRoles', value: (x.usage_roles || []).join(', ') }),
    { label: 'Loan constraints (JSON, blank: unconstrained)', name: 'loanConstraints', type: 'textarea', rows: 3, required: false,
      value: x.loan_constraints ? JSON.stringify(x.loan_constraints) : '', hint: '{"match":"ALL","filters":[{"type":"AMOUNT","max":50000},{"type":"TYPE","values":["REPAYMENT"]}]}' },
    { label: 'Deposit constraints (JSON, blank: unconstrained)', name: 'savingsConstraints', type: 'textarea', rows: 3, required: false,
      value: x.savings_constraints ? JSON.stringify(x.savings_constraints) : '', hint: 'Types DEPOSIT, WITHDRAWAL; products by ID' },
    ...(x.id ? [{ label: 'Active', name: 'isActive', options: ['true', 'false'], value: String(x.is_active) }] : []),
  ], x.id ? `Channel ${x.id}` : 'New channel');
  const channelBody = (d) => {
    const parse = (v) => (v ? JSON.parse(v) : null);
    return { ...d, usageRoles: rolesOf(d.usageRoles), loanConstraints: parse(d.loanConstraints), savingsConstraints: parse(d.savingsConstraints),
      ...(d.isActive !== undefined ? { isActive: d.isActive === 'true' } : {}) };
  };
  on('#channel-add', async () => {
    const d = await channelForm();
    if (!d) return;
    try { done(await api('POST', '/api/transaction-channels', channelBody(d)), 'Channel created'); } catch { toast('Constraints must be JSON', true); }
  });
  each('channel', async (id) => {
    const d = await channelForm((chans.body || []).find((x) => x.id === id));
    if (!d) return;
    try { done(await api('PATCH', `/api/transaction-channels/${id}`, channelBody(d)), 'Channel saved'); } catch { toast('Constraints must be JSON', true); }
  });
  each('channel-up', async (id) => {
    const ids = (chans.body || []).map((x) => x.id);
    const k = ids.indexOf(id);
    if (k > 0) [ids[k - 1], ids[k]] = [ids[k], ids[k - 1]];
    done(await api('PUT', '/api/transaction-channels/order', { order: ids }), 'Order saved');
  });
  const idtForm = (t = {}) => ask([
    ...(t.id ? [] : [opt({ label: 'Template ID (letters and digits)', name: 'id' })]),
    { label: 'ID type', name: 'idType', value: t.id_type || '' }, { label: 'Issuing authority', name: 'issuingAuthority', value: t.issuing_authority || '' },
    { label: 'ID document template', name: 'mask', value: t.mask || '', hint: '# a digit, @ a letter, $ either' },
    { label: 'Mandatory for members', name: 'mandatory', options: ['false', 'true'], value: String(Boolean(t.mandatory)) },
    { label: 'Allow attachments', name: 'allowAttachments', options: ['false', 'true'], value: String(Boolean(t.allow_attachments)) },
    { label: 'Fills the member\'s national ID', name: 'nationalId', options: ['false', 'true'], value: String(Boolean(t.national_id)) },
  ], t.id ? `ID template ${t.id}` : 'New ID template');
  const idtBody = (d) => ({ ...d, id: d.id || undefined, mandatory: d.mandatory === 'true', allowAttachments: d.allowAttachments === 'true', nationalId: d.nationalId === 'true' });
  on('#idt-add', async () => { const d = await idtForm(); if (d) done(await api('POST', '/api/id-templates', idtBody(d)), 'Template created'); });
  each('idt', async (id) => { const d = await idtForm((idt.body?.templates || []).find((t) => t.id === id)); if (d) done(await api('PATCH', `/api/id-templates/${id}`, idtBody(d)), 'Template saved'); });
  on('#idt-other', async () => done(await api('PUT', '/api/id-templates/other', { allow: !idt.body?.allowOther }), 'Saved'));
  on('#rate-add', async () => {
    const d = await ask([{ label: 'ID', name: 'id' }, { label: 'Name', name: 'name' }, { label: 'Kind', name: 'kind', options: ['INTEREST', 'VAT', 'WITHHOLDING'] }, opt({ label: 'Notes', name: 'notes' })], 'New rate source');
    if (d) done(await api('POST', '/api/index-rates', d), 'Rate source created');
  });
  each('rate', async (id) => {
    const d = await ask([{ label: 'Rate (%)', name: 'rate', type: 'number', step: '0.0001' }, { label: 'Valid from', name: 'validFrom', type: 'date', value: today() }], `New value for ${id}`);
    if (d) done(await api('POST', `/api/index-rates/${id}/rates`, { rate: Number(d.rate), validFrom: d.validFrom }), 'Rate saved');
  });
  on('#currency-add', async () => {
    const pre = await api('GET', '/api/currencies/presets');
    const d = await ask([{ label: 'Currency (ISO 4217)', name: 'code', options: (pre.body || []).map((x) => x.code), value: 'USD' },
      opt({ label: 'Symbol (blank: standard)', name: 'symbol' }), { label: 'Symbol position', name: 'symbolPosition', options: ['BEFORE', 'AFTER'] }], 'Add currency');
    if (d) done(await api('POST', '/api/currencies', { code: d.code, symbol: d.symbol || undefined, symbolPosition: d.symbolPosition }), 'Currency added');
  });
  each('fx', async (code) => {
    const d = await ask([{ label: `Buy rate (${code} in base)`, name: 'buyRate', type: 'number', step: 'any' }, { label: 'Sell rate', name: 'sellRate', type: 'number', step: 'any' }], `Exchange rate for ${code}`);
    if (d) done(await api('POST', `/api/currencies/${code}/exchange-rates`, { buyRate: Number(d.buyRate), sellRate: Number(d.sellRate) }), 'Exchange rate set');
  });
  wireFields(orgView);
  const docProduct = () => ask([{ label: 'Product kind', name: 'kind', options: ['loan', 'savings'] }, { label: 'Product ID', name: 'productId' }], 'Product');
  const showDocs = async (kind, productId) => {
    const r = await api('GET', `/api/documents/templates/${kind}/${productId}`);
    if (!r.ok) return toast(r.error, true);
    $('#org-docs').innerHTML = `<h3>${esc(kind)} product ${esc(productId)}</h3>${table([
      { label: 'Name', key: 'name' }, { label: 'For', key: 'availability' },
      { label: '', html: true, value: (x) => `<button class="link" data-doc-edit="${esc(x.id)}">edit</button> <button class="link" data-doc-del="${esc(x.id)}">delete</button>` },
    ], r.body, { empty: 'No templates' })}`;
    view().querySelectorAll('[data-doc-edit]').forEach((b) => b.addEventListener('click', async () => {
      const t = (await api('GET', `/api/documents/templates/${b.dataset.docEdit}`)).body;
      const d = await ask([{ label: 'Name', name: 'name', value: t.name }, { label: 'Content (HTML with placeholders)', name: 'content', type: 'textarea', rows: 14, value: t.content }], `Template ${t.name}`);
      if (!d) return;
      const res = await api('PATCH', `/api/documents/templates/${t.id}`, d);
      toast(res.ok ? 'Template saved' : res.error, !res.ok);
      if (res.ok) showDocs(kind, productId);
    }));
    view().querySelectorAll('[data-doc-del]').forEach((b) => b.addEventListener('click', async () => {
      const res = await api('DELETE', `/api/documents/templates/${b.dataset.docDel}`);
      toast(res.ok ? 'Template deleted' : res.error, !res.ok);
      if (res.ok) showDocs(kind, productId);
    }));
    return null;
  };
  on('#doc-list', async () => { const d = await docProduct(); if (d) showDocs(d.kind, d.productId); });
  on('#doc-add', async () => {
    const d = await ask([{ label: 'Product kind', name: 'kind', options: ['loan', 'savings'] }, { label: 'Product ID', name: 'productId' },
      { label: 'Name', name: 'name' }, { label: 'For', name: 'availability', options: ['ACCOUNT', 'TRANSACTION'] },
      { label: 'Content (HTML with placeholders)', name: 'content', type: 'textarea', rows: 12, required: false,
        value: '<h1>{{organization.name}}</h1>\n<p>{{member.fullName}} · {{account.accountNo}}</p>' }], 'New document template');
    if (!d) return;
    const res = await api('POST', `/api/documents/templates/${d.kind}/${d.productId}`, { name: d.name, availability: d.availability, content: d.content });
    toast(res.ok ? 'Template created' : res.error, !res.ok);
    if (res.ok) showDocs(d.kind, d.productId);
  });
}
