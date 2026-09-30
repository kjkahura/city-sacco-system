/**
 * The teller page.
 */

import { $, api, esc, money, toast } from './base.js';
import { card, view } from './ui.js';
import { can } from './access.js';
import { telleringCard, wireTills } from './tills.js';

// --------------------------------------------------------------------------
// Teller
// --------------------------------------------------------------------------

export async function tellerView() {
  const mine = can('VIEW_SAVINGS_ACCOUNT_DETAILS', 'VIEW_LOAN_ACCOUNT_DETAILS') ? await api('GET', '/api/tills/mine') : null;
  const own = mine && mine.ok ? mine.body : null;
  view().innerHTML = `
    <h1>Teller</h1>
    <p class="hint">Postings are immediate and cannot be edited. A mistake is corrected with a reversal,
      which stays on the record next to the original. Cash you post goes through your open till.</p>
    <div class="grid">
      ${telleringCard(own)}
      ${card('Savings', `
        <label>Account number<input id="t-account" placeholder="SA000001"></label>
        <label>Amount<input id="t-amount" type="number" step="0.01"></label>
        <label>Channel<select id="t-channel">
          <option value="cash">Cash</option><option value="mpesa">M-Pesa</option>
          <option value="bank">Bank transfer</option><option value="cheque">Cheque</option>
          <option value="payroll">Payroll check-off</option>
        </select></label>
        ${can('BACKDATE_SAVINGS_TRANSACTIONS') ? '<label>Value date (blank: today; back to the day after the last interest application)<input id="t-date" type="date"></label>' : ''}
        <div class="toolbar">
          <button id="t-deposit">Deposit</button>
          <button id="t-withdraw" class="secondary">Withdraw</button>
        </div>`)}
      ${card('Reverse a transaction', `
        <label>Reference<input id="t-ref" placeholder="DEP-..."></label>
        <label>Reason<input id="t-reason"></label>
        <button id="t-reverse" class="secondary">Reverse</button>
        <p class="hint">Reversal is dated with the original entry, so both periods stay correct.
          A closed year refuses it until the year is reopened.</p>`)}
    </div>
    <div id="t-result"></div>`;

  const post = async (kind) => {
    const account = $('#t-account').value.trim();
    const amount = Number($('#t-amount').value);
    const channelId = $('#t-channel').value;
    if (!account || !(amount > 0)) return toast('Account and a positive amount are needed', true);
    const path = kind === 'deposit' ? 'deposits' : 'withdrawals';
    const valueDate = $('#t-date')?.value || undefined;
    const r = await api('POST', `/api/savings/${encodeURIComponent(account)}/${path}`, { amount, channelId, valueDate });
    toast(r.ok ? `${kind} posted: ${r.body.reference}` : r.error, !r.ok);
    if (r.ok && own?.till && channelId === 'cash') {
      const t = await api('GET', `/api/tills/${own.till.id}`);
      if (t.ok && $('#my-till')) $('#my-till').outerHTML = new DOMParser().parseFromString(telleringCard({ till: t.body }), 'text/html').querySelector('#my-till').outerHTML;
    }
    if (r.ok) {
      const bal = await api('GET', `/api/savings/${encodeURIComponent(account)}/balance`);
      $('#t-result').innerHTML = card('Account after posting',
        `<dl class="kv"><dt>Account</dt><dd>${esc(account)}</dd>
         <dt>Balance</dt><dd>${money(bal.body?.balance)}</dd></dl>`);
    }
  };
  if (own?.till) wireTills([own.till], tellerView);
  $('#t-deposit').addEventListener('click', () => post('deposit'));
  $('#t-withdraw').addEventListener('click', () => post('withdrawal'));
  $('#t-reverse').addEventListener('click', async () => {
    const ref = $('#t-ref').value.trim();
    const r = await api('POST', `/api/savings/transactions/${encodeURIComponent(ref)}/reversal`,
      { reason: $('#t-reason').value });
    toast(r.ok ? 'Reversed' : r.error, !r.ok);
  });
}
