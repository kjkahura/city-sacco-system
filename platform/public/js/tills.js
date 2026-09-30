/**
 * Tills and the tellering card.
 */

import { $, S, api, esc, money, toast } from './base.js';
import { ask, card, table, view } from './ui.js';
import { can } from './access.js';
import { go } from './nav.js';

// --------------------------------------------------------------------------
// Tills (the reference platform's Tellers and Tellering widgets)
// --------------------------------------------------------------------------

const tillState = { includeClosed: false, open: null };

async function tillCash(t, direction, reload) {
  const d = await ask([{ name: 'amount', label: 'Amount', type: 'number', step: '0.01' },
    { name: 'note', label: 'Note', required: false }], `${direction === 'IN' ? 'Add cash to' : 'Remove cash from'} ${t.tillId}`);
  if (!d) return;
  const r = await api('POST', `/api/tills/${t.id}/${direction === 'IN' ? 'add-cash' : 'remove-cash'}`, { amount: Number(d.amount), note: d.note || null });
  toast(r.ok ? `${t.tillId}: expected cash ${money(r.body.expectedCash)}` : r.error, !r.ok);
  if (r.ok) reload();
}

async function tillClose(t, reload) {
  const d = await ask([{ name: 'countedCash', label: 'Cash counted in the till', type: 'number', step: '0.01', value: t.expectedCash },
    { name: 'note', label: 'Note', required: false }], `Close ${t.tillId} (expected ${money(t.expectedCash)})`);
  if (!d) return;
  const r = await api('POST', `/api/tills/${t.id}/close`, { countedCash: Number(d.countedCash), note: d.note || null });
  if (!r.ok) return toast(r.error, true);
  const diff = r.body.difference;
  toast(diff ? `${t.tillId} closed ${diff < 0 ? 'short' : 'over'} by ${money(Math.abs(diff))}; the difference is posted to cash over and short` : `${t.tillId} closed and balanced`);
  return reload();
}

const tillButtons = (t) => {
  const own = t.teller.email.toLowerCase() === String(S.user.email).toLowerCase();
  const b = [];
  if (t.status === 'OPEN') {
    if (can('ADD_CASH')) b.push(`<button class="link" data-till="${esc(t.id)}" data-act="in">add cash</button>`);
    if (can('REMOVE_CASH')) b.push(`<button class="link" data-till="${esc(t.id)}" data-act="out">remove cash</button>`);
    if (can('CLOSE_TILL') && (own || can('OPEN_TILL'))) b.push(`<button class="link" data-till="${esc(t.id)}" data-act="close">close</button>`);
    if (can('OPEN_TILL')) b.push(`<button class="link" data-till="${esc(t.id)}" data-act="undo-open">undo open</button>`);
  } else {
    if (can('CLOSE_TILL')) b.push(`<button class="link" data-till="${esc(t.id)}" data-act="undo-close">undo close</button>`);
    if (can('OPEN_TILL')) b.push(`<button class="link" data-till="${esc(t.id)}" data-act="reopen">reopen</button>`);
  }
  b.push(`<button class="link" data-till="${esc(t.id)}" data-act="log">log</button>`);
  return b.join(' ');
};

export function wireTills(list, reload) {
  view().querySelectorAll('[data-till]').forEach((b) => b.addEventListener('click', async () => {
    const t = list.find((x) => x.id === b.dataset.till);
    const act = b.dataset.act;
    if (act === 'in' || act === 'out') return tillCash(t, act === 'in' ? 'IN' : 'OUT', reload);
    if (act === 'close') return tillClose(t, reload);
    if (act === 'log') { tillState.open = t.id; return go('tills'); }
    if (act === 'undo-open' && !window.confirm(`Undo opening ${t.tillId}? Only a till with no transactions can be undone.`)) return null;
    const r = act === 'undo-open' ? await api('DELETE', `/api/tills/${t.id}`) : await api('POST', `/api/tills/${t.id}/${act}`);
    toast(r.ok ? `${t.tillId}: ${act.replace('-', ' ')} done` : r.error, !r.ok);
    return r.ok ? reload() : null;
  }));
}

export const TILL_COLUMNS = (actions = tillButtons) => [
  { label: 'Till', key: 'tillId' }, { label: 'Teller', value: (t) => t.teller.name || t.teller.email },
  { label: 'Branch', value: (t) => t.branch?.code || '' }, { label: 'Status', key: 'status' },
  { label: 'Opening', num: true, value: (t) => money(t.openingAmount) },
  { label: 'Expected cash', num: true, html: true, value: (t) => `${money(t.expectedCash)}${t.outsideLimits ? ' <span class="badge bad">outside limits</span>' : ''}` },
  { label: 'Difference', num: true, value: (t) => (t.difference === null ? '' : money(t.difference)) },
  { label: '', html: true, value: actions },
];

export async function openTill(reload) {
  const [users, next, channels] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/tills/next-id'), api('GET', '/api/transaction-channels')]);
  const tellers = (users.body || []).filter((u) => u.status === 'ACTIVE' && (u.role === 'TELLER' || u.role_code)).map((u) => u.email);
  const chans = (channels.body || []).filter((c) => c.active !== false).map((c) => c.id).filter(Boolean);
  const d = await ask([
    { name: 'tellerEmail', label: 'Teller', options: tellers.length ? tellers : [''] },
    { name: 'tillId', label: 'Till ID', value: next.body?.tillId || '' },
    { name: 'openingAmount', label: 'Opening cash', type: 'number', step: '0.01', value: 0 },
    ...(chans.length ? [{ name: 'channelId', label: 'Channel', options: chans, value: chans.includes('cash') ? 'cash' : chans[0] }] : []),
    { name: 'glAccount', label: 'Till GL account (blank: the channel\'s)', required: false },
    { name: 'balanceConstraint', label: 'Balance limits', options: ['NONE', 'SOFT', 'HARD'], value: 'NONE' },
    { name: 'minBalance', label: 'Minimum', type: 'number', step: '0.01', required: false },
    { name: 'maxBalance', label: 'Maximum', type: 'number', step: '0.01', required: false },
  ], 'Open a till');
  if (!d) return;
  const body = { ...d, openingAmount: Number(d.openingAmount || 0) };
  for (const k of ['glAccount', 'minBalance', 'maxBalance']) if (body[k] === '') delete body[k];
  if (body.minBalance !== undefined) body.minBalance = Number(body.minBalance);
  if (body.maxBalance !== undefined) body.maxBalance = Number(body.maxBalance);
  const r = await api('POST', '/api/tills', body);
  toast(r.ok ? `${r.body.tillId} opened for ${r.body.teller.email}` : r.error, !r.ok);
  if (r.ok) reload();
}

export async function tillsView() {
  if (tillState.open) return tillLog();
  const r = await api('GET', `/api/tills${tillState.includeClosed ? '?includeClosed=true' : ''}`);
  if (!r.ok) throw new Error(r.error);
  view().innerHTML = `<div class="toolbar"><h1>Tills</h1>${can('OPEN_TILL') ? '<button id="till-open">Open a till</button>' : ''}
      <label class="check"><input type="checkbox" id="till-closed" ${tillState.includeClosed ? 'checked' : ''}> Closed tills too</label></div>
    <p class="hint">A till holds a teller's cash for the day. Cash deposits, withdrawals and repayments the teller posts go through it.
      Closing it takes the cash counted; a difference from the expected cash is posted to cash over and short.</p>
    <div id="till-list">${table(TILL_COLUMNS(), r.body, { empty: 'No open tills' })}</div>`;
  wireTills(r.body, tillsView);
  $('#till-open')?.addEventListener('click', () => openTill(tillsView));
  $('#till-closed').addEventListener('change', (e) => { tillState.includeClosed = e.target.checked; tillsView(); });
}

async function tillLog() {
  const r = await api('GET', `/api/tills/${tillState.open}`);
  if (!r.ok) { tillState.open = null; toast(r.error, true); return tillsView(); }
  const t = r.body;
  view().innerHTML = `<button class="secondary" id="back">← Tills</button>
    <h1>${esc(t.tillId)} <span class="badge">${esc(t.status)}</span></h1>
    <dl class="kv"><dt>Teller</dt><dd>${esc(t.teller.email)}</dd><dt>GL account</dt><dd>${esc(t.glAccount)}</dd>
      <dt>Opening cash</dt><dd>${money(t.openingAmount)}</dd><dt>Expected cash</dt><dd id="till-expected">${money(t.expectedCash)}</dd>
      ${t.countedCash !== null ? `<dt>Counted</dt><dd>${money(t.countedCash)}</dd><dt>Difference</dt><dd>${money(t.difference)}</dd>` : ''}</dl>
    <div class="toolbar">${tillButtons(t).replace(/<button class="link" data-till="[^"]+" data-act="log">log<\/button>/, '')}</div>
    ${card('Log', table([{ label: 'When', value: (m) => String(m.createdAt).replace('T', ' ').slice(0, 16) }, { label: 'What', key: 'kind' },
    { label: 'Reference', value: (m) => m.reference || m.note || '' }, { label: 'Account', key: 'accountNo' },
    { label: 'Amount', num: true, value: (m) => money(m.amount) }, { label: 'Till cash', num: true, value: (m) => money(m.balance) }], t.log, { empty: 'Nothing through this till yet' }))}`;
  $('#back').addEventListener('click', () => { tillState.open = null; tillsView(); });
  wireTills([t], tillLog);
}

/** The Tellering widget: the teller's own till, if they have one open. */
export function telleringCard(mine) {
  if (!mine) return '';
  const t = mine.till;
  if (!t) {
    return card('Your till', `<p class="hint" id="my-till">${mine.mustUseTill ? 'You have no open till. Cash transactions are refused until a supervisor opens one for you.'
      : 'You have no open till. Cash you post is not counted in a till.'}</p>`);
  }
  return card(`Your till ${t.tillId}`, `<dl class="kv" id="my-till"><dt>Opening cash</dt><dd>${money(t.openingAmount)}</dd>
    <dt>Expected cash</dt><dd>${money(t.expectedCash)}${t.outsideLimits ? ' <span class="badge bad">outside limits</span>' : ''}</dd>
    <dt>Transactions</dt><dd>${t.log.filter((m) => m.kind === 'TRANSACTION').length}</dd></dl>
    <div class="toolbar">${can('CLOSE_TILL') ? `<button class="secondary" data-till="${esc(t.id)}" data-act="close">Close till</button>` : ''}
      <button class="link" data-till="${esc(t.id)}" data-act="log">log</button></div>`);
}
