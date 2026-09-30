/**
 * Report templates.
 */

import { $, S, api, esc, money, openFile, toast } from './base.js';
import { ask, card, table, view } from './ui.js';
import { can, roleCodes, usageRightsDialog } from './access.js';

// --------------------------------------------------------------------------
// Report templates (in place of the reference platform's Jasper reports)
// --------------------------------------------------------------------------

/** Ask for a template's parameters, then run it and show the result. */
async function runTemplate(t, recordId = null) {
  let parameters = {};
  if (t.parameters.length) {
    const d = await ask(t.parameters.map((p) => ({
      name: p.name, label: p.label || p.name, required: Boolean(p.required),
      type: p.type === 'DATE' ? 'date' : p.type === 'NUMBER' ? 'number' : 'text',
      ...(p.type === 'SELECTION' ? { options: ['', ...(p.options || [])] } : {}),
      ...(p.type === 'BOOLEAN' ? { options: ['', 'true', 'false'] } : {}),
      value: ['TODAY', 'MONTH_START', 'YEAR_START'].includes(p.default) ? '' : (p.default ?? ''),
      hint: p.default && ['TODAY', 'MONTH_START', 'YEAR_START'].includes(p.default) ? `Blank: ${p.default.toLowerCase().replace('_', ' ')}` : undefined,
    })), `Run ${t.name}`);
    if (!d) return;
    parameters = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== ''));
  }
  const body = { parameters, recordId };
  const r = await api('POST', `/api/report-templates/${t.id}/run`, body);
  if (!r.ok) return toast(r.error, true);
  const x = r.body;
  const dlg = document.createElement('dialog');
  dlg.id = 'report-run';
  const show = (v, c) => (c.num && typeof v === 'number' ? money(v) : v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v);
  dlg.innerHTML = `<div class="card wide"><h2>${esc(x.title)}</h2>
    <p class="hint">${Object.entries(x.parameters || {}).map(([k, v]) => `${esc(k)}: ${esc(v ?? '')}`).join(' · ')}</p>
    ${x.sections.map((s) => `${s.title ? `<h3>${esc(s.title)}</h3>` : ''}${s.type === 'TEXT' ? `<p>${esc(s.text)}</p>`
    : s.type === 'FIELDS' ? `<dl class="kv">${s.columns.map((c) => `<dt>${esc(c.label)}</dt><dd>${esc(show((s.rows[0] || {})[c.key], c))}</dd>`).join('')}</dl>`
      : table(s.columns.map((c) => ({ label: c.label, num: c.num, value: (row) => show(row[c.key], c) })), s.totals ? [...s.rows, Object.fromEntries(s.columns.map((c, i) => [c.key, s.totals[c.key] ?? (i === 0 ? 'Total' : '')]))] : s.rows)}
      ${s.truncated ? `<p class="hint">First ${s.rows.length} of ${s.total} rows.</p>` : ''}`).join('')}
    ${x.footer ? `<p class="hint">${esc(x.footer)}</p>` : ''}
    <menu class="dialog-actions">${['pdf', 'html', ...(can('EXPORT_TO_EXCEL') ? ['xlsx', 'csv'] : [])].map((f) => `<button class="secondary" data-rt-fmt="${f}">${f.toUpperCase()}</button>`).join('')}
      <button id="rt-close">Close</button></menu></div>`;
  document.body.appendChild(dlg);
  $('#rt-close', dlg).addEventListener('click', () => { dlg.close(); dlg.remove(); });
  dlg.querySelectorAll('[data-rt-fmt]').forEach((b) => b.addEventListener('click', async () => {
    const fmt = b.dataset.rtFmt;
    const res = await fetch(`/api/report-templates/${t.id}/run?format=${fmt}`, {
      method: 'POST', headers: { authorization: `Bearer ${S.access}`, 'x-tenant': S.tenant, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) return toast(`Could not make the ${fmt.toUpperCase()}`, true);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    if (fmt === 'html') a.target = '_blank'; else a.download = `${String(t.name).replace(/\s+/g, '-').toLowerCase()}.${fmt}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return null;
  }));
  dlg.showModal();
}

/** Other reports: the templates not tied to a record, and managing all templates. */
export async function templatesReport(out) {
  const r = await api('GET', '/api/report-templates');
  if (!r.ok) { out.innerHTML = `<p class="error">${esc(r.error)}</p>`; return; }
  const list = r.body;
  const manage = can('CREATE_REPORTS', 'EDIT_REPORTS', 'DELETE_REPORTS');
  out.innerHTML = `<p class="hint">Report templates are JSON files: sections built from custom views and the built-in reports, with parameters.
    Member, loan, deposit, branch and centre templates run from their record's page; Other templates run here. Each runs with the reader's own permissions.</p>
    <div id="rt-list">${table([{ label: 'Name', key: 'name' }, { label: 'On', value: (t) => t.reportType.toLowerCase() }, { label: 'Description', key: 'description' },
    { label: 'Shared', value: (t) => (t.usageRights.allUsers ? 'all users' : t.usageRights.roles.join(', ')) },
    { label: '', html: true, value: (t) => [t.reportType === 'OTHER' ? `<button class="link" data-rt-run="${esc(t.id)}">run</button>` : '',
      `<button class="link" data-rt-dl="${esc(t.id)}">template</button>`,
      can('EDIT_REPORTS') ? `<button class="link" data-rt-edit="${esc(t.id)}">replace</button> <button class="link" data-rt-share="${esc(t.id)}">share</button>` : '',
      can('DELETE_REPORTS') ? `<button class="link" data-rt-del="${esc(t.id)}">delete</button>` : ''].filter(Boolean).join(' ') }], list, { empty: 'No report templates yet' })}</div>
    ${manage && can('CREATE_REPORTS') ? `<div class="toolbar"><label>Upload a template<input type="file" id="rt-file" accept=".json,application/json"></label>
      <label>On<select id="rt-type">${['OTHER', 'MEMBER', 'LOAN', 'DEPOSIT', 'BRANCH', 'CENTRE'].map((x) => `<option>${x}</option>`).join('')}</select></label></div>` : ''}`;
  const reload = () => templatesReport(out);
  const on = (attr, fn) => out.querySelectorAll(`[${attr}]`).forEach((b) => b.addEventListener('click', () => fn(list.find((t) => t.id === b.getAttribute(attr)))));
  on('data-rt-run', (t) => runTemplate(t));
  on('data-rt-dl', (t) => openFile(`/api/report-templates/${t.id}/template`, `${t.fileName || t.name}.json`.replace(/\.json\.json$/, '.json'), { save: true }));
  on('data-rt-del', async (t) => {
    if (!window.confirm(`Delete ${t.name}?`)) return;
    const d = await api('DELETE', `/api/report-templates/${t.id}`);
    toast(d.ok ? 'Template deleted' : d.error, !d.ok);
    if (d.ok) reload();
  });
  on('data-rt-share', async (t) => {
    const rights = await usageRightsDialog(`Who sees ${t.name}`, t.usageRights, await roleCodes());
    if (!rights) return;
    const d = await api('PATCH', `/api/report-templates/${t.id}`, { usageRights: rights });
    toast(d.ok ? 'Usage rights saved' : d.error, !d.ok);
    if (d.ok) reload();
  });
  const pick = () => new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = '.json,application/json';
    i.addEventListener('change', () => resolve(i.files[0] || null));
    i.click();
  });
  const readJson = async (file) => { try { return JSON.parse(await file.text()); } catch { toast('That file is not JSON', true); return null; } };
  on('data-rt-edit', async (t) => {
    const file = await pick();
    const def = file && await readJson(file);
    if (!def) return;
    const d = await api('PATCH', `/api/report-templates/${t.id}`, { definition: def, fileName: file.name });
    toast(d.ok ? 'Template replaced' : d.error, !d.ok);
    if (d.ok) reload();
  });
  $('#rt-file', out)?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const def = file && await readJson(file);
    if (!def) return;
    const d = await api('POST', '/api/report-templates', {
      name: def.name || def.title || file.name.replace(/\.json$/i, ''), reportType: $('#rt-type', out).value,
      description: def.description || null, definition: def, fileName: file.name,
    });
    toast(d.ok ? `Template ${d.body.name} added` : d.error, !d.ok);
    if (d.ok) reload();
  });
}

/** The Reports card on a record's page: the templates for that kind of record. */
export async function entityReports(type, recordId) {
  if (!can('VIEW_REPORTS')) return;
  const r = await api('GET', `/api/report-templates?type=${type}`);
  if (!r.ok || !r.body.length) return;
  const box = document.createElement('div');
  box.id = 'entity-reports';
  box.innerHTML = card('Reports', `<ul>${r.body.map((t) => `<li><button class="link" data-er="${esc(t.id)}">${esc(t.name)}</button>${t.description ? ` <span class="hint">${esc(t.description)}</span>` : ''}</li>`).join('')}</ul>`);
  view().appendChild(box);
  box.querySelectorAll('[data-er]').forEach((b) => b.addEventListener('click', () => runTemplate(r.body.find((t) => t.id === b.dataset.er), recordId)));
}
