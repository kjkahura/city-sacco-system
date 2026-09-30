/**
 * Lending controls.
 */

import { $, S, api, day, esc, money, toast } from './base.js';
import { ask, card, table, view } from './ui.js';
import { opt } from './products.js';

// --------------------------------------------------------------------------
// Lending controls
// --------------------------------------------------------------------------

const CONTROL_ROLES = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'TELLER', 'AUDITOR'];
let lastControlsRun = null;

export async function controlsView() {
  const [ctl, users, excluded] = await Promise.all([api('GET', '/api/loans/controls'), api('GET', '/api/loans/controls/users'),
    api('GET', '/api/loans/eod-exclusions')]);
  if (!ctl.ok) throw new Error(ctl.error);
  const k = ctl.body;
  const yes = (v) => (v ? 'yes' : 'no');
  const limit = (v) => (v === null || v === undefined ? 'no limit' : money(v));
  const exposure = k.max_exposure_mode === 'UNLIMITED' || k.max_exposure_amount === null ? 'no cap'
    : `${money(k.max_exposure_amount)} (${k.max_exposure_mode === 'SUM_MINUS_DEPOSITS' ? 'loans less deposits' : 'sum of loans'})`;
  const admin = S.user.role === 'TENANT_ADMIN';
  view().innerHTML = `
    <div class="toolbar"><h1>Lending controls</h1></div>
    <p class="hint">Tenant-wide rules every loan product follows, after the reference platform's internal controls. Per-product controls
      (the charge cap, locking after days in arrears, closing loans that owe nothing) are on each product.
      ${admin ? '' : 'Only a tenant administrator can change these.'}</p>
    <div class="grid">
      ${card('Controls', `<dl class="kv" id="controls-kv">
        <dt>Maximum exposure per member</dt><dd>${esc(exposure)}</dd>
        <dt>One running loan per member</dt><dd>${yes(k.one_active_loan_per_member)}</dd>
        <dt>Days in arrears before a write-off</dt><dd>${Number(k.min_arrears_days_before_writeoff || 0)}</dd>
        <dt>Days a closed loan or application may be reopened</dt><dd>${k.max_days_undo_close === null ? 'no limit' : k.max_days_undo_close}</dd>
        <dt>Two-man rule (the approver may not disburse)</dt><dd>${yes(k.two_man_rule)}</dd>
        <dt>A write-off needs a second person's approval</dt><dd>${yes(k.write_off_requires_approval)}</dd>
        <dt>Roles that may post repayments on a locked loan</dt><dd id="locked-roles">${(k.locked_posting_roles || []).length ? esc(k.locked_posting_roles.join(', ')) : 'none'}</dd>
        <dt>Roles that may post custom repayments</dt><dd id="custom-roles">${k.custom_allocation_roles ? esc(k.custom_allocation_roles.join(', ') || 'none') : 'any that posts repayments'}</dd>
        <dt>Roles that may set disbursement details</dt><dd id="disbursement-roles">${k.disbursement_conditions_roles ? esc(k.disbursement_conditions_roles.join(', ') || 'none') : 'any that edits applications'}</dd>
        <dt>Roles that may pay off a loan</dt><dd id="pay-off-roles">${k.pay_off_roles ? esc(k.pay_off_roles.join(', ') || 'none') : 'any that posts repayments'}</dd>
        <dt>Roles that may apply loan adjustments</dt><dd id="adjustment-roles">${k.loan_adjustment_roles ? esc(k.loan_adjustment_roles.join(', ') || 'none') : 'any that may reduce a balance'}</dd>
        <dt>Roles that may collect securities</dt><dd id="collect-roles">${k.collect_securities_roles ? esc(k.collect_securities_roles.join(', ') || 'none') : 'any that may write off'}</dd>
      </dl>${admin ? '<button id="ctl-edit" class="secondary">Change controls</button>' : ''}`)}
      ${card('Run the controls now', `<p class="hint">The end of day runs these every night: it locks loans at their product's charge cap
        or after its days in arrears, and closes running loans that have owed nothing for the product's number of days.</p>
        ${lastControlsRun ? `<dl class="kv" id="controls-run"><dt>Locked at the cap</dt><dd>${lastControlsRun.capped}</dd>
          <dt>Locked for days in arrears</dt><dd>${lastControlsRun.lockedForArrears}</dd><dt>Closed, owing nothing</dt><dd>${lastControlsRun.closed}</dd></dl>` : ''}
        <button id="ctl-run" class="secondary">Run now</button>`)}
    </div>
    ${users.ok ? card('Transaction limits per user', `${table([
    { label: 'User', value: (u) => `${u.name || u.email}${u.name ? ` · ${u.email}` : ''}` },
    { label: 'Role', key: 'role' },
    { label: 'Status', key: 'status' },
    { label: 'Largest loan they may approve', num: true, value: (u) => limit(u.approvalLimit) },
    { label: 'Largest disbursement', num: true, value: (u) => limit(u.disbursementLimit) },
    { label: '', html: true, value: (u) => (admin ? `<button class="link" data-limits="${esc(u.id)}">set limits</button>` : '') },
  ], users.body, { empty: 'No staff users' })}<p class="hint">A blank limit means none beyond the user's role.</p>`) : ''}
    <div id="eod-exclusions">${card('Loans left out of the end of day', `${table([
    { label: 'Loan', value: (x) => `${x.account_no} · ${x.member_no} ${x.first_name} ${x.last_name}` },
    { label: 'Since', value: (x) => day(x.business_date) },
    { label: 'Job', key: 'job' },
    { label: 'Error', key: 'error' },
    { label: '', html: true, value: (x) => `<button class="link" data-include="${esc(x.account_no)}">include</button>` },
  ], excluded.body || [], { empty: 'None: every loan runs in the end of day' })}
    <p class="hint">A loan that breaks an end-of-day job is left out so the rest run; nothing is accrued or charged on it until it is fixed and included,
      which catches it up.</p>`)}</div>`;
  view().querySelectorAll('[data-include]').forEach((btn) => btn.addEventListener('click', async () => {
    const res = await api('POST', `/api/loans/${encodeURIComponent(btn.dataset.include)}/eod-include`, {});
    toast(res.ok ? `${btn.dataset.include} included and caught up` : res.error, !res.ok);
    if (res.ok) controlsView();
  }));

  if (admin) {
    $('#ctl-edit').addEventListener('click', async () => {
      const d = await ask([
        { label: 'Maximum exposure per member', name: 'maxExposureMode', options: ['UNLIMITED', 'SUM_OF_LOANS', 'SUM_MINUS_DEPOSITS'], value: k.max_exposure_mode || 'UNLIMITED' },
        opt({ label: 'Exposure cap (amount)', name: 'maxExposureAmount', type: 'number', step: '0.01', value: k.max_exposure_amount ?? '' }),
        { label: 'One running loan per member', name: 'oneActiveLoanPerMember', options: ['false', 'true'], value: String(!!k.one_active_loan_per_member) },
        { label: 'Days in arrears before a write-off', name: 'minArrearsDaysBeforeWriteoff', type: 'number', value: k.min_arrears_days_before_writeoff ?? 0 },
        opt({ label: 'Days a closed loan or application may be reopened (blank: no limit)', name: 'maxDaysUndoClose', type: 'number', value: k.max_days_undo_close ?? '' }),
        { label: 'Two-man rule', name: 'twoManRule', options: ['false', 'true'], value: String(!!k.two_man_rule) },
        { label: 'A write-off needs a second person\'s approval', name: 'writeOffRequiresApproval', options: ['true', 'false'], value: String(!!k.write_off_requires_approval) },
        ...CONTROL_ROLES.map((r) => ({ label: `${r} may post on locked loans`, name: `lock_${r}`, options: ['false', 'true'], value: String((k.locked_posting_roles || []).includes(r)) })),
        opt({ label: 'Roles that may post custom repayments (comma separated; blank: any)', name: 'customRoles', value: (k.custom_allocation_roles || []).join(', ') }),
        opt({ label: 'Roles that may set disbursement details (comma separated; blank: any)', name: 'disbursementRoles', value: (k.disbursement_conditions_roles || []).join(', ') }),
        opt({ label: 'Roles that may pay off a loan (comma separated; blank: any)', name: 'payOffRoles', value: (k.pay_off_roles || []).join(', ') }),
        opt({ label: 'Roles that may apply loan adjustments (comma separated; blank: any)', name: 'adjustmentRoles', value: (k.loan_adjustment_roles || []).join(', ') }),
        opt({ label: 'Roles that may collect securities (comma separated; blank: any)', name: 'collectRoles', value: (k.collect_securities_roles || []).join(', ') }),
      ], 'Lending controls');
      const roles = (v) => (v ? v.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : null);
      if (!d) return;
      const num = (v) => (v === '' || v === undefined ? null : Number(v));
      const res = await api('PATCH', '/api/loans/controls', {
        maxExposureMode: d.maxExposureMode, maxExposureAmount: num(d.maxExposureAmount),
        oneActiveLoanPerMember: d.oneActiveLoanPerMember === 'true',
        minArrearsDaysBeforeWriteoff: Number(d.minArrearsDaysBeforeWriteoff || 0), maxDaysUndoClose: num(d.maxDaysUndoClose),
        twoManRule: d.twoManRule === 'true', writeOffRequiresApproval: d.writeOffRequiresApproval === 'true',
        lockedPostingRoles: CONTROL_ROLES.filter((r) => d[`lock_${r}`] === 'true'),
        customAllocationRoles: d.customRoles ? d.customRoles.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : null,
        disbursementConditionsRoles: d.disbursementRoles ? d.disbursementRoles.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : null,
        payOffRoles: roles(d.payOffRoles), loanAdjustmentRoles: roles(d.adjustmentRoles), collectSecuritiesRoles: roles(d.collectRoles),
      });
      toast(res.ok ? 'Controls saved' : res.error, !res.ok);
      if (res.ok) controlsView();
    });
    view().querySelectorAll('[data-limits]').forEach((btn) => btn.addEventListener('click', async () => {
      const u = users.body.find((x) => x.id === btn.dataset.limits);
      const d = await ask([
        opt({ label: 'Largest loan they may approve (blank: no limit)', name: 'approvalLimit', type: 'number', step: '0.01', value: u.approvalLimit ?? '' }),
        opt({ label: 'Largest disbursement (blank: no limit)', name: 'disbursementLimit', type: 'number', step: '0.01', value: u.disbursementLimit ?? '' }),
      ], `Limits for ${u.email}`);
      if (!d) return;
      const num = (v) => (v === '' || v === undefined ? null : Number(v));
      const res = await api('PATCH', `/api/loans/controls/users/${u.id}`, { approvalLimit: num(d.approvalLimit), disbursementLimit: num(d.disbursementLimit) });
      toast(res.ok ? `Limits for ${u.email} saved` : res.error, !res.ok);
      if (res.ok) controlsView();
    }));
  }
  $('#ctl-run').addEventListener('click', async () => {
    const res = await api('POST', '/api/loans/controls/run', {});
    if (!res.ok) return toast(res.error, true);
    lastControlsRun = res.body;
    toast(`Controls run: ${res.body.capped + res.body.lockedForArrears} locked, ${res.body.closed} closed`);
    controlsView();
  });
}
