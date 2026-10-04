/**
 * Loans: the list and a loan's page.
 */

import { $, S, api, apiRaw, day, esc, navFilter, money, openFile, toast, today } from './base.js';
import { pageTitle } from './menuDef.js';
import { ask, card, pager, scheduleEditor, table, view, wirePager, wireRows } from './ui.js';
import { activityCard, loadActivity } from './members.js';
import { collectionsView } from './collections.js';
import { opt } from './products.js';
import { customFieldsCard, wireCustomFields } from './organization.js';
import { entityReports } from './templates.js';

// --------------------------------------------------------------------------
// Loans
// --------------------------------------------------------------------------

const loanState = { offset: 0, limit: 25, status: '' };

export async function loansView(filter) {
  const f = navFilter(filter);
  if (f) { loanState.status = f.state || ''; loanState.offset = 0; }
  const qs = new URLSearchParams({ offset: loanState.offset, limit: loanState.limit });
  if (loanState.status) qs.set('status', loanState.status);
  const r = await api('GET', `/api/loans?${qs}`);
  if (!r.ok) throw new Error(r.error);

  view().innerHTML = `
    <div class="toolbar"><h1>${esc(pageTitle('loans', loanState.status))}</h1>
      <label>Status<select id="l-status">
        ${['', 'CLOSED_REPAID,CLOSED_RESCHEDULED,CLOSED_REFINANCED', 'PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'IN_ARREARS', 'LOCKED', 'CLOSED_REPAID',
    'CLOSED_WRITTEN_OFF', 'CLOSED_RESCHEDULED', 'CLOSED_REFINANCED', 'CLOSED_REJECTED', 'CLOSED_WITHDRAWN'].map((s) =>
    `<option ${s === loanState.status ? 'selected' : ''} value="${s}">${s.includes(',') ? 'CLOSED (repaid, rescheduled, refinanced)' : s || 'Any'}</option>`).join('')}
      </select></label>
      <span class="spacer"></span>
      <button id="collection-sheet" class="secondary">Collection sheet</button>
    </div>
    ${table([
    { label: 'Account', key: 'account_no' },
    { label: 'Member', value: (l) => `${l.first_name} ${l.last_name}` },
    { label: 'Status', value: (l) => l.status },
    { label: 'Principal', num: true, value: (l) => money(l.principal) },
    { label: 'Outstanding', num: true, value: (l) => money(Number(l.principal_disbursed) + Number(l.principal_capitalized || 0) - l.principal_paid) },
    { label: 'Penalty', num: true, value: (l) => money(l.penalty_accrued - l.penalty_paid) },
  ], r.body, { onRow: true, empty: 'No loans match' })}
    ${pager(loanState, r.total)}`;

  wireRows(r.body, loanDetail);
  wirePager(loanState, loansView);
  $('#l-status').addEventListener('change', (e) => {
    loanState.status = e.target.value; loanState.offset = 0; loansView();
  });
  $('#collection-sheet').addEventListener('click', () => collectionsView());
}

const RUNNING_EXTRAS = [['repay-deposit', 'Repay from deposit'], ['pay-off', 'Pay off'], ['terminate', 'Terminate'], ['undo-terminate', 'Undo terminate'],
  ['rate', 'Change interest rate'], ['reduce-balance', 'Reduce balance'], ['holiday-interest', 'Apply holiday interest'],
  ['revolving-installment', 'Add installment'], ['guarantor', 'Add guarantor'], ['undo-restructure', 'Undo reschedule or top-up'], ['attach', 'Attach document'], ['name', 'Name']];
const LOAN_ACTIONS = {
  PARTIAL_APPLICATION: [['request-approval', 'Request approval'], ['amend', 'Amend terms'], ['disbursement-details', 'Disbursement details'], ['edit-schedule', 'Edit schedule'], ['product-schedule', 'Product schedule'], ['guarantor', 'Add guarantor'], ['collateral', 'Add collateral'], ['funding', 'Add funder'], ['tranches', 'Set tranches'], ['revolving-installment', 'Add installment'], ['attach', 'Attach document'], ['reject', 'Reject'], ['withdraw', 'Withdraw'], ['delete', 'Delete']],
  PENDING_APPROVAL: [['approve', 'Approve'], ['set-incomplete', 'Send back'], ['amend', 'Amend terms'], ['disbursement-details', 'Disbursement details'], ['planned-fee', 'Plan a fee'], ['edit-schedule', 'Edit schedule'], ['product-schedule', 'Product schedule'], ['guarantor', 'Add guarantor'], ['collateral', 'Add collateral'], ['funding', 'Add funder'], ['tranches', 'Set tranches'], ['revolving-installment', 'Add installment'], ['attach', 'Attach document'], ['reject', 'Reject'], ['withdraw', 'Withdraw'], ['delete', 'Delete']],
  APPROVED: [['disburse', 'Disburse'], ['disbursement-details', 'Disbursement details'], ['planned-fee', 'Plan a fee'], ['settlement', 'Settlement account'], ['edit-schedule', 'Edit schedule'], ['product-schedule', 'Product schedule'], ['guarantor', 'Add guarantor'], ['revolving-installment', 'Add installment'], ['attach', 'Attach document'], ['undo-approve', 'Undo approval'], ['withdraw', 'Withdraw'], ['delete', 'Delete'], ['notes', 'Notes']],
  ACTIVE: [['repay', 'Post repayment'], ['custom-repay', 'Custom repayment'], ['postdate', 'Postdated payment'], ['postdate-all', 'Postdate installments'], ['drawdown', 'Draw down'], ['collateral', 'Add collateral'], ['fee', 'Apply fee'], ['planned-fee', 'Plan a fee'], ['penalty-rate', 'Change penalty rate'], ['settlement', 'Settlement account'], ['edit-schedule', 'Edit schedule'], ['holiday', 'Payment holiday'], ['due-day', 'Change due day'], ['lock', 'Lock'], ['close', 'Close'], ['reschedule', 'Reschedule'], ['refinance', 'Top-up'], ['write-off', 'Write off'], ...RUNNING_EXTRAS, ['notes', 'Notes']],
  IN_ARREARS: [['repay', 'Post repayment'], ['custom-repay', 'Custom repayment'], ['postdate', 'Postdated payment'], ['drawdown', 'Draw down'], ['collateral', 'Add collateral'], ['fee', 'Apply fee'], ['planned-fee', 'Plan a fee'], ['penalty-rate', 'Change penalty rate'], ['settlement', 'Settlement account'], ['edit-schedule', 'Edit schedule'], ['holiday', 'Payment holiday'], ['lock', 'Lock'], ['reschedule', 'Reschedule'], ['refinance', 'Top-up'], ['write-off', 'Write off'], ...RUNNING_EXTRAS, ['notes', 'Notes']],
  LOCKED: [['unlock', 'Unlock'], ['lock-settings', 'Change lock'], ['repay', 'Post repayment'], ['fee', 'Apply fee'], ['pay-off', 'Pay off'], ['reduce-balance', 'Reduce balance'], ['penalty-rate', 'Change penalty rate'], ['reschedule', 'Reschedule'], ['write-off', 'Write off'], ['guarantor', 'Add guarantor'], ['undo-restructure', 'Undo reschedule or top-up'], ['attach', 'Attach document'], ['name', 'Name'], ['notes', 'Notes']],
  CLOSED_WRITTEN_OFF: [['recovery', 'Post recovery'], ['guarantor-recovery', 'Recover from guarantor'], ['release-call', 'Release guarantor call'], ['attach', 'Attach document'], ['name', 'Name'], ['notes', 'Notes']],
  CLOSED_REPAID: [['undo-close', 'Undo closure'], ['attach', 'Attach document'], ['name', 'Name'], ['notes', 'Notes']],
  CLOSED_RESCHEDULED: [['attach', 'Attach document'], ['name', 'Name']],
  CLOSED_REFINANCED: [['attach', 'Attach document'], ['name', 'Name']],
  CLOSED_REJECTED: [['undo-reject', 'Undo rejection'], ['attach', 'Attach document'], ['delete', 'Delete']],
  CLOSED_WITHDRAWN: [['undo-withdraw', 'Undo withdrawal'], ['attach', 'Attach document'], ['delete', 'Delete']],
};
const BAD_STATES = ['IN_ARREARS', 'LOCKED', 'CLOSED_WRITTEN_OFF'];

export async function loanDetail(row) {
  const id = row.account_no;
  const [loan, schedule, txs, pens, fees, hist, tranches, collateral, funding, woReqs, postdated, planned, amort] = await Promise.all([
    api('GET', `/api/loans/${id}`),
    api('GET', `/api/loans/${id}/schedule`),
    api('GET', `/api/loans/${id}/transactions?limit=25`),
    api('GET', `/api/loans/${id}/penalties?limit=25`),
    api('GET', `/api/loans/${id}/fees`),
    api('GET', `/api/loans/${id}/history`),
    api('GET', `/api/loans/${id}/tranches`),
    api('GET', `/api/loans/${id}/collateral`),
    api('GET', `/api/loans/${id}/funding`),
    api('GET', `/api/loans/${id}/write-off`),
    api('GET', `/api/loans/${id}/postdated-payments`),
    api('GET', `/api/loans/${id}/planned-fees`),
    api('GET', `/api/loans/${id}/fee-amortization`),
  ]);
  if (!loan.ok) throw new Error(loan.error);
  const l = loan.body;
  const [guarantors, attachments, revSched, details, loanCf] = await Promise.all([
    api('GET', `/api/loans/${id}/guarantors`),
    api('GET', `/api/loans/${id}/attachments`),
    l.product_type === 'REVOLVING' ? api('GET', `/api/loans/${id}/revolving-schedule`) : Promise.resolve({ ok: false }),
    ['PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED'].includes(l.status) ? api('GET', `/api/loans/${id}/disbursement-details`) : Promise.resolve({ ok: false }),
    api('GET', `/api/custom-fields/values/LOAN_ACCOUNT/${l.id}`),
  ]);
  const bd = l.breakdown || {};
  const APPLICATION_STATES = ['PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED'];
  const application = APPLICATION_STATES.includes(l.status);
  const drawsSchedule = !['REVOLVING', 'TRANCHED'].includes(l.product_type);
  const appSchedule = application && drawsSchedule ? await api('GET', `/api/loans/${id}/application-schedule`) : null;
  const shapeEdits = ['PAYMENT_DATES', 'PRINCIPAL', 'INTEREST', 'FEES', 'NUMBER_OF_INSTALLMENTS'];
  const fixedTerm = ['FIXED_TERM', 'INTEREST_FREE'].includes(l.product_type);
  const b = l.balances || {};
  const revolving = l.product_type === 'REVOLVING';
  const tranched = l.product_type === 'TRANCHED';
  const woPending = (woReqs.body || []).find((r) => r.status === 'PENDING');
  const actions = (LOAN_ACTIONS[l.status] || []).flatMap((x) => (x[0] === 'write-off' && woPending
    ? [['approve-write-off', 'Approve write-off'], ['reject-write-off', 'Reject write-off']] : [x])).filter(([a]) => {
    if (a === 'drawdown') return revolving || (tranched && (tranches.body || []).some((t) => t.status === 'PLANNED'));
    if (a === 'close') return revolving;
    if (a === 'tranches') return tranched;
    if (['reschedule', 'refinance'].includes(a)) return !revolving;
    if (a === 'holiday') return (l.schedule_editing || []).includes('PAYMENT_HOLIDAYS');
    if (a === 'edit-schedule') return drawsSchedule && (l.schedule_editing || []).some((x) => shapeEdits.includes(x) && (!application || x !== 'FEES'));
    if (a === 'product-schedule') return Boolean(appSchedule?.body?.custom);
    if (a === 'postdate' || a === 'postdate-all') return fixedTerm && l.allow_postdated_payments;
    if (a === 'penalty-rate') return l.penalty_basis && l.penalty_basis !== 'NONE';
    if (a === 'planned-fee') return drawsSchedule || tranched;
    if (a === 'settlement') return Boolean(l.settlement_enabled);
    if (a === 'due-day') return (l.schedule_editing || []).includes('PAYMENT_DATES') && ['DYNAMIC_TERM', 'TRANCHED'].includes(l.product_type);
    if (a === 'terminate') return !l.terminated_on && ['FIXED_TERM', 'DYNAMIC_TERM', 'INTEREST_FREE'].includes(l.product_type);
    if (a === 'undo-terminate') return Boolean(l.terminated_on);
    if (a === 'rate') return l.product_type !== 'INTEREST_FREE';
    if (a === 'holiday-interest') return Number(l.holiday_interest_pending) > 0;
    if (a === 'revolving-installment') return revolving;
    if (a === 'undo-restructure') return Boolean(l.parent_loan_id);
    if (a === 'delete') return S.user?.role === 'TENANT_ADMIN';
    return true;
  });
  if (l.eod_excluded) actions.unshift(['eod-include', 'Include in the end of day']);
  if (!['PARTIAL_APPLICATION'].includes(l.status)) actions.push(['documents', 'Documents']);
  const outstanding = Number(l.principal_disbursed) + Number(l.principal_capitalized || 0) - Number(l.principal_paid);

  view().innerHTML = `
    <button class="secondary" id="back">← Loans</button>
    <h1>${esc(l.account_no)} <span class="badge ${BAD_STATES.includes(l.status) ? 'bad' : ''}">${esc(l.status)}</span>
      ${l.locked_reason ? `<span class="badge warn">locked: ${esc(l.locked_reason)}</span>` : ''}</h1>
    ${l.name ? `<p id="loan-name"><strong>${esc(l.name)}</strong></p>` : ''}
    ${l.status === 'LOCKED' ? `<p class="notice" id="lock-suspends">Locked: ${['interest', 'fees', 'penalties'].filter((x) => l[`lock_${x}`]).join(', ') || 'nothing'} suspended${
    ['interest', 'fees', 'penalties'].some((x) => l[`lock_${x}`] === false) ? `; ${['interest', 'fees', 'penalties'].filter((x) => l[`lock_${x}`] === false).join(', ')} still running` : ''}.</p>` : ''}
    ${Number(l.penalty_deferred) > 0 ? `<p class="notice" id="penalty-deferred">Penalty of ${money(l.penalty_deferred)} accrued while locked, applied on ${day(l.penalty_deferred_until)}.</p>` : ''}
    <p class="hint">${esc(l.first_name)} ${esc(l.last_name)} · ${esc(l.member_no)} · product ${esc(l.product_id)} · ${esc(l.product_type || '')}
      ${l.purpose ? ` · ${esc(l.purpose)}` : ''}${l.parent_account_no ? ` · replaces ${esc(l.parent_account_no)}` : ''}</p>
    ${l.eod_excluded ? `<p class="notice" id="eod-excluded">Left out of the end of day since ${day(l.eod_excluded.since)}: ${esc(l.eod_excluded.job)} failed on it (${esc(l.eod_excluded.error)}). Nothing is accrued or charged until it is included again.</p>` : ''}
    ${l.terminated_on ? `<p class="notice" id="terminated">Terminated on ${day(l.terminated_on)}: everything owed fell due that day.</p>` : ''}
    ${woPending ? `<p class="notice" id="wo-pending">Write-off of ${money(woPending.amount_at_request)} requested by ${esc(woPending.requested_by)}, dated ${day(woPending.value_date)}: ${esc(woPending.reason)}. Another manager approves it.</p>` : ''}
    ${l.refinance_of && !l.parent_loan_id ? `<p class="notice" id="top-up-quote">Top-up of ${esc(l.refinances_account_no)}: on disbursement this loan settles it and pays the rest to the member.</p>` : ''}
    ${l.notes ? `<p class="hint">${esc(l.notes)}</p>` : ''}
    <div class="toolbar">${actions.map(([a, label]) =>
    `<button data-action="${a}" class="${['approve', 'disburse', 'repay', 'request-approval'].includes(a) ? '' : 'secondary'}">${label}</button>`).join('')}</div>
    <div class="grid">
      ${card('Balances', `<dl class="kv">
        <dt>Principal</dt><dd>${money(l.principal)}</dd>
        <dt>Disbursed</dt><dd>${money(l.principal_disbursed)}</dd>
        ${Number(l.principal_capitalized) > 0 ? `<dt>Capitalised</dt><dd>${money(l.principal_capitalized)}</dd>` : ''}
        <dt>Principal outstanding</dt><dd>${money(b.principal ?? outstanding)}</dd>
        <dt>Interest outstanding</dt><dd>${money(b.interest ?? (l.interest_accrued - l.interest_paid))}</dd>
        <dt>Fees outstanding</dt><dd>${money(b.fees ?? (l.fees_due - l.fees_paid))}</dd>
        <dt>Penalty outstanding</dt><dd>${money(b.penalty ?? (l.penalty_accrued - l.penalty_paid))}</dd>
        <dt>Total outstanding</dt><dd>${money(b.total)}</dd>
        ${revolving ? `<dt>Credit limit</dt><dd>${money(l.principal)}</dd><dt>Credit balance (member's money)</dt><dd>${money(l.credit_balance)}</dd>
          ${l.next_billing_on ? `<dt>Next billing</dt><dd>${day(l.next_billing_on)}</dd>` : ''}` : ''}
        ${Number(l.tax_charged) > 0 ? `<dt>Of which tax</dt><dd>${money(l.tax_charged)}</dd>` : ''}
        ${Number(l.interest_prepaid) > 0 ? `<dt>Interest paid in advance</dt><dd id="interest-prepaid">${money(l.interest_prepaid)}</dd>` : ''}
        ${Number(l.ns_fees_due) > 0 ? `<dt>Fees outside the schedule</dt><dd id="ns-fees">${money(Number(l.ns_fees_due) - Number(l.ns_fees_paid))} of ${money(l.ns_fees_due)}</dd>` : ''}
        ${Number(l.penalty_unapplied) > 0 ? `<dt>Penalty accrued, not yet applied</dt><dd id="penalty-unapplied">${money(l.penalty_unapplied)}</dd>` : ''}
        ${l.settlement_account_no ? `<dt>Settlement account</dt><dd id="settlement-account">${esc(l.settlement_account_no)} · ${esc(String(l.settlement_option || '').toLowerCase().replace(/_/g, ' '))}</dd>` : ''}
        ${l.days_late ? `<dt>Days late</dt><dd id="days-late">${l.days_late}</dd><dt>Days in arrears</dt><dd id="days-in-arrears">${l.days_in_arrears}</dd>` : ''}
        ${l.penalty_rate !== null && l.penalty_basis && l.penalty_basis !== 'NONE' ? `<dt>Penalty rate</dt><dd id="penalty-rate">${esc(l.penalty_rate)}% · ${esc(l.penalty_basis.toLowerCase().replace(/_/g, ' '))}</dd>` : ''}
        ${l.postdated_pending ? `<dt>Postdated payments pending</dt><dd>${l.postdated_pending}</dd>` : ''}
        ${l.arrears_since ? `<dt>In arrears since</dt><dd>${day(l.arrears_since)}</dd>` : ''}
        ${l.rate_plan ? `<dt>Rate in force</dt><dd id="rate-plan">${esc(l.monthly_rate)}% · ${l.rate_plan === 'INDEX' ? 'index plus spread, reviewed' : 'adjustable periods'}</dd>` : ''}
        ${l.written_off_on ? `<dt>Written off</dt><dd>${money(l.written_off_amount)} on ${day(l.written_off_on)} by ${esc(l.written_off_by || '')}</dd>
          <dt>Recovered since</dt><dd>${money(l.recovered)}</dd>
          <dt>Still to recover</dt><dd id="wo-left">${money(Number(l.written_off_amount) - Number(l.recovered))}</dd>` : ''}
        ${bd.interestFromArrears && bd.interestFromArrears.accrued > 0 ? `<dt>Interest from arrears due</dt><dd id="interest-from-arrears">${money(bd.interestFromArrears.due)} of ${money(bd.interestFromArrears.accrued)}</dd>` : ''}
        ${Number(l.holiday_interest_pending) > 0 ? `<dt>Holiday interest held</dt><dd id="holiday-held">${money(l.holiday_interest_pending)}</dd>` : ''}
        ${l.previous_account_no ? `<dt>Previously numbered</dt><dd>${esc(l.previous_account_no)}</dd>` : ''}
        <dt>Member's completed loan cycles</dt><dd id="loan-cycles">${l.completed_loan_cycles ?? 0}</dd>
        ${l.approved_by ? `<dt>Approved by</dt><dd>${esc(l.approved_by)}</dd>` : ''}
        ${l.disbursed_by ? `<dt>Disbursed by</dt><dd>${esc(l.disbursed_by)}</dd>` : ''}
      </dl>`)}
      ${card('Recent transactions', table([
    { label: 'Date', value: (t) => day(t.value_date) },
    { label: 'Kind', key: 'kind' },
    { label: 'Amount', num: true, value: (t) => money(t.amount) },
  ], txs.body || [], { empty: 'None yet' }))}
    </div>
    ${bd.principal && Number(l.principal_disbursed) > 0 ? `<div id="breakdown">${card('Due and paid', table([
    { label: '', key: 'k' },
    { label: 'Expected', num: true, value: (x) => (x.expected === undefined ? '' : money(x.expected)) },
    { label: 'Due now', num: true, value: (x) => money(x.due) },
    { label: 'Paid', num: true, value: (x) => money(x.paid) },
    { label: 'Outstanding', num: true, value: (x) => money(x.outstanding) },
  ], [['Principal', bd.principal], ['Interest', bd.interest], ['Fees', bd.fees], ['Penalties', bd.penalty]].map(([k, x]) => ({ k, ...x }))))}</div>` : ''}
    ${details.ok ? `<div id="disbursement-details">${card('Disbursement details', `<dl class="kv">
        <dt>Anticipated disbursement</dt><dd>${day(details.body.expectedDisbursementDate) || '—'}</dd>
        <dt>First repayment</dt><dd>${day(details.body.firstRepaymentDate) || 'from the product'}</dd>
        <dt>Paid out</dt><dd>${details.body.disbursementSavingsAccountId ? 'into the member\'s deposit account' : esc(details.body.disbursementChannelId || 'channel chosen at disbursement')}</dd>
        <dt>Changes</dt><dd>${details.body.changes.length}</dd></dl>`)}</div>` : ''}
    ${revSched.ok ? `<div id="revolving-schedule">${card('Installments added by hand', `${table([
    { label: 'Due', value: (x) => day(x.dueDate) },
    { label: 'Status', key: 'status' },
    { label: '', html: true, value: (x) => `<button class="link" data-drop-installment="${x.id}">remove</button>` },
  ], revSched.body.addedByHand, { empty: 'None to come' })}<p class="hint">Next product billing date: ${day(revSched.body.nextProductBilling) || '—'}</p>`)}</div>` : ''}
    ${appSchedule?.ok ? `<div id="application-schedule">${card(appSchedule.body.custom ? 'Schedule edited on the application (as if disbursed today)' : 'Schedule if disbursed today', table([
    { label: '#', key: 'number' },
    { label: 'Due', value: (i) => day(i.dueDate) },
    { label: 'Principal', num: true, value: (i) => money(i.principal) },
    { label: 'Interest', num: true, value: (i) => money(i.interest) },
    { label: 'Fees', num: true, value: (i) => money(i.fee) },
  ], appSchedule.body.installments))}</div>` : ''}
    ${(planned.body || []).length ? card('Planned fees', table([
    { label: 'Installment', key: 'installment_number' },
    { label: 'Due', value: (p) => (p.due_date ? day(p.due_date) : '') },
    { label: 'Fee', key: 'name' },
    { label: 'Amount', num: true, value: (p) => money(p.amount) },
    { label: 'Apply on', value: (p) => (p.apply_on ? day(p.apply_on) : '') },
    { label: 'Status', value: (p) => `${p.status}${p.reason ? `: ${p.reason}` : ''}` },
    { label: '', html: true, value: (p) => (p.status === 'PLANNED' ? `<button class="link" data-apply-planned="${p.id}">apply now</button> <button class="link" data-edit-planned="${p.id}">edit</button> <button class="link" data-drop-planned="${p.id}">delete</button>` : '') },
  ], planned.body)) : ''}
    ${(amort.body || []).length ? card('Fee amortisation', table([
    { label: 'Fee', key: 'fee_name' },
    { label: 'Period', value: (a) => `${day(a.period_start)} to ${day(a.period_end)}` },
    { label: 'Amount', num: true, value: (a) => money(a.amount) },
    { label: 'Recognised', num: true, value: (a) => money(a.recognised) },
    { label: 'Status', key: 'status' },
  ], amort.body)) : ''}
    ${(postdated.body || []).length ? card('Postdated payments', table([
    { label: 'Value date', value: (p) => day(p.value_date) },
    { label: 'Amount', num: true, value: (p) => money(p.amount) },
    { label: 'Installment', value: (p) => p.installment_no || '' },
    { label: 'Reference', value: (p) => p.reference || '' },
    { label: 'Status', value: (p) => `${p.status}${p.failure ? `: ${p.failure}` : ''}` },
    { label: '', html: true, value: (p) => (p.status === 'PENDING' ? `<button class="link" data-cancel-postdated="${p.id}">cancel</button>` : '') },
  ], postdated.body)) : ''}
    ${application && appSchedule?.ok ? '' : card('Schedule', table([
    { label: '#', key: 'number' },
    { label: 'Due', value: (i) => day(i.due_date) },
    { label: 'Principal', num: true, value: (i) => money(i.principal_due) },
    { label: 'Interest', num: true, value: (i) => money(i.interest_due) },
    { label: 'Fees', num: true, value: (i) => `${money(i.fee_due)}${Number(i.planned_fees) > 0 ? ` + ${money(i.planned_fees)} planned` : ''}` },
    { label: 'Paid', num: true, value: (i) => money(Number(i.principal_paid) + Number(i.interest_paid) + Number(i.fee_paid)) },
    { label: 'Status', key: 'status' },
  ], schedule.body || [], { empty: 'Not disbursed yet' }))}
    <div class="grid">
    ${card('Fees', table([
    { label: 'Applied', value: (f) => day(f.applied_on) },
    { label: 'Fee', key: 'name' },
    { label: 'Type', key: 'fee_type' },
    { label: 'Amount', num: true, value: (f) => money(f.amount) },
    { label: 'Paid', num: true, value: (f) => money(f.paid) },
    { label: 'Status', key: 'status' },
    { label: '', html: true, value: (f) => (f.status === 'DUE' ? `<button class="link" data-waive-fee="${f.id}">waive</button>${Number(f.paid) === 0 && !String(f.fee_type).startsWith('DISBURSEMENT_') ? ` <button class="link" data-adjust-fee="${f.id}">adjust</button>` : ''}` : '') },
  ], fees.body || [], { empty: 'None' }))}
    ${card('Penalties', table([
    { label: 'Charged', value: (p) => day(p.charged_on) },
    { label: 'Days late', num: true, key: 'days_late' },
    { label: 'Amount', num: true, value: (p) => money(p.amount) },
    { label: 'Waived', value: (p) => (p.adjusted_at ? 'adjusted' : p.waived_at ? 'yes' : '') },
    { label: '', html: true, value: (p) => (!p.waived_at && !p.reversed_at && Number(p.amount) > 0 ? `<button class="link" data-adjust-penalty="${p.id}">adjust</button>` : '') },
  ], pens.body || [], { empty: 'None' }))}
    </div>
    <div class="grid">
    ${card('Guarantors', table([
    { label: 'Guarantor', value: (g) => `${g.first_name} ${g.last_name} · ${g.member_no}` },
    { label: 'Pledged', num: true, value: (g) => money(g.pledged_amount) },
    { label: 'Status', key: 'status' },
    { label: '', html: true, value: (g) => (g.status === 'PLEDGED' ? `<button class="link" data-drop-guarantor="${g.id}">remove</button>` : '') },
  ], guarantors.body || [], { empty: 'None' }))}
    <div id="attachments">${card('Attachments', table([
    { label: 'Title', key: 'title' },
    { label: 'File', value: (x) => `${x.fileName} · ${Math.ceil(x.size / 1024)} KB` },
    { label: 'Added', value: (x) => `${day(x.createdAt)} ${x.createdBy || ''}` },
    { label: '', html: true, value: (x) => `${x.previewable ? `<button class="link" data-preview="${x.id}">preview</button> ` : ''}<button class="link" data-download="${x.id}">download</button> <button class="link" data-edit-attachment="${x.id}">edit</button> <button class="link" data-drop-attachment="${x.id}">delete</button>` },
  ], attachments.body || [], { empty: 'No documents' }))}</div>
    </div>
    ${(tranches.body || []).length ? card('Tranches', table([
    { label: '#', key: 'number' },
    { label: 'Amount', num: true, value: (t) => money(t.amount) },
    { label: 'Expected', value: (t) => day(t.expected_on) },
    { label: 'Disbursed', value: (t) => (t.disbursed_on ? `${day(t.disbursed_on)} · ${money(t.disbursed_amount)}` : '') },
    { label: 'Status', key: 'status' },
  ], tranches.body)) : ''}
    ${(collateral.body || []).length ? card('Collateral', table([
    { label: 'Asset', value: (k) => `${k.asset_type} · ${k.description}${k.reference ? ` (${k.reference})` : ''}` },
    { label: 'Value', num: true, value: (k) => money(k.value) },
    { label: 'Status', key: 'status' },
    { label: '', html: true, value: (k) => (k.status === 'PLEDGED' ? `<button class="link" data-release="${k.id}">release</button>` : '') },
  ], collateral.body)) : ''}
    ${(funding.body || []).length ? card('Funding sources', table([
    { label: 'Funder', value: (f) => `${f.first_name} ${f.last_name} · ${f.account_no}` },
    { label: 'Amount', num: true, value: (f) => money(f.amount) },
    { label: 'Rate', num: true, value: (f) => (f.funder_rate === null ? '' : `${f.funder_rate}%`) },
    { label: 'Principal back', num: true, value: (f) => money(f.principal_returned) },
    { label: 'Interest back', num: true, value: (f) => money(f.interest_returned) },
    { label: 'Status', key: 'status' },
  ], funding.body)) : ''}
    ${card('History', table([
    { label: 'When', value: (h) => day(h.at) },
    { label: 'Action', key: 'action' },
    { label: 'From', value: (h) => h.from_status || '' },
    { label: 'To', key: 'to_status' },
    { label: 'By', key: 'actor' },
    { label: 'Note', value: (h) => h.note || '' },
  ], hist.body || [], { empty: 'None' }))}
    ${loanCf.ok ? customFieldsCard(loanCf.body) : ''}${activityCard()}`;
  loadActivity('loans', id);

  $('#back').addEventListener('click', loansView);
  entityReports('LOAN', id);
  if (loanCf.ok) wireCustomFields(loanCf.body, 'LOAN_ACCOUNT', l.id, () => loanDetail(row));
  view().querySelectorAll('[data-release]').forEach((btn) => btn.addEventListener('click', async () => {
    const d = await ask([{ label: 'Note', name: 'note', required: false }], 'Release collateral');
    if (!d) return;
    const res = await api('POST', `/api/loans/collateral/${btn.dataset.release}/release`, { note: d.note });
    toast(res.ok ? 'Released' : res.error, !res.ok);
    if (res.ok) loanDetail(row);
  }));
  view().querySelectorAll('[data-apply-planned]').forEach((btn) => btn.addEventListener('click', async () => {
    const res = await api('POST', `/api/loans/${id}/planned-fees/apply`, { ids: [Number(btn.dataset.applyPlanned)] });
    toast(res.ok ? 'Planned fee applied' : res.error, !res.ok);
    if (res.ok) loanDetail(row);
  }));
  view().querySelectorAll('[data-edit-planned]').forEach((btn) => btn.addEventListener('click', async () => {
    const p = (planned.body || []).find((x) => String(x.id) === btn.dataset.editPlanned);
    const d = await ask([
      { label: 'Installment', name: 'installment', type: 'number', value: p.installment_number },
      { label: 'Amount', name: 'amount', type: 'number', step: '0.01', value: p.amount },
      { label: 'Apply on (blank: the due date)', name: 'applyOn', type: 'date', value: p.apply_on ? String(p.apply_on).slice(0, 10) : '', required: false },
    ], 'Edit planned fee');
    if (!d) return;
    const res = await api('PATCH', `/api/loans/planned-fees/${p.id}`, { installment: Number(d.installment), amount: Number(d.amount), applyOn: d.applyOn || null });
    toast(res.ok ? 'Planned fee changed' : res.error, !res.ok);
    if (res.ok) loanDetail(row);
  }));
  view().querySelectorAll('[data-drop-planned]').forEach((btn) => btn.addEventListener('click', async () => {
    const res = await api('DELETE', `/api/loans/planned-fees/${btn.dataset.dropPlanned}`);
    toast(res.ok ? 'Planned fee deleted' : res.error, !res.ok);
    if (res.ok) loanDetail(row);
  }));
  view().querySelectorAll('[data-cancel-postdated]').forEach((btn) => btn.addEventListener('click', async () => {
    const d = await ask([{ label: 'Reason', name: 'reason', required: false }], 'Cancel postdated payment');
    if (!d) return;
    const res = await api('POST', `/api/loans/postdated-payments/${btn.dataset.cancelPostdated}/cancel`, { reason: d.reason || undefined });
    toast(res.ok ? 'Postdated payment cancelled' : res.error, !res.ok);
    if (res.ok) loanDetail(row);
  }));
  view().querySelectorAll('[data-waive-fee]').forEach((btn) => btn.addEventListener('click', async () => {
    const d = await ask([{ label: 'Reason', name: 'reason' }], 'Waive fee');
    if (!d) return;
    const res = await api('POST', `/api/loans/fees/${btn.dataset.waiveFee}/waive`, { reason: d.reason });
    toast(res.ok ? 'Fee waived' : res.error, !res.ok);
    if (res.ok) loanDetail(row);
  }));
  const reload = () => loanDetail(row);
  view().querySelectorAll('[data-adjust-fee]').forEach((btn) => btn.addEventListener('click', async () => {
    const d = await ask([{ label: 'Reason (the fee is taken back as if never applied)', name: 'reason' }], 'Adjust fee');
    if (!d) return;
    const res = await api('POST', `/api/loans/fees/${btn.dataset.adjustFee}/adjust`, { reason: d.reason });
    toast(res.ok ? 'Fee adjusted' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  view().querySelectorAll('[data-adjust-penalty]').forEach((btn) => btn.addEventListener('click', async () => {
    const d = await ask([{ label: 'Reason (only before a repayment is entered)', name: 'reason' }], 'Adjust penalty');
    if (!d) return;
    const res = await api('POST', `/api/loans/penalties/${btn.dataset.adjustPenalty}/adjust`, { reason: d.reason });
    toast(res.ok ? 'Penalty adjusted' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  view().querySelectorAll('[data-drop-guarantor]').forEach((btn) => btn.addEventListener('click', async () => {
    const d = await ask([{ label: 'Note', name: 'note', required: false }], 'Remove guarantor');
    if (!d) return;
    const res = await api('DELETE', `/api/loans/${id}/guarantors/${btn.dataset.dropGuarantor}`, { note: d.note || undefined });
    toast(res.ok ? 'Guarantor removed' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  view().querySelectorAll('[data-drop-installment]').forEach((btn) => btn.addEventListener('click', async () => {
    const res = await api('DELETE', `/api/loans/${id}/revolving-installments/${btn.dataset.dropInstallment}`);
    toast(res.ok ? 'Installment removed' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  const attachment = (aid) => (attachments.body || []).find((x) => x.id === aid);
  view().querySelectorAll('[data-preview]').forEach((btn) => btn.addEventListener('click', () =>
    openFile(`/api/loans/${id}/attachments/${btn.dataset.preview}/preview`, attachment(btn.dataset.preview)?.fileName)));
  view().querySelectorAll('[data-download]').forEach((btn) => btn.addEventListener('click', () =>
    openFile(`/api/loans/${id}/attachments/${btn.dataset.download}/download`, attachment(btn.dataset.download)?.fileName, { save: true })));
  view().querySelectorAll('[data-edit-attachment]').forEach((btn) => btn.addEventListener('click', async () => {
    const x = attachment(btn.dataset.editAttachment);
    const d = await ask([{ label: 'Title', name: 'title', value: x.title }, { label: 'Description', name: 'description', value: x.description || '', required: false }], 'Edit document');
    if (!d) return;
    const res = await api('PATCH', `/api/loans/${id}/attachments/${x.id}`, { title: d.title, description: d.description });
    toast(res.ok ? 'Document saved' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  view().querySelectorAll('[data-drop-attachment]').forEach((btn) => btn.addEventListener('click', async () => {
    const d = await ask([{ label: `Delete ${attachment(btn.dataset.dropAttachment)?.fileName}? Type DELETE`, name: 'confirm' }], 'Delete document');
    if (!d || d.confirm !== 'DELETE') return;
    const res = await api('DELETE', `/api/loans/${id}/attachments/${btn.dataset.dropAttachment}`);
    toast(res.ok ? 'Document deleted' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  view().querySelectorAll('[data-action]').forEach((btn) => btn.addEventListener('click', async () => {
    const a = btn.dataset.action;
    let res;
    const simple = ['approve', 'undo-approve', 'request-approval', 'undo-reject', 'undo-withdraw', 'close'];
    if (simple.includes(a)) res = await api('POST', `/api/loans/${id}/${a}`, {});
    const SUSPEND = ['interest', 'fees', 'penalties'];
    if (a === 'lock' || a === 'lock-settings') {
      const d = await ask([
        ...SUSPEND.map((x) => ({ label: `Suspend ${x}`, name: x, options: ['true', 'false'], value: a === 'lock' ? 'true' : String(l[`lock_${x}`] !== false) })),
        opt({ label: 'Date (blank: today)', name: 'valueDate', type: 'date' }),
        opt({ label: 'Note', name: 'note' }),
      ], a === 'lock' ? `Lock ${l.account_no}` : `Change what the lock on ${l.account_no} suspends`);
      if (!d) return;
      const body = { suspend: Object.fromEntries(SUSPEND.map((x) => [x, d[x] === 'true'])), valueDate: d.valueDate || undefined, note: d.note || undefined };
      res = await api('POST', `/api/loans/${id}/${a}`, body);
    }
    if (a === 'unlock' || a === 'undo-close') {
      const d = await ask([opt({ label: 'Date (blank: today)', name: 'valueDate', type: 'date' }), opt({ label: 'Note', name: 'note' })],
        a === 'unlock' ? `Unlock ${l.account_no}: penalties suspended while locked are not charged for those days` : `Undo the closure of ${l.account_no}`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/${a}`, { valueDate: d.valueDate || undefined, note: d.note || undefined });
    }
    if (a === 'name') {
      const d = await ask([opt({ label: 'Name', name: 'name', value: l.name || '' })], `Name of ${l.account_no}`);
      if (!d) return;
      res = await api('PATCH', `/api/loans/${id}`, { name: d.name || null });
    }
    if (a === 'delete') {
      const d = await ask([opt({ label: 'Reason', name: 'note' }), { label: 'Type DELETE to confirm', name: 'confirm' }],
        `Delete ${l.account_no}: only a loan nothing was posted to; it cannot be brought back`);
      if (!d || d.confirm !== 'DELETE') return;
      res = await api('DELETE', `/api/loans/${id}`, { note: d.note || undefined });
      if (res.ok) { toast(`${l.account_no} deleted`); return loansView(); }
    }
    if (['reject', 'withdraw', 'set-incomplete'].includes(a)) {
      const d = await ask([{ label: 'Note', name: 'note', required: false }], `${btn.textContent} ${l.account_no}`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/${a}`, { note: d.note });
    }
    if (a === 'amend') {
      const d = await ask([
        { label: 'Principal', name: 'principal', type: 'number', step: '0.01', value: l.principal },
        { label: 'Installments', name: 'termMonths', type: 'number', value: l.term_months },
        { label: 'Rate (product unit)', name: 'monthlyRate', type: 'number', step: '0.001', value: l.monthly_rate },
        { label: 'Name', name: 'name', value: l.name || '', required: false },
        { label: 'Purpose', name: 'purpose', value: l.purpose || '', required: false },
        { label: 'Notes', name: 'notes', value: l.notes || '', required: false },
      ], 'Amend application');
      if (!d) return;
      res = await api('PATCH', `/api/loans/${id}`, {
        principal: Number(d.principal), termMonths: Number(d.termMonths), monthlyRate: Number(d.monthlyRate), name: d.name || null, purpose: d.purpose, notes: d.notes });
    }
    if (a === 'notes') {
      const d = await ask([{ label: 'Notes', name: 'notes', value: l.notes || '' }], 'Notes');
      if (!d) return;
      res = await api('PATCH', `/api/loans/${id}`, { notes: d.notes });
    }
    if (a === 'disburse' && l.refinance_of) {
      const q = await api('GET', `/api/loans/${id}/refinance-quote`);
      if (!q.ok) return toast(q.error, true);
      const d = await ask([
        { label: `Settles ${q.body.refinances.accountNo} (${money(q.body.settlement)}); top-up paid out now ${money(q.body.topUp)}. Channel`, name: 'channelId', value: 'bank' },
      ], 'Disburse top-up');
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/disbursements`, { channelId: d.channelId });
      if (res.ok) { toast(`Top-up of ${money(res.body.topUp)} paid; ${res.body.oldLoan.accountNo} closed`); return loanDetail(row); }
    } else if (a === 'disburse') {
      const dd = details.body || {};
      const d = await ask([
        { label: 'Amount', name: 'amount', type: 'number', step: '0.01', value: l.principal },
        opt({ label: 'Channel (blank: into the deposit account below or in the details)', name: 'channelId', value: dd.disbursementSavingsAccountId ? '' : (dd.disbursementChannelId || 'bank') }),
        opt({ label: 'Into the member\'s deposit account number', name: 'savingsAccountId', value: '' }),
        opt({ label: 'Value date (blank: today)', name: 'valueDate', type: 'date', value: day(dd.expectedDisbursementDate) }),
        opt({ label: 'First repayment date (blank: the details, else the product)', name: 'firstRepaymentDate', type: 'date', value: '' }),
        { label: 'Optional fee codes, comma separated', name: 'fees', value: '', required: false },
      ], 'Disburse loan');
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/disbursements`, {
        amount: Number(d.amount), channelId: d.channelId || undefined, savingsAccountId: d.savingsAccountId ? d.savingsAccountId.trim() : undefined,
        valueDate: d.valueDate || undefined, firstRepaymentDate: d.firstRepaymentDate || undefined,
        fees: d.fees ? d.fees.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : [] });
    }
    if (a === 'drawdown') {
      const d = await ask([
        { label: tranched ? 'Amount (blank: the next tranche)' : 'Amount', name: 'amount', type: 'number', step: '0.01', required: !tranched },
        { label: 'Channel', name: 'channelId', value: 'bank' },
      ], tranched ? 'Disburse next tranche' : 'Draw down');
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/disbursements`, { amount: d.amount ? Number(d.amount) : undefined, channelId: d.channelId });
    }
    if (a === 'collateral') {
      const d = await ask([
        { label: 'Asset type', name: 'assetType', options: ['VEHICLE', 'LAND', 'BUILDING', 'EQUIPMENT', 'SHARES', 'STOCK', 'OTHER'], value: 'OTHER' },
        { label: 'Description', name: 'description' },
        { label: 'Value accepted as security', name: 'value', type: 'number', step: '0.01' },
        { label: 'Reference (logbook, title number)', name: 'reference', required: false },
      ], 'Add collateral');
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/collateral`, { assetType: d.assetType, description: d.description, value: Number(d.value), reference: d.reference || undefined });
    }
    if (a === 'funding') {
      const d = await ask([
        { label: 'Funding account number', name: 'savingsAccountId' },
        { label: 'Amount', name: 'amount', type: 'number', step: '0.01' },
        { label: 'Funder rate (fixed commissions only)', name: 'funderRate', type: 'number', step: '0.0001', required: false },
      ], 'Add funding source');
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/funding`, { savingsAccountId: d.savingsAccountId, amount: Number(d.amount), funderRate: d.funderRate ? Number(d.funderRate) : undefined });
    }
    if (a === 'tranches') {
      const d = await ask([
        { label: 'Tranches, one per line as amount,date (e.g. 100000,2026-03-01)', name: 'tranches' },
      ], 'Set planned tranches');
      if (!d) return;
      const list = d.tranches.split(/[;\n]/).map((x) => x.trim()).filter(Boolean).map((x) => { const [amount, expectedOn] = x.split(','); return { amount: Number(amount), expectedOn: (expectedOn || '').trim() }; });
      res = await api('PUT', `/api/loans/${id}/tranches`, { tranches: list });
    }
    if (a === 'repay') {
      const d = await ask([
        { label: 'Amount', name: 'amount', type: 'number', step: '0.01' },
        { label: 'Channel', name: 'channelId', value: 'cash' },
      ], 'Post repayment');
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/repayments`, { amount: Number(d.amount), channelId: d.channelId });
    }
    if (a === 'fee') {
      const d = await ask([
        { label: 'Fee code (leave blank for an arbitrary fee)', name: 'fee', value: '', required: false },
        { label: 'Name (arbitrary fee)', name: 'name', value: '', required: false },
        { label: 'Amount (if the fee leaves it open)', name: 'amount', type: 'number', step: '0.01', required: false },
        { label: 'Goes on', name: 'allocation', options: ['FEE_SETTING', 'NEXT_INSTALLMENT', 'NO_ALLOCATION'], value: 'FEE_SETTING' },
        opt({ label: 'On installment number (blank: as above)', name: 'installmentNumber', type: 'number' }),
        opt({ label: 'Back date (blank: today)', name: 'valueDate', type: 'date' }),
        { label: 'Note', name: 'note', required: false },
      ], 'Apply fee');
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/fees`, {
        fee: d.fee ? d.fee.toUpperCase() : undefined, name: d.name || undefined,
        amount: d.amount ? Number(d.amount) : undefined, note: d.note,
        installmentNumber: d.installmentNumber ? Number(d.installmentNumber) : undefined, valueDate: d.valueDate || undefined,
        allocation: d.allocation === 'FEE_SETTING' ? undefined : d.allocation });
    }
    if (a === 'reschedule' || a === 'refinance') {
      const d = await ask([
        { label: 'New number of installments', name: 'termMonths', type: 'number', value: l.term_months },
        { label: 'Product (blank keeps the same)', name: 'productId', value: '', required: false },
        ...(a === 'refinance' ? [{ label: 'Top-up the member asks for', name: 'topUp', type: 'number', step: '0.01' }] : []),
        { label: 'Interest, fees and penalties owed', name: 'arrears', options: ['CAPITALIZE', 'WRITE_OFF', 'PART'], value: 'CAPITALIZE' },
        opt({ label: `If PART: interest to capitalise (owed ${money(b.interest)}), the rest written off`, name: 'capInterest', type: 'number', step: '0.01' }),
        opt({ label: `If PART: fees to capitalise (owed ${money(Number(b.fees || 0) + Number(b.nonScheduledFees || 0))})`, name: 'capFees', type: 'number', step: '0.01' }),
        opt({ label: `If PART: penalties to capitalise (owed ${money(b.penalty)})`, name: 'capPenalty', type: 'number', step: '0.01' }),
        ...(a === 'reschedule' ? [opt({ label: `New principal (blank: all ${money(b.principal)}; less writes the rest off)`, name: 'principal', type: 'number', step: '0.01' })] : []),
        { label: 'Late and payment-due fees move to the new loan', name: 'carryFees', options: ['true', 'false'], value: 'true' },
        { label: 'The new loan keeps this account number', name: 'keepAccountNo', options: ['false', 'true'], value: 'false' },
        { label: 'Note', name: 'note', required: false },
      ], a === 'refinance' ? 'Top-up application' : 'Reschedule loan');
      if (!d) return;
      const part = d.arrears === 'PART';
      res = await api('POST', `/api/loans/${id}/${a}`, {
        termMonths: Number(d.termMonths), productId: d.productId || undefined, arrears: part ? 'CAPITALIZE' : d.arrears, note: d.note,
        ...(part ? { capitalize: { interest: Number(d.capInterest || 0), fees: Number(d.capFees || 0), penalty: Number(d.capPenalty || 0) } } : {}),
        ...(a === 'reschedule' && d.principal ? { principal: Number(d.principal) } : {}),
        carryFees: d.carryFees === 'true', keepAccountNo: d.keepAccountNo === 'true',
        ...(a === 'refinance' ? { topUp: Number(d.topUp) } : {}) });
      if (res.ok && a === 'refinance') {
        toast(`Application ${res.body.application.account_no} for ${money(res.body.application.principal)} awaits approval`);
        return loanDetail({ account_no: res.body.application.account_no });
      }
      if (res.ok) { toast(`New loan ${res.body.newLoan.account_no} opened`); return loanDetail({ account_no: res.body.newLoan.account_no }); }
    }
    if (a === 'custom-repay') {
      const d = await ask([
        { label: `Penalty (owed ${money(b.penalty)})`, name: 'penalty', type: 'number', step: '0.01', value: 0 },
        { label: `Fees (owed ${money(b.fees)})`, name: 'fee', type: 'number', step: '0.01', value: 0 },
        { label: `Interest (owed ${money(b.interest)})`, name: 'interest', type: 'number', step: '0.01', value: 0 },
        { label: `Principal (owed ${money(b.principal)})`, name: 'principal', type: 'number', step: '0.01', value: 0 },
        { label: `Fees outside the schedule (owed ${money(b.nonScheduledFees || 0)})`, name: 'nonScheduledFee', type: 'number', step: '0.01', value: 0 },
        { label: 'Channel', name: 'channelId', value: 'cash' },
      ], `Custom repayment on ${l.account_no}`);
      if (!d) return;
      const parts = Object.fromEntries(['penalty', 'fee', 'interest', 'principal', 'nonScheduledFee'].map((k) => [k, Number(d[k] || 0)]).filter(([, v]) => v > 0));
      const amount = Math.round(Object.values(parts).reduce((x, v) => x + v, 0) * 100) / 100;
      res = await api('POST', `/api/loans/${id}/repayments`, { amount, channelId: d.channelId, customAllocation: parts });
    }
    if (a === 'settlement') {
      const d = await ask([
        { label: `Deposit account number${l.settlement_account_no ? ` (now ${l.settlement_account_no}; blank to unlink)` : ''}`, name: 'account', value: l.settlement_account_no || '', required: false },
      ], `Settlement account for ${l.account_no}`);
      if (!d) return;
      res = d.account ? await api('PUT', `/api/loans/${id}/settlement-account`, { savingsAccountId: d.account.trim() })
        : await api('DELETE', `/api/loans/${id}/settlement-account`);
    }
    if (a === 'penalty-rate') {
      const d = await ask([
        { label: 'New penalty rate', name: 'rate', type: 'number', step: '0.001', value: l.penalty_rate ?? '' },
        { label: 'Note', name: 'note', required: false },
      ], `Change the penalty rate of ${l.account_no}`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/penalty-rate`, { rate: Number(d.rate), note: d.note || undefined });
    }
    if (a === 'planned-fee') {
      const d = await ask([
        { label: 'Installment number', name: 'installment', type: 'number' },
        { label: 'Manual fee code (blank for an arbitrary fee)', name: 'fee', required: false },
        { label: 'Name (arbitrary fee)', name: 'name', required: false },
        { label: 'Amount (blank: the fee\'s own)', name: 'amount', type: 'number', step: '0.01', required: false },
        { label: 'Apply on (blank: the installment\'s due date)', name: 'applyOn', type: 'date', required: false },
      ], `Plan a fee on ${l.account_no}`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/planned-fees`, {
        installment: Number(d.installment), fee: d.fee ? d.fee.toUpperCase() : undefined, name: d.name || undefined,
        amount: d.amount ? Number(d.amount) : undefined, applyOn: d.applyOn || undefined });
    }
    if (a === 'edit-schedule') {
      const e = await api('GET', `/api/loans/${id}/schedule/editable`);
      if (!e.ok) return toast(e.error, true);
      if (!e.body.installments.length) return toast('No installment can change: each has been paid on, has fallen due or has started to earn interest', true);
      const d = await scheduleEditor(e.body, `Edit the schedule of ${l.account_no}`);
      if (!d) return;
      res = await api('PUT', `/api/loans/${id}/schedule`, d);
    }
    if (a === 'product-schedule') res = await api('DELETE', `/api/loans/${id}/application-schedule`);
    if (a === 'postdate') {
      const d = await ask([
        { label: 'Amount', name: 'amount', type: 'number', step: '0.01' },
        { label: 'Value date (when it is applied)', name: 'valueDate', type: 'date' },
        { label: 'Channel', name: 'channelId', value: 'bank' },
        { label: 'Reference (cheque number)', name: 'reference', required: false },
      ], `Postdated payment on ${l.account_no}`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/postdated-payments`, { amount: Number(d.amount), valueDate: d.valueDate, channelId: d.channelId, reference: d.reference || undefined });
    }
    if (a === 'postdate-all') {
      const d = await ask([
        { label: 'Channel', name: 'channelId', value: 'bank' },
        { label: 'Reference prefix (cheque series)', name: 'reference', required: false },
        { label: 'From installment number (blank: the next)', name: 'from', type: 'number', required: false },
      ], `One postdated payment per remaining installment of ${l.account_no}`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/postdated-payments`, { installments: true, channelId: d.channelId, reference: d.reference || undefined, from: d.from ? Number(d.from) : undefined });
      if (res.ok) { toast(`${res.body.length} postdated payments recorded`); return loanDetail(row); }
    }
    if (a === 'holiday') {
      const d = await ask([
        { label: 'From installment number', name: 'from', type: 'number' },
        { label: 'Number of installments', name: 'count', type: 'number', value: 1 },
        { label: 'Kind', name: 'kind', options: ['NO_PRINCIPAL_NO_INTEREST', 'PRINCIPAL_NO_INTEREST'], value: 'NO_PRINCIPAL_NO_INTEREST' },
        { label: 'The holiday\'s interest (no principal, no interest)', name: 'interest', options: ['SPREAD', 'NONE', 'APPLY_LATER'], value: 'SPREAD' },
        { label: 'Note', name: 'note', required: false },
      ], `Payment holiday on ${l.account_no}`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/payment-holiday`, { from: Number(d.from), count: Number(d.count), kind: d.kind, interest: d.interest, note: d.note || undefined });
    }
    if (a === 'due-day') {
      const d = await ask([
        { label: 'New day of the month for the next installment and every later one', name: 'day', type: 'number' },
        { label: 'Note', name: 'note', required: false },
      ], `Change the due day of ${l.account_no}`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/due-day`, { day: Number(d.day), note: d.note || undefined });
    }
    if (a === 'recovery') {
      const d = await ask([
        { label: 'Amount recovered', name: 'amount', type: 'number', step: '0.01' },
        { label: 'From', name: 'source', options: ['MEMBER', 'COLLATERAL', 'OTHER'], value: 'MEMBER' },
        { label: 'Channel', name: 'channelId', value: 'cash' },
        { label: 'Note', name: 'narration', required: false },
      ], `Recovery on ${l.account_no}`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/recoveries`, { amount: Number(d.amount), source: d.source, channelId: d.channelId, narration: d.narration || undefined });
    }
    if (a === 'guarantor-recovery' || a === 'release-call') {
      const gs = ((await api('GET', `/api/loans/${id}/guarantors`)).body || []).filter((g) => g.status === 'CALLED');
      if (!gs.length) return toast('No guarantor on this loan has an open call', true);
      const d = await ask([
        { label: 'Guarantor (member number)', name: 'memberNo', options: gs.map((g) => g.member_no), value: gs[0].member_no },
        ...(a === 'guarantor-recovery' ? [{ label: `Amount (blank: the rest of the pledge; ${gs.map((g) => `${g.member_no} ${money(g.pledged_amount - g.recovered)}`).join(', ')})`, name: 'amount', type: 'number', step: '0.01', required: false }]
          : [{ label: 'Reason', name: 'note' }]),
      ], a === 'guarantor-recovery' ? 'Recover from a called guarantor\'s deposits' : 'Release the rest of a guarantor\'s call');
      if (!d) return;
      const g = gs.find((x) => x.member_no === d.memberNo);
      res = a === 'guarantor-recovery'
        ? await api('POST', `/api/loans/${id}/guarantors/${g.id}/recover`, { amount: d.amount ? Number(d.amount) : undefined })
        : await api('POST', `/api/loans/${id}/guarantors/${g.id}/release-call`, { note: d.note });
    }
    if (a === 'write-off') {
      const d = await ask([
        { label: 'Reason', name: 'narration' },
        { label: 'Value date (blank: today)', name: 'valueDate', type: 'date', required: false },
        { label: 'Collect securities first (take the guarantors\' pledges as a repayment)', name: 'collectSecurities', options: ['false', 'true'], value: 'false' },
      ], `Write off ${l.account_no}`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/write-off`, { reason: d.narration, valueDate: d.valueDate || undefined, collectSecurities: d.collectSecurities === 'true' });
      if (res.ok && !res.body.transaction) { toast('Write-off requested; another manager approves it'); return loanDetail(row); }
    }
    if (a === 'eod-include') res = await api('POST', `/api/loans/${id}/eod-include`, {});
    if (a === 'documents') {
      const t = await api('GET', `/api/documents/loan/${l.id}`);
      if (!t.ok) return toast(t.error, true);
      if (!t.body.length) return toast(`No document templates for product ${l.product_id}`, true);
      const d = await ask([
        { label: 'Document', name: 'doc', options: t.body.map((x) => x.name) },
        opt({ label: 'Statement from', name: 'from', type: 'date' }), opt({ label: 'Statement to', name: 'to', type: 'date', value: today() }),
        opt({ label: 'Transaction reference (transaction documents)', name: 'reference' }),
      ], `Documents of ${l.account_no}`);
      if (!d) return;
      const doc = t.body.find((x) => x.name === d.doc);
      const qs = new URLSearchParams();
      if (d.from) qs.set('from', d.from);
      if (d.to && d.from) qs.set('to', d.to);
      if (d.reference) qs.set('reference', d.reference.trim());
      return openFile(`/api/documents/loan/${l.id}/${doc.id}?${qs}`, `${doc.name}.html`);
    }
    if (a === 'disbursement-details') {
      const dd = details.body || {};
      const d = await ask([
        opt({ label: 'Anticipated disbursement date', name: 'expectedDisbursementDate', type: 'date', value: day(dd.expectedDisbursementDate) }),
        opt({ label: 'First repayment date (blank: from the product)', name: 'firstRepaymentDate', type: 'date', value: day(dd.firstRepaymentDate) }),
        opt({ label: 'Channel to pay out through', name: 'disbursementChannelId', value: dd.disbursementChannelId || '' }),
        opt({ label: 'Or the member\'s deposit account number', name: 'disbursementSavingsAccountId', value: '' }),
      ], `Disbursement details of ${l.account_no}`);
      if (!d) return;
      res = await api('PUT', `/api/loans/${id}/disbursement-details`, {
        expectedDisbursementDate: d.expectedDisbursementDate || null, firstRepaymentDate: d.firstRepaymentDate || null,
        ...(d.disbursementSavingsAccountId ? { disbursementSavingsAccountId: d.disbursementSavingsAccountId.trim() }
          : { disbursementChannelId: d.disbursementChannelId || null }) });
    }
    if (a === 'repay-deposit') {
      const d = await ask([
        { label: 'Deposit account number (the member\'s or anyone\'s)', name: 'savingsAccountId' },
        { label: 'Amount', name: 'amount', type: 'number', step: '0.01' },
      ], `Repay ${l.account_no} from a deposit account`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/repayments`, { amount: Number(d.amount), savingsAccountId: d.savingsAccountId.trim() });
    }
    if (a === 'pay-off') {
      const when = await ask([opt({ label: 'Pay-off date (blank: today; a date to come shows a preview only)', name: 'valueDate', type: 'date' })], `Pay off ${l.account_no}`);
      if (!when) return;
      const q = await api('GET', `/api/loans/${id}/pay-off${when.valueDate ? `?valueDate=${encodeURIComponent(when.valueDate)}` : ''}`);
      if (!q.ok) return toast(q.error, true);
      if (when.valueDate && when.valueDate > new Date().toISOString().slice(0, 10)) {
        await ask([{ label: 'Preview', name: 'preview', value: `On ${q.body.valueDate}: principal ${money(q.body.principal)}, interest ${money(q.body.interest)}, fees ${money(q.body.fees)}, penalties ${money(q.body.penalty)}, total ${money(q.body.total)}`, required: false }],
          `Pay-off preview for ${l.account_no}`);
        return;
      }
      const d = await ask([
        { label: `Principal ${money(q.body.principal)} is paid in full. Interest owed ${money(q.body.interest)}: collect`, name: 'interest', type: 'number', step: '0.01', value: q.body.interest },
        { label: `Fees owed ${money(q.body.fees)}: collect`, name: 'fees', type: 'number', step: '0.01', value: q.body.fees },
        { label: `Penalties owed ${money(q.body.penalty)}: collect`, name: 'penalty', type: 'number', step: '0.01', value: q.body.penalty },
        { label: 'Channel', name: 'channelId', value: 'cash' },
        opt({ label: 'Note', name: 'note' }),
      ], `Pay off ${l.account_no} (what is not collected is written off)`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/pay-off`, { interest: Number(d.interest), fees: Number(d.fees), penalty: Number(d.penalty), channelId: d.channelId, note: d.note || undefined, valueDate: when.valueDate || undefined });
    }
    if (a === 'terminate') {
      const d = await ask([opt({ label: 'Termination date (blank: today)', name: 'valueDate', type: 'date' }), opt({ label: 'Note', name: 'note' })],
        `Terminate ${l.account_no}: everything owed falls due on the date`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/terminate`, { valueDate: d.valueDate || undefined, note: d.note || undefined });
    }
    if (a === 'undo-terminate') res = await api('POST', `/api/loans/${id}/undo-terminate`, {});
    if (a === 'rate') {
      const indexed = l.rate_plan === 'INDEX';
      const d = await ask([
        { label: indexed ? 'New spread' : 'New interest rate (product unit)', name: 'value', type: 'number', step: '0.0001', value: indexed ? '' : l.monthly_rate },
        opt({ label: 'From (blank: today)', name: 'effectiveFrom', type: 'date' }),
        opt({ label: 'Note', name: 'note' }),
      ], `Change the interest rate of ${l.account_no}`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/interest-rate`, { [indexed ? 'spread' : 'rate']: Number(d.value), effectiveFrom: d.effectiveFrom || undefined, note: d.note || undefined });
    }
    if (a === 'reduce-balance') {
      const d = await ask([
        { label: 'Balance', name: 'component', options: ['FEE', 'PENALTY'], value: 'FEE' },
        { label: `New amount due (fees now ${money(Number(b.fees || 0) + Number(b.nonScheduledFees || 0))}, penalties now ${money(b.penalty)})`, name: 'newBalance', type: 'number', step: '0.01' },
        opt({ label: 'Reason', name: 'reason' }),
      ], `Reduce a balance of ${l.account_no} (the difference is written off)`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/reduce-balance`, { component: d.component, newBalance: Number(d.newBalance), reason: d.reason || undefined });
    }
    if (a === 'holiday-interest') {
      const d = await ask([{ label: `Amount to apply (held ${money(l.holiday_interest_pending)})`, name: 'amount', type: 'number', step: '0.01', value: l.holiday_interest_pending }],
        `Apply payment holiday interest on ${l.account_no}`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/holiday-interest`, { amount: Number(d.amount) });
    }
    if (a === 'revolving-installment') {
      const d = await ask([{ label: 'Due date', name: 'dueDate', type: 'date' }], `Add an installment to ${l.account_no}`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/revolving-installments`, { dueDate: d.dueDate });
    }
    if (a === 'guarantor') {
      const d = await ask([
        { label: 'Guarantor member number or id', name: 'member' },
        { label: 'Amount pledged', name: 'amount', type: 'number', step: '0.01' },
      ], `Add a guarantor to ${l.account_no}`);
      if (!d) return;
      const m = await api('GET', `/api/members/${encodeURIComponent(d.member.trim())}`);
      if (!m.ok) return toast(m.error, true);
      res = await api('POST', `/api/loans/${id}/guarantors`, { memberId: m.body.id, amount: Number(d.amount) });
    }
    if (a === 'undo-restructure') {
      const d = await ask([opt({ label: 'Note', name: 'note' })], `Undo: ${l.parent_account_no} runs again and ${l.account_no} is withdrawn`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/undo-restructure`, { note: d.note || undefined });
      if (res.ok) { toast(`${res.body.restored.accountNo} is running again`); return loanDetail({ account_no: res.body.restored.accountNo }); }
    }
    if (a === 'attach') {
      const d = await ask([
        { label: 'File', name: 'file', type: 'file' },
        opt({ label: 'Title', name: 'title' }),
        opt({ label: 'Description', name: 'description' }),
      ], `Attach a document to ${l.account_no}`);
      if (!d || !d.file || !d.file.size) return;
      const qs = new URLSearchParams({ fileName: d.file.name, ...(d.title ? { title: d.title } : {}), ...(d.description ? { description: d.description } : {}) });
      res = await apiRaw('POST', `/api/loans/${id}/attachments?${qs}`, await d.file.arrayBuffer(), d.file.type || 'application/octet-stream');
    }
    if (a === 'approve-write-off') res = await api('POST', `/api/loans/${id}/write-off/approve`, {});
    if (a === 'reject-write-off') {
      const d = await ask([{ label: 'Why it is rejected', name: 'note', required: false }], `Reject write-off of ${l.account_no}`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/write-off/reject`, { note: d.note });
    }
    if (!res) return;
    toast(res.ok ? 'Done' : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) loanDetail(row);
  }));
}
