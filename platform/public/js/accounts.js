/**
 * A credit arrangement's page, a deposit account's page and a branch's page.
 */

import { $, api, day, esc, money, toast } from './base.js';
import { ask, card, table, view } from './ui.js';
import { activityCard, loadActivity, memberDetail, membersView, stateBadge } from './members.js';
import { opt } from './products.js';
import { orgView } from './organization.js';
import { can } from './access.js';
import { entityReports } from './templates.js';
import { sendEmailDialog } from './email.js';
import { sendSmsDialog } from './sms.js';
import { appTabs } from './apps.js';

const CA_ACTIONS = [
  ['APPROVE', 'Approve', ['PENDING_APPROVAL'], 'APPROVE_LINE_OF_CREDIT'], ['REJECT', 'Reject', ['PENDING_APPROVAL'], 'REJECT_LINE_OF_CREDIT'],
  ['WITHDRAW', 'Withdraw', ['PENDING_APPROVAL'], 'WITHDRAW_LINE_OF_CREDIT'], ['UNDO_APPROVE', 'Undo approval', ['APPROVED'], 'UNDO_APPROVE_LINE_OF_CREDIT'],
  ['UNDO_REJECT', 'Undo reject', ['REJECTED'], 'UNDO_REJECT_LINE_OF_CREDIT'], ['UNDO_WITHDRAW', 'Undo withdraw', ['WITHDRAWN'], 'UNDO_WITHDRAW_LINE_OF_CREDIT'],
  ['CLOSE', 'Close', ['APPROVED', 'ACTIVE'], 'CLOSE_LINES_OF_CREDIT'], ['UNDO_CLOSE', 'Reopen', ['CLOSED'], 'CLOSE_LINES_OF_CREDIT'],
];

/** A credit arrangement (the reference platform's line of credit): its limit on both bases, its states and its accounts. */
export async function creditArrangementDetail(id, holder = null) {
  const [r, acc] = await Promise.all([api('GET', `/api/creditarrangements/${id}`), api('GET', `/api/creditarrangements/${id}/accounts`)]);
  if (!r.ok) throw new Error(r.error);
  const ca = r.body;
  const a = acc.body || { loanAccounts: [], depositAccounts: [] };
  const open = ['APPROVED', 'ACTIVE'].includes(ca.state);
  const drop = (type) => (x) => (can('REMOTE_ACCOUNTS_FROM_LINE_OF_CREDIT') && !String(x.accountState).startsWith('CLOSED')
    ? `<button class="link" data-ca-drop="${esc(x.encodedKey)}" data-ca-type="${type}">remove</button>` : '');
  view().innerHTML = `
    <button class="secondary" id="back">← ${holder ? esc(holder.member_no) : 'Back'}</button>
    <h1>Credit arrangement <span class="badge">${esc(ca.id)}</span> ${stateBadge(ca.state)}</h1>
    <div class="toolbar" id="ca-actions">
      ${CA_ACTIONS.filter(([, , from, perm]) => from.includes(ca.state) && can(perm)).map(([x, label]) => `<button class="secondary" data-ca-action="${x}">${esc(label)}</button>`).join('')}
      ${can('EDIT_LINES_OF_CREDIT') && !['CLOSED', 'WITHDRAWN', 'REJECTED'].includes(ca.state) ? '<button class="secondary" id="ca-edit">Edit</button>' : ''}
      ${can('DELETE_LINES_OF_CREDIT') && !a.loanAccounts.length && !a.depositAccounts.length ? '<button class="secondary" id="ca-delete">Delete</button>' : ''}
    </div>
    <div class="grid" id="credit-arrangement">${card('Limit', `<dl class="kv">
      <dt>Holder</dt><dd>${esc(`${ca.holderName} (${ca.holderId})`)}</dd><dt>Amount</dt><dd>${money(ca.amount)}</dd>
      <dt>Counted as</dt><dd>${esc(ca.exposureLimitType.replace(/_/g, ' ').toLowerCase())}</dd>
      <dt>Consumed</dt><dd>${money(ca.consumedCreditAmount)}</dd><dt>Available</dt><dd>${money(ca.availableCreditAmount)}</dd>
      <dt>Loan amounts and overdraft limits</dt><dd>${money(ca.exposure.approvedAmount)}</dd><dt>Owed</dt><dd>${money(ca.exposure.outstandingAmount)}</dd>
      <dt>Dates</dt><dd>${day(ca.startDate)} to ${day(ca.expireDate)}</dd>${ca.notes ? `<dt>Notes</dt><dd>${esc(ca.notes)}</dd>` : ''}</dl>`)}</div>
    ${card('Loan accounts', table([
    { label: 'Account', key: 'id' }, { label: 'Product', key: 'productId' }, { label: 'State', key: 'accountState' },
    { label: 'Amount', num: true, value: (x) => money(x.loanAmount) }, { label: 'Owed', num: true, value: (x) => money(x.principalBalance) },
    { label: 'Matures', value: (x) => day(x.maturityDate) }, { label: '', html: true, value: drop('LOAN') },
  ], a.loanAccounts, { empty: 'No loan accounts' }))}
    ${card('Deposit accounts', table([
    { label: 'Account', key: 'id' }, { label: 'Product', key: 'productId' }, { label: 'State', key: 'accountState' },
    { label: 'Overdraft limit', num: true, value: (x) => money(x.overdraftLimit) }, { label: 'Balance', num: true, value: (x) => money(x.balance) },
    { label: 'Overdraft expires', value: (x) => day(x.overdraftExpiryDate) }, { label: '', html: true, value: drop('DEPOSIT') },
  ], a.depositAccounts, { empty: 'No deposit accounts' }))}
    ${open && can('ADD_ACCOUNTS_TO_LINE_OF_CREDIT') ? '<button class="secondary" id="ca-add">Add an account</button>' : ''}${activityCard()}`;
  loadActivity('creditarrangements', id);
  const reload = () => creditArrangementDetail(ca.encodedKey, holder);
  $('#back').addEventListener('click', () => (holder ? memberDetail(holder) : membersView()));
  view().querySelectorAll('[data-ca-action]').forEach((b) => b.addEventListener('click', async () => {
    const d = await ask([opt({ label: 'Notes', name: 'notes' })], `${b.textContent} ${ca.id}?`);
    if (!d) return;
    const res = await api('POST', `/api/creditarrangements/${ca.encodedKey}:changeState`, { action: b.dataset.caAction, notes: d.notes || undefined });
    toast(res.ok ? `Now ${res.body.state.replace(/_/g, ' ').toLowerCase()}` : res.error, !res.ok);
    if (res.ok) reload();
  }));
  view().querySelectorAll('[data-ca-drop]').forEach((b) => b.addEventListener('click', async () => {
    const res = await api('POST', `/api/creditarrangements/${ca.encodedKey}:removeAccount`, { accountId: b.dataset.caDrop, accountType: b.dataset.caType });
    toast(res.ok ? 'Removed' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  const on = (sel, fn) => { const b = $(sel); if (b) b.addEventListener('click', fn); };
  on('#ca-edit', async () => {
    const d = await ask([{ label: 'Amount', name: 'amount', type: 'number', step: '0.01', value: ca.amount },
      { label: 'Start date', name: 'startDate', type: 'date', value: ca.startDate }, { label: 'Expire date', name: 'expireDate', type: 'date', value: ca.expireDate },
      { label: 'Exposure counted as', name: 'exposureLimitType', options: ['APPROVED_AMOUNT', 'OUTSTANDING_AMOUNT'], value: ca.exposureLimitType },
      opt({ label: 'Notes', name: 'notes', type: 'textarea', rows: 2, value: ca.notes || '' })], `Edit ${ca.id}`);
    if (!d) return;
    const res = await api('PATCH', `/api/creditarrangements/${ca.encodedKey}`, { ...d, amount: Number(d.amount), notes: d.notes || null });
    toast(res.ok ? 'Saved' : res.error, !res.ok);
    if (res.ok) reload();
  });
  on('#ca-delete', async () => {
    if (!(await ask([], `Delete ${ca.id}? It cannot be undone.`))) return;
    const res = await api('DELETE', `/api/creditarrangements/${ca.encodedKey}`);
    toast(res.ok ? `Deleted ${ca.id}` : res.error, !res.ok);
    if (res.ok) (holder ? memberDetail(holder) : membersView());
  });
  on('#ca-add', async () => {
    const [ls, ds] = await Promise.all([api('GET', `/api/loans?memberId=${ca.holderKey}&limit=100`), api('GET', `/api/savings?memberId=${ca.holderKey}&limit=100`)]);
    const choices = [
      ...(ls.body || []).filter((l) => !l.credit_arrangement_id && !String(l.status).startsWith('CLOSED')).map((l) => `LOAN ${l.account_no}`),
      ...(ds.body || []).filter((x) => !x.credit_arrangement_id && x.status !== 'CLOSED').map((x) => `DEPOSIT ${x.account_no}`),
    ];
    if (!choices.length) return toast('The holder has no account to add', true);
    const d = await ask([{ label: 'Account', name: 'account', options: choices,
      hint: 'A deposit account needs an overdraft with an expiry date; the product must take credit arrangements.' }], `Add an account to ${ca.id}`);
    if (!d) return;
    const [type, no] = d.account.split(' ');
    const res = await api('POST', `/api/creditarrangements/${ca.encodedKey}:addAccount`, { accountId: no, accountType: type });
    toast(res.ok ? `Added ${no}` : res.error, !res.ok);
    if (res.ok) reload();
  });
  appTabs('LINE_OF_CREDIT_VIEW', ca.id || ca.encodedKey);
}

// The deposit account actions the console offers (../src/domain/savings ACTIONS decides).
const DEP_ACTIONS = [
  { action: 'APPROVE', label: 'Approve', code: 'APPROVE_SAVINGS', from: ['PENDING_APPROVAL'] },
  { action: 'UNDO_APPROVE', label: 'Undo approval', code: 'APPROVE_SAVINGS', from: ['APPROVED'] },
  { action: 'UNDO_ACTIVATE', label: 'Undo activation', code: 'APPROVE_SAVINGS', from: ['ACTIVE'], when: (b, t) => Boolean(b.activatedOn) && !t.length },
  { action: 'CLOSE_REJECT', label: 'Reject', code: 'CLOSE_SAVINGS_ACCOUNTS', from: ['PENDING_APPROVAL'] },
  { action: 'CLOSE_WITHDRAW', label: 'Withdraw', code: 'CLOSE_SAVINGS_ACCOUNTS', from: ['PENDING_APPROVAL', 'APPROVED'] },
  { action: 'LOCK', label: 'Lock', code: 'LOCK_SAVINGS_ACCOUNT', from: ['ACTIVE', 'IN_ARREARS', 'DORMANT'] },
  { action: 'UNLOCK', label: 'Unlock', code: 'UNLOCK_SAVINGS_ACCOUNT', from: ['LOCKED'] },
  { action: 'CLOSE_WRITE_OFF', label: 'Close and write off', code: 'CLOSE_SAVINGS_ACCOUNTS', from: ['ACTIVE', 'IN_ARREARS', 'DORMANT', 'LOCKED', 'MATURED'], when: (b) => Number(b.balance) < 0 },
  { action: 'UNDO_CLOSE_WRITE_OFF', label: 'Undo write-off', code: 'REVERSE_SAVINGS_ACCOUNT_WRITE_OFF', from: ['CLOSED'], when: (b) => b.closedAs === 'WRITTEN_OFF' },
  { action: 'REOPEN', label: 'Reopen', code: 'REOPEN_SAVINGS_ACCOUNT', from: ['CLOSED'], when: (b) => !b.closedAs && ['CURRENT_ACCOUNT', 'SAVINGS_ACCOUNT'].includes(b.productType) },
];

/** A deposit account: its balance, its transactions, its state, blocks and holds, closing it, and its report templates. */
export async function depositDetail(a, holder = null) {
  const [bal, tx, bl, hd] = await Promise.all([api('GET', `/api/savings/${a.id}/balance`), api('GET', `/api/savings/${a.id}/transactions?limit=50`),
    api('GET', `/api/savings/${a.id}/blocks`), can('VIEW_HOLDS') ? api('GET', `/api/savings/${a.id}/authorizationholds`) : Promise.resolve({ body: [] })]);
  if (!bal.ok) throw new Error(bal.error);
  const b = bal.body;
  view().innerHTML = `
    <button class="secondary" id="back">← ${holder ? esc(holder.member_no) : 'Back'}</button>
    <h1>Deposit account <span class="badge">${esc(b.accountNo)}</span> ${stateBadge(b.status)}</h1>
    <div class="grid" id="deposit-detail">${card('Balances', `<dl class="kv">
      <dt>Product</dt><dd>${esc(b.productId)}</dd><dt>Balance</dt><dd>${money(b.balance)}</dd><dt>Available</dt><dd>${money(b.available)}</dd>
      <dt>Pledged (member)</dt><dd>${money(b.pledged)}</dd><dt>Overdraft limit</dt><dd>${money(b.overdraftLimit)}${b.overdraftExpiryDate ? ` (expires ${day(b.overdraftExpiryDate)}${b.overdraftExpired ? ', expired' : ''})` : ''}</dd>
      <dt>Interest accrued</dt><dd>${money(b.interest.accrued)}</dd><dt>Interest last applied</dt><dd>${esc(b.interest.lastApplied || '—')}</dd>
      ${b.balances?.blockedBalance ? `<dt>Blocked</dt><dd>${money(b.balances.blockedBalance)}</dd>` : ''}
      ${b.balances?.holdBalance ? `<dt>On hold</dt><dd>${money(b.balances.holdBalance)}</dd>` : ''}
      ${b.balances?.pendingCredits ? `<dt>Credits on their way</dt><dd>${money(b.balances.pendingCredits)}</dd>` : ''}</dl>
      ${can('CLOSE_SAVINGS_ACCOUNTS') && ['ACTIVE', 'DORMANT', 'MATURED'].includes(b.status) && Number(b.balance) === 0 ? '<button class="secondary" id="dep-close">Close account</button>' : ''}`)}
      ${card('Terms', `<dl class="kv" id="deposit-terms">
      <dt>Name</dt><dd>${esc(b.name || '')}</dd>
      <dt>Type</dt><dd>${esc(String(b.productType || '').replace(/_/g, ' ').toLowerCase())}</dd>
      <dt>Interest rate</dt><dd>${b.interestRate === null ? esc(String(b.interestRateTerms || '').replace(/_/g, ' ').toLowerCase()) : `${esc(b.interestRate)}%${b.interestRateOwn ? ' (the account\'s own)' : ''}`}</dd>
      <dt>Maximum balance</dt><dd>${b.maxBalance === null ? 'none' : money(b.maxBalance)}</dd>
      <dt>Maximum withdrawal</dt><dd>${b.maxWithdrawalAmount === null ? 'none' : money(b.maxWithdrawalAmount)}</dd>
      ${b.maturity ? `<dt>Term</dt><dd>${esc(b.maturity.termLength)} ${esc(String(b.maturity.termUnit || '').toLowerCase())}</dd>
      <dt>Maturity</dt><dd>${b.maturity.startedOn ? `started ${day(b.maturity.startedOn)}, matures ${day(b.maturity.maturityDate)}` : `not started${b.maturity.minOpeningBalance ? ` (opening balance ${money(b.maturity.minOpeningBalance)})` : ''}`}</dd>` : ''}
      <dt>Last activity</dt><dd>${day(b.lastActivityOn) || '—'}</dd></dl>
      <div class="toolbar">
      ${b.maturity && !b.maturity.startedOn && b.status === 'ACTIVE' && can('ACTIVATE_MATURITY') ? '<button class="secondary" id="dep-mature">Start maturity</button>' : ''}
      ${b.maturity && b.maturity.startedOn && b.status !== 'MATURED' && can('UNDO_MATURITY') ? '<button class="secondary" id="dep-unmature">Undo maturity</button>' : ''}
      ${b.interestRateTerms === 'FIXED' && can('EDIT_SAVINGS_ACCOUNT') && b.status !== 'CLOSED' ? '<button class="secondary" id="dep-rate">Change interest rate</button>' : ''}
      ${can('EDIT_SAVINGS_ACCOUNT') && b.status !== 'CLOSED' ? '<button class="secondary" id="dep-max">Maximum balance</button>' : ''}
      ${can('EDIT_SAVINGS_ACCOUNT') ? '<button class="secondary" id="dep-edit">Edit account</button>' : ''}
      ${can('EDIT_SAVINGS_ACCOUNT') && b.productType === 'CURRENT_ACCOUNT' && ['ACTIVE', 'IN_ARREARS', 'PENDING_APPROVAL', 'APPROVED'].includes(b.status) ? '<button class="secondary" id="dep-overdraft">Overdraft terms</button>' : ''}</div>`)}
      ${card('State', `<dl class="kv" id="deposit-state">
      <dt>State</dt><dd>${esc(String(b.accountState || b.status).replace(/_/g, ' ').toLowerCase())}</dd>
      ${b.approvedOn ? `<dt>Approved</dt><dd>${day(b.approvedOn)}</dd>` : ''}${b.activatedOn ? `<dt>Activated</dt><dd>${day(b.activatedOn)}</dd>` : ''}
      ${b.lockedOn ? `<dt>Locked</dt><dd>${day(b.lockedOn)} (from ${esc(String(b.stateBeforeLock || 'ACTIVE').toLowerCase())})</dd>` : ''}
      ${b.inArrearsSince ? `<dt>In arrears since</dt><dd>${day(b.inArrearsSince)}</dd>` : ''}${b.closedOn ? `<dt>Closed</dt><dd>${day(b.closedOn)}</dd>` : ''}</dl>
      <div class="toolbar">${DEP_ACTIONS.filter((x) => x.from.includes(b.status) && can(x.code) && (!x.when || x.when(b, tx.body || [])))
    .map((x) => `<button class="secondary" id="dep-act-${x.action}">${esc(x.label)}</button>`).join('')}
      ${can('DELETE_SAVINGS_ACCOUNT') && !(tx.body || []).length ? '<button class="secondary" id="dep-delete">Delete account</button>' : ''}
      ${can('SEND_MANUAL_EMAIL') ? '<button class="secondary" id="dep-email">Send email</button>' : ''}
      ${can('SEND_MANUAL_SMS') ? '<button class="secondary" id="dep-sms">Send SMS</button>' : ''}</div>`)}
      ${card('Blocks and holds', `<div id="deposit-blocks">${table([
    { label: 'Kind', value: (x) => (x.creditDebitIndicator ? `hold (${x.creditDebitIndicator})` : 'block') }, { label: 'Reference', value: (x) => esc(x.externalReferenceId) },
    { label: 'Amount', num: true, value: (x) => money(x.amount) }, { label: 'Seized', num: true, value: (x) => (x.seizedAmount === undefined ? '' : money(x.seizedAmount)) },
    { label: 'State', value: (x) => esc(String(x.state || x.status).toLowerCase()) },
  ], [...(bl.body || []), ...(hd.body || [])], { empty: 'No blocks or holds' })}</div>
      <div class="toolbar">${can('BLOCK_AND_SEIZE_FUNDS') ? '<button class="secondary" id="dep-block">Block funds</button><button class="secondary" id="dep-unblock">Unblock</button><button class="secondary" id="dep-seize">Seize</button>' : ''}
      ${can('CREATE_HOLDS') ? '<button class="secondary" id="dep-hold">Hold</button>' : ''}${can('DELETE_HOLDS') ? '<button class="secondary" id="dep-unhold">Reverse a hold</button>' : ''}</div>`)}</div>
    ${card('Transactions', table([
    { label: 'Date', value: (t) => day(t.value_date || t.created_at) }, { label: 'Kind', key: 'kind' }, { label: 'Reference', key: 'reference' },
    { label: 'Amount', num: true, value: (t) => money(t.amount) },
  ], tx.body || [], { empty: 'No transactions' }))}${activityCard()}`;
  loadActivity('savings', a.id);
  $('#dep-email')?.addEventListener('click', () => sendEmailDialog({ depositAccountKey: a.id }));
  $('#dep-sms')?.addEventListener('click', () => sendSmsDialog({ depositAccountKey: a.id }));
  $('#back').addEventListener('click', () => (holder ? memberDetail(holder) : membersView()));
  const again = () => depositDetail(a, holder);
  const onDep = (sel, fn) => { const x = $(sel); if (x) x.addEventListener('click', fn); };
  onDep('#dep-mature', async () => {
    const d = await ask([opt({ label: `Term in ${String(b.maturity.termUnit || '').toLowerCase()} (blank: ${b.maturity.termLength})`, name: 'termLength', type: 'number' })], `Start the maturity of ${b.accountNo}`);
    if (!d) return;
    const res = await api('POST', `/api/savings/${a.id}/maturity`, { termLength: d.termLength ? Number(d.termLength) : undefined });
    toast(res.ok ? `Matures ${day(res.body.maturity_date)}` : res.error, !res.ok);
    if (res.ok) again();
  });
  onDep('#dep-unmature', async () => {
    if (!(await ask([], `Undo the maturity of ${b.accountNo}?`))) return;
    const res = await api('DELETE', `/api/savings/${a.id}/maturity`);
    toast(res.ok ? 'Maturity undone' : res.error, !res.ok);
    if (res.ok) again();
  });
  onDep('#dep-rate', async () => {
    const d = await ask([{ label: 'Interest rate, percent', name: 'interestRate', type: 'number', step: '0.0001', value: b.interestRate ?? '' },
      opt({ label: 'From (blank: today; back to the day after the last application)', name: 'valueDate', type: 'date' }),
      opt({ label: 'Notes', name: 'notes' })], `Interest rate of ${b.accountNo}`);
    if (!d) return;
    const res = await api('POST', `/api/savings/${a.id}:changeInterestRate`, { interestRate: Number(d.interestRate), valueDate: d.valueDate || undefined, notes: d.notes || undefined });
    toast(res.ok ? `Now ${res.body.interestRate}%${res.body.accruedChange ? `, accrued interest changed by ${money(res.body.accruedChange)}` : ''}` : res.error, !res.ok);
    if (res.ok) again();
  });
  onDep('#dep-edit', async () => {
    // The reference platform: the name and notes at any time; the terms only before activation.
    const before = ['PENDING_APPROVAL', 'APPROVED'].includes(b.status);
    const fields = [opt({ label: 'Account name (blank: the product\'s)', name: 'name', value: b.ownName || '' }), opt({ label: 'Notes', name: 'notes' })];
    if (before && b.interestRateTerms === 'FIXED') fields.push(opt({ label: 'Interest rate, percent', name: 'interestRate', type: 'number', step: '0.0001', value: b.interestRate ?? '' }));
    if (before && b.maturity) fields.push(opt({ label: `Term in ${String(b.maturity.termUnit || '').toLowerCase()}`, name: 'termLength', type: 'number', value: b.maturity.termLength ?? '' }));
    const d = await ask(fields, `Edit ${b.accountNo}${before ? '' : ' (its terms change only before activation)'}`);
    if (!d) return;
    const body = { name: d.name || null };
    if (d.notes) body.notes = d.notes;
    if (d.interestRate !== undefined && d.interestRate !== '') body.interestRate = Number(d.interestRate);
    if (d.termLength !== undefined && d.termLength !== '') body.termLength = Number(d.termLength);
    const res = await api('PATCH', `/api/savings/${a.id}`, body);
    toast(res.ok ? 'Saved' : res.error, !res.ok);
    if (res.ok) again();
  });
  onDep('#dep-overdraft', async () => {
    // The reference platform's Adjusting Overdraft Terms: the limit, the expiry date and the rate.
    const d = await ask([{ label: 'Overdraft limit', name: 'limit', type: 'number', step: '0.01', value: b.overdraftLimit ?? 0 },
      opt({ label: 'Expiry date (blank: none)', name: 'expiryDate', type: 'date', value: b.overdraftExpiryDate || '' }),
      opt({ label: 'Overdraft rate, % a year (blank: unchanged)', name: 'interestRate', type: 'number', step: '0.0001' })], `Overdraft terms of ${b.accountNo}`);
    if (!d) return;
    const body = { limit: Number(d.limit), expiryDate: d.expiryDate || null };
    if (d.interestRate !== '' && d.interestRate !== undefined) body.interestRate = Number(d.interestRate);
    const res = await api('PUT', `/api/savings/${a.id}/overdraft`, body);
    toast(res.ok ? 'Overdraft terms saved' : res.error, !res.ok);
    if (res.ok) again();
  });
  onDep('#dep-max', async () => {
    const d = await ask([opt({ label: 'Maximum balance (blank: none)', name: 'maxBalance', type: 'number', step: '0.01', value: b.maxBalance ?? '' })], `Maximum balance of ${b.accountNo}`);
    if (!d) return;
    const res = await api('PATCH', `/api/savings/${a.id}`, { maxBalance: d.maxBalance === '' ? null : Number(d.maxBalance) });
    toast(res.ok ? 'Saved' : res.error, !res.ok);
    if (res.ok) again();
  });
  for (const x of DEP_ACTIONS) {
    onDep(`#dep-act-${x.action}`, async () => {
      const d = await ask([opt({ label: 'Notes', name: 'notes' })], `${x.label}: ${b.accountNo}`);
      if (!d) return;
      const res = await api('POST', `/api/savings/${a.id}:changeState`, { action: x.action, notes: d.notes || undefined });
      toast(res.ok ? `${x.label}: done` : res.error, !res.ok);
      if (res.ok) again();
    });
  }
  const pendingBlocks = (bl.body || []).filter((x) => x.state === 'PENDING').map((x) => x.externalReferenceId);
  const pendingHolds = (hd.body || []).filter((x) => x.status === 'PENDING').map((x) => x.externalReferenceId);
  const act = async (method, path, body, done) => {
    const res = await api(method, path, body);
    toast(res.ok ? done : res.error, !res.ok);
    if (res.ok) again();
  };
  onDep('#dep-block', async () => {
    const d = await ask([{ label: 'Amount', name: 'amount', type: 'number', step: '0.01' }, opt({ label: 'Reference (blank: generated)', name: 'externalReferenceId' }),
      opt({ label: 'Why (court order, investigation)', name: 'notes' })], `Block funds in ${b.accountNo}`);
    if (d) act('POST', `/api/savings/${a.id}/blocks`, { amount: Number(d.amount), externalReferenceId: d.externalReferenceId || undefined, notes: d.notes || undefined }, 'Blocked');
  });
  onDep('#dep-unblock', async () => {
    if (!pendingBlocks.length) return toast('No pending block', true);
    const d = await ask([{ label: 'Block', name: 'ref', options: pendingBlocks }], `Unblock funds in ${b.accountNo}`);
    if (d) act('DELETE', `/api/savings/${a.id}/blocks/${encodeURIComponent(d.ref)}`, undefined, 'Unblocked');
  });
  onDep('#dep-seize', async () => {
    if (!pendingBlocks.length) return toast('No pending block', true);
    const d = await ask([{ label: 'Block', name: 'ref', options: pendingBlocks }, opt({ label: 'Amount (blank: all it holds)', name: 'amount', type: 'number', step: '0.01' }),
      opt({ label: 'Channel (blank: bank)', name: 'channelId' }), opt({ label: 'Notes', name: 'notes' })], `Seize blocked funds in ${b.accountNo}`);
    if (d) act('POST', `/api/savings/${a.id}/seizure-transactions`, { blockId: d.ref, amount: d.amount ? Number(d.amount) : undefined,
      transactionChannelId: d.channelId || undefined, notes: d.notes || undefined }, 'Seized');
  });
  onDep('#dep-hold', async () => {
    const d = await ask([{ label: 'External reference (up to 32 characters)', name: 'externalReferenceId' }, { label: 'Amount', name: 'amount', type: 'number', step: '0.01' },
      { label: 'Direction', name: 'creditDebitIndicator', options: ['DBIT', 'CRDT'] }, opt({ label: 'Notes', name: 'notes' })], `Hold on ${b.accountNo}`);
    if (d) act('POST', `/api/savings/${a.id}/authorizationholds`, { ...d, amount: Number(d.amount), notes: d.notes || undefined }, 'Held');
  });
  onDep('#dep-unhold', async () => {
    if (!pendingHolds.length) return toast('No pending hold', true);
    const d = await ask([{ label: 'Hold', name: 'ref', options: pendingHolds }], `Reverse a hold on ${b.accountNo}`);
    if (d) act('DELETE', `/api/savings/${a.id}/authorizationholds/${encodeURIComponent(d.ref)}`, undefined, 'Hold reversed');
  });
  onDep('#dep-delete', async () => {
    if (!(await ask([], `Delete ${b.accountNo}? It cannot be undone.`))) return;
    const res = await api('DELETE', `/api/savings/${a.id}`);
    toast(res.ok ? `Deleted ${b.accountNo}` : res.error, !res.ok);
    if (res.ok) (holder ? memberDetail(holder) : membersView());
  });
  const close = $('#dep-close');
  if (close) close.addEventListener('click', async () => {
    const res = await api('POST', `/api/savings/${a.id}/close`, {});
    toast(res.ok ? 'Account closed' : res.error, !res.ok);
    if (res.ok) depositDetail(a, holder);
  });
  entityReports('DEPOSIT', b.accountNo);
  appTabs('DEPOSIT_ACCOUNT_VIEW', a.id);
}

/** A branch (the reference platform's branch view): what sits in it, its centres and holidays, and its report templates. */
export async function branchDetail(code) {
  const r = await api('GET', `/api/branches/${encodeURIComponent(code)}`);
  if (!r.ok) throw new Error(r.error);
  const b = r.body;
  view().innerHTML = `
    <button class="secondary" id="back">← Organization</button>
    <h1>${esc(b.name)} <span class="badge">${esc(b.code)}</span> ${stateBadge(b.status)}</h1>
    <div class="grid" id="branch-detail">${card('Branch', `<dl class="kv"><dt>Members</dt><dd>${esc(b.members)}</dd>
      <dt>Running loans</dt><dd>${esc(b.active_loans)}</dd><dt>Open deposit accounts</dt><dd>${esc(b.active_deposits)}</dd>
      <dt>Town</dt><dd>${esc(b.town || '—')}</dd><dt>Phone · email</dt><dd>${esc(b.phone || '—')} · ${esc(b.email || '—')}</dd></dl>`)}
      ${card('Centres', table([{ label: 'Code', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Status', key: 'status' }], b.centres || [], { empty: 'No centres' }))}
      ${card('Holidays', table([{ label: 'Date', value: (h) => day(h.holiday_date) }, { label: 'Description', key: 'description' },
    { label: 'Recurring', value: (h) => (h.recurring ? 'yes' : '') }], b.holidays || [], { empty: 'No branch holidays' }))}</div>`;
  $('#back').addEventListener('click', orgView);
  entityReports('BRANCH', b.code);
  appTabs('BRANCH_VIEW', b.id);
}
