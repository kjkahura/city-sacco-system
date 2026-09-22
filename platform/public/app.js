'use strict';

/**
 * SACCO back office.
 *
 * Plain JavaScript against the same API everything else uses. No build
 * step, no framework, no bundle: the console is served from public/ and
 * what is on disk is what runs, which matters for a system whose users may
 * have to audit it.
 *
 * Tokens live in memory. The refresh token goes in sessionStorage so a page
 * reload does not sign a teller out mid-transaction, and it dies with the
 * tab. Nothing is written to localStorage, because a shared branch machine
 * would keep it.
 */

const S = {
  tenant: sessionStorage.getItem('tenant') || '',
  access: null,
  refresh: sessionStorage.getItem('refresh') || null,
  user: null,
  sacco: null,
  view: 'members',
  enrolToken: null,
  mfaTicket: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (id) => document.getElementById(id);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const money = (n) => (n === null || n === undefined || n === ''
  ? '' : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

const day = (d) => (d ? String(d).slice(0, 10) : '');
const today = () => new Date().toISOString().slice(0, 10);

function toast(message, bad = false) {
  const t = el('toast');
  t.textContent = message;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3000);
}

// --------------------------------------------------------------------------
// API
// --------------------------------------------------------------------------

/**
 * One call. A 401 on an expired access token is retried once after a
 * refresh, so a session that outlives the 15 minute access token does not
 * drop a teller back to the login screen in the middle of a deposit.
 */
async function api(method, path, body, { retry = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (S.tenant) headers['x-tenant'] = S.tenant;
  if (S.access) headers.authorization = `Bearer ${S.access}`;

  const res = await fetch(path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* empty body */ }

  if (res.status === 401 && retry && S.refresh) {
    const ok = await refreshSession();
    if (ok) return api(method, path, body, { retry: false });
  }

  const out = {
    ok: res.ok,
    status: res.status,
    body: payload,
    total: Number(res.headers.get('items-total') || 0),
    error: res.ok ? null : (payload?.errors?.[0]?.errorReason || `HTTP ${res.status}`),
  };
  if (!res.ok && res.status === 401) signOut(true);
  return out;
}

async function refreshSession() {
  const r = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant': S.tenant },
    body: JSON.stringify({ refreshToken: S.refresh }),
  });
  if (!r.ok) return false;
  const pair = await r.json();
  S.access = pair.accessToken;
  S.refresh = pair.refreshToken;
  sessionStorage.setItem('refresh', S.refresh);
  return true;
}

// --------------------------------------------------------------------------
// Sign in
// --------------------------------------------------------------------------

el('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const err = el('login-error');
  err.textContent = '';
  S.tenant = String(f.get('tenant') || '').trim().toLowerCase();

  // Enrolment: the account has no authenticator yet and the tenant policy
  // requires one. The server hands back a token scoped to these two calls.
  if (S.enrolToken) {
    S.access = S.enrolToken;
    const confirm = await api('POST', '/api/auth/mfa/confirm', { code: String(f.get('enrolCode') || '').trim() });
    S.access = null;
    if (!confirm.ok) { err.textContent = confirm.error; return; }
    S.enrolToken = null;
    el('enrol').hidden = true;
    toast(`Authenticator enrolled. Recovery codes: ${(confirm.body.recoveryCodes || []).join(' ')}`);
    window.alert('Save these recovery codes now, they are shown once:\n\n'
      + (confirm.body.recoveryCodes || []).join('\n'));
    // Fall through to a normal sign-in with the same credentials.
  }

  if (S.mfaTicket) {
    const code = String(f.get('code') || '').trim();
    const verify = await api('POST', '/api/auth/mfa/verify',
      /^\d{6}$/.test(code) ? { mfaTicket: S.mfaTicket, code } : { mfaTicket: S.mfaTicket, recoveryCode: code });
    if (!verify.ok) { err.textContent = verify.error; return; }
    return start(verify.body);
  }

  const login = await api('POST', '/api/auth/login', {
    email: String(f.get('email') || '').trim(),
    password: String(f.get('password') || ''),
  });

  if (login.status === 403 && login.body?.enrolmentRequired) {
    S.enrolToken = login.body.enrolmentToken;
    S.access = S.enrolToken;
    const begin = await api('POST', '/api/auth/mfa/enrol');
    S.access = null;
    el('enrol').hidden = false;
    el('enrol-secret').textContent = begin.body?.secret || '';
    err.textContent = 'Enrol an authenticator to continue.';
    return;
  }
  if (login.body?.mfaRequired) {
    S.mfaTicket = login.body.mfaTicket || login.body.ticket;
    el('mfa-code').hidden = false;
    err.textContent = 'Enter the code from your authenticator.';
    return;
  }
  if (!login.ok) { err.textContent = login.error; return; }
  return start(login.body);
});

function start(session) {
  S.access = session.accessToken;
  S.refresh = session.refreshToken;
  S.user = session.user;
  S.sacco = session.tenant || S.sacco;
  sessionStorage.setItem('refresh', S.refresh);
  sessionStorage.setItem('tenant', S.tenant);
  el('login').hidden = true;
  el('app').hidden = false;
  el('sacco-name').textContent = S.sacco?.name || S.tenant;
  el('whoami').textContent = `${S.user.name || S.user.email} (${S.user.role})`;
  render();
}

function signOut(silent) {
  S.access = null; S.refresh = null; S.user = null;
  sessionStorage.removeItem('refresh');
  el('app').hidden = true;
  el('login').hidden = false;
  el('mfa-code').hidden = true;
  S.mfaTicket = null;
  if (!silent) toast('Signed out');
}

el('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout', { refreshToken: S.refresh });
  signOut();
});

el('nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  S.view = b.dataset.view;
  for (const n of el('nav').children) n.classList.toggle('active', n === b);
  render();
});

// Resume a session across a reload.
(async () => {
  if (S.refresh && S.tenant && await refreshSession()) {
    const me = await api('GET', '/api/auth/me');
    const t = await api('GET', '/api/');
    if (me.ok) {
      S.user = me.body;
      S.sacco = t.ok ? t.body : null;
      start({ accessToken: S.access, refreshToken: S.refresh, user: me.body, tenant: S.sacco });
    }
  }
})();

// --------------------------------------------------------------------------
// Rendering helpers
// --------------------------------------------------------------------------

const view = () => el('view');

function table(columns, rows, { onRow = null, empty = 'Nothing to show' } = {}) {
  if (!rows.length) return `<p class="hint">${esc(empty)}</p>`;
  const head = columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('');
  const body = rows.map((r, i) => {
    const cells = columns.map((c) => {
      const v = typeof c.value === 'function' ? c.value(r) : r[c.key];
      return `<td class="${c.num ? 'num' : ''}">${c.html ? (v ?? '') : esc(v ?? '')}</td>`;
    }).join('');
    return `<tr class="${onRow ? 'clickable' : ''}" data-row="${i}">${cells}</tr>`;
  }).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function wireRows(rows, onRow) {
  view().querySelectorAll('tr[data-row]').forEach((tr) => {
    tr.addEventListener('click', () => onRow(rows[Number(tr.dataset.row)]));
  });
}

function pager(state, total, reload) {
  const from = total === 0 ? 0 : state.offset + 1;
  const to = Math.min(state.offset + state.limit, total);
  return `<div class="pager">
    <button class="secondary" data-page="prev" ${state.offset === 0 ? 'disabled' : ''}>Previous</button>
    <button class="secondary" data-page="next" ${to >= total ? 'disabled' : ''}>Next</button>
    <span>${from}–${to} of ${total}</span>
  </div>`;
}

function wirePager(state, reload) {
  view().querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => {
    state.offset = b.dataset.page === 'next'
      ? state.offset + state.limit
      : Math.max(0, state.offset - state.limit);
    reload();
  }));
}

const card = (title, inner) => `<section class="card"><h2>${esc(title)}</h2>${inner}</section>`;

async function ask(fields, title) {
  // A tiny inline form in a dialog. Enough for a deposit or a rate change
  // without pulling in a UI library.
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog" class="card"><h2>${esc(title)}</h2>
      ${fields.map((f) => `<label>${esc(f.label)}
        ${f.options
    ? `<select name="${esc(f.name)}">${f.options.map((o) =>
      `<option value="${esc(o)}" ${String(o) === String(f.value) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
    : `<input name="${esc(f.name)}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}"
          ${f.step ? `step="${f.step}"` : ''} ${f.required === false ? '' : 'required'}>`}</label>`).join('')}
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

function render() {
  const fn = VIEWS[S.view];
  view().innerHTML = '<p class="hint">Loading…</p>';
  fn().catch((e) => { view().innerHTML = `<p class="error">${esc(e.message)}</p>`; });
}

// --------------------------------------------------------------------------
// Members
// --------------------------------------------------------------------------

const memberState = { offset: 0, limit: 25, q: '', status: '' };

async function membersView() {
  const qs = new URLSearchParams({ offset: memberState.offset, limit: memberState.limit });
  if (memberState.q) qs.set('q', memberState.q);
  if (memberState.status) qs.set('status', memberState.status);
  const r = await api('GET', `/api/members?${qs}`);
  if (!r.ok) throw new Error(r.error);

  view().innerHTML = `
    <div class="toolbar">
      <label>Search<input id="m-q" value="${esc(memberState.q)}" placeholder="name, number or phone"></label>
      <label>Status<select id="m-status">
        ${['', 'ACTIVE', 'DORMANT', 'PENDING', 'EXITED'].map((s) =>
    `<option ${s === memberState.status ? 'selected' : ''} value="${s}">${s || 'Any'}</option>`).join('')}
      </select></label>
      <button id="m-new">New member</button>
    </div>
    ${table([
    { label: 'No.', key: 'member_no' },
    { label: 'Name', value: (m) => `${m.first_name} ${m.last_name}` },
    { label: 'Phone', key: 'phone' },
    { label: 'Status', value: (m) => m.status },
    { label: 'Joined', value: (m) => day(m.joined_on) },
  ], r.body, { onRow: true, empty: 'No members match' })}
    ${pager(memberState, r.total)}`;

  wireRows(r.body, memberDetail);
  wirePager(memberState, membersView);
  $('#m-q').addEventListener('change', (e) => {
    memberState.q = e.target.value; memberState.offset = 0; membersView();
  });
  $('#m-status').addEventListener('change', (e) => {
    memberState.status = e.target.value; memberState.offset = 0; membersView();
  });
  $('#m-new').addEventListener('click', async () => {
    const d = await ask([
      { label: 'First name', name: 'firstName' },
      { label: 'Last name', name: 'lastName' },
      { label: 'Phone', name: 'phone', required: false },
      { label: 'National ID', name: 'nationalId', required: false },
    ], 'New member');
    if (!d) return;
    const res = await api('POST', '/api/members', d);
    toast(res.ok ? `Member ${res.body.member_no} created` : res.error, !res.ok);
    if (res.ok) membersView();
  });
}

async function memberDetail(m) {
  const [savings, loans, shares] = await Promise.all([
    api('GET', `/api/savings?memberId=${m.id}&limit=50`),
    api('GET', `/api/loans?memberId=${m.id}&limit=50`),
    api('GET', '/api/shares?limit=200'),
  ]);
  const myShares = (shares.body || []).filter((s) => s.member_id === m.id);

  view().innerHTML = `
    <button class="secondary" id="back">← Members</button>
    <h1>${esc(m.first_name)} ${esc(m.last_name)} <span class="badge">${esc(m.member_no)}</span></h1>
    <div class="grid">
      ${card('Details', `<dl class="kv">
        <dt>Status</dt><dd>${esc(m.status)}</dd>
        <dt>Phone</dt><dd>${esc(m.phone || '—')}</dd>
        <dt>Email</dt><dd>${esc(m.email || '—')}</dd>
        <dt>National ID</dt><dd>${esc(m.national_id || '—')}</dd>
        <dt>Joined</dt><dd>${day(m.joined_on)}</dd>
      </dl>`)}
      ${card('Savings', table([
    { label: 'Account', key: 'account_no' },
    { label: 'Product', key: 'product_id' },
    { label: 'Balance', num: true, value: (a) => money(a.balance) },
  ], savings.body || [], { empty: 'No savings accounts' }))}
      ${card('Shares', table([
    { label: 'Account', key: 'account_no' },
    { label: 'Units', num: true, value: (a) => Number(a.units).toLocaleString() },
  ], myShares, { empty: 'No share account' }))}
    </div>
    ${card('Loans', table([
    { label: 'Account', key: 'account_no' },
    { label: 'Status', key: 'status' },
    { label: 'Principal', num: true, value: (l) => money(l.principal) },
    { label: 'Outstanding', num: true, value: (l) => money(Number(l.principal_disbursed) + Number(l.principal_capitalized || 0) - l.principal_paid) },
  ], loans.body || [], { onRow: true, empty: 'No loans' }))}`;

  $('#back').addEventListener('click', membersView);
  wireRows(loans.body || [], loanDetail);
}

// --------------------------------------------------------------------------
// Loans
// --------------------------------------------------------------------------

const loanState = { offset: 0, limit: 25, status: '' };

async function loansView() {
  const qs = new URLSearchParams({ offset: loanState.offset, limit: loanState.limit });
  if (loanState.status) qs.set('status', loanState.status);
  const r = await api('GET', `/api/loans?${qs}`);
  if (!r.ok) throw new Error(r.error);

  view().innerHTML = `
    <div class="toolbar">
      <label>Status<select id="l-status">
        ${['', 'PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'IN_ARREARS', 'LOCKED', 'CLOSED_REPAID',
    'CLOSED_WRITTEN_OFF', 'CLOSED_RESCHEDULED', 'CLOSED_REFINANCED', 'CLOSED_REJECTED', 'CLOSED_WITHDRAWN'].map((s) =>
    `<option ${s === loanState.status ? 'selected' : ''} value="${s}">${s || 'Any'}</option>`).join('')}
      </select></label>
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
}

const LOAN_ACTIONS = {
  PARTIAL_APPLICATION: [['request-approval', 'Request approval'], ['amend', 'Amend terms'], ['collateral', 'Add collateral'], ['funding', 'Add funder'], ['tranches', 'Set tranches'], ['reject', 'Reject'], ['withdraw', 'Withdraw']],
  PENDING_APPROVAL: [['approve', 'Approve'], ['set-incomplete', 'Send back'], ['amend', 'Amend terms'], ['collateral', 'Add collateral'], ['funding', 'Add funder'], ['tranches', 'Set tranches'], ['reject', 'Reject'], ['withdraw', 'Withdraw']],
  APPROVED: [['disburse', 'Disburse'], ['undo-approve', 'Undo approval'], ['withdraw', 'Withdraw'], ['notes', 'Notes']],
  ACTIVE: [['repay', 'Post repayment'], ['drawdown', 'Draw down'], ['collateral', 'Add collateral'], ['fee', 'Apply fee'], ['lock', 'Lock'], ['close', 'Close'], ['reschedule', 'Reschedule'], ['refinance', 'Refinance'], ['write-off', 'Write off'], ['notes', 'Notes']],
  IN_ARREARS: [['repay', 'Post repayment'], ['drawdown', 'Draw down'], ['collateral', 'Add collateral'], ['fee', 'Apply fee'], ['lock', 'Lock'], ['reschedule', 'Reschedule'], ['refinance', 'Refinance'], ['write-off', 'Write off'], ['notes', 'Notes']],
  LOCKED: [['unlock', 'Unlock'], ['reschedule', 'Reschedule'], ['write-off', 'Write off'], ['notes', 'Notes']],
  CLOSED_REJECTED: [['undo-reject', 'Undo rejection']],
  CLOSED_WITHDRAWN: [['undo-withdraw', 'Undo withdrawal']],
};
const BAD_STATES = ['IN_ARREARS', 'LOCKED', 'CLOSED_WRITTEN_OFF'];

async function loanDetail(row) {
  const id = row.account_no;
  const [loan, schedule, txs, pens, fees, hist, tranches, collateral, funding] = await Promise.all([
    api('GET', `/api/loans/${id}`),
    api('GET', `/api/loans/${id}/schedule`),
    api('GET', `/api/loans/${id}/transactions?limit=25`),
    api('GET', `/api/loans/${id}/penalties?limit=25`),
    api('GET', `/api/loans/${id}/fees`),
    api('GET', `/api/loans/${id}/history`),
    api('GET', `/api/loans/${id}/tranches`),
    api('GET', `/api/loans/${id}/collateral`),
    api('GET', `/api/loans/${id}/funding`),
  ]);
  if (!loan.ok) throw new Error(loan.error);
  const l = loan.body;
  const b = l.balances || {};
  const revolving = l.product_type === 'REVOLVING';
  const tranched = l.product_type === 'TRANCHED';
  const actions = (LOAN_ACTIONS[l.status] || []).filter(([a]) => {
    if (a === 'drawdown') return revolving || (tranched && (tranches.body || []).some((t) => t.status === 'PLANNED'));
    if (a === 'close') return revolving;
    if (a === 'tranches') return tranched;
    if (['reschedule', 'refinance'].includes(a)) return !revolving;
    return true;
  });
  const outstanding = Number(l.principal_disbursed) + Number(l.principal_capitalized || 0) - Number(l.principal_paid);

  view().innerHTML = `
    <button class="secondary" id="back">← Loans</button>
    <h1>${esc(l.account_no)} <span class="badge ${BAD_STATES.includes(l.status) ? 'bad' : ''}">${esc(l.status)}</span>
      ${l.locked_reason ? `<span class="badge warn">locked: ${esc(l.locked_reason)}</span>` : ''}</h1>
    <p class="hint">${esc(l.first_name)} ${esc(l.last_name)} · ${esc(l.member_no)} · product ${esc(l.product_id)} · ${esc(l.product_type || '')}
      ${l.purpose ? ` · ${esc(l.purpose)}` : ''}${l.parent_loan_id ? ' · restructured from an earlier loan' : ''}</p>
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
        ${l.arrears_since ? `<dt>In arrears since</dt><dd>${day(l.arrears_since)}</dd>` : ''}
        ${l.approved_by ? `<dt>Approved by</dt><dd>${esc(l.approved_by)}</dd>` : ''}
        ${l.disbursed_by ? `<dt>Disbursed by</dt><dd>${esc(l.disbursed_by)}</dd>` : ''}
      </dl>`)}
      ${card('Recent transactions', table([
    { label: 'Date', value: (t) => day(t.value_date) },
    { label: 'Kind', key: 'kind' },
    { label: 'Amount', num: true, value: (t) => money(t.amount) },
  ], txs.body || [], { empty: 'None yet' }))}
    </div>
    ${card('Schedule', table([
    { label: '#', key: 'number' },
    { label: 'Due', value: (i) => day(i.due_date) },
    { label: 'Principal', num: true, value: (i) => money(i.principal_due) },
    { label: 'Interest', num: true, value: (i) => money(i.interest_due) },
    { label: 'Fees', num: true, value: (i) => money(i.fee_due) },
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
    { label: '', value: (f) => (f.status === 'DUE' ? `<button class="link" data-waive-fee="${f.id}">waive</button>` : '') },
  ], fees.body || [], { empty: 'None' }))}
    ${card('Penalties', table([
    { label: 'Charged', value: (p) => day(p.charged_on) },
    { label: 'Days late', num: true, key: 'days_late' },
    { label: 'Amount', num: true, value: (p) => money(p.amount) },
    { label: 'Waived', value: (p) => (p.waived_at ? 'yes' : '') },
  ], pens.body || [], { empty: 'None' }))}
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
    { label: '', value: (k) => (k.status === 'PLEDGED' ? `<button class="link" data-release="${k.id}">release</button>` : '') },
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
  ], hist.body || [], { empty: 'None' }))}`;

  $('#back').addEventListener('click', loansView);
  view().querySelectorAll('[data-release]').forEach((btn) => btn.addEventListener('click', async () => {
    const d = await ask([{ label: 'Note', name: 'note', required: false }], 'Release collateral');
    if (!d) return;
    const res = await api('POST', `/api/loans/collateral/${btn.dataset.release}/release`, { note: d.note });
    toast(res.ok ? 'Released' : res.error, !res.ok);
    if (res.ok) loanDetail(row);
  }));
  view().querySelectorAll('[data-waive-fee]').forEach((btn) => btn.addEventListener('click', async () => {
    const d = await ask([{ label: 'Reason', name: 'reason' }], 'Waive fee');
    if (!d) return;
    const res = await api('POST', `/api/loans/fees/${btn.dataset.waiveFee}/waive`, { reason: d.reason });
    toast(res.ok ? 'Fee waived' : res.error, !res.ok);
    if (res.ok) loanDetail(row);
  }));
  view().querySelectorAll('[data-action]').forEach((btn) => btn.addEventListener('click', async () => {
    const a = btn.dataset.action;
    let res;
    const simple = ['approve', 'undo-approve', 'request-approval', 'unlock', 'undo-reject', 'undo-withdraw', 'close'];
    if (simple.includes(a)) res = await api('POST', `/api/loans/${id}/${a}`, {});
    if (['reject', 'withdraw', 'set-incomplete', 'lock'].includes(a)) {
      const d = await ask([{ label: 'Note', name: 'note', required: false }], `${btn.textContent} ${l.account_no}`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/${a}`, { note: d.note });
    }
    if (a === 'amend') {
      const d = await ask([
        { label: 'Principal', name: 'principal', type: 'number', step: '0.01', value: l.principal },
        { label: 'Installments', name: 'termMonths', type: 'number', value: l.term_months },
        { label: 'Rate (product unit)', name: 'monthlyRate', type: 'number', step: '0.001', value: l.monthly_rate },
        { label: 'Purpose', name: 'purpose', value: l.purpose || '', required: false },
        { label: 'Notes', name: 'notes', value: l.notes || '', required: false },
      ], 'Amend application');
      if (!d) return;
      res = await api('PATCH', `/api/loans/${id}`, {
        principal: Number(d.principal), termMonths: Number(d.termMonths), monthlyRate: Number(d.monthlyRate), purpose: d.purpose, notes: d.notes });
    }
    if (a === 'notes') {
      const d = await ask([{ label: 'Notes', name: 'notes', value: l.notes || '' }], 'Notes');
      if (!d) return;
      res = await api('PATCH', `/api/loans/${id}`, { notes: d.notes });
    }
    if (a === 'disburse') {
      const d = await ask([
        { label: 'Amount', name: 'amount', type: 'number', step: '0.01', value: l.principal },
        { label: 'Channel', name: 'channelId', value: 'bank' },
        { label: 'Optional fee codes, comma separated', name: 'fees', value: '', required: false },
      ], 'Disburse loan');
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/disbursements`, {
        amount: Number(d.amount), channelId: d.channelId, fees: d.fees ? d.fees.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : [] });
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
        { label: 'Note', name: 'note', required: false },
      ], 'Apply fee');
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/fees`, {
        fee: d.fee ? d.fee.toUpperCase() : undefined, name: d.name || undefined,
        amount: d.amount ? Number(d.amount) : undefined, note: d.note });
    }
    if (a === 'reschedule' || a === 'refinance') {
      const d = await ask([
        { label: 'New number of installments', name: 'termMonths', type: 'number', value: l.term_months },
        { label: 'Product (blank keeps the same)', name: 'productId', value: '', required: false },
        ...(a === 'refinance' ? [{ label: 'Top-up paid to the member', name: 'topUp', type: 'number', step: '0.01' },
          { label: 'Channel', name: 'channelId', value: 'bank' }] : []),
        { label: 'Interest, fees and penalties owed', name: 'arrears', options: ['CAPITALIZE', 'WRITE_OFF'], value: 'CAPITALIZE' },
        { label: 'Note', name: 'note', required: false },
      ], a === 'refinance' ? 'Refinance loan' : 'Reschedule loan');
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/${a}`, {
        termMonths: Number(d.termMonths), productId: d.productId || undefined, arrears: d.arrears, note: d.note,
        ...(a === 'refinance' ? { topUp: Number(d.topUp), channelId: d.channelId } : {}) });
      if (res.ok) { toast(`New loan ${res.body.newLoan.account_no} opened`); return loanDetail({ account_no: res.body.newLoan.account_no }); }
    }
    if (a === 'write-off') {
      const d = await ask([{ label: 'Reason', name: 'narration' }], `Write off ${l.account_no}`);
      if (!d) return;
      res = await api('POST', `/api/loans/${id}/write-off`, { narration: d.narration });
    }
    if (!res) return;
    toast(res.ok ? 'Done' : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) loanDetail(row);
  }));
}

// --------------------------------------------------------------------------
// Teller
// --------------------------------------------------------------------------

async function tellerView() {
  view().innerHTML = `
    <h1>Teller</h1>
    <p class="hint">Postings are immediate and cannot be edited. A mistake is corrected with a reversal,
      which stays on the record next to the original.</p>
    <div class="grid">
      ${card('Savings', `
        <label>Account number<input id="t-account" placeholder="SA000001"></label>
        <label>Amount<input id="t-amount" type="number" step="0.01"></label>
        <label>Channel<select id="t-channel">
          <option value="cash">Cash</option><option value="mpesa">M-Pesa</option>
          <option value="bank">Bank transfer</option><option value="cheque">Cheque</option>
          <option value="payroll">Payroll check-off</option>
        </select></label>
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
    const r = await api('POST', `/api/savings/${encodeURIComponent(account)}/${path}`, { amount, channelId });
    toast(r.ok ? `${kind} posted: ${r.body.reference}` : r.error, !r.ok);
    if (r.ok) {
      const bal = await api('GET', `/api/savings/${encodeURIComponent(account)}/balance`);
      $('#t-result').innerHTML = card('Account after posting',
        `<dl class="kv"><dt>Account</dt><dd>${esc(account)}</dd>
         <dt>Balance</dt><dd>${money(bal.body?.balance)}</dd></dl>`);
    }
  };
  $('#t-deposit').addEventListener('click', () => post('deposit'));
  $('#t-withdraw').addEventListener('click', () => post('withdrawal'));
  $('#t-reverse').addEventListener('click', async () => {
    const ref = $('#t-ref').value.trim();
    const r = await api('POST', `/api/savings/transactions/${encodeURIComponent(ref)}/reversal`,
      { reason: $('#t-reason').value });
    toast(r.ok ? 'Reversed' : r.error, !r.ok);
  });
}

// --------------------------------------------------------------------------
// Reports
// --------------------------------------------------------------------------

const reportState = { which: 'trial-balance', from: '', to: '', asAt: '', offset: 0, limit: 50 };

async function reportsView() {
  const R = reportState;
  view().innerHTML = `
    <div class="toolbar">
      <label>Report<select id="r-which">
        ${[['trial-balance', 'Trial balance'], ['balance-sheet', 'Balance sheet'],
    ['income-statement', 'Income statement'], ['portfolio-at-risk', 'Portfolio at risk'],
    ['par-loans', 'Loans at risk'], ['prudential', 'Prudential ratios']].map(([v, label]) =>
    `<option value="${v}" ${R.which === v ? 'selected' : ''}>${label}</option>`).join('')}
      </select></label>
      <label>From<input id="r-from" type="date" value="${R.from}"></label>
      <label>To<input id="r-to" type="date" value="${R.to}"></label>
      <button id="r-run">Run</button>
    </div>
    <div id="r-out"><p class="hint">Loading…</p></div>`;

  $('#r-which').addEventListener('change', (e) => { R.which = e.target.value; R.offset = 0; reportsView(); });
  $('#r-from').addEventListener('change', (e) => { R.from = e.target.value; });
  $('#r-to').addEventListener('change', (e) => { R.to = e.target.value; });
  $('#r-run').addEventListener('click', runReport);
  runReport();
}

async function runReport() {
  const R = reportState;
  const out = el('r-out');
  const qs = new URLSearchParams();
  if (R.from) qs.set('from', R.from);
  if (R.to) { qs.set('to', R.to); qs.set('asAt', R.to); }

  if (R.which === 'trial-balance') {
    qs.set('offset', R.offset); qs.set('limit', R.limit);
    const r = await api('GET', `/api/accounting/trial-balance?${qs}`);
    if (!r.ok) return void (out.innerHTML = `<p class="error">${esc(r.error)}</p>`);
    const t = r.body;
    out.innerHTML = table([
      { label: 'Code', key: 'code' }, { label: 'Account', key: 'name' },
      { label: 'Debit', num: true, value: (x) => money(x.debit) },
      { label: 'Credit', num: true, value: (x) => money(x.credit) },
    ], t.rows) + `<table><tbody><tr class="total">
        <td>Total (whole book, not this page)</td>
        <td class="num">${money(t.totals.debit)}</td><td class="num">${money(t.totals.credit)}</td>
      </tr></tbody></table>`
      + (t.balanced ? '' : '<p class="error">The trial balance does not balance.</p>')
      + pager({ offset: t.page.offset, limit: t.page.limit || R.limit }, t.page.total);
    wirePager(R, runReport);
    return;
  }

  if (R.which === 'balance-sheet') {
    const r = await api('GET', `/api/reports/balance-sheet?${qs}`);
    const b = r.body;
    const block = (title, rows, total) => card(title, table([
      { label: 'Code', value: (x) => x.code || '' }, { label: 'Account', key: 'name' },
      { label: 'Amount', num: true, value: (x) => money(x.amount) },
    ], rows) + `<p class="num"><strong>${money(total)}</strong></p>`);
    out.innerHTML = `<div class="grid">
      ${block('Assets', b.assets, b.totalAssets)}
      ${block('Liabilities', b.liabilities, b.totalLiabilities)}
      ${block('Equity', b.equity, b.totalEquity)}
    </div>${b.balances ? '' : `<p class="error">Out by ${money(b.difference)}</p>`}`;
    return;
  }

  if (R.which === 'income-statement') {
    const r = await api('GET', `/api/reports/income-statement?${qs}`);
    const s = r.body;
    out.innerHTML = `<div class="grid">
      ${card('Income', table([{ label: 'Account', key: 'name' },
    { label: 'Amount', num: true, value: (x) => money(x.amount) }], s.income))}
      ${card('Expenses', table([{ label: 'Account', key: 'name' },
    { label: 'Amount', num: true, value: (x) => money(x.amount) }], s.expenses))}
    </div>
    ${card('Result', `<dl class="kv">
      <dt>Total income</dt><dd>${money(s.totalIncome)}</dd>
      <dt>Total expenses</dt><dd>${money(s.totalExpenses)}</dd>
      <dt>Surplus</dt><dd><strong>${money(s.surplus)}</strong></dd></dl>
      <p class="hint">Year-end closing entries are excluded, so a closed year still shows what it earned.</p>`)}`;
    return;
  }

  if (R.which === 'portfolio-at-risk') {
    const r = await api('GET', `/api/reports/portfolio-at-risk?${qs}`);
    const p = r.body;
    out.innerHTML = table([
      { label: 'Bucket', key: 'bucket' }, { label: 'Loans', num: true, key: 'loans' },
      { label: 'Outstanding', num: true, value: (x) => money(x.outstanding) },
    ], p.buckets) + `<p class="hint">PAR ${p.parPercent}% of ${money(p.totalOutstanding)} outstanding.</p>`;
    return;
  }

  if (R.which === 'par-loans') {
    qs.set('offset', R.offset); qs.set('limit', R.limit);
    const r = await api('GET', `/api/reports/portfolio-at-risk/loans?${qs}`);
    const p = r.body;
    out.innerHTML = table([
      { label: 'Loan', key: 'account_no' },
      { label: 'Member', value: (x) => `${x.first_name} ${x.last_name}` },
      { label: 'Bucket', key: 'bucket' },
      { label: 'Days late', num: true, key: 'days_late' },
      { label: 'Outstanding', num: true, value: (x) => money(x.outstanding) },
    ], p.items || []) + pager(R, p.total || 0);
    wirePager(R, runReport);
    return;
  }

  const r = await api('GET', `/api/reports/prudential?${qs}`);
  const p = r.body;
  out.innerHTML = `<p class="notice">${esc(p.disclaimer)}</p>` + table([
    { label: 'Measure', key: 'label' },
    { label: 'Value', num: true, value: (m) => (m.value === null ? '—' : money(m.value)) },
    { label: 'Minimum', num: true, value: (m) => (m.minimum === null ? '—' : money(m.minimum)) },
    {
      label: 'Status',
      html: true,
      value: (m) => (m.compliant === null ? '<span class="badge">unknown</span>'
        : m.compliant ? '<span class="badge">met</span>' : '<span class="badge bad">below</span>'),
    },
  ], p.measures);
}

// --------------------------------------------------------------------------
// Provisioning and the year-end close
// --------------------------------------------------------------------------

async function financeView() {
  const [bands, years, settings] = await Promise.all([
    api('GET', '/api/provisioning/bands'),
    api('GET', '/api/periods'),
    api('GET', '/api/periods/settings'),
  ]);
  if (!bands.ok) throw new Error(bands.error);

  const unset = (bands.body || []).filter((b) => b.rate_percent === null);
  const pct = settings.body?.statutory_reserve_percent;

  view().innerHTML = `
    <h1>Period and provisions</h1>
    ${unset.length ? `<p class="notice">${unset.length} provisioning band(s) have no rate.
      Provisioning will refuse to run until every band has one. The system ships no rates on purpose:
      they are a regulatory figure and must be entered from the rules that apply to this SACCO.</p>` : ''}
    ${pct === null || pct === undefined ? `<p class="notice">No statutory reserve percentage is set.
      A year cannot be closed until it is.</p>` : ''}
    <div class="grid">
      ${card('Provision bands', table([
    { label: 'Band', key: 'label' },
    { label: 'Days', value: (b) => `${b.min_days}–${b.max_days ?? '∞'}` },
    { label: 'Rate %', num: true, value: (b) => (b.rate_percent === null ? 'not set' : b.rate_percent) },
  ], bands.body || [], { onRow: true }) + '<p class="hint">Click a band to set its rate.</p>')}
      ${card('Close settings', `<dl class="kv">
        <dt>Statutory reserve</dt><dd>${pct === null || pct === undefined ? 'not set' : `${pct}%`}</dd>
        <dt>Retained earnings</dt><dd>${esc(settings.body?.gl_retained_earnings || '')}</dd>
        <dt>Statutory reserve account</dt><dd>${esc(settings.body?.gl_statutory_reserve || '')}</dd>
      </dl><button id="f-settings" class="secondary">Set reserve percentage</button>`)}
    </div>
    ${card('Provisioning', `<div class="toolbar">
      <button id="f-preview">Preview</button>
      <button id="f-run" class="secondary">Post the movement</button>
    </div><div id="f-prov"></div>`)}
    ${card('Financial years', table([
    { label: 'Year', key: 'year' },
    { label: 'From', value: (y) => day(y.starts_on) },
    { label: 'To', value: (y) => day(y.ends_on) },
    { label: 'Status', key: 'status' },
    { label: 'Surplus', num: true, value: (y) => money(y.surplus) },
  ], years.body || [], { onRow: true }) + `<div class="toolbar spaced">
      <button id="f-openyear" class="secondary">Open a year</button></div>
    <p class="hint">Click a year to preview or run its close.</p>`)}`;

  wireRows(bands.body || [], async (b) => {
    const d = await ask([{ label: `Rate % for ${b.label} (${b.min_days}–${b.max_days ?? '∞'} days)`,
      name: 'ratePercent', type: 'number', step: '0.001', value: b.rate_percent ?? '' },
    { label: 'Source note', name: 'sourceNote', required: false, value: b.source_note || '' }],
    'Set provisioning rate');
    if (!d) return;
    const r = await api('PATCH', `/api/provisioning/bands/${b.code}`,
      { ratePercent: Number(d.ratePercent), sourceNote: d.sourceNote });
    toast(r.ok ? `${b.code} set to ${d.ratePercent}%` : r.error, !r.ok);
    if (r.ok) financeView();
  });

  $('#f-settings').addEventListener('click', async () => {
    const d = await ask([
      { label: 'Statutory reserve percentage of surplus', name: 'statutoryReservePercent', type: 'number', step: '0.001', value: pct ?? '' },
      { label: 'Source note', name: 'sourceNote', required: false, value: settings.body?.source_note || '' },
    ], 'Close settings');
    if (!d) return;
    const r = await api('PATCH', '/api/periods/settings',
      { statutoryReservePercent: Number(d.statutoryReservePercent), sourceNote: d.sourceNote });
    toast(r.ok ? 'Saved' : r.error, !r.ok);
    if (r.ok) financeView();
  });

  const showProvision = (p) => {
    el('f-prov').innerHTML = table([
      { label: 'Band', key: 'label' }, { label: 'Loans', num: true, key: 'loans' },
      { label: 'Outstanding', num: true, value: (x) => money(x.outstanding) },
      { label: 'Rate %', num: true, key: 'rate' },
      { label: 'Required', num: true, value: (x) => money(x.required) },
    ], p.lines || []) + `<dl class="kv spaced">
      <dt>Required</dt><dd>${money(p.requiredTotal)}</dd>
      <dt>Already held</dt><dd>${money(p.heldTotal)}</dd>
      <dt>Movement to post</dt><dd><strong>${money(p.movement)}</strong></dd></dl>`;
  };

  $('#f-preview').addEventListener('click', async () => {
    const r = await api('GET', '/api/provisioning/preview');
    if (!r.ok) return toast(r.error, true);
    showProvision(r.body);
  });

  $('#f-run').addEventListener('click', async () => {
    const r = await api('POST', '/api/provisioning/run', {});
    if (!r.ok) return toast(r.error, true);
    showProvision(r.body);
    toast(r.body.skipped ? 'Already run for this date' : `Posted ${money(r.body.movement)}`);
  });

  $('#f-openyear').addEventListener('click', async () => {
    const d = await ask([{ label: 'Year', name: 'year', type: 'number', value: new Date().getFullYear() }],
      'Open a financial year');
    if (!d) return;
    const r = await api('POST', '/api/periods', { year: Number(d.year) });
    toast(r.ok ? `Opened ${d.year}` : r.error, !r.ok);
    if (r.ok) financeView();
  });

  wireRows(years.body || [], yearDetail);
}

async function yearDetail(y) {
  const p = await api('GET', `/api/periods/${y.year}/close-preview`);
  if (!p.ok) return toast(p.error, true);
  const v = p.body;

  view().innerHTML = `
    <button class="secondary" id="back">← Period and provisions</button>
    <h1>Financial year ${y.year} <span class="badge">${esc(y.status)}</span></h1>
    <div class="grid">
      ${card('Income', table([{ label: 'Account', key: 'name' },
    { label: 'Amount', num: true, value: (x) => money(x.amount) }], v.income))}
      ${card('Expenses', table([{ label: 'Account', key: 'name' },
    { label: 'Amount', num: true, value: (x) => money(x.amount) }], v.expenses))}
    </div>
    ${card('What the close would post', `<dl class="kv">
      <dt>Total income</dt><dd>${money(v.totalIncome)}</dd>
      <dt>Total expenses</dt><dd>${money(v.totalExpenses)}</dd>
      <dt>Surplus</dt><dd><strong>${money(v.surplus)}</strong></dd>
      <dt>Statutory reserve</dt><dd>${v.reservePercent === null ? 'percentage not set' : `${v.reservePercent}% = ${money(v.reserveAmount)}`}</dd>
      <dt>To retained earnings</dt><dd>${money(v.retainedAmount)}</dd>
    </dl>
    <div class="toolbar spaced">
      ${y.status === 'OPEN' ? '<button id="y-close">Close the year</button>'
    : '<button id="y-reopen" class="secondary">Reopen</button>'}
    </div>
    <p class="hint">Closing sweeps income and expenses to retained earnings, transfers the reserve,
      and locks the year in the database. Reopening reverses the close and unlocks it; both stay on the record.</p>`)}`;

  $('#back').addEventListener('click', financeView);
  const closeBtn = $('#y-close');
  if (closeBtn) closeBtn.addEventListener('click', async () => {
    if (!window.confirm(`Close ${y.year}? Nothing can be posted into it afterwards without reopening.`)) return;
    const r = await api('POST', `/api/periods/${y.year}/close`, {});
    toast(r.ok ? `Closed ${y.year}` : r.error, !r.ok);
    if (r.ok) financeView();
  });
  const reopenBtn = $('#y-reopen');
  if (reopenBtn) reopenBtn.addEventListener('click', async () => {
    const d = await ask([{ label: 'Reason', name: 'reason' }], `Reopen ${y.year}`);
    if (!d) return;
    const r = await api('POST', `/api/periods/${y.year}/reopen`, { reason: d.reason });
    toast(r.ok ? `Reopened ${y.year}` : r.error, !r.ok);
    if (r.ok) financeView();
  });
}

// --------------------------------------------------------------------------
// Returns
// --------------------------------------------------------------------------

async function returnsView() {
  const r = await api('GET', '/api/returns');
  if (!r.ok) throw new Error(r.error);
  view().innerHTML = `
    <h1>Regulatory returns</h1>
    <p class="notice">Returns are defined as data, and nothing official ships with the system.
      A template marked "not official" has line items that nobody has checked against a published form.</p>
    ${table([
    { label: 'Code', key: 'code' }, { label: 'Name', key: 'name' },
    { label: 'Basis', value: (t) => (t.period_kind === 'PERIOD' ? 'period' : 'as at a date') },
    { label: 'Lines', num: true, key: 'line_count' },
    {
      label: 'Status',
      html: true,
      value: (t) => (t.is_official ? '<span class="badge">confirmed by your team</span>'
        : '<span class="badge warn">not official</span>'),
    },
  ], r.body, { onRow: true, empty: 'No templates loaded' })}`;
  wireRows(r.body, renderReturn);
}

async function renderReturn(t) {
  const qs = new URLSearchParams();
  const from = t.period_kind === 'PERIOD' ? `${new Date().getFullYear()}-01-01` : '';
  if (from) { qs.set('from', from); qs.set('to', today()); } else qs.set('asAt', today());
  const r = await api('GET', `/api/returns/${t.code}?${qs}`);
  if (!r.ok) return toast(r.error, true);
  const v = r.body;

  view().innerHTML = `
    <button class="secondary" id="back">← Returns</button>
    <h1>${esc(v.name)}</h1>
    <p class="notice">${esc(v.disclaimer)}</p>
    <p class="hint">${v.periodKind === 'PERIOD' ? `${esc(from)} to ${today()}` : `As at ${today()}`}</p>
    <table><thead><tr><th>Ref</th><th>Line</th><th class="num">Amount</th></tr></thead><tbody>
      ${v.lines.map((l) => `<tr class="${l.heading ? 'heading' : ''}">
        <td>${esc(l.ref)}</td><td>${esc(l.label)}${l.note ? `<br><span class="hint">${esc(l.note)}</span>` : ''}</td>
        <td class="num">${l.value === null || l.value === undefined ? '' : money(l.value)}</td></tr>`).join('')}
    </tbody></table>`;
  $('#back').addEventListener('click', returnsView);
}

// --------------------------------------------------------------------------
// Loan products
// --------------------------------------------------------------------------

// The product form, in the order Mambu's form runs: identity, type and
// interest, amount and term, schedule, repayment, arrears and penalties,
// controls, accounting. Blank optional fields are left unset.
const opt = (f) => ({ ...f, required: false });
const PRODUCT_FIELDS = (p = {}) => [
  { label: 'Name', name: 'name', value: p.name || '' },
  { label: 'Category', name: 'category', options: ['PERSONAL', 'PURCHASE_FINANCING', 'MORTGAGE', 'SME', 'COMMERCIAL', 'UNCATEGORIZED'], value: p.category || 'UNCATEGORIZED' },
  { label: 'Account number pattern (# digit, @ letter, $ either)', name: 'idPattern', value: p.idPattern || 'LN######' },
  { label: 'Numbering', name: 'idMode', options: ['INCREMENTAL', 'RANDOM'], value: p.idMode || 'INCREMENTAL' },
  { label: 'New applications start as', name: 'initialState', options: ['PENDING_APPROVAL', 'PARTIAL_APPLICATION'], value: p.initialState || 'PENDING_APPROVAL' },
  { label: 'Product type (fixed once created)', name: 'productType', options: ['FIXED_TERM', 'DYNAMIC_TERM', 'INTEREST_FREE', 'TRANCHED', 'REVOLVING'], value: p.productType || 'FIXED_TERM' },
  opt({ label: 'Maximum tranches (tranched)', name: 'maxTranches', type: 'number', value: p.maxTranches ?? '' }),
  opt({ label: 'Revolving: installment principal method', name: 'revolvingRepaymentMethod', options: ['', 'PRINCIPAL_FLAT', 'PRINCIPAL_PERCENT', 'TOTAL_DUE_PERCENT'], value: p.revolving?.repaymentMethod || '' }),
  opt({ label: 'Revolving: amount or percent', name: 'revolvingRepaymentValue', type: 'number', step: '0.0001', value: p.revolving?.repaymentValue ?? '' }),
  opt({ label: 'Revolving: repayment floor', name: 'revolvingRepaymentFloor', type: 'number', step: '0.01', value: p.revolving?.repaymentFloor ?? '' }),
  opt({ label: 'Revolving: repayment ceiling', name: 'revolvingRepaymentCeiling', type: 'number', step: '0.01', value: p.revolving?.repaymentCeiling ?? '' }),
  { label: 'Revolving: hold overpayments as a credit balance', name: 'creditBalanceEnabled', options: ['false', 'true'], value: String(p.revolving?.creditBalanceEnabled ?? false) },
  opt({ label: 'Revolving: maximum credit balance', name: 'maxCreditBalance', type: 'number', step: '0.01', value: p.revolving?.maxCreditBalance ?? '' }),
  opt({ label: 'Revolving: credit balance GL (liability)', name: 'glCreditBalance', value: p.revolving?.glCreditBalance || '200-310' }),
  { label: 'Interest method', name: 'method', options: ['FLAT', 'REDUCING', 'REDUCING_EQUAL_INSTALLMENTS'], value: p.method || 'FLAT' },
  { label: 'Interest type', name: 'interestType', options: ['SIMPLE', 'CAPITALIZED', 'COMPOUND'], value: p.interestType || 'SIMPLE' },
  { label: 'Simple interest base', name: 'simpleBase', options: ['PRINCIPAL_ONLY', 'PRINCIPAL_AND_INTEREST'], value: p.simpleBase || 'PRINCIPAL_ONLY' },
  { label: 'Interest applied', name: 'interestPosting', options: ['ON_REPAYMENT', 'ON_DISBURSEMENT'], value: p.interestPosting || 'ON_REPAYMENT' },
  { label: 'Rate quoted', name: 'rateFrequency', options: ['PER_MONTH', 'PER_YEAR', 'PER_WEEK', 'PER_DAY'], value: p.rateFrequency || 'PER_MONTH' },
  { label: 'Default rate, percent', name: 'monthlyRate', type: 'number', step: '0.0001', value: p.monthlyRate ?? 1 },
  opt({ label: 'Minimum rate', name: 'rateMin', type: 'number', step: '0.0001', value: p.rateMin ?? '' }),
  opt({ label: 'Maximum rate', name: 'rateMax', type: 'number', step: '0.0001', value: p.rateMax ?? '' }),
  { label: 'Prepayment on a dynamic loan', name: 'prepaymentRecalculation', options: ['REDUCE_INSTALLMENT_AMOUNT', 'REDUCE_NUMBER_OF_INSTALLMENTS', 'NONE'], value: p.prepaymentRecalculation || 'REDUCE_INSTALLMENT_AMOUNT' },
  { label: 'Accrue interest after maturity (dynamic)', name: 'accrueLateInterest', options: ['true', 'false'], value: String(p.accrueLateInterest ?? true) },
  opt({ label: 'Minimum amount', name: 'minPrincipal', type: 'number', step: '0.01', value: p.minPrincipal ?? '' }),
  opt({ label: 'Default amount', name: 'defaultPrincipal', type: 'number', step: '0.01', value: p.defaultPrincipal ?? '' }),
  opt({ label: 'Maximum amount', name: 'maxPrincipal', type: 'number', step: '0.01', value: p.maxPrincipal ?? '' }),
  opt({ label: 'Minimum installments', name: 'minTerm', type: 'number', value: p.minTerm ?? '' }),
  opt({ label: 'Default installments', name: 'defaultTerm', type: 'number', value: p.defaultTerm ?? '' }),
  { label: 'Maximum installments', name: 'maxTerm', type: 'number', value: p.maxTerm ?? 60 },
  { label: 'Repayment every', name: 'repaymentIntervalCount', type: 'number', value: p.repaymentIntervalCount ?? 1 },
  { label: 'Repayment interval unit', name: 'repaymentIntervalUnit', options: ['MONTHS', 'WEEKS', 'DAYS'], value: p.repaymentIntervalUnit || 'MONTHS' },
  opt({ label: 'Or fixed days of month, comma separated (e.g. 1,15)', name: 'fixedDaysOfMonth', value: (p.fixedDaysOfMonth || []).join(',') }),
  { label: 'Short month handling', name: 'shortMonthHandling', options: ['LAST_DAY', 'FIRST_OF_NEXT'], value: p.shortMonthHandling || 'LAST_DAY' },
  { label: 'First due date offset, days', name: 'firstDueOffsetDays', type: 'number', value: p.firstDueOffsetDays ?? 0 },
  { label: 'Grace', name: 'graceType', options: ['NONE', 'PRINCIPAL', 'PURE'], value: p.graceType || 'NONE' },
  { label: 'Grace periods', name: 'gracePeriods', type: 'number', value: p.gracePeriods ?? 0 },
  opt({ label: 'Amortise over (periods, for a balloon)', name: 'amortizationPeriods', type: 'number', value: p.amortizationPeriods ?? '' }),
  { label: 'Rounding of payments', name: 'rounding', options: ['NONE', 'WHOLE', 'WHOLE_UP'], value: p.rounding || 'NONE' },
  { label: 'Processing fee (legacy upfront flat fee)', name: 'processingFee', type: 'number', step: '0.01', value: p.processingFee ?? 0 },
  { label: 'Allow arbitrary fees', name: 'allowArbitraryFees', options: ['false', 'true'], value: String(p.allowArbitraryFees ?? false) },
  { label: 'Times own deposits a member may borrow', name: 'maxMultiplier', type: 'number', step: '0.1', value: p.maxMultiplier ?? 3 },
  { label: 'Enforce that multiplier at approval', name: 'enforceDepositMultiplier', options: ['true', 'false'], value: String(p.enforceDepositMultiplier ?? true) },
  { label: 'Require guarantor cover at approval', name: 'requireGuarantorCover', options: ['true', 'false'], value: String(p.requireGuarantorCover ?? false) },
  { label: 'Securities: guarantors', name: 'enableGuarantors', options: ['true', 'false'], value: String(p.securities?.guarantors ?? true) },
  { label: 'Securities: collateral assets', name: 'enableCollateral', options: ['false', 'true'], value: String(p.securities?.collateral ?? false) },
  opt({ label: 'Tax rate, percent (blank: no tax)', name: 'taxRatePercent', type: 'number', step: '0.0001', value: p.tax?.ratePercent ?? '' }),
  { label: 'Tax method', name: 'taxMethod', options: ['EXCLUSIVE', 'INCLUSIVE'], value: p.tax?.method || 'EXCLUSIVE' },
  { label: 'Tax on interest', name: 'taxOnInterest', options: ['false', 'true'], value: String(p.tax?.onInterest ?? false) },
  { label: 'Tax on fees', name: 'taxOnFees', options: ['false', 'true'], value: String(p.tax?.onFees ?? false) },
  { label: 'Tax on penalties', name: 'taxOnPenalties', options: ['false', 'true'], value: String(p.tax?.onPenalties ?? false) },
  opt({ label: 'Taxes payable GL (liability)', name: 'glTaxPayable', value: p.tax?.glTaxPayable || '200-300' }),
  { label: 'Funding sources (P2P)', name: 'fundingEnabled', options: ['false', 'true'], value: String(!!p.funding) },
  { label: 'Funder interest allocation', name: 'funderAllocation', options: ['PERCENT_OF_FUNDING', 'FIXED_COMMISSIONS'], value: p.funding?.allocation || 'PERCENT_OF_FUNDING' },
  opt({ label: 'Organisation interest commission', name: 'orgCommission', type: 'number', step: '0.0001', value: p.funding?.orgCommission ?? '' }),
  opt({ label: 'Funder rate default (fixed commissions)', name: 'funderRateDefault', type: 'number', step: '0.0001', value: p.funding?.funderRateDefault ?? '' }),
  opt({ label: 'Funder rate minimum', name: 'funderRateMin', type: 'number', step: '0.0001', value: p.funding?.funderRateMin ?? '' }),
  opt({ label: 'Funder rate maximum', name: 'funderRateMax', type: 'number', step: '0.0001', value: p.funding?.funderRateMax ?? '' }),
  { label: 'Lock funders\' money at approval', name: 'lockFundsAtApproval', options: ['true', 'false'], value: String(p.funding?.lockFundsAtApproval ?? true) },
  { label: 'Arrears tolerance, days', name: 'arrearsToleranceDays', type: 'number', value: p.arrearsToleranceDays ?? 0 },
  opt({ label: 'Arrears tolerance, % of outstanding', name: 'arrearsTolerancePercent', type: 'number', step: '0.001', value: p.arrearsTolerancePercent ?? '' }),
  opt({ label: 'with a floor of', name: 'arrearsToleranceFloor', type: 'number', step: '0.01', value: p.arrearsToleranceFloor ?? '' }),
  { label: 'Count days in arrears from', name: 'arrearsCountFrom', options: ['OLDEST_LATE', 'FIRST_ARREARS'], value: p.arrearsCountFrom || 'OLDEST_LATE' },
  { label: 'Non-working days in tolerance', name: 'arrearsNonWorkingDays', options: ['INCLUDE', 'EXCLUDE'], value: p.arrearsNonWorkingDays || 'INCLUDE' },
  { label: 'Penalty, percent per day', name: 'penaltyRate', type: 'number', step: '0.001', value: p.penaltyRate ?? 0 },
  { label: 'Penalty basis', name: 'penaltyBasis', options: ['OVERDUE_ALL', 'OVERDUE_PRINCIPAL', 'OVERDUE_PRINCIPAL_INTEREST', 'OUTSTANDING_PRINCIPAL', 'NONE'], value: p.penaltyBasis || 'OVERDUE_ALL' },
  { label: 'Penalty tolerance, days', name: 'penaltyToleranceDays', type: 'number', value: p.penaltyToleranceDays ?? 0 },
  opt({ label: 'Cap on charges, % of principal (blank: none)', name: 'chargeCapPercent', type: 'number', step: '0.001', value: p.chargeCapPercent ?? '' }),
  { label: 'Cap base', name: 'chargeCapBase', options: ['OUTSTANDING_PRINCIPAL', 'ORIGINAL_PRINCIPAL'], value: p.chargeCapBase || 'OUTSTANDING_PRINCIPAL' },
  { label: 'Cap mode', name: 'chargeCapMode', options: ['HARD', 'SOFT'], value: p.chargeCapMode || 'HARD' },
  opt({ label: 'Lock after days in arrears (blank: never)', name: 'autoLockArrearsDays', type: 'number', value: p.autoLockArrearsDays ?? '' }),
  { label: 'Accounting', name: 'accountingMethod', options: ['ACCRUAL', 'CASH', 'NONE'], value: p.accountingMethod || 'ACCRUAL' },
  { label: 'Interest accrual', name: 'interestAccrual', options: ['DAILY', 'MONTHLY', 'NONE'], value: p.interestAccrual || 'DAILY' },
  { label: 'Day count', name: 'dayCount', options: ['THIRTY_360', 'ACTUAL_365', 'ACTUAL_360', 'ACTUAL_ACTUAL'], value: p.dayCount || 'THIRTY_360' },
];

const PRODUCT_ENUM_FIELDS = ['category', 'idMode', 'initialState', 'productType', 'method', 'interestType', 'simpleBase', 'interestPosting',
  'rateFrequency', 'prepaymentRecalculation', 'repaymentIntervalUnit', 'shortMonthHandling', 'graceType', 'rounding',
  'arrearsCountFrom', 'arrearsNonWorkingDays', 'penaltyBasis', 'chargeCapBase', 'chargeCapMode', 'accountingMethod', 'interestAccrual', 'dayCount',
  'taxMethod', 'funderAllocation'];
const PRODUCT_NUM_FIELDS = ['monthlyRate', 'rateMin', 'rateMax', 'minPrincipal', 'defaultPrincipal', 'maxPrincipal', 'minTerm', 'defaultTerm', 'maxTerm',
  'repaymentIntervalCount', 'firstDueOffsetDays', 'gracePeriods', 'amortizationPeriods', 'processingFee', 'maxMultiplier',
  'arrearsToleranceDays', 'arrearsTolerancePercent', 'arrearsToleranceFloor', 'penaltyRate', 'penaltyToleranceDays',
  'chargeCapPercent', 'autoLockArrearsDays', 'maxTranches', 'revolvingRepaymentValue', 'revolvingRepaymentFloor', 'revolvingRepaymentCeiling',
  'maxCreditBalance', 'taxRatePercent', 'orgCommission', 'funderRateDefault', 'funderRateMin', 'funderRateMax'];
const PRODUCT_BOOL_FIELDS = ['accrueLateInterest', 'allowArbitraryFees', 'enforceDepositMultiplier', 'requireGuarantorCover',
  'creditBalanceEnabled', 'enableGuarantors', 'enableCollateral', 'taxOnInterest', 'taxOnFees', 'taxOnPenalties', 'fundingEnabled', 'lockFundsAtApproval'];
// Optional numbers that a blank field sets back to "unset".
const PRODUCT_NULLABLE = ['rateMin', 'rateMax', 'minPrincipal', 'defaultPrincipal', 'maxPrincipal', 'minTerm', 'defaultTerm',
  'amortizationPeriods', 'arrearsTolerancePercent', 'arrearsToleranceFloor', 'chargeCapPercent', 'autoLockArrearsDays',
  'maxTranches', 'revolvingRepaymentValue', 'revolvingRepaymentFloor', 'revolvingRepaymentCeiling', 'maxCreditBalance', 'taxRatePercent',
  'orgCommission', 'funderRateDefault', 'funderRateMin', 'funderRateMax'];

function productBody(d) {
  const out = { name: d.name, idPattern: d.idPattern };
  for (const k of PRODUCT_ENUM_FIELDS) if (d[k] !== undefined) out[k] = d[k];
  for (const k of PRODUCT_BOOL_FIELDS) if (d[k] !== undefined) out[k] = d[k] === 'true';
  for (const k of PRODUCT_NUM_FIELDS) {
    if (d[k] === undefined) continue;
    if (d[k] === '') { if (PRODUCT_NULLABLE.includes(k)) out[k] = null; continue; }
    out[k] = Number(d[k]);
  }
  if (d.fixedDaysOfMonth !== undefined) {
    out.fixedDaysOfMonth = d.fixedDaysOfMonth.trim() ? d.fixedDaysOfMonth.split(',').map((x) => Number(x.trim())).filter(Boolean) : null;
  }
  if (d.revolvingRepaymentMethod !== undefined) out.revolvingRepaymentMethod = d.revolvingRepaymentMethod || null;
  for (const k of ['glCreditBalance', 'glTaxPayable']) if (d[k] !== undefined) out[k] = d[k] || null;
  if (out.productType === 'INTEREST_FREE') out.monthlyRate = 0;
  return out;
}

const FEE_FIELDS = (f = {}) => [
  { label: 'Code', name: 'code', value: f.code || '' },
  { label: 'Name', name: 'name', value: f.name || '' },
  { label: 'When', name: 'feeType', options: ['MANUAL', 'DISBURSEMENT_DEDUCTED', 'DISBURSEMENT_CAPITALIZED', 'DISBURSEMENT_UPFRONT', 'PAYMENT_DUE', 'LATE_REPAYMENT'], value: f.feeType || 'MANUAL' },
  { label: 'How much', name: 'calculation', options: ['FLAT', 'PERCENT_OF_AMOUNT', 'FLAT_PER_INSTALLMENT', 'PERCENT_PER_INSTALLMENT', 'PERCENT_OF_INSTALLMENT_PRINCIPAL'], value: f.calculation || 'FLAT' },
  opt({ label: 'Amount (flat)', name: 'amount', type: 'number', step: '0.01', value: f.amount ?? '' }),
  opt({ label: 'Percent', name: 'percent', type: 'number', step: '0.0001', value: f.percent ?? '' }),
  opt({ label: 'Minimum', name: 'minAmount', type: 'number', step: '0.01', value: f.minAmount ?? '' }),
  opt({ label: 'Maximum', name: 'maxAmount', type: 'number', step: '0.01', value: f.maxAmount ?? '' }),
  { label: 'Required', name: 'required', options: ['true', 'false'], value: String(f.required ?? true) },
  opt({ label: 'Fee income GL (blank: product default)', name: 'glIncome', value: f.glIncome || '' }),
  opt({ label: 'Fee receivable GL (blank: product default)', name: 'glReceivable', value: f.glReceivable || '' }),
  { label: 'Active', name: 'isActive', options: ['true', 'false'], value: String(f.isActive ?? true) },
];
function feeBody(d) {
  const num = (v) => (v === '' || v === undefined ? null : Number(v));
  return {
    code: d.code ? d.code.toUpperCase() : undefined, name: d.name, feeType: d.feeType, calculation: d.calculation,
    amount: num(d.amount), percent: num(d.percent), minAmount: num(d.minAmount), maxAmount: num(d.maxAmount),
    required: d.required === 'true', isActive: d.isActive === 'true',
    glIncome: d.glIncome || null, glReceivable: d.glReceivable || null,
  };
}

async function productDetail(p0) {
  const r = await api('GET', `/api/loan-products/${p0.id}`);
  if (!r.ok) throw new Error(r.error);
  const p = r.body;
  const words = {
    FLAT: 'Flat', REDUCING: 'Reducing', REDUCING_EQUAL_INSTALLMENTS: 'Reducing, equal installments',
    FIXED_TERM: 'Fixed term', DYNAMIC_TERM: 'Dynamic term', INTEREST_FREE: 'Interest free', TRANCHED: 'Tranched', REVOLVING: 'Revolving credit',
  };
  view().innerHTML = `
    <button class="secondary" id="back">← Products</button>
    <div class="toolbar"><h1>${esc(p.id)} · ${esc(p.name)}</h1><span class="spacer"></span>
      <button id="p-edit" class="secondary">Edit settings</button><button id="p-fee">Add fee</button></div>
    <div class="grid">
      ${card('Interest', `<dl class="kv">
        <dt>Type</dt><dd>${esc(words[p.productType] || p.productType)}</dd>
        <dt>Method</dt><dd>${esc(words[p.method] || p.method)}</dd>
        <dt>Interest type</dt><dd>${esc(p.interestType)}${p.simpleBase === 'PRINCIPAL_AND_INTEREST' ? ' on principal and interest' : ''}</dd>
        <dt>Rate</dt><dd>${p.monthlyRate}% ${esc(p.rateFrequency.replace('PER_', 'per ').toLowerCase())}${p.rateMin !== null || p.rateMax !== null ? ` (${p.rateMin ?? '…'} to ${p.rateMax ?? '…'})` : ''} · ${p.annualRate}% a year</dd>
        <dt>Applied</dt><dd>${esc(p.interestPosting)} · accrual ${esc(p.interestAccrual)} · ${esc(p.dayCount)}</dd>
        <dt>Prepayment</dt><dd>${esc(p.prepaymentRecalculation)}${p.accrueLateInterest ? '' : ' · stops at maturity'}</dd>
      </dl>`)}
      ${card('Schedule', `<dl class="kv">
        <dt>Amount</dt><dd>${p.minPrincipal ?? '…'} to ${p.maxPrincipal ?? '…'}${p.defaultPrincipal !== null ? `, default ${p.defaultPrincipal}` : ''}</dd>
        <dt>Installments</dt><dd>${p.minTerm ?? '…'} to ${p.maxTerm}${p.defaultTerm !== null ? `, default ${p.defaultTerm}` : ''}</dd>
        <dt>Falls</dt><dd>${p.fixedDaysOfMonth ? `on the ${p.fixedDaysOfMonth.join(' and ')} of the month` : `every ${p.repaymentIntervalCount} ${p.repaymentIntervalUnit.toLowerCase()}`}${p.firstDueOffsetDays ? `, first ${p.firstDueOffsetDays} days later` : ''}</dd>
        <dt>Grace</dt><dd>${p.graceType === 'NONE' ? 'none' : `${p.gracePeriods} ${p.graceType.toLowerCase()} period(s)`}</dd>
        <dt>Balloon</dt><dd>${p.amortizationPeriods ? `amortised over ${p.amortizationPeriods}` : 'none'}</dd>
        <dt>Rounding</dt><dd>${esc(p.rounding)}</dd>
        <dt>Numbering</dt><dd>${esc(p.idPattern)} ${esc(p.idMode.toLowerCase())}, next ${p.idNext} · starts ${esc(p.initialState)}</dd>
      </dl>`)}
      ${card('Arrears, penalties, controls', `<dl class="kv">
        <dt>Arrears tolerance</dt><dd>${p.arrearsToleranceDays} days${p.arrearsTolerancePercent !== null ? `, ${p.arrearsTolerancePercent}% of outstanding` : ''}${p.arrearsToleranceFloor !== null ? ` (floor ${p.arrearsToleranceFloor})` : ''} · ${esc(p.arrearsNonWorkingDays.toLowerCase())} non-working days · from ${esc(p.arrearsCountFrom)}</dd>
        <dt>Penalty</dt><dd>${p.penaltyBasis === 'NONE' ? 'none' : `${p.penaltyRate}% a day on ${esc(p.penaltyBasis)}, after ${p.penaltyToleranceDays} days`}</dd>
        <dt>Cap on charges</dt><dd>${p.chargeCapPercent === null ? 'none set' : `${p.chargeCapPercent}% of ${esc(p.chargeCapBase)}, ${esc(p.chargeCapMode)}`}</dd>
        <dt>Auto lock</dt><dd>${p.autoLockArrearsDays === null ? 'never' : `after ${p.autoLockArrearsDays} days in arrears`}</dd>
        <dt>Eligibility</dt><dd>${p.maxMultiplier}× deposits${p.enforceDepositMultiplier ? '' : ' (not enforced)'}${p.requireGuarantorCover ? `, ${p.minCoverPercent}% cover` : ''}</dd>
        <dt>Accounting</dt><dd>${esc(p.accountingMethod)}${p.accountingMethod !== 'NONE' ? ` · portfolio ${esc(p.gl.portfolio)} · interest ${esc(p.gl.interestIncome)}` : ''}</dd>
        <dt>Allocation</dt><dd>${p.allocationOrder.join(' → ')}</dd>
        <dt>Securities</dt><dd>${[p.securities.guarantors ? 'guarantors' : null, p.securities.collateral ? 'collateral' : null].filter(Boolean).join(', ') || 'none'}</dd>
        <dt>Tax</dt><dd>${p.tax.ratePercent === null ? 'none' : `${p.tax.ratePercent}% ${p.tax.method.toLowerCase()} on ${[p.tax.onInterest ? 'interest' : null, p.tax.onFees ? 'fees' : null, p.tax.onPenalties ? 'penalties' : null].filter(Boolean).join(', ') || 'nothing'}`}</dd>
        ${p.maxTranches ? `<dt>Tranches</dt><dd>up to ${p.maxTranches}</dd>` : ''}
        ${p.revolving ? `<dt>Revolving</dt><dd>${esc(p.revolving.repaymentMethod)} ${p.revolving.repaymentValue}${p.revolving.creditBalanceEnabled ? ` · credit balance up to ${p.revolving.maxCreditBalance ?? 'any'}` : ''}</dd>` : ''}
        ${p.funding ? `<dt>Funding</dt><dd>${esc(p.funding.allocation)} · commission ${p.funding.orgCommission}%</dd>` : ''}
      </dl>`)}
    </div>
    ${card('Fees', table([
    { label: 'Code', key: 'code' },
    { label: 'Fee', key: 'name' },
    { label: 'When', key: 'feeType' },
    { label: 'How much', value: (f) => (f.amount !== null ? money(f.amount) : `${f.percent}%`) + (f.calculation.includes('INSTALLMENT') ? ` ${f.calculation.toLowerCase().replace(/_/g, ' ')}` : '') },
    { label: 'Required', value: (f) => (f.required ? 'yes' : 'optional') },
    { label: 'Active', value: (f) => (f.isActive ? 'yes' : 'no') },
  ], p.fees || [], { onRow: true, empty: 'No fees defined. The legacy processing fee, if any, still applies.' }))}
    <p class="hint">Click a fee to change it.</p>`;

  $('#back').addEventListener('click', productsView);
  $('#p-edit').addEventListener('click', async () => {
    const d = await ask(PRODUCT_FIELDS(p), `Edit ${p.id}`);
    if (!d) return;
    const res = await api('PATCH', `/api/loan-products/${p.id}`, productBody(d));
    toast(res.ok ? `${p.id} saved` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) productDetail(p);
  });
  $('#p-fee').addEventListener('click', async () => {
    const d = await ask(FEE_FIELDS(), `New fee on ${p.id}`);
    if (!d) return;
    const res = await api('POST', `/api/loan-products/${p.id}/fees`, feeBody(d));
    toast(res.ok ? `Fee ${res.body.code} added` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) productDetail(p);
  });
  wireRows(p.fees || [], async (f) => {
    const d = await ask(FEE_FIELDS(f).filter((x) => x.name !== 'code'), `Edit fee ${f.code}`);
    if (!d) return;
    const body = feeBody(d);
    delete body.code;
    const res = await api('PATCH', `/api/loan-products/${p.id}/fees/${f.id}`, body);
    toast(res.ok ? `Fee ${f.code} saved` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) productDetail(p);
  });
}

async function productsView() {
  const r = await api('GET', '/api/loan-products');
  if (!r.ok) throw new Error(r.error);
  view().innerHTML = `
    <div class="toolbar"><h1>Loan products</h1><span class="spacer"></span><button id="p-new">New product</button></div>
    <p class="hint">Rates are copied onto a loan when it is applied for, so changing a product does not
      reprice loans already running. The accounting method and GL accounts are read live.
      A fixed-term loan owes the interest on its schedule however it is paid; a dynamic-term loan
      pays interest on the actual balance for the actual days and its schedule is redrawn when it prepays.</p>
    ${table([
    { label: 'Id', key: 'id' },
    { label: 'Name', key: 'name' },
    { label: 'Type', value: (p) => ({ DYNAMIC_TERM: 'Dynamic', FIXED_TERM: 'Fixed', INTEREST_FREE: 'Interest free', TRANCHED: 'Tranched', REVOLVING: 'Revolving' }[p.productType] || p.productType) },
    { label: 'Method', value: (p) => ({ FLAT: 'Flat', REDUCING: 'Reducing', REDUCING_EQUAL_INSTALLMENTS: 'Reducing, equal installments' }[p.method] || p.method) },
    { label: 'Rate', num: true, value: (p) => `${p.monthlyRate}% ${p.rateFrequency.replace('PER_', '/').toLowerCase()}` },
    { label: 'Max term', num: true, key: 'maxTerm' },
    { label: 'Fees', num: true, value: (p) => `${p.feeCount}${p.processingFee > 0 ? ` + ${money(p.processingFee)}` : ''}` },
    { label: 'x deposits', num: true, value: (p) => `${p.maxMultiplier}${p.enforceDepositMultiplier ? '' : ' (not enforced)'}` },
    { label: 'Accounting', value: (p) => `${p.accountingMethod} · ${p.interestAccrual} · ${p.dayCount}` },
    { label: 'Loans', num: true, key: 'loans' },
    { label: 'Active', value: (p) => (p.isActive ? 'yes' : 'no') },
  ], r.body, { onRow: true, empty: 'No products' })}
    <p class="hint">Click a product to see and change its settings and fees.</p>`;

  wireRows(r.body, productDetail);

  $('#p-new').addEventListener('click', async () => {
    const d = await ask([
      { label: 'Id (2 to 16 letters, digits or underscore)', name: 'id' },
      ...PRODUCT_FIELDS(),
      { label: 'Portfolio GL account', name: 'glPortfolio', value: '100-100' },
      { label: 'Interest income GL account', name: 'glInterestInc', value: '400-100' },
      { label: 'Fee income GL account', name: 'glFeeInc', value: '400-200' },
    ], 'New loan product');
    if (!d) return;
    const res = await api('POST', '/api/loan-products', {
      id: d.id, ...productBody(d), glPortfolio: d.glPortfolio, glInterestInc: d.glInterestInc, glFeeInc: d.glFeeInc,
    });
    toast(res.ok ? `${res.body.id} created` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) productsView();
  });
}

const VIEWS = {
  members: membersView,
  products: productsView,
  loans: loansView,
  teller: tellerView,
  reports: reportsView,
  finance: financeView,
  returns: returnsView,
};
