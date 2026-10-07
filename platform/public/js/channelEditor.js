/**
 * The transaction channel form: name, type, GL account, usage rights, state,
 * and the loan and deposit constraints as the reference platform sets them
 * (Unconstrained or Limited usage, Match All or Match Any, one row per
 * filter). It edits the API v2 shape (/api/organization/transactionChannels)
 * and resolves to that body, or null when cancelled.
 */

import { $, esc } from './base.js';

const TYPES = ['CASH', 'MOBILE', 'TRANSFER', 'CHEQUE', 'INTERNAL', 'PAYROLL'];
const OPS = { AMOUNT: ['EQUALS', 'MORE_THAN', 'LESS_THAN', 'BETWEEN', 'EMPTY', 'NOT_EMPTY'], TYPE: ['IN', 'EMPTY', 'NOT_EMPTY'], PRODUCT: ['IN', 'EMPTY', 'NOT_EMPTY'] };
const KINDS = { loan: ['DISBURSEMENT', 'REPAYMENT', 'RECOVERY'], deposit: ['DEPOSIT', 'WITHDRAWAL'] };
const OP_LABEL = { EQUALS: 'equals', MORE_THAN: 'more than', LESS_THAN: 'less than', BETWEEN: 'between', IN: 'in', EMPTY: 'empty', NOT_EMPTY: 'not empty' };

const select = (name, options, value, labels = {}) => `<select data-k="${name}">${options.map((o) =>
  `<option value="${esc(o)}" ${o === value ? 'selected' : ''}>${esc(labels[o] || o)}</option>`).join('')}</select>`;

/** One filter row's inputs: the values a criterion and operator take. */
function valuesHtml(side, criteria, operator, k) {
  if (operator === 'EMPTY' || operator === 'NOT_EMPTY') return '';
  if (criteria === 'TYPE') {
    const have = new Set(k.values || (k.value ? [k.value] : []));
    return KINDS[side].map((t) => `<label class="inline"><input type="checkbox" data-k="type" value="${t}" ${have.has(t) ? 'checked' : ''}> ${t.toLowerCase()}</label>`).join(' ');
  }
  if (criteria === 'PRODUCT') {
    const v = (k.values || (k.value ? [k.value] : [])).join(', ');
    return `<input data-k="products" placeholder="product IDs, comma separated" value="${esc(v)}">`;
  }
  return `<input data-k="value" inputmode="decimal" placeholder="amount" value="${esc(k.value ?? '')}">${operator === 'BETWEEN'
    ? ` and <input data-k="second" inputmode="decimal" placeholder="amount" value="${esc(k.secondValue ?? '')}">` : ''}`;
}

function rowHtml(side, k) {
  const criteria = OPS[k.criteria] ? k.criteria : 'AMOUNT';
  const operator = OPS[criteria].includes(k.operator) ? k.operator : OPS[criteria][0];
  return `<div class="filter-row" data-row>
    ${select('criteria', Object.keys(OPS), criteria, { AMOUNT: 'amount', TYPE: 'type', PRODUCT: 'product' })}
    ${select('operator', OPS[criteria], operator, OP_LABEL)}
    <span data-values>${valuesHtml(side, criteria, operator, k)}</span>
    <button type="button" class="link" data-remove>remove</button></div>`;
}

function sideHtml(side, title, con) {
  const limited = con && con.usage === 'LIMITED';
  return `<fieldset data-side="${side}"><legend>${esc(title)}</legend>
    <label>Usage ${select('usage', ['UNCONSTRAINED', 'LIMITED'], limited ? 'LIMITED' : 'UNCONSTRAINED', { UNCONSTRAINED: 'Unconstrained usage', LIMITED: 'Limited usage' })}</label>
    <div data-limited ${limited ? '' : 'hidden'}>
      <label>Match ${select('match', ['ALL', 'ANY'], con?.matchFiltersOption || 'ALL', { ALL: 'all filters', ANY: 'any filter' })}</label>
      <div data-rows>${(limited ? con.constraints : []).map((k) => rowHtml(side, k)).join('')}</div>
      <button type="button" class="secondary" data-add>Add filter</button>
      <p class="hint">Limited usage with no filter closes the channel to these transactions.</p>
    </div></fieldset>`;
}

/** The constraints a fieldset holds, in the API v2 shape. */
function readSide(fs) {
  if ($('[data-k="usage"]', fs).value !== 'LIMITED') return { usage: 'UNCONSTRAINED', constraints: [] };
  const constraints = [...fs.querySelectorAll('[data-row]')].map((row) => {
    const criteria = $('[data-k="criteria"]', row).value;
    const operator = $('[data-k="operator"]', row).value;
    const k = { criteria, operator };
    if (operator === 'EMPTY' || operator === 'NOT_EMPTY') return k;
    if (criteria === 'TYPE') k.values = [...row.querySelectorAll('[data-k="type"]:checked')].map((x) => x.value);
    else if (criteria === 'PRODUCT') k.values = $('[data-k="products"]', row).value.split(',').map((x) => x.trim()).filter(Boolean);
    else {
      k.value = $('[data-k="value"]', row).value.trim();
      const second = $('[data-k="second"]', row);
      if (second) k.secondValue = second.value.trim();
    }
    return k;
  });
  return { usage: 'LIMITED', matchFiltersOption: $('[data-k="match"]', fs).value, constraints };
}

function wireSide(fs, side) {
  const rows = $('[data-rows]', fs);
  $('[data-k="usage"]', fs).addEventListener('change', (e) => { $('[data-limited]', fs).hidden = e.target.value !== 'LIMITED'; });
  $('[data-add]', fs).addEventListener('click', () => rows.insertAdjacentHTML('beforeend', rowHtml(side, { criteria: 'AMOUNT', operator: 'LESS_THAN' })));
  rows.addEventListener('click', (e) => { if (e.target.matches('[data-remove]')) e.target.closest('[data-row]').remove(); });
  rows.addEventListener('change', (e) => {
    const row = e.target.closest('[data-row]');
    if (!row) return;
    const k = e.target.dataset.k;
    if (k === 'criteria') {
      const criteria = e.target.value;
      row.outerHTML = rowHtml(side, { criteria, operator: OPS[criteria][0] });
    } else if (k === 'operator') {
      $('[data-values]', row).innerHTML = valuesHtml(side, $('[data-k="criteria"]', row).value, e.target.value, {});
    }
  });
}

/** The form for channel x (API v2 shape; empty for a new one). */
export function channelEditor(x = {}) {
  const isNew = !x.id;
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog" class="card wide" id="channel-form"><h2>${esc(isNew ? 'New channel' : `Channel ${x.id}`)}</h2>
      ${isNew ? '<label>ID (no spaces)<input name="id" required maxlength="32" pattern="\\S+"></label>' : ''}
      <label>Name<input name="name" required maxlength="255" value="${esc(x.name || '')}"></label>
      <label>Type<select name="channelType">${TYPES.map((t) => `<option ${t === (x.channelType || 'CASH') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>GL account<input name="glAccount" value="${esc(x.glAccount || '')}" ${isNew ? 'required' : ''}></label>
      <label>Usage rights<input name="usageRights" value="${esc((x.usageRights || []).join(', '))}">
        <span class="hint">Role IDs, comma separated; blank: all users</span></label>
      ${isNew || x.isDefault ? '' : `<label>State<select name="state">${['ACTIVE', 'INACTIVE'].map((s) => `<option ${s === x.state ? 'selected' : ''}>${s}</option>`).join('')}</select></label>`}
      ${sideHtml('loan', 'Loan constraints', x.loanConstraints)}
      ${sideHtml('deposit', 'Deposit constraints', x.depositConstraints)}
      <menu class="dialog-actions"><button value="cancel" class="secondary" formnovalidate>Cancel</button><button value="ok">Save</button></menu></form>`;
    document.body.appendChild(dlg);
    const form = $('form', dlg);
    wireSide($('[data-side="loan"]', form), 'loan');
    wireSide($('[data-side="deposit"]', form), 'deposit');
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      const d = Object.fromEntries(new FormData(form).entries());
      const roles = String(d.usageRights || '').split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
      const body = {
        ...(isNew ? { id: d.id.trim() } : { id: x.id }),
        name: d.name.trim(),
        channelType: d.channelType,
        glAccount: d.glAccount.trim() || null,
        availableForAll: !roles.length,
        usageRights: roles,
        state: d.state || x.state || 'ACTIVE',
        loanConstraints: readSide($('[data-side="loan"]', form)),
        depositConstraints: readSide($('[data-side="deposit"]', form)),
      };
      dlg.remove();
      resolve(ok ? body : null);
    });
    dlg.showModal();
  });
}

/** A channel's constraints as one line for the table. */
export function constraintsText(con) {
  if (!con || con.usage !== 'LIMITED') return 'unconstrained';
  if (!con.constraints.length) return 'closed';
  const one = (k) => {
    const what = k.criteria.toLowerCase();
    if (k.operator === 'EMPTY' || k.operator === 'NOT_EMPTY') return `${what} ${OP_LABEL[k.operator]}`;
    if (k.criteria !== 'AMOUNT') return `${what} in ${(k.values || [k.value]).join('/')}`;
    return `${what} ${OP_LABEL[k.operator]} ${k.value}${k.operator === 'BETWEEN' ? ` and ${k.secondValue}` : ''}`;
  };
  return `${con.matchFiltersOption === 'ANY' ? 'any of' : 'all of'}: ${con.constraints.map(one).join(', ')}`;
}
