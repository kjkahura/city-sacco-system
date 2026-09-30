/**
 * Bulk repayment collection.
 */

import { $, api, esc, money, openFile, toast, today } from './base.js';
import { ask, view } from './ui.js';
import { loansView } from './loans.js';
import { opt } from './products.js';

// --------------------------------------------------------------------------
// Bulk repayment collection
// --------------------------------------------------------------------------

const collectState = { view: 'REPAYMENTS', from: '', to: '', asOf: '', productId: '', branchId: '' };

export async function collectionsView(result = null) {
  const q = collectState;
  const d0 = q.from || today();
  const qs = new URLSearchParams(q.view === 'REPAYMENTS' ? { view: q.view, from: d0, to: q.to || d0 } : { view: q.view, asOf: q.asOf || today() });
  if (q.productId) qs.set('productId', q.productId);
  if (q.branchId) qs.set('branchId', q.branchId);
  const r = await api('GET', `/api/loans/collections/sheet?${qs}`);
  if (!r.ok) throw new Error(r.error);
  const rows = r.body.rows;
  view().innerHTML = `
    <button class="secondary" id="back">← Loans</button>
    <h1>Collection sheet</h1>
    <div class="toolbar no-print">
      <label>View<select id="c-view">${['REPAYMENTS', 'ACCOUNTS'].map((v) => `<option ${v === q.view ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      ${q.view === 'REPAYMENTS' ? `<label>From<input id="c-from" type="date" value="${esc(d0)}"></label><label>To<input id="c-to" type="date" value="${esc(q.to || d0)}"></label>`
    : `<label>As of<input id="c-asof" type="date" value="${esc(q.asOf || today())}"></label>`}
      <label>Product<input id="c-product" value="${esc(q.productId)}" size="8"></label>
      <button id="c-filter" class="secondary">Filter</button>
      <span class="spacer"></span>
      <button id="c-print" class="secondary">Print</button>
      <button id="c-csv" class="secondary">Export CSV</button>
      <button id="c-post">Post selected</button>
    </div>
    ${result ? `<p class="notice" id="batch-result">Batch posted: ${result.posted} of ${result.rows} for ${money(result.amount)}${result.failed ? `; ${result.failed} failed: ${result.results.filter((x) => x.status === 'FAILED').map((x) => `${esc(x.loanId)} ${esc(x.error)}`).join('; ')}` : ''}</p>` : ''}
    <div id="collection-rows">${rows.length ? `<table><thead><tr><th class="no-print"><input type="checkbox" id="c-all" checked></th><th>Member</th><th>Account</th>
      <th>${q.view === 'REPAYMENTS' ? 'Installment' : 'Installments due'}</th><th>Due</th><th class="num">Expected</th><th>Date paid</th><th class="num">Amount paid</th></tr></thead><tbody>
      ${rows.map((x, k) => `<tr data-k="${k}"><td class="no-print"><input type="checkbox" class="c-pick" checked></td>
        <td>${esc(x.member_no)} ${esc(x.member_name)}</td><td>${esc(x.account_no)}</td>
        <td>${q.view === 'REPAYMENTS' ? x.number : x.installments_due}</td><td>${esc(q.view === 'REPAYMENTS' ? x.due_date : r.body.asOf)}</td>
        <td class="num">${money(x.expected)}</td>
        <td><input type="date" class="c-date" value="${esc(x.datePaid)}"></td>
        <td class="num"><input type="number" step="0.01" class="c-amount" value="${x.amountPaid}"></td></tr>`).join('')}
      </tbody></table><p class="hint">Total expected ${money(r.body.total)}. A row changed from its defaults is highlighted.</p>` : '<p class="hint">Nothing due for these filters</p>'}</div>`;

  $('#back').addEventListener('click', loansView);
  const read = () => {
    q.view = $('#c-view').value;
    if ($('#c-from')) { q.from = $('#c-from').value; q.to = $('#c-to').value; }
    if ($('#c-asof')) q.asOf = $('#c-asof').value;
    q.productId = $('#c-product').value.trim();
  };
  $('#c-view').addEventListener('change', () => { read(); collectionsView(); });
  $('#c-filter').addEventListener('click', () => { read(); collectionsView(); });
  $('#c-print').addEventListener('click', () => window.print());
  $('#c-csv').addEventListener('click', () => openFile(`/api/loans/collections/sheet?${qs}&format=csv`, 'collection-sheet.csv', { save: true }));
  $('#c-all')?.addEventListener('change', (e) => view().querySelectorAll('.c-pick').forEach((c) => { c.checked = e.target.checked; }));
  view().querySelectorAll('tr[data-k]').forEach((tr) => tr.querySelectorAll('input.c-date, input.c-amount').forEach((inp) => inp.addEventListener('input', () => {
    const x = rows[Number(tr.dataset.k)];
    tr.classList.toggle('changed', $('.c-date', tr).value !== x.datePaid || Number($('.c-amount', tr).value) !== x.amountPaid);
  })));
  $('#c-post').addEventListener('click', async () => {
    const picked = [...view().querySelectorAll('tr[data-k]')].filter((tr) => $('.c-pick', tr).checked).map((tr) => {
      const x = rows[Number(tr.dataset.k)];
      return { loanId: x.loan_id, amount: Number($('.c-amount', tr).value), valueDate: $('.c-date', tr).value || undefined };
    }).filter((x) => x.amount > 0);
    if (!picked.length) return toast('Choose at least one row with an amount', true);
    const total = Math.round(picked.reduce((a, x) => a + x.amount, 0) * 100) / 100;
    const d = await ask([
      { label: 'Channel for the batch', name: 'channelId', value: 'cash' },
      opt({ label: 'Receipt or cheque reference', name: 'reference' }),
    ], `Post ${picked.length} repayments for ${money(total)}`);
    if (!d) return;
    const res = await api('POST', '/api/loans/collections/batches', { rows: picked, channelId: d.channelId, reference: d.reference || undefined });
    if (!res.ok) return toast(res.error, true);
    toast(`${res.body.posted} posted${res.body.failed ? `, ${res.body.failed} failed` : ''}`, res.body.failed > 0);
    collectionsView(res.body);
  });
}
