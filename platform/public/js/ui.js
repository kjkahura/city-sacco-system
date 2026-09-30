/**
 * Rendering helpers: tables, pagers, cards, the form dialog and the schedule editor.
 */

import { $, el, esc, money } from './base.js';

// --------------------------------------------------------------------------
// Rendering helpers
// --------------------------------------------------------------------------

export const view = () => el('view');

export function table(columns, rows, { onRow = null, empty = 'Nothing to show' } = {}) {
  if (!rows.length) return `<p class="hint">${esc(empty)}</p>`;
  const head = columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('');
  const body = rows.map((r, i) => {
    const cells = columns.map((c) => {
      const v = typeof c.value === 'function' ? c.value(r) : r[c.key];
      return `<td class="${c.num ? 'num' : ''}">${c.html ? (v ?? '') : esc(v ?? '')}</td>`;
    }).join('');
    // Only a clickable table's rows are wired, each to its own table (onRow: true is 'main').
    return onRow ? `<tr class="clickable" data-row="${i}" data-tbl="${esc(onRow === true ? 'main' : onRow)}">${cells}</tr>` : `<tr>${cells}</tr>`;
  }).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function wireRows(rows, onRow, key = 'main') {
  view().querySelectorAll(`tr[data-row][data-tbl="${key}"]`).forEach((tr) => {
    tr.addEventListener('click', () => onRow(rows[Number(tr.dataset.row)]));
  });
}

export function pager(state, total, reload) {
  const from = total === 0 ? 0 : state.offset + 1;
  const to = Math.min(state.offset + state.limit, total);
  return `<div class="pager">
    <button class="secondary" data-page="prev" ${state.offset === 0 ? 'disabled' : ''}>Previous</button>
    <button class="secondary" data-page="next" ${to >= total ? 'disabled' : ''}>Next</button>
    <span>${from}–${to} of ${total}</span>
  </div>`;
}

export function wirePager(state, reload) {
  view().querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => {
    state.offset = b.dataset.page === 'next'
      ? state.offset + state.limit
      : Math.max(0, state.offset - state.limit);
    reload();
  }));
}

export const card = (title, inner) => `<section class="card"><h2>${esc(title)}</h2>${inner}</section>`;

export async function ask(fields, title) {
  // A tiny inline form in a dialog. Enough for a deposit or a rate change
  // without pulling in a UI library.
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog" class="card"><h2>${esc(title)}</h2>
      ${fields.map((f) => `<label>${esc(f.label)}
        ${f.options
    ? `<select name="${esc(f.name)}">${f.options.map((o) =>
      `<option value="${esc(o)}" ${String(o) === String(f.value) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
    : f.type === 'textarea'
      ? `<textarea name="${esc(f.name)}" rows="${f.rows || 8}" ${f.required === false ? '' : 'required'}>${esc(f.value ?? '')}</textarea>`
      : `<input name="${esc(f.name)}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}"
          ${f.step ? `step="${f.step}"` : ''} ${f.required === false ? '' : 'required'}>`}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</label>`).join('')}
      <menu class="dialog-actions">
        <button value="cancel" class="secondary">Cancel</button>
        <button value="ok">Confirm</button>
      </menu></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => {
      const data = Object.fromEntries(new FormData($('form', dlg)).entries());
      dlg.remove();
      resolve(dlg.returnValue === 'ok' ? data : null);
    });
    dlg.showModal();
  });
}

/**
 * The schedule editor: one row per installment that may change, with the
 * fields the product lets change open for editing. Resolves to the new
 * installments and a note, or null when cancelled.
 */
export async function scheduleEditor(e, title) {
  const can = new Set(e.allowed || []);
  const dates = can.has('PAYMENT_DATES');
  const principal = can.has('PRINCIPAL');
  const interest = can.has('INTEREST') && e.fixedTerm;
  const feesOpen = can.has('FEES') && !e.application;
  const addable = e.countMayChange && dates && principal;
  const first = e.installments.length ? e.installments[0].number : 1;
  const row = (i) => `<tr>
    <td class="n"></td>
    <td><input type="date" name="dueDate" value="${esc(i.dueDate || '')}" ${dates ? '' : 'disabled'}></td>
    <td><input type="number" step="0.01" name="principal" value="${esc(i.principal ?? 0)}" ${principal ? '' : 'disabled'}></td>
    <td><input type="number" step="0.01" name="interest" value="${esc(i.interest ?? 0)}" ${interest ? '' : 'disabled'}></td>
    <td><input type="number" step="0.01" name="fee" value="${esc(i.fee ?? 0)}" ${feesOpen ? '' : 'disabled'}></td>
    <td>${addable ? '<button type="button" class="link" data-drop>remove</button>' : ''}</td></tr>`;
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.id = 'schedule-editor';
    dlg.innerHTML = `<form method="dialog" class="card wide"><h2>${esc(title)}</h2>
      <p class="hint">${e.application ? 'The schedule this application will be drawn with. Dates left as the product\'s move with the disbursement date.'
    : `Installments ${first} onward can change: nothing has been paid on them, they are not due and their interest has not started to be earned.`}
      ${e.fixedTerm ? '' : ' Interest on this loan follows its balance and is worked out again from the new dates and principal.'}
      Principal${feesOpen ? ' and fees' : ''} must add up to what ${e.application ? 'the application' : 'these installments'} carry now.</p>
      <table class="editor"><thead><tr><th>#</th><th>Due</th><th>Principal</th><th>Interest</th><th>Fees</th><th></th></tr></thead>
      <tbody>${e.installments.map(row).join('')}</tbody></table>
      <p class="hint" id="se-total"></p>
      ${addable ? '<button type="button" class="secondary" id="se-add">Add installment</button>' : ''}
      <label>Note <input name="note"></label>
      <menu class="dialog-actions">
        <button value="cancel" class="secondary">Cancel</button>
        <button value="ok">Save schedule</button>
      </menu></form>`;
    document.body.appendChild(dlg);
    const body = $('tbody', dlg);
    const renumber = () => {
      let total = 0;
      body.querySelectorAll('tr').forEach((tr, k) => {
        $('.n', tr).textContent = first + k;
        total += Number($('[name=principal]', tr).value || 0);
      });
      $('#se-total', dlg).textContent = `Principal on these installments: ${money(total)}`;
    };
    body.addEventListener('input', renumber);
    body.addEventListener('click', (ev) => { if (ev.target.matches('[data-drop]')) { ev.target.closest('tr').remove(); renumber(); } });
    if (addable) $('#se-add', dlg).addEventListener('click', () => { body.insertAdjacentHTML('beforeend', row({ principal: 0, interest: 0, fee: 0 })); renumber(); });
    renumber();
    dlg.addEventListener('close', () => {
      const list = [...body.querySelectorAll('tr')].map((tr) => {
        const x = {};
        if (dates) x.dueDate = $('[name=dueDate]', tr).value;
        if (principal) x.principal = Number($('[name=principal]', tr).value || 0);
        if (interest) x.interest = Number($('[name=interest]', tr).value || 0);
        if (feesOpen) x.fee = Number($('[name=fee]', tr).value || 0);
        return x;
      });
      const note = $('[name=note]', dlg).value;
      dlg.remove();
      resolve(dlg.returnValue === 'ok' ? { installments: list, note: note || undefined } : null);
    });
    dlg.showModal();
  });
}
