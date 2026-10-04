/**
 * Accounting: branches, inter-branch rules and closures, the chart of
 * accounts and journal entries.
 */

import { $, api, apiRaw, esc, money, openFile, toast, today } from './base.js';
import { ask, card, pager, table, view, wirePager, wireRows } from './ui.js';
import { opt } from './products.js';
import { showDialog } from './users.js';
import { can } from './access.js';
import { go } from './nav.js';

// --------------------------------------------------------------------------
// Accounting: branches, inter-branch rules, closures
// --------------------------------------------------------------------------

export async function accountingView() {
  const [br, rules, closures, settings] = await Promise.all([
    api('GET', '/api/branches'), api('GET', '/api/accounting/inter-branch-rules'),
    api('GET', '/api/accounting/closures'), api('GET', '/api/accounting/settings'),
  ]);
  if (!br.ok) throw new Error(br.error);
  const code = (id) => (br.body.find((b) => b.id === id) || {}).code || 'every branch';
  const s = settings.body || {};
  view().innerHTML = `
    <div class="toolbar"><h1>Accounting</h1></div>
    <p class="hint">Closures refuse anything dated on or before them, for the whole book or one branch.
      An entry whose lines fall in two branches is squared through the inter-branch account named by the rule for that pair, or the default rule.</p>
    <div class="grid">
      ${card('Branches', `${table([
    { label: 'Code', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Members', num: true, key: 'members' },
    { label: 'Closed through', value: (b) => (b.closed_through ? String(b.closed_through).slice(0, 10) : 'open') },
  ], br.body, { empty: 'No branches yet' })}<button id="b-new" class="secondary">Add branch</button>`)}
      ${card('Inter-branch rules', `${table([
    { label: 'Rule', key: 'id' }, { label: 'Between', value: (r) => (r.branch_a ? `${r.branch_a_code} and ${r.branch_b_code}` : 'any two branches (default)') },
    { label: 'GL account', key: 'gl_code' },
  ], rules.body || [], { empty: 'No rule: an entry across branches will be refused' })}<button id="r-default" class="secondary">Set default rule</button>`)}
      ${card('Closures', `${table([
    { label: 'Closed through', value: (k) => String(k.closed_through).slice(0, 10) }, { label: 'Scope', value: (k) => code(k.branch_id) },
    { label: 'How', value: (k) => (k.automatic ? 'automatic' : 'by hand') }, { label: 'By', key: 'created_by' },
  ], closures.body || [], { empty: 'The books are open' })}
        <p class="hint">Automatic closures: ${s.auto_closure_enabled ? `every ${s.auto_closure_interval_days} day(s)` : 'off'}.</p>
        <button id="k-new" class="secondary">Close the books</button> <button id="k-auto" class="secondary">Automatic closures</button>`)}
    </div>`;
  $('#b-new').addEventListener('click', async () => {
    const d = await ask([{ label: 'Code', name: 'code' }, { label: 'Name', name: 'name' }, opt({ label: 'Town', name: 'town', value: '' })], 'New branch');
    if (!d) return;
    const res = await api('POST', '/api/branches', { code: d.code.toUpperCase(), name: d.name, town: d.town || null });
    toast(res.ok ? `Branch ${res.body.code} added` : res.error, !res.ok);
    if (res.ok) accountingView();
  });
  $('#r-default').addEventListener('click', async () => {
    const d = await ask([{ label: 'Inter-branch GL account', name: 'glCode', value: '290-100' }], 'Default inter-branch rule');
    if (!d) return;
    const named = (rules.body || []).filter((x) => x.branch_a).map((x) => ({ id: x.id, branchA: x.branch_a, branchB: x.branch_b, glCode: x.gl_code }));
    const res = await api('PUT', '/api/accounting/inter-branch-rules', { rules: [{ id: 'DEFAULT', glCode: d.glCode }, ...named] });
    toast(res.ok ? 'Rules saved' : res.error, !res.ok);
    if (res.ok) accountingView();
  });
  $('#k-new').addEventListener('click', async () => {
    const d = await ask([
      { label: 'Close through (a past date)', name: 'closedThrough', type: 'date' },
      { label: 'Branch', name: 'branchId', options: ['', ...br.body.map((b) => b.code)], value: '' },
      opt({ label: 'Notes', name: 'notes', value: '' }),
    ], 'Close the books');
    if (!d) return;
    const res = await api('POST', '/api/accounting/closures', { closedThrough: d.closedThrough, branchId: d.branchId || null, notes: d.notes || null });
    toast(res.ok ? `Closed through ${d.closedThrough}` : res.error, !res.ok);
    if (res.ok) accountingView();
  });
  $('#k-auto').addEventListener('click', async () => {
    const d = await ask([
      { label: 'Automatic closures', name: 'on', options: ['false', 'true'], value: String(!!s.auto_closure_enabled) },
      opt({ label: 'Every N days', name: 'days', type: 'number', value: s.auto_closure_interval_days ?? '' }),
    ], 'Automatic closures');
    if (!d) return;
    const res = await api('PUT', '/api/accounting/settings', { autoClosureEnabled: d.on === 'true', autoClosureIntervalDays: d.days === '' ? null : Number(d.days) });
    toast(res.ok ? 'Saved' : res.error, !res.ok);
    if (res.ok) accountingView();
  });
}

// --------------------------------------------------------------------------
// Chart of accounts (/api/glaccounts) and journal entries (/api/gljournalentries)
// --------------------------------------------------------------------------

const GL_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
const chartState = { type: '', to: '' };

/** The chart in tree order (parents before their accounts), each with its depth. */
function chartTree(list) {
  const kids = new Map();
  const codes = new Set(list.map((g) => g.glCode));
  for (const g of list) {
    const p = g.parentGlCode && codes.has(g.parentGlCode) ? g.parentGlCode : '';
    kids.set(p, [...(kids.get(p) || []), g]);
  }
  const out = [];
  const walk = (p, depth) => {
    for (const g of (kids.get(p) || []).sort((a, b) => a.glCode.localeCompare(b.glCode))) {
      out.push({ ...g, depth });
      if (depth < 20) walk(g.glCode, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

export async function chartView() {
  const qs = new URLSearchParams({ limit: '1000' });
  if (chartState.type) qs.set('type', chartState.type);
  if (chartState.to) qs.set('to', chartState.to);
  const res = await api('GET', `/api/glaccounts?${qs}`);
  if (!res.ok) throw new Error(res.error);
  const rows = chartTree(res.body);
  const manage = can('MANAGE_ACCOUNTS');
  view().innerHTML = `
    <div class="toolbar"><h1>Chart of accounts</h1><span class="spacer"></span>
      <label>Type<select id="coa-type">${['', ...GL_TYPES].map((t) => `<option value="${t}" ${t === chartState.type ? 'selected' : ''}>${t || 'All'}</option>`).join('')}</select></label>
      <label>Balances as at<input id="coa-to" type="date" value="${esc(chartState.to)}"></label>
      ${manage ? '<button id="coa-new">Add account</button>' : ''}</div>
    <p class="hint">A header's balance is the sum of the accounts under it. Balances read in each account's own sign.
      A GL code changes only while nothing uses the account; the type and usage never change.</p>
    ${card('Accounts', `<div id="coa-table">${table([
    { label: 'GL code', value: (g) => `${'· '.repeat(g.depth)}${g.glCode}` },
    { label: 'Name', key: 'name' }, { label: 'Type', key: 'type' }, { label: 'Usage', key: 'usage' },
    { label: 'Manual entries', value: (g) => (g.allowManualJournalEntries ? 'allowed' : 'no') },
    { label: 'Active', value: (g) => (g.activated ? 'yes' : 'no') },
    { label: 'Balance', num: true, value: (g) => money(g.balance) },
  ], rows, { onRow: true, empty: 'No accounts' })}</div>`)}`;
  $('#coa-type').addEventListener('change', (e) => { chartState.type = e.target.value; chartView(); });
  $('#coa-to').addEventListener('change', (e) => { chartState.to = e.target.value; chartView(); });
  if (manage) $('#coa-new').addEventListener('click', () => editAccount(null, res.body));
  wireRows(rows, (g) => accountDialog(g, res.body));
}

async function editAccount(g, list) {
  const headers = list.filter((x) => x.usage === 'HEADER').map((x) => x.glCode);
  const d = await ask(g ? [
    { label: 'GL code (changes only while the account is unused)', name: 'glCode', value: g.glCode },
    { label: 'Name', name: 'name', value: g.name },
    opt({ label: 'Description', name: 'description', value: g.description || '' }),
    { label: 'Parent (a header of the same type)', name: 'parentGlCode', options: ['', ...headers.filter((h) => h !== g.glCode)], value: g.parentGlCode || '' },
    ...(g.usage === 'DETAIL' ? [{ label: 'Allow manual journal entries', name: 'allowManualJournalEntries', options: ['true', 'false'], value: String(g.allowManualJournalEntries) }] : []),
  ] : [
    { label: 'GL code', name: 'glCode' }, { label: 'Name', name: 'name' },
    { label: 'Type', name: 'type', options: GL_TYPES, value: 'EXPENSE' },
    { label: 'Usage', name: 'usage', options: ['DETAIL', 'HEADER'], value: 'DETAIL' },
    { label: 'Parent (a header of the same type)', name: 'parentGlCode', options: ['', ...headers], value: '' },
    opt({ label: 'Description', name: 'description', value: '' }),
    { label: 'Allow manual journal entries (detail accounts)', name: 'allowManualJournalEntries', options: ['true', 'false'], value: 'true' },
  ], g ? `Edit ${g.glCode}` : 'New GL account');
  if (!d) return;
  const body = { ...d, parentGlCode: d.parentGlCode || null, description: d.description || null };
  if (body.allowManualJournalEntries !== undefined) body.allowManualJournalEntries = body.allowManualJournalEntries === 'true';
  if (!g && body.usage === 'HEADER') delete body.allowManualJournalEntries;
  const res = g ? await api('PUT', `/api/glaccounts/${encodeURIComponent(g.glCode)}`, body) : await api('POST', '/api/glaccounts', body);
  toast(res.ok ? `${res.body.glCode} saved` : res.error, !res.ok);
  if (res.ok) chartView();
}

function accountDialog(g, list) {
  const manage = can('MANAGE_ACCOUNTS');
  const dlg = showDialog(`${g.glCode} ${g.name}`, `
    <dl class="kv">
      <dt>Type</dt><dd>${esc(g.type)} · ${esc(g.usage)}</dd>
      <dt>Parent</dt><dd>${esc(g.parentGlCode || 'none')}</dd>
      <dt>Description</dt><dd>${esc(g.description || '')}</dd>
      <dt>Manual entries</dt><dd>${g.allowManualJournalEntries ? 'allowed' : 'not allowed'}</dd>
      <dt>Active</dt><dd>${g.activated ? 'yes' : 'no'}</dd>
      <dt>Balance</dt><dd>${money(g.balance)}</dd>
    </dl>
    ${manage ? `<div class="toolbar"><button id="coa-edit" class="secondary">Edit</button>
      <button id="coa-active" class="secondary">${g.activated ? 'Deactivate' : 'Activate'}</button>
      <button id="coa-delete" class="secondary">Delete</button></div>` : ''}
    <button id="coa-lines" class="link">Journal lines on this account</button>`);
  const close = () => { dlg.close(); dlg.remove(); };
  $('#coa-lines', dlg).addEventListener('click', () => { close(); journalState.glAccountId = g.glCode; journalState.offset = 0; go('journal'); });
  if (!manage) return;
  $('#coa-edit', dlg).addEventListener('click', () => { close(); editAccount(g, list); });
  $('#coa-active', dlg).addEventListener('click', async () => {
    const res = await api('PATCH', `/api/glaccounts/${encodeURIComponent(g.glCode)}`, [{ op: 'replace', path: '/activated', value: !g.activated }]);
    toast(res.ok ? `${g.glCode} ${res.body.activated ? 'activated' : 'deactivated'}` : res.error, !res.ok);
    if (res.ok) { close(); chartView(); }
  });
  $('#coa-delete', dlg).addEventListener('click', async () => {
    const res = await api('DELETE', `/api/glaccounts/${encodeURIComponent(g.glCode)}`);
    toast(res.ok ? `${g.glCode} deleted` : res.error, !res.ok);
    if (res.ok) { close(); chartView(); }
  });
}

const journalState = { from: '', to: '', glAccountId: '', manual: '', offset: 0, limit: 50 };

export async function journalView() {
  const s = journalState;
  const qs = new URLSearchParams({ paginationDetails: 'ON', offset: String(s.offset), limit: String(s.limit) });
  const criteria = [];
  if (s.from) criteria.push({ field: 'bookingDate', operator: 'AFTER_INCLUSIVE', value: s.from });
  if (s.to) criteria.push({ field: 'bookingDate', operator: 'BEFORE_INCLUSIVE', value: s.to });
  if (s.glAccountId) criteria.push({ field: 'glAccountId', operator: 'EQUALS', value: s.glAccountId });
  if (s.manual) criteria.push({ field: 'sourceType', operator: 'EQUALS', value: 'MANUAL' });
  const res = await api('POST', `/api/gljournalentries:search?${qs}`, { filterCriteria: criteria });
  if (!res.ok) throw new Error(res.error);
  const log = can('LOG_JOURNAL_ENTRIES');
  view().innerHTML = `
    <div class="toolbar"><h1>Journal entries</h1><span class="spacer"></span>
      <label>From<input id="je-from" type="date" value="${esc(s.from)}"></label>
      <label>To<input id="je-to" type="date" value="${esc(s.to)}"></label>
      <label>GL code<input id="je-gl" value="${esc(s.glAccountId)}"></label>
      <label>Entries<select id="je-manual"><option value="">All</option><option value="1" ${s.manual ? 'selected' : ''}>Manual only</option></select></label>
      <button id="je-apply" class="secondary">Show</button>
      ${log ? '<button id="je-new">Log journal entry</button>' : ''}</div>
    <p class="hint">One row per line. A manual entry is reversed here, with notes; an entry a transaction posted is corrected by reversing the transaction.</p>
    ${card('Lines', `<div id="je-table">${table([
    { label: 'Date', key: 'bookingDate' }, { label: 'Transaction ID', key: 'transactionId' },
    { label: 'GL account', value: (l) => `${l.glAccount.glCode} ${l.glAccount.name}` },
    { label: 'Debit', num: true, value: (l) => (l.type === 'DEBIT' ? money(l.amount) : '') },
    { label: 'Credit', num: true, value: (l) => (l.type === 'CREDIT' ? money(l.amount) : '') },
    { label: 'Branch', value: (l) => l.branchId || '' },
    { label: 'Source', value: (l) => (l.sourceType === 'MANUAL' ? `manual${l.reversalOf ? ' reversal' : ''}${l.reversalEntryKey ? ' (reversed)' : ''}` : (l.sourceType || '')) },
    { label: 'Notes', key: 'notes' },
  ], res.body, { onRow: true, empty: 'No journal lines' })}</div>${pager(s, res.total, journalView)}`)}`;
  $('#je-apply').addEventListener('click', () => {
    Object.assign(s, { from: $('#je-from').value, to: $('#je-to').value, glAccountId: $('#je-gl').value.trim(), manual: $('#je-manual').value, offset: 0 });
    journalView();
  });
  if (log) $('#je-new').addEventListener('click', logJournalEntry);
  wirePager(s, journalView);
  wireRows(res.body, (l) => journalEntryDialog(l.journalEntryId));
}

const accrualState = { offset: 0, limit: 50, from: '', to: '' };

/** Interest accruals: each accrual line posted, by booking date (POST /api/accounting/interestaccrual:search). */
export async function accrualsView() {
  const s = accrualState;
  const criteria = [];
  if (s.from) criteria.push({ field: 'bookingDate', operator: 'AFTER_INCLUSIVE', value: s.from });
  if (s.to) criteria.push({ field: 'bookingDate', operator: 'BEFORE_INCLUSIVE', value: s.to });
  const qs = new URLSearchParams({ paginationDetails: 'ON', offset: String(s.offset), limit: String(s.limit) });
  const res = await api('POST', `/api/accounting/interestaccrual:search?${qs}`, { filterCriteria: criteria });
  if (!res.ok) throw new Error(res.error);
  view().innerHTML = `
    <div class="toolbar"><h1>Interest Accruals</h1><span class="spacer"></span>
      <label>From<input id="ac-from" type="date" value="${esc(s.from)}"></label>
      <label>To<input id="ac-to" type="date" value="${esc(s.to)}"></label></div>
    <p class="hint">Interest accrued on loans and deposit accounts, line by line, as the end of day posted it.</p>
    ${table([
    { label: 'Booked', value: (l) => String(l.bookingDate || '').slice(0, 10) }, { label: 'Entry', key: 'entryType' },
    { label: 'Account', value: (l) => l.accountId || '' }, { label: 'Product', key: 'productId' },
    { label: 'GL account', value: (l) => `${l.glAccountId} ${l.glAccountName || ''}` }, { label: 'Branch', value: (l) => l.branchId || '' },
    { label: 'Amount', num: true, value: (l) => money(l.amount) },
  ], res.body, { empty: 'No accruals posted in these dates' })}
    ${pager(s, res.total)}`;
  wirePager(s, accrualsView);
  $('#ac-from').addEventListener('change', (e) => { s.from = e.target.value; s.offset = 0; accrualsView(); });
  $('#ac-to').addEventListener('change', (e) => { s.to = e.target.value; s.offset = 0; accrualsView(); });
}

/** "GL code, amount[, branch code]" per line. */
function journalLines(text) {
  return String(text || '').split('\n').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [glAccount, amount, branchId] = x.split(',').map((y) => y.trim());
    return { glAccount, amount: Number(amount), ...(branchId ? { branchId } : {}) };
  });
}

async function logJournalEntry() {
  const br = await api('GET', '/api/branches');
  const d = await ask([
    { label: 'Booking date (today or earlier)', name: 'date', type: 'date', value: today() },
    { label: 'Branch', name: 'branchId', options: ['', ...(br.body || []).map((b) => b.code)], value: '' },
    { label: 'Debits: one per line, "GL code, amount" (a branch code third for another branch)', name: 'debits', type: 'textarea', rows: 4 },
    { label: 'Credits: the same', name: 'credits', type: 'textarea', rows: 4 },
    { label: 'Notes', name: 'notes' },
    opt({ label: 'Transaction ID (generated when blank)', name: 'transactionId', value: '' }),
  ], 'Log a journal entry');
  if (!d) return;
  const res = await api('POST', '/api/gljournalentries', {
    date: d.date, branchId: d.branchId || null, notes: d.notes, transactionId: d.transactionId || undefined,
    debits: journalLines(d.debits), credits: journalLines(d.credits),
  });
  toast(res.ok ? `Journal entry ${res.body[0].transactionId} logged` : res.error, !res.ok);
  if (res.ok) journalView();
}

async function journalEntryDialog(ref) {
  const [e, files] = await Promise.all([api('GET', `/api/gljournalentries/${encodeURIComponent(ref)}`), api('GET', `/api/gljournalentries/${encodeURIComponent(ref)}/attachments`)]);
  if (!e.ok) return toast(e.error, true);
  const x = e.body;
  const log = can('LOG_JOURNAL_ENTRIES');
  const reversible = x.manual && !x.reversalOf && !x.reversalEntryKey;
  const dlg = showDialog(`Journal entry ${x.transactionId || ''}`, `
    <dl class="kv"><dt>Date</dt><dd>${esc(x.bookingDate)}</dd><dt>Source</dt><dd>${esc(x.manual ? 'manual' : x.sourceType || '')}</dd>
      <dt>Notes</dt><dd>${esc(x.notes || '')}</dd><dt>By</dt><dd>${esc(x.userKey || '')}</dd>
      ${x.reversalEntryKey ? '<dt>Reversed</dt><dd>yes</dd>' : ''}${x.reversalOf ? '<dt>Reverses</dt><dd>an earlier entry</dd>' : ''}</dl>
    ${table([{ label: 'GL account', value: (l) => `${l.glAccount.glCode} ${l.glAccount.name}` },
    { label: 'Debit', num: true, value: (l) => (l.type === 'DEBIT' ? money(l.amount) : '') },
    { label: 'Credit', num: true, value: (l) => (l.type === 'CREDIT' ? money(l.amount) : '') }, { label: 'Branch', value: (l) => l.branchId || '' }], x.lines)}
    ${x.manual ? `<h3>Files</h3><div id="je-files">${table([{ label: 'File', key: 'fileName' }, { label: 'Title', key: 'title' },
    { label: '', html: true, value: (f) => `<button class="link" data-file="${esc(f.id)}" data-name="${esc(f.fileName)}">Download</button>` }], files.body || [], { empty: 'No files' })}</div>` : ''}
    ${log && x.manual ? `<div class="toolbar">${reversible ? '<button id="je-reverse" class="secondary">Reverse</button>' : ''}
      <button id="je-attach" class="secondary">Attach a file</button></div>` : ''}`);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelectorAll('[data-file]').forEach((b) => b.addEventListener('click', () =>
    openFile(`/api/gljournalentries/${encodeURIComponent(x.journalEntryId)}/attachments/${b.dataset.file}/download`, b.dataset.name, { save: true })));
  const rev = $('#je-reverse', dlg);
  if (rev) rev.addEventListener('click', async () => {
    const d = await ask([{ label: 'Why it is reversed', name: 'notes' }, opt({ label: 'Booking date (blank: the entry\'s own)', name: 'date', type: 'date', value: '' })], 'Reverse the entry');
    if (!d) return;
    const res = await api('POST', `/api/gljournalentries/${encodeURIComponent(x.journalEntryId)}:reverse`, { notes: d.notes, date: d.date || undefined });
    toast(res.ok ? `Reversed as ${res.body[0].transactionId}` : res.error, !res.ok);
    if (res.ok) { close(); journalView(); }
  });
  const att = $('#je-attach', dlg);
  if (att) att.addEventListener('click', async () => {
    const d = await ask([{ label: 'File (at most five on an entry)', name: 'file', type: 'file' }, opt({ label: 'Title', name: 'title', value: '' })], 'Attach a file');
    if (!d || !d.file || !d.file.name) return;
    const q = new URLSearchParams({ fileName: d.file.name, ...(d.title ? { title: d.title } : {}) });
    const res = await apiRaw('POST', `/api/gljournalentries/${encodeURIComponent(x.journalEntryId)}/attachments?${q}`, await d.file.arrayBuffer(), d.file.type || 'application/octet-stream');
    toast(res.ok ? `${d.file.name} attached` : res.error, !res.ok);
    if (res.ok) { close(); journalEntryDialog(x.journalEntryId); }
  });
  return null;
}
