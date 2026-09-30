/**
 * Data: import, backups, the dictionary and the extract.
 */

import { $, S, api, apiRaw, day, el, esc, money, openFile, toast } from './base.js';
import { ask, card, table, view } from './ui.js';
import { render } from './nav.js';

// --------------------------------------------------------------------------
// Data: import, backups, dictionary, extract (the reference platform's Data Management)
// --------------------------------------------------------------------------

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const dataState = { table: 'members' };

export async function dataView() {
  const role = S.user.role;
  const owner = role === 'TENANT_ADMIN';
  const importer = ['TENANT_ADMIN', 'MANAGER'].includes(role);
  const [imps, backups, dict, streams, prereq] = await Promise.all([
    ['TENANT_ADMIN', 'MANAGER', 'AUDITOR'].includes(role) ? api('GET', '/api/data-imports') : Promise.resolve({ ok: false, body: [] }),
    owner ? api('GET', '/api/database/backup') : Promise.resolve({ ok: false, body: [] }),
    api('GET', '/api/data-dictionary'),
    ['TENANT_ADMIN', 'ACCOUNTANT', 'AUDITOR'].includes(role) ? api('GET', '/api/extract') : Promise.resolve({ ok: false, body: [] }),
    importer ? api('GET', '/api/data-imports/prerequisites') : Promise.resolve({ ok: false, body: [] }),
  ]);
  const missing = (prereq.ok ? prereq.body : []).filter((p) => !p.ok);
  const tables = dict.ok ? dict.body.tables : [];
  const t = tables.find((x) => x.name === dataState.table) || tables[0];
  const importRows = imps.ok ? imps.body : [];
  view().innerHTML = `
    <div class="toolbar"><h1>Data</h1></div>
    <p class="hint">Data import, database backups, the data dictionary and the incremental extract, after the reference platform's Data Management pages.</p>
    ${importer ? card('Import from Excel', `
      <p class="hint">Download the template, fill in the sheets you need, and upload it. The template also reads the reference platform's layout
      (Clients, Savings Accounts, Loan Schedules, Loan Transactions, Chart of Accounts, dd.MM.yyyy dates). The upload is checked
      row by row and run without saving anything; nothing is created until it is approved.</p>
      ${missing.length ? `<p class="notice" id="imp-prereq">Set up first: ${esc(missing.map((p) => p.item).join(', '))}.</p>` : ''}
      <button class="secondary" id="imp-template">Download template</button>
      <label>Workbook (.xlsx, up to 5 MB)<input type="file" id="imp-file" accept=".xlsx,${XLSX_TYPE}"></label>
      <button id="imp-upload">Upload and check</button>
      <div id="imp-progress" hidden><progress max="100" value="0"></progress> <span class="hint"></span></div>
      <div id="imp-list">${table([
    { label: 'Uploaded', value: (x) => String(x.created_at).slice(0, 16).replace('T', ' ') },
    { label: 'File', key: 'file_name' },
    { label: 'Migration date', value: (x) => day(x.as_of) },
    { label: 'Status', value: (x) => (['QUEUED', 'IN_PROGRESS'].includes(x.status) ? `${x.status} ${x.progress}%` : x.import_state === 'DRAFT' ? 'Draft (pending approval)' : x.import_state === 'REVERTED' ? 'Reverted (rejected)' : x.status) },
    { label: 'Errors', num: true, value: (x) => (x.errors || []).length },
    { label: 'Warnings', num: true, value: (x) => (x.warnings || []).length },
    { label: 'By', key: 'created_by' },
    { label: '', html: true, value: (x) => `<button class="link" data-imp="${esc(x.id)}">review</button>` },
  ], importRows, { empty: 'No imports yet' })}</div>`) : ''}
    ${owner ? card('Database backup', `
      <p class="hint">A ZIP of one CSV per table from one snapshot, with the schema and the data dictionary. One runs at a time; each is kept for 30 days.
      Member PINs and portal sessions are never included.</p>
      <button id="bk-run">Back up now</button> <button class="secondary" id="bk-some">Back up some tables…</button>
      <div id="bk-list">${table([
    { label: 'Requested', value: (x) => String(x.created_at).slice(0, 16).replace('T', ' ') },
    { label: 'Status', key: 'status' },
    { label: 'Tables', value: (x) => (x.tables ? x.tables.join(', ') : 'all') },
    { label: 'From', value: (x) => (x.from_date ? String(x.from_date).slice(0, 16).replace('T', ' ') : '') },
    { label: 'Size', num: true, value: (x) => (x.file_size ? `${Math.ceil(x.file_size / 1024)} KB` : '') },
    { label: 'Expires', value: (x) => day(x.expires_at) },
    { label: '', html: true, value: (x) => (x.status === 'COMPLETE' ? `<button class="link" data-bk="${esc(x.id)}" data-name="${esc(x.file_name)}">download</button>` : esc(x.error || '')) },
  ], backups.ok ? backups.body : [], { empty: 'No backups yet' })}</div>`) : ''}
    ${card('Data dictionary', `
      <p class="hint">${esc(dict.body?.conventions?.dates || '')}</p>
      <label>Table<select id="dd-table">${tables.map((x) => `<option ${x.name === t?.name ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <p id="dd-desc">${esc(t?.description || '')}</p>
      <div id="dd-cols">${t ? table([
    { label: 'Column', key: 'name' }, { label: 'Type', key: 'type' },
    { label: 'Null', value: (c) => (c.nullable ? 'yes' : '') },
    { label: 'Key', value: (c) => (c.primaryKey ? 'PK' : c.references ? `→ ${c.references.table}.${c.references.column}` : '') },
    { label: 'Description', key: 'description' },
  ], t.columns) : ''}</div>
      <button class="secondary" id="dd-csv">Download as CSV</button>`)}
    ${streams.ok ? card('Incremental extract', `
      <p class="hint">For a data warehouse or Stitch: GET /api/extract/&lt;stream&gt;?cursor=… returns rows changed since the cursor, in order,
      with the next cursor. bin/tap-sacco.js is a Singer tap over it; run it with a user in the AUDITOR role.</p>
      ${table([{ label: 'Stream', key: 'stream' }, { label: 'Key', value: (x) => x.keyProperties.join(', ') },
    { label: 'Read on', key: 'replicationKey' }, { label: 'Holds', key: 'description' }], streams.body)}`) : ''}`;

  el('dd-table')?.addEventListener('change', (ev) => { dataState.table = ev.target.value; render(); });
  el('dd-csv')?.addEventListener('click', () => openFile('/api/data-dictionary?format=csv', 'data-dictionary.csv', { save: true }));
  el('imp-template')?.addEventListener('click', () => openFile('/api/data-imports/template', 'data-import-template.xlsx', { save: true }));
  el('imp-upload')?.addEventListener('click', async () => {
    const file = el('imp-file').files[0];
    if (!file) return toast('Choose a workbook first', true);
    const r = await apiRaw('POST', `/api/data-imports?fileName=${encodeURIComponent(file.name)}`, file, XLSX_TYPE);
    if (!r.ok) return toast(r.error, true);
    // The check runs in the background: show its progress until it is done.
    const bar = el('imp-progress');
    bar.hidden = false;
    let x = r.body;
    while (['QUEUED', 'IN_PROGRESS'].includes(x.status)) {
      $('progress', bar).value = x.progress || 0;
      $('span', bar).textContent = `${x.status === 'QUEUED' ? 'Queued' : 'Checking'}: ${x.progress || 0}%`;
      await new Promise((ok) => setTimeout(ok, 400));
      const g = await api('GET', `/api/data-imports/${x.id}`);
      if (!g.ok) return toast(g.error, true);
      x = g.body;
    }
    $('progress', bar).value = 100;
    toast(x.status === 'PENDING_APPROVAL' ? 'Checked: ready for review' : `${(x.errors || []).length} errors: download the workbook with the errors marked`, x.status !== 'PENDING_APPROVAL');
    await render();
    return showImport(x.id);
  });
  view().querySelectorAll('[data-imp]').forEach((b) => b.addEventListener('click', () => showImport(b.dataset.imp)));
  el('bk-run')?.addEventListener('click', async () => {
    const r = await api('POST', '/api/database/backup', {});
    toast(r.ok ? 'Backup started; it appears here when it is ready' : r.error, !r.ok);
    setTimeout(() => { if (S.view === 'data') render(); }, 1500);
  });
  el('bk-some')?.addEventListener('click', async () => {
    const d = await ask([
      { name: 'tables', label: 'Tables, comma separated', value: 'members, loan_accounts, savings_accounts' },
      { name: 'from', label: 'Only rows created or changed from (optional)', type: 'datetime-local', required: false },
    ], 'Back up some tables');
    if (!d) return;
    const r = await api('POST', '/api/database/backup', {
      tables: d.tables.split(',').map((x) => x.trim()).filter(Boolean),
      ...(d.from ? { createBackupFromDate: new Date(d.from).toISOString() } : {}),
    });
    toast(r.ok ? 'Backup started' : r.error, !r.ok);
    setTimeout(() => { if (S.view === 'data') render(); }, 1500);
  });
  view().querySelectorAll('[data-bk]').forEach((b) => b.addEventListener('click', () => openFile(`/api/database/backup/${b.dataset.bk}/file`, b.dataset.name, { save: true })));
}

async function showImport(id) {
  const r = await api('GET', `/api/data-imports/${id}`);
  if (!r.ok) return toast(r.error, true);
  const x = r.body;
  const owner = S.user.role === 'TENANT_ADMIN';
  const creates = x.summary?.created || x.summary?.creates || {};
  const dlg = document.createElement('dialog');
  dlg.id = 'import-review';
  const shown = x.import_state === 'DRAFT' ? 'Draft (pending approval)' : x.import_state === 'REVERTED' ? 'Reverted (rejected)' : x.status;
  dlg.innerHTML = `<div class="card wide"><h2>${esc(x.file_name)}: ${esc(shown)}</h2>
    <dl class="kv"><dt>Migration date</dt><dd>${esc(day(x.as_of))}</dd><dt>Uploaded by</dt><dd>${esc(x.created_by)}</dd>
    ${x.decided_by ? `<dt>Decided by</dt><dd>${esc(x.decided_by)} ${esc(x.decision_note || '')}</dd>` : ''}</dl>
    ${Object.keys(creates).length ? `<h3>${x.status === 'APPROVED' ? 'Created' : 'Will create'}</h3>${table([{ label: 'What', key: 'k' }, { label: 'Count', num: true, key: 'n' }],
    Object.entries(creates).map(([k, n]) => ({ k, n })))}` : ''}
    ${(x.warnings || []).length ? `<h3>Warnings</h3>${table([{ label: 'Sheet', key: 'sheet' }, { label: 'Row', key: 'row' }, { label: 'Warning', key: 'message' }], x.warnings)}` : ''}
    ${(x.errors || []).length ? `<h3>Errors</h3>${table([{ label: 'Sheet', key: 'sheet' }, { label: 'Row', key: 'row' }, { label: 'Column', key: 'column' }, { label: 'Error', key: 'message' }], x.errors.slice(0, 200))}` : ''}
    ${x.has_preview ? '<h3>Preview</h3><p class="hint">The records approval will create, as they will be.</p><div id="imp-kinds" class="toolbar"></div><div id="imp-preview"></div>' : ''}
    <menu class="dialog-actions">
      ${x.has_error_file ? '<button class="secondary" data-act="errors">Download with errors marked</button>' : ''}
      ${owner && ['PENDING_APPROVAL', 'INVALID'].includes(x.status) ? '<button class="secondary" data-act="reject">Reject</button>' : ''}
      ${owner && x.status === 'PENDING_APPROVAL' ? '<button data-act="approve">Approve</button>' : ''}
      <button class="secondary" data-act="close">Close</button>
    </menu></div>`;
  document.body.appendChild(dlg);
  if (x.has_preview) {
    const k = await api('GET', `/api/data-imports/${x.id}/preview`);
    const kinds = Object.entries(k.body?.kinds || {}).filter(([, n]) => n > 0);
    $('#imp-kinds', dlg).innerHTML = kinds.map(([kind, n]) => `<button class="secondary" data-kind="${esc(kind)}">${esc(kind)} (${n})</button>`).join(' ');
    const show = async (kind) => {
      const p = await api('GET', `/api/data-imports/${x.id}/preview?kind=${encodeURIComponent(kind)}&limit=100`);
      const items = p.body?.items || [];
      const cols = Object.keys(items[0] || {}).filter((c) => c !== 'schedule');
      const box = $('#imp-preview', dlg);
      box.innerHTML = `${table(cols.map((c) => ({ label: c, value: (r) => (Array.isArray(r[c]) ? r[c].join('; ') : r[c]) })), items, { onRow: kind === 'loans' ? 'imp' : null })}
        ${p.body.total > items.length ? `<p class="hint">First ${items.length} of ${p.body.total}.</p>` : ''}<div id="imp-schedule"></div>`;
      if (kind === 'loans') {
        box.querySelectorAll('tr[data-row]').forEach((tr) => tr.addEventListener('click', () => {
          const l = items[Number(tr.dataset.row)];
          $('#imp-schedule', box).innerHTML = l.schedule ? `<h3>${esc(l.accountNo)} schedule</h3>${table([
            { label: '#', key: 'number' }, { label: 'Due', value: (i) => day(i.due_date) }, { label: 'Status', key: 'status' },
            { label: 'Principal', num: true, value: (i) => `${money(i.principal_paid)} / ${money(i.principal_due)}` },
            { label: 'Interest', num: true, value: (i) => `${money(i.interest_paid)} / ${money(i.interest_due)}` },
            { label: 'Fees', num: true, value: (i) => `${money(i.fee_paid)} / ${money(i.fee_due)}` },
            { label: 'Late fee exempt', value: (i) => (i.late_fee_exempt ? 'yes' : '') }], l.schedule)}` : '<p class="hint">Schedule not kept in the preview for this loan.</p>';
        }));
        box.querySelectorAll('tr[data-row]').forEach((tr) => tr.classList.add('clickable'));
      }
    };
    $('#imp-kinds', dlg).addEventListener('click', (ev) => { if (ev.target.dataset.kind) show(ev.target.dataset.kind); });
    if (kinds.length) await show(kinds.find(([kd]) => kd === 'loans')?.[0] || kinds[0][0]);
  }
  dlg.addEventListener('click', async (ev) => {
    const act = ev.target.dataset?.act;
    if (!act) return;
    if (act === 'close') { dlg.close(); dlg.remove(); return; }
    if (act === 'errors') { openFile(`/api/data-imports/${x.id}/errors`, `${x.file_name.replace(/\.xlsx$/i, '')}-errors.xlsx`, { save: true }); return; }
    const d = await ask([{ name: 'note', label: act === 'approve' ? 'Note for the approval' : 'Why is it rejected?', required: act !== 'approve' }],
      act === 'approve' ? 'Approve the import' : 'Reject the import');
    if (!d) return;
    const res = await api('POST', `/api/data-imports/${x.id}/${act}`, { note: d.note || null });
    toast(res.ok ? (act === 'approve' ? 'Imported' : 'Rejected') : (res.body?.importErrors ? `Approval failed: ${res.body.importErrors.length} errors` : res.error), !res.ok);
    dlg.close(); dlg.remove();
    render();
  });
  dlg.showModal();
  return null;
}
