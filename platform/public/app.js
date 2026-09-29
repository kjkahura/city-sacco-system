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
  menu: null,
  menuItem: null,
  enrolToken: null,
  mfaTicket: null,
  pwToken: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (id) => document.getElementById(id);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const money = (n) => (n === null || n === undefined || n === ''
  ? '' : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

const day = (d) => (d ? String(d).slice(0, 10) : '');
// The organization's day, in its own time zone, as the server counts it.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: S.sacco?.timezone || 'Africa/Nairobi' }).format(new Date());

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
async function api(method, path, body, { retry = true, reauth = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (S.tenant) headers['x-tenant'] = S.tenant;
  if (S.access) headers.authorization = `Bearer ${S.access}`;
  if (S.reauth && S.reauth.until > Date.now()) headers['x-reauth-token'] = S.reauth.token;

  const res = await fetch(path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* empty body */ }

  if (res.status === 401 && retry && S.refresh) {
    const ok = await refreshSession();
    if (ok) return api(method, path, body, { retry: false, reauth });
  }
  // A critical action with re-authentication on: the password, then once more.
  if (res.status === 403 && reauth && /^REAUTHENTICATION_REQUIRED/.test(payload?.errors?.[0]?.errorReason || '')) {
    if (await reauthenticate()) return api(method, path, body, { retry, reauth: false });
  }

  const out = {
    ok: res.ok,
    status: res.status,
    body: payload,
    total: Number(res.headers.get('items-total') || 0),
    error: res.ok ? null : (payload?.errors?.[0]?.errorReason || `HTTP ${res.status}`),
  };
  if (!res.ok && res.status === 401) {
    signOut(true);
    if (S.timedOut) { toast('Signed out after a time without activity', true); S.timedOut = false; }
  }
  return out;
}

/** A file sent as the raw request body (an attachment), with the session's headers. */
async function apiRaw(method, path, bytes, type) {
  const headers = { 'content-type': type || 'application/octet-stream' };
  if (S.tenant) headers['x-tenant'] = S.tenant;
  if (S.access) headers.authorization = `Bearer ${S.access}`;
  const res = await fetch(path, { method, headers, body: bytes });
  let payload = null;
  try { payload = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, body: payload, error: res.ok ? null : (payload?.errors?.[0]?.errorReason || `HTTP ${res.status}`) };
}

/** Fetch a file with the session's headers and open it (preview) or save it. */
async function openFile(path, name, { save = false } = {}) {
  const headers = {};
  if (S.tenant) headers['x-tenant'] = S.tenant;
  if (S.access) headers.authorization = `Bearer ${S.access}`;
  const res = await fetch(path, { headers });
  if (!res.ok) return toast(`HTTP ${res.status}`, true);
  const url = URL.createObjectURL(await res.blob());
  if (save) {
    const a = document.createElement('a');
    a.href = url; a.download = name || 'file'; document.body.appendChild(a); a.click(); a.remove();
  } else {
    window.open(url, '_blank', 'noopener');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return null;
}

async function refreshSession() {
  const r = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant': S.tenant },
    body: JSON.stringify({ refreshToken: S.refresh }),
  });
  if (!r.ok) {
    const b = await r.json().catch(() => null);
    S.timedOut = /SESSION_TIMED_OUT/.test(b?.errors?.[0]?.errorReason || '');
    return false;
  }
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

  // A temporary password: change it with the scoped token, then sign in
  // with the new one.
  let password = String(f.get('password') || '');
  if (S.pwToken) {
    const next = String(f.get('newPassword') || '');
    S.access = S.pwToken;
    const changed = await api('POST', '/api/auth/password', { currentPassword: password, newPassword: next }, { retry: false });
    S.access = null;
    if (!changed.ok) { err.textContent = changed.error; return; }
    S.pwToken = null;
    el('pwchange').hidden = true;
    password = next;
    e.target.querySelector('input[name=password]').value = next;
    toast('Password changed');
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
    password,
  });

  if (login.status === 403 && login.body?.passwordChangeRequired) {
    S.pwToken = login.body.passwordChangeToken;
    el('pwchange').hidden = false;
    const pol = login.body.passwordPolicy;
    if (pol) el('pw-rules').textContent = `At least ${pol.minLength} characters, with a letter and ${pol.minDigits} digit(s)${pol.minUppercase ? `, ${pol.minUppercase} capital(s)` : ''}${pol.minSpecial ? `, ${pol.minSpecial} symbol(s)` : ''}; not your username or a recent password.`;
    err.textContent = login.error === 'PASSWORD_EXPIRED' ? 'Your password has expired. Choose a new password to continue.' : 'Choose a new password to continue.';
    return;
  }

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
  showHeaderIcon();
  loadAccess().then(() => {
    if (S.user.roleCode) el('whoami').textContent = `${S.user.name || S.user.email} (${S.user.roleCode}, ${S.user.role})`;
    render();
  });
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

el('whoami').addEventListener('click', () => profileDialog());

el('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout', { refreshToken: S.refresh });
  signOut();
});

el('nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  S.view = b.dataset.view;
  for (const n of el('nav').children) n.classList.toggle('active', n === b);
  for (const n of el('menu-nav').children) n.classList.remove('active');
  render();
});

// The SACCO's logo on the sign-in screen, once the SACCO is known.
if (S.tenant) setTimeout(() => showLoginLogo(S.tenant), 0);
el('login-form').querySelector('input[name=tenant]').addEventListener('change', (ev) => showLoginLogo(String(ev.target.value || '').trim().toLowerCase()));

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
    // Only a clickable table's rows are wired, each to its own table (onRow: true is 'main').
    return onRow ? `<tr class="clickable" data-row="${i}" data-tbl="${esc(onRow === true ? 'main' : onRow)}">${cells}</tr>` : `<tr>${cells}</tr>`;
  }).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function wireRows(rows, onRow, key = 'main') {
  view().querySelectorAll(`tr[data-row][data-tbl="${key}"]`).forEach((tr) => {
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
async function scheduleEditor(e, title) {
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

/** Open a view from code, as the navigation does. */
function go(name) {
  S.view = name;
  for (const n of el('nav').children) n.classList.toggle('active', n.dataset.view === name);
  for (const n of el('menu-nav').children) n.classList.remove('active');
  render();
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
const MEMBER_STATES = ['PENDING_APPROVAL', 'INACTIVE', 'ACTIVE', 'EXITED', 'BLACKLISTED', 'REJECTED'];
const LANGUAGES = ['ENGLISH', 'SWAHILI', 'FRENCH', 'PORTUGESE', 'SPANISH', 'GERMAN', 'ITALIAN', 'CHINESE', 'RUSSIAN', 'NORWEGIAN'];
const stateBadge = (s) => `<span class="badge ${['ACTIVE', 'INACTIVE'].includes(s) ? '' : 'bad'}" data-state="${esc(s)}">${esc(String(s).replace(/_/g, ' ').toLowerCase())}</span>`;

async function membersView() {
  const qs = new URLSearchParams({ offset: memberState.offset, limit: memberState.limit });
  if (memberState.q) qs.set('q', memberState.q);
  if (memberState.status) qs.set('status', memberState.status);
  const r = await api('GET', `/api/members?${qs}`);
  if (!r.ok) throw new Error(r.error);
  const assoc = can('MANAGE_CLIENT_ASSOCIATION');

  view().innerHTML = `
    <div class="toolbar">
      <label>Search<input id="m-q" value="${esc(memberState.q)}" placeholder="name, number, phone, email or national ID"></label>
      <label>State<select id="m-status">
        ${['', ...MEMBER_STATES].map((s) =>
    `<option ${s === memberState.status ? 'selected' : ''} value="${s}">${s ? s.replace(/_/g, ' ').toLowerCase() : 'Any'}</option>`).join('')}
      </select></label>
      ${can('CREATE_CLIENT') ? '<button id="m-new">New member</button>' : ''}
      ${assoc ? '<button class="secondary" id="m-reassign">Reassign selected</button>' : ''}
    </div>
    ${table([
    ...(assoc ? [{ label: '', html: true, value: (m) => `<input type="checkbox" data-pick="${esc(m.id)}" aria-label="select ${esc(m.member_no)}">` }] : []),
    { label: 'No.', key: 'member_no' },
    { label: 'Name', value: (m) => [m.first_name, m.middle_name, m.last_name].filter(Boolean).join(' ') },
    { label: 'Phone', key: 'phone' },
    { label: 'State', html: true, value: (m) => stateBadge(m.status) },
    { label: 'Type', key: 'client_type_id' },
    { label: 'Joined', value: (m) => day(m.joined_on) },
  ], r.body, { onRow: true, empty: 'No members match' })}
    ${pager(memberState, r.total)}`;

  wireRows(r.body, memberDetail);
  view().querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', (e) => e.stopPropagation()));
  wirePager(memberState, membersView);
  $('#m-q').addEventListener('change', (e) => {
    memberState.q = e.target.value; memberState.offset = 0; membersView();
  });
  $('#m-status').addEventListener('change', (e) => {
    memberState.status = e.target.value; memberState.offset = 0; membersView();
  });
  const nb = $('#m-new');
  if (nb) nb.addEventListener('click', () => newHolder('CLIENT', membersView));
  const rb = $('#m-reassign');
  if (rb) rb.addEventListener('click', async () => {
    const ids = [...view().querySelectorAll('[data-pick]:checked')].map((x) => x.dataset.pick);
    if (!ids.length) return toast('Select the members to reassign first', true);
    const d = await associationForm(`Reassign ${ids.length} member(s)`, { bulk: true });
    if (!d) return;
    const res = await api('POST', '/api/members:reassign', { members: ids, ...d });
    toast(res.ok ? `${res.body.reassigned} member(s) reassigned` : res.error, !res.ok);
    if (res.ok) membersView();
  });
}

/** Branch, centre, credit officer and whether the accounts move (the reference platform's Reassign). */
async function associationForm(title, { bulk = false, m = null } = {}) {
  const [br, ce] = await Promise.all([api('GET', '/api/branches'), api('GET', '/api/centres')]);
  const code = (list, id) => (list || []).find((x) => x.id === id)?.code || '';
  const d = await ask([
    opt({ label: 'Branch', name: 'branchId', options: ['', ...(br.body || []).filter((b) => b.status === 'ACTIVE').map((b) => b.code)], value: m ? code(br.body, m.branch_id) : '' }),
    opt({ label: 'Centre', name: 'centreId', options: ['', ...(ce.body || []).filter((x) => x.status === 'ACTIVE').map((x) => x.code)], value: m ? code(ce.body, m.centre_id) : '',
      hint: bulk ? 'Blank keeps each member\'s centre' : 'In the branch chosen' }),
    opt({ label: 'Credit officer (email)', name: 'creditOfficer', value: m?.credit_officer || '', hint: bulk ? 'Blank keeps each member\'s credit officer' : '' }),
    { label: 'Move the accounts too', name: 'moveAccounts', options: ['false', 'true'] },
  ], title);
  if (!d) return null;
  const out = { moveAccounts: d.moveAccounts === 'true' };
  if (d.branchId) out.branchId = d.branchId;
  if (bulk) { if (d.centreId) out.centreId = d.centreId; if (d.creditOfficer) out.creditOfficer = d.creditOfficer; }
  else { out.centreId = d.centreId || null; out.creditOfficer = d.creditOfficer || null; }
  return out;
}

/** The fields of the create and edit forms, as the holder's type shows them. */
function holderFields(type, m = null, holderType = 'CLIENT') {
  const f = [];
  if (holderType === 'GROUP') f.push({ label: 'Group name', name: 'groupName', value: m?.first_name || '' });
  else {
    f.push({ label: 'First name', name: 'firstName', value: m?.first_name || '' }, opt({ label: 'Middle name', name: 'middleName', value: m?.middle_name || '' }),
      { label: 'Last name', name: 'lastName', value: m?.last_name || '' },
      opt({ label: 'Gender', name: 'gender', options: ['', 'FEMALE', 'MALE', 'OTHER'], value: m?.gender || '' }),
      opt({ label: 'Date of birth', name: 'dateOfBirth', type: 'date', value: m?.date_of_birth || '' }),
      opt({ label: 'National ID', name: 'nationalId', value: m?.national_id || '' }), opt({ label: 'KRA PIN', name: 'kraPin', value: m?.kra_pin || '' }),
      opt({ label: 'Employer', name: 'employer', value: m?.employer || '' }));
  }
  f.push(opt({ label: 'Mobile phone', name: 'phone', value: m?.phone || '' }), opt({ label: 'Other phone', name: 'phone2', value: m?.phone2 || '' }),
    opt({ label: 'Email', name: 'email', type: 'email', value: m?.email || '' }),
    opt({ label: 'Preferred language', name: 'preferredLanguage', options: ['', ...LANGUAGES], value: m?.preferred_language || '' }));
  if (!type || type.useDefaultAddress !== false) {
    f.push(opt({ label: 'Address', name: 'addressLine1', value: m?.address_line1 || '' }), opt({ label: 'Address, second line', name: 'addressLine2', value: m?.address_line2 || '' }),
      opt({ label: 'City', name: 'city', value: m?.city || '' }), opt({ label: 'Postcode', name: 'postcode', value: m?.postcode || '' }),
      opt({ label: 'Region', name: 'region', value: m?.region || '' }), opt({ label: 'Country', name: 'country', value: m?.country || '' }));
  }
  f.push(opt({ label: 'Notes', name: 'notes', type: 'textarea', rows: 3, value: m?.notes || '' }));
  return f;
}

/**
 * Create a member or a group (the reference platform's Create): the type first, then its
 * form, with the association, the mandatory ID documents and the required
 * custom fields of that type. A member's duplicate checks are asked before
 * it is saved; warnings are shown and confirmed.
 */
async function newHolder(holderType, after) {
  const word = holderType === 'GROUP' ? 'group' : 'member';
  const tr = await api('GET', `/api/client-types?holderType=${holderType}`);
  const types = tr.body || [];
  let type = types.find((t) => t.isDefault) || types[0];
  if (types.length > 1) {
    const d = await ask([{ label: holderType === 'GROUP' ? 'Group type' : 'Client type', name: 'type', options: types.map((t) => t.id), value: type?.id,
      hint: types.map((t) => `${t.id}: ${t.name}`).join('; ') }], `New ${word}`);
    if (!d) return;
    type = types.find((t) => t.id === d.type);
  }
  const [br, ce, idt, defs] = await Promise.all([api('GET', '/api/branches'), api('GET', '/api/centres'), api('GET', '/api/id-templates'),
    api('GET', `/api/custom-fields/definitions?entity=${holderType === 'GROUP' ? 'GROUP' : 'MEMBER'}`)]);
  const fields = holderFields(type, null, holderType);
  fields.push(opt({ label: 'Branch', name: 'branchId', options: ['', ...(br.body || []).filter((b) => b.status === 'ACTIVE').map((b) => b.code)], hint: 'Blank: your own branch' }),
    opt({ label: 'Centre', name: 'centreId', options: ['', ...(ce.body || []).filter((x) => x.status === 'ACTIVE').map((x) => x.code)] }),
    opt({ label: 'Credit officer (email)', name: 'creditOfficer' }));
  if (can(holderType === 'GROUP' ? 'EDIT_GROUP_ID' : 'EDIT_CLIENT_ID')) fields.push(opt({ label: 'ID (blank: the next from the type)', name: 'memberNo' }));
  const mandatory = holderType === 'CLIENT' && type?.requireIdentificationDocuments ? (idt.body?.templates || []).filter((t) => t.mandatory) : [];
  for (const t of mandatory) fields.push({ label: `${t.id_type} number`, name: `doc:${t.id}`, hint: `Template ${t.mask}` });
  const required = (defs.body || []).filter((d) => d.is_active && d.set_id && d.set_type !== 'GROUPED'
    && (d.available_for_all ? d.usage?.required : d.usage?.items?.[type?.id]?.required));
  for (const d of required) {
    const f = { label: `${d.set_name || d.set_id}: ${d.name}`, name: `cf:${d.set_id}|${d.id}` };
    if (d.field_type === 'SELECTION') f.options = (d.options || []).map((o) => o.id);
    if (d.field_type === 'DATE') f.type = 'date';
    if (d.field_type === 'NUMBER') { f.type = 'number'; f.step = 'any'; }
    fields.push(f);
  }
  const d = await ask(fields, `New ${type ? type.name.toLowerCase() : word}`);
  if (!d) return;
  const body = { holderType, clientTypeId: type?.id, identificationDocuments: [], customFields: {} };
  for (const [k, v] of Object.entries(d)) {
    if (v === '' || v === undefined) continue;
    if (k.startsWith('doc:')) body.identificationDocuments.push({ templateId: k.slice(4), documentId: v });
    else if (k.startsWith('cf:')) {
      const [sid, fid] = k.slice(3).split('|');
      const def = required.find((x) => x.set_id === sid && x.id === fid);
      body.customFields[sid] = { ...(body.customFields[sid] || {}), [fid]: def?.field_type === 'NUMBER' ? Number(v) : v };
    } else body[k] = v;
  }
  if (holderType === 'CLIENT') {
    const dup = await api('POST', '/api/members:duplicates', body);
    const hard = (dup.body || []).filter((x) => x.level === 'ERROR');
    if (hard.length) return toast(`Duplicate: ${hard.map((x) => `${x.check.replace(/_/g, ' ').toLowerCase()} matches ${x.memberNo} (${x.state.toLowerCase()})`).join('; ')}`, true);
    const soft = (dup.body || []).filter((x) => x.level === 'WARNING');
    if (soft.length && !(await ask([], `Possible duplicate: ${soft.map((x) => `${x.check.replace(/_/g, ' ').toLowerCase()} matches ${x.memberNo}`).join('; ')}. Create anyway?`))) return;
  }
  const res = await api('POST', '/api/members', body);
  toast(res.ok ? `${holderType === 'GROUP' ? 'Group' : 'Member'} ${res.body.member_no} created` : res.error, !res.ok);
  if (res.ok) memberDetail(res.body);
  else if (after) after();
}

/** The state actions a member's state allows and the user may take (the reference platform's life cycle). */
const STATE_ACTIONS = [
  ['APPROVE', 'Approve', ['PENDING_APPROVAL'], 'APPROVE_CLIENT'], ['REJECT', 'Reject', ['PENDING_APPROVAL'], 'REJECT_CLIENT'],
  ['UNDO_APPROVE', 'Undo approve', ['INACTIVE'], 'UNDO_CLIENT_STATE_CHANGED'], ['UNDO_REJECT', 'Undo reject', ['REJECTED'], 'UNDO_CLIENT_STATE_CHANGED'],
  ['EXIT', 'Exit', ['INACTIVE'], 'EXIT_CLIENT'], ['UNDO_EXIT', 'Undo exit', ['EXITED'], 'UNDO_CLIENT_STATE_CHANGED'],
  ['BLACKLIST', 'Blacklist', ['PENDING_APPROVAL', 'INACTIVE', 'ACTIVE'], 'BLACKLIST_CLIENT'],
  ['UNDO_BLACKLIST', 'Undo blacklist', ['BLACKLISTED'], 'UNDO_CLIENT_STATE_CHANGED'],
];

async function memberDetail(m0) {
  const fresh = await api('GET', `/api/members/${m0.id}`);
  if (!fresh.ok) throw new Error(fresh.error);
  const m = fresh.body;
  const isGroup = m.holder_type === 'GROUP';
  const P = isGroup ? { edit: 'EDIT_GROUP', assoc: 'MANAGE_GROUP_ASSOCIATION', del: 'DELETE_GROUP' } : { edit: 'EDIT_CLIENT', assoc: 'MANAGE_CLIENT_ASSOCIATION', del: 'DELETE_CLIENTS' };
  const [savings, loans, shares, history, ids, cf, types, br, ce, roleNames] = await Promise.all([
    api('GET', `/api/savings?memberId=${m.id}&limit=50`),
    api('GET', `/api/loans?memberId=${m.id}&limit=50`),
    api('GET', `/api/shares?memberId=${m.id}&limit=50`),
    api('GET', `/api/members/${m.id}/loan-history`),
    isGroup ? Promise.resolve({ ok: true, body: [] }) : api('GET', `/api/members/${m.id}/identifications`),
    api('GET', `/api/custom-fields/values/${isGroup ? 'GROUP' : 'MEMBER'}/${m.id}`),
    api('GET', '/api/client-types'), api('GET', '/api/branches'), api('GET', '/api/centres'),
    isGroup ? api('GET', '/api/group-role-names') : Promise.resolve({ body: [] }),
  ]);
  const [arrangements, solidarity] = await Promise.all([
    can('VIEW_LINE_OF_CREDIT_DETAILS') ? api('GET', `/api/${isGroup ? 'groups' : 'clients'}/${m.id}/creditarrangements`) : Promise.resolve({ ok: false }),
    isGroup ? api('GET', `/api/groups/${m.id}/solidarity-loans`) : Promise.resolve({ ok: false }),
  ]);
  const h = history.body || {};
  const myShares = (shares.body || []).filter((s) => s.member_id === m.id);
  const type = (types.body || []).find((t) => t.id === m.client_type_id);
  const code = (list, id) => (list || []).find((x) => x.id === id)?.code || '—';
  const name = isGroup ? m.first_name : [m.first_name, m.middle_name, m.last_name].filter(Boolean).join(' ');
  const actions = isGroup || m.anonymized_at ? [] : STATE_ACTIONS.filter(([, , from, perm]) => from.includes(m.status) && can(perm));
  const editable = m.status !== 'BLACKLISTED' && !m.anonymized_at;
  const roleName = new Map((roleNames.body || []).map((r) => [r.id, r.name]));

  view().innerHTML = `
    <button class="secondary" id="back">← ${isGroup ? 'Groups' : 'Members'}</button>
    <h1>${esc(name)} <span class="badge">${esc(m.member_no)}</span> ${stateBadge(m.status)}</h1>
    <div class="toolbar" id="member-actions">
      ${editable && can(P.edit) ? '<button class="secondary" id="m-edit">Edit</button>' : ''}
      ${editable && can(P.assoc) ? '<button class="secondary" id="m-assoc">Change association</button>' : ''}
      ${actions.map(([a, label]) => `<button class="secondary" data-state-action="${a}">${esc(label)}</button>`).join('')}
      ${!isGroup ? '<button class="secondary" id="m-history">State history</button>' : ''}
      ${!isGroup && m.status === 'EXITED' && !m.anonymized_at && can('ANONYMIZE_CLIENT') ? '<button class="secondary" id="m-anon">Anonymize</button>' : ''}
      ${can(P.del) ? '<button class="secondary" id="m-delete">Delete</button>' : ''}
    </div>
    <div class="grid">
      ${card('Details', `<dl class="kv" id="member-details">
        <dt>State</dt><dd>${esc(m.status)}${m.state_reason ? ` (${esc(m.state_reason)})` : ''}${m.exit_reason ? ` (${esc(m.exit_reason)})` : ''}</dd>
        <dt>Type</dt><dd>${esc(type ? type.name : m.client_type_id)}</dd>
        ${isGroup ? '' : `<dt>Gender</dt><dd>${esc(m.gender || '—')}</dd><dt>Date of birth</dt><dd>${day(m.date_of_birth) || '—'}</dd>
        <dt>National ID</dt><dd>${esc(m.national_id || '—')}</dd><dt>KRA PIN</dt><dd>${esc(m.kra_pin || '—')}</dd>`}
        <dt>Phone</dt><dd>${esc(m.phone || '—')}${m.phone2 ? `, ${esc(m.phone2)}` : ''}</dd>
        <dt>Email</dt><dd>${esc(m.email || '—')}</dd>
        <dt>Branch</dt><dd>${esc(code(br.body, m.branch_id))}</dd><dt>Centre</dt><dd>${esc(code(ce.body, m.centre_id))}</dd>
        <dt>Credit officer</dt><dd>${esc(m.credit_officer || '—')}</dd>
        <dt>Joined</dt><dd>${day(m.joined_on)}</dd>${m.exited_on ? `<dt>Exited</dt><dd>${day(m.exited_on)}</dd>` : ''}
        ${!isGroup ? `<dt>Groups</dt><dd>${(m.groups || []).map((g) => esc(`${g.group_name} (${g.member_no})`)).join(', ') || '—'}</dd>` : ''}
      </dl>`)}
      ${card('Savings', `${table([
    { label: 'Account', key: 'account_no' },
    { label: 'Product', key: 'product_id' },
    { label: 'State', key: 'status' },
    { label: 'Balance', num: true, value: (a) => money(a.balance) },
    { label: '', html: true, value: (a) => (can('CLOSE_SAVINGS_ACCOUNTS') && ['ACTIVE', 'DORMANT'].includes(a.status) && Number(a.balance) === 0
      ? `<button class="link" data-close-acc="${esc(a.id)}">close</button>` : '') },
  ], savings.body || [], { onRow: 'dep', empty: 'No savings accounts' })}`)}
      ${card('Shares', table([
    { label: 'Account', key: 'account_no' },
    { label: 'Units', num: true, value: (a) => Number(a.units).toLocaleString() },
  ], myShares, { empty: 'No share account' }))}
    </div>
    ${isGroup ? '' : `<div id="member-media">${card('Picture and signature', `<div class="grid">
      <figure><figcaption>Picture</figcaption>${m.media?.picture ? '<img id="media-picture" alt="picture" style="max-width:200px;max-height:200px">' : '<p class="hint">None</p>'}
        ${can('EDIT_CLIENT') && !m.anonymized_at ? `<button class="secondary" data-media-up="picture">Upload</button>${m.media?.picture ? ' <button class="link" data-media-drop="picture">remove</button>' : ''}` : ''}</figure>
      <figure><figcaption>Signature</figcaption>${m.media?.signature ? '<img id="media-signature" alt="signature" style="max-width:300px;max-height:120px">' : '<p class="hint">None</p>'}
        ${can('EDIT_CLIENT') && !m.anonymized_at ? `<button class="secondary" data-media-up="signature">Upload</button>${m.media?.signature ? ' <button class="link" data-media-drop="signature">remove</button>' : ''}` : ''}</figure>
      </div><p class="hint">PNG, JPEG or GIF, up to 50 MB.</p>`)}</div>`}
    ${isGroup ? `<div id="group-members">${card('Group members', `${table([
    { label: 'No.', key: 'member_no' }, { label: 'Name', value: (x) => `${x.first_name} ${x.last_name}` },
    { label: 'Roles', value: (x) => (x.roles || []).map((r) => roleName.get(r) || r).join(', ') },
    { label: 'State', key: 'status' },
    { label: '', html: true, value: (x) => (can('EDIT_GROUP') ? `<button class="link" data-gm-drop="${esc(x.member_id)}">remove</button>` : '') },
  ], m.groupMembers || [], { empty: 'No members yet' })}
      ${can('EDIT_GROUP') ? '<button class="secondary" id="gm-add">Add member</button>' : ''}`)}</div>` : ''}
    ${solidarity.ok ? `<div id="solidarity-loans">${card('Solidarity loans', `${table([
    { label: 'Loan', key: 'id' }, { label: 'Member', value: (x) => `${x.memberName} (${x.memberId})` }, { label: 'State', key: 'accountState' },
    { label: 'Amount', num: true, value: (x) => money(x.loanAmount) }, { label: 'Outstanding', num: true, value: (x) => money(x.principalBalance) },
  ], solidarity.body.loans, { onRow: 'sol', empty: 'No solidarity loans' })}
      <p class="hint">${solidarity.body.totals.running} running of ${solidarity.body.totals.loans}; principal outstanding ${money(solidarity.body.totals.principalBalance)}.</p>
      ${can('CREATE_LOAN_ACCOUNT') && (m.groupMembers || []).length ? '<button class="secondary" id="sol-open">Open solidarity loans</button>' : ''}`)}</div>` : ''}
    ${arrangements.ok ? `<div id="credit-arrangements">${card('Credit arrangements', `${table([
    { label: 'ID', key: 'id' }, { label: 'State', key: 'state' }, { label: 'Amount', num: true, value: (x) => money(x.amount) },
    { label: 'Consumed', num: true, value: (x) => money(x.consumedCreditAmount) }, { label: 'Available', num: true, value: (x) => money(x.availableCreditAmount) },
    { label: 'Expires', value: (x) => day(x.expireDate) },
  ], arrangements.body || [], { onRow: 'ca', empty: 'No credit arrangements' })}
      ${can('CREATE_LINES_OF_CREDIT') ? '<button class="secondary" id="ca-new">New credit arrangement</button>' : ''}`)}</div>` : ''}
    ${card('Loans', table([
    { label: 'Account', key: 'account_no' },
    { label: 'Status', key: 'status' },
    { label: 'Principal', num: true, value: (l) => money(l.principal) },
    { label: 'Outstanding', num: true, value: (l) => money(Number(l.principal_disbursed) + Number(l.principal_capitalized || 0) - l.principal_paid) },
  ], loans.body || [], { onRow: true, empty: 'No loans' }))}
    ${history.ok ? `<div id="loan-history">${card('Loan history', `<dl class="kv">
        <dt>Completed loan cycles</dt><dd id="cycles">${h.completedLoanCycles}</dd>
        <dt>Largest loan approved</dt><dd>${h.maxLoanSize === null ? '—' : money(h.maxLoanSize)}</dd>
        <dt>On-time repayment rate</dt><dd id="on-time">${h.overallOnTimeRate === null ? '—' : `${h.overallOnTimeRate}%`}</dd></dl>
      ${table([
    { label: 'Account', value: (x) => `${x.accountNo}${x.maxLoanSize ? ' (largest)' : ''}` },
    { label: 'Amount', num: true, value: (x) => money(x.amount) },
    { label: 'Closed', value: (x) => day(x.closedOn) },
    { label: 'How', value: (x) => String(x.closedAs).toLowerCase().replace(/_/g, ' ') },
    { label: 'On time', num: true, value: (x) => (x.onTimeRate === null ? '' : `${x.onTimeRate}%`) },
  ], h.closedLoans || [], { empty: 'No closed loans' })}`)}</div>` : ''}
    ${isGroup ? '' : `<div id="identifications">${card('Identification documents', `${table([
    { label: 'Type', key: 'id_type' }, { label: 'Number', key: 'document_id' }, { label: 'Issued by', key: 'issuing_authority' },
    { label: 'Valid until', html: true, value: (x) => `${day(x.valid_until)}${x.expired ? ' <span class="badge bad" data-expired>expired</span>' : x.expiresInDays !== null && x.expiresInDays <= 30 ? ` <span class="badge">in ${x.expiresInDays} days</span>` : ''}` },
    { label: '', html: true, value: (x) => `<button class="link" data-id-files="${esc(x.id)}">files</button> <button class="link" data-id-drop="${esc(x.id)}">remove</button>` },
  ], ids.body || [], { empty: 'No identification documents' })}
      ${m.expiredIdDocuments ? `<p class="notice">${m.expiredIdDocuments} document(s) past their valid-until date.</p>` : ''}
      <button class="secondary" id="id-add">Add document</button>`)}</div>`}
    ${cf.ok ? customFieldsCard(cf.body) : ''}`;

  $('#back').addEventListener('click', isGroup ? groupsView : membersView);
  memberTasks(m);
  entityReports('MEMBER', m.member_no);
  wireRows(loans.body || [], loanDetail);
  wireRows(savings.body || [], (a) => depositDetail(a, m), 'dep');
  if (solidarity.ok) wireRows(solidarity.body.loans, (x) => loanDetail({ id: x.encodedKey }), 'sol');
  if (arrangements.ok) wireRows(arrangements.body || [], (x) => creditArrangementDetail(x.encodedKey, m), 'ca');
  view().querySelectorAll('tr[data-tbl="dep"] button').forEach((b) => b.addEventListener('click', (e) => e.stopPropagation()));
  const reload = () => memberDetail(m);
  const on = (sel, fn) => { const b = $(sel); if (b) b.addEventListener('click', fn); };
  if (cf.ok) wireCustomFields(cf.body, isGroup ? 'GROUP' : 'MEMBER', m.id, reload);
  on('#m-edit', async () => {
    const fields = holderFields(type, m, m.holder_type);
    if (can(isGroup ? 'CHANGE_GROUP_TYPE' : 'CHANGE_CLIENT_TYPE')) {
      fields.push({ label: 'Type', name: 'clientTypeId', options: (types.body || []).filter((t) => t.holderType === m.holder_type).map((t) => t.id), value: m.client_type_id });
    }
    if (can(isGroup ? 'EDIT_GROUP_ID' : 'EDIT_CLIENT_ID')) fields.push({ label: 'ID', name: 'memberNo', value: m.member_no });
    const d = await ask(fields, `Edit ${m.member_no}`);
    if (!d) return;
    const cols = { firstName: 'first_name', middleName: 'middle_name', lastName: 'last_name', groupName: 'first_name', gender: 'gender', dateOfBirth: 'date_of_birth',
      nationalId: 'national_id', kraPin: 'kra_pin', employer: 'employer', phone: 'phone', phone2: 'phone2', email: 'email', preferredLanguage: 'preferred_language',
      addressLine1: 'address_line1', addressLine2: 'address_line2', city: 'city', postcode: 'postcode', region: 'region', country: 'country', notes: 'notes',
      clientTypeId: 'client_type_id', memberNo: 'member_no' };
    const patch = {};
    for (const [k, v] of Object.entries(d)) if ((m[cols[k]] ?? '') !== v) patch[k] = v === '' ? null : v;
    if (!Object.keys(patch).length) return toast('Nothing changed');
    const res = await api('PATCH', `/api/members/${m.id}`, patch);
    const warn = res.body?.duplicateWarnings?.length ? ` (possible duplicate of ${res.body.duplicateWarnings.map((x) => x.memberNo).join(', ')})` : '';
    toast(res.ok ? `Saved${warn}` : res.error, !res.ok);
    if (res.ok) reload();
  });
  on('#m-assoc', async () => {
    const d = await associationForm(`Association of ${m.member_no}`, { m });
    if (!d) return;
    const res = await api('POST', `/api/members/${m.id}/association`, d);
    toast(res.ok ? `Reassigned${res.body.accountsMoved.length ? `, ${res.body.accountsMoved.length} account(s) moved` : ''}` : res.error, !res.ok);
    if (res.ok) reload();
  });
  view().querySelectorAll('[data-state-action]').forEach((b) => b.addEventListener('click', async () => {
    const a = b.dataset.stateAction;
    const needsReason = ['REJECT', 'BLACKLIST', 'EXIT'].includes(a);
    const d = await ask(needsReason ? [opt({ label: 'Reason', name: 'reason', type: 'textarea', rows: 3 })] : [], `${b.textContent} ${m.member_no}?`);
    if (!d) return;
    const res = await api('POST', `/api/members/${m.id}/state`, { action: a, reason: d.reason || undefined });
    toast(res.ok ? `Now ${res.body.status.replace(/_/g, ' ').toLowerCase()}` : res.error, !res.ok);
    if (res.ok) reload();
  }));
  on('#m-history', async () => {
    const r = await api('GET', `/api/members/${m.id}/state-history`);
    showDialog(`State history of ${m.member_no}`, table([
      { label: 'When', value: (x) => String(x.changed_at).replace('T', ' ').slice(0, 16) }, { label: 'Action', key: 'action' },
      { label: 'From', key: 'from_state' }, { label: 'To', key: 'to_state' }, { label: 'By', key: 'actor' }, { label: 'Reason', key: 'reason' },
    ], r.body || [], { empty: 'No changes' }));
  });
  on('#m-anon', async () => {
    if (!(await ask([], `Anonymize ${m.member_no}? Personal details, ID documents and portal access are removed for good; the number and the accounts stay.`))) return;
    const res = await api('POST', `/api/members/${m.id}/anonymize`);
    toast(res.ok ? 'Anonymized' : res.error, !res.ok);
    if (res.ok) reload();
  });
  on('#m-delete', async () => {
    if (!(await ask([], `Delete ${m.member_no}? Only a ${isGroup ? 'group' : 'member'} that never had an account can be deleted, and it cannot be undone.`))) return;
    const res = await api('DELETE', `/api/members/${m.id}`);
    toast(res.ok ? `Deleted ${m.member_no}` : res.error, !res.ok);
    if (res.ok) (isGroup ? groupsView : membersView)();
  });
  view().querySelectorAll('[data-close-acc]').forEach((b) => b.addEventListener('click', async () => {
    const res = await api('POST', `/api/savings/${b.dataset.closeAcc}/close`, {});
    toast(res.ok ? 'Account closed' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  on('#ca-new', async () => {
    const d = await ask([{ label: 'Amount', name: 'amount', type: 'number', step: '0.01' },
      opt({ label: 'Start date (blank: today)', name: 'startDate', type: 'date' }), { label: 'Expire date', name: 'expireDate', type: 'date' },
      { label: 'Exposure counted as', name: 'exposureLimitType', options: ['APPROVED_AMOUNT', 'OUTSTANDING_AMOUNT'],
        hint: 'APPROVED_AMOUNT: loan amounts and overdraft limits. OUTSTANDING_AMOUNT: what is owed.' },
      opt({ label: 'Notes', name: 'notes', type: 'textarea', rows: 2 })], `New credit arrangement for ${m.member_no}`);
    if (!d) return;
    const res = await api('POST', '/api/creditarrangements', { holderKey: m.id, holderType: isGroup ? 'GROUP' : 'CLIENT', amount: Number(d.amount),
      startDate: d.startDate || undefined, expireDate: d.expireDate, exposureLimitType: d.exposureLimitType, notes: d.notes || undefined });
    toast(res.ok ? `Created ${res.body.id} (${res.body.state.replace(/_/g, ' ').toLowerCase()})` : res.error, !res.ok);
    if (res.ok) reload();
  });
  on('#sol-open', async () => {
    const lp = await api('GET', '/api/loan-products');
    const products = (lp.body || []).filter((p) => (p.availableFor || []).includes('SOLIDARITY_GROUPS'));
    if (!products.length) return toast('No loan product is available for solidarity groups', true);
    const members = m.groupMembers || [];
    const d = await ask([{ label: 'Product', name: 'productId', options: products.map((p) => p.id) },
      opt({ label: 'Installments (blank: the product default)', name: 'termMonths', type: 'number' }),
      ...members.map((x) => opt({ label: `Amount for ${x.first_name} ${x.last_name} (${x.member_no}); blank: none`, name: `amt_${x.member_id}`, type: 'number', step: '0.01' }))],
    `Solidarity loans for ${m.member_no}`);
    if (!d) return;
    const lines = members.filter((x) => d[`amt_${x.member_id}`]).map((x) => ({ memberId: x.member_id, principal: Number(d[`amt_${x.member_id}`]) }));
    if (!lines.length) return toast('Give at least one member an amount', true);
    const res = await api('POST', `/api/groups/${m.id}/solidarity-loans`, { productId: d.productId, termMonths: d.termMonths ? Number(d.termMonths) : undefined, members: lines });
    toast(res.ok ? `Opened ${lines.length} loan(s)` : res.error, !res.ok);
    if (res.ok) reload();
  });
  on('#gm-add', async () => {
    const d = await ask([{ label: 'Member number', name: 'memberId' },
      opt({ label: 'Role names (IDs, comma separated)', name: 'roles', hint: (roleNames.body || []).map((r) => `${r.id}: ${r.name}`).join('; ') || 'No role names are set up' })], `Add a member to ${m.member_no}`);
    if (!d) return;
    const res = await api('POST', `/api/groups/${m.id}/members`, { memberId: d.memberId, roles: String(d.roles || '').split(',').map((x) => x.trim()).filter(Boolean) });
    toast(res.ok ? `Added${res.body.groupWarnings?.length ? ` (${res.body.groupWarnings.join('; ')})` : ''}` : res.error, !res.ok);
    if (res.ok) reload();
  });
  view().querySelectorAll('[data-gm-drop]').forEach((b) => b.addEventListener('click', async () => {
    const res = await api('DELETE', `/api/groups/${m.id}/members/${b.dataset.gmDrop}`);
    toast(res.ok ? 'Removed from the group' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  view().querySelectorAll('[data-id-files]').forEach((b) => b.addEventListener('click', () => idFiles(m, b.dataset.idFiles, reload)));
  for (const kind of ['picture', 'signature']) {
    const img = $(`#media-${kind}`);
    if (img) blobUrl(`/api/members/${m.id}/${kind}`).then((u) => { if (u) img.src = u; });
  }
  view().querySelectorAll('[data-media-up]').forEach((b) => b.addEventListener('click', async () => {
    const d = await ask([{ label: 'Image (PNG, JPEG or GIF)', name: 'file', type: 'file' }], `Upload ${b.dataset.mediaUp}`);
    if (!d || !d.file || !d.file.size) return;
    const res = await apiRaw('PUT', `/api/members/${m.id}/${b.dataset.mediaUp}?fileName=${encodeURIComponent(d.file.name)}`, d.file, d.file.type);
    toast(res.ok ? 'Uploaded' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  view().querySelectorAll('[data-media-drop]').forEach((b) => b.addEventListener('click', async () => {
    const res = await api('DELETE', `/api/members/${m.id}/${b.dataset.mediaDrop}`);
    toast(res.ok ? 'Removed' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  view().querySelectorAll('[data-id-drop]').forEach((b) => b.addEventListener('click', async () => {
    const res = await api('DELETE', `/api/members/${m.id}/identifications/${b.dataset.idDrop}`);
    toast(res.ok ? 'Document removed' : res.error, !res.ok);
    if (res.ok) reload();
  }));
  on('#id-add', async () => {
    const t = await api('GET', '/api/id-templates');
    const opts = (t.body?.templates || []).map((x) => x.id);
    if (t.body?.allowOther) opts.push('OTHER');
    if (!opts.length) return toast('No ID templates are set up', true);
    const d = await ask([
      { label: 'Template', name: 'templateId', options: opts, hint: (t.body?.templates || []).map((x) => `${x.id}: ${x.id_type} ${x.mask}`).join('; ') },
      { label: 'Document number', name: 'documentId' }, opt({ label: 'Valid until', name: 'validUntil', type: 'date' }),
      opt({ label: 'ID type (Other documents)', name: 'idType' }), opt({ label: 'Issuing authority (Other documents)', name: 'issuingAuthority' }),
      opt({ label: 'Attachment (where the template allows it)', name: 'file', type: 'file' }),
    ], 'Add identification document');
    if (!d) return;
    const body = { templateId: d.templateId, documentId: d.documentId, validUntil: d.validUntil || undefined, idType: d.idType || undefined, issuingAuthority: d.issuingAuthority || undefined };
    if (d.file && d.file.size) body.attachment = { name: d.file.name, type: d.file.type, data: await fileBase64(d.file) };
    const res = await api('POST', `/api/members/${m.id}/identifications`, body);
    toast(res.ok ? 'Document added' : res.error, !res.ok);
    if (res.ok) reload();
  });
}

/** A file fetched with the session's headers, as an object URL (for an <img>), or null. */
async function blobUrl(path) {
  const headers = {};
  if (S.tenant) headers['x-tenant'] = S.tenant;
  if (S.access) headers.authorization = `Bearer ${S.access}`;
  const res = await fetch(path, { headers });
  return res.ok ? URL.createObjectURL(await res.blob()) : null;
}

/** The files on an identification document: up to five, each up to 50 MB. */
async function idFiles(m, docId, reload) {
  const r = await api('GET', `/api/members/${m.id}/identifications/${docId}/files`);
  if (!r.ok) return toast(r.error, true);
  const dlg = showDialog('Document files', `${table([
    { label: 'File', key: 'fileName' }, { label: 'Type', key: 'contentType' }, { label: 'Size', num: true, value: (f) => `${Math.ceil(f.sizeBytes / 1024)} KB` },
    { label: '', html: true, value: (f) => `<button class="link" data-f-get="${esc(f.id)}">download</button>${can('DELETE_DOCUMENTS') ? ` <button class="link" data-f-drop="${esc(f.id)}">remove</button>` : ''}` },
  ], r.body, { empty: 'No files' })}
    ${can('CREATE_DOCUMENTS') && r.body.length < 5 ? '<button class="secondary" id="f-add">Add file</button>' : ''}<p class="hint">PNG, JPEG or PDF, up to 50 MB each, five at most.</p>`);
  dlg.querySelectorAll('[data-f-get]').forEach((b) => b.addEventListener('click', () =>
    openFile(`/api/members/${m.id}/identifications/${docId}/files/${b.dataset.fGet}`, 'document', { save: true })));
  dlg.querySelectorAll('[data-f-drop]').forEach((b) => b.addEventListener('click', async () => {
    const res = await api('DELETE', `/api/members/${m.id}/identifications/${docId}/files/${b.dataset.fDrop}`);
    toast(res.ok ? 'File removed' : res.error, !res.ok);
    dlg.close(); dlg.remove();
    if (res.ok) idFiles(m, docId, reload);
  }));
  const add = $('#f-add', dlg);
  if (add) add.addEventListener('click', async () => {
    dlg.close(); dlg.remove();
    const d = await ask([{ label: 'File (PNG, JPEG or PDF)', name: 'file', type: 'file' }], 'Add a file to the document');
    if (!d || !d.file || !d.file.size) return;
    const res = await apiRaw('POST', `/api/members/${m.id}/identifications/${docId}/files?fileName=${encodeURIComponent(d.file.name)}`, d.file, d.file.type || 'application/octet-stream');
    toast(res.ok ? 'File added' : res.error, !res.ok);
    idFiles(m, docId, reload);
  });
}

const CA_ACTIONS = [
  ['APPROVE', 'Approve', ['PENDING_APPROVAL'], 'APPROVE_LINE_OF_CREDIT'], ['REJECT', 'Reject', ['PENDING_APPROVAL'], 'REJECT_LINE_OF_CREDIT'],
  ['WITHDRAW', 'Withdraw', ['PENDING_APPROVAL'], 'WITHDRAW_LINE_OF_CREDIT'], ['UNDO_APPROVE', 'Undo approval', ['APPROVED'], 'UNDO_APPROVE_LINE_OF_CREDIT'],
  ['UNDO_REJECT', 'Undo reject', ['REJECTED'], 'UNDO_REJECT_LINE_OF_CREDIT'], ['UNDO_WITHDRAW', 'Undo withdraw', ['WITHDRAWN'], 'UNDO_WITHDRAW_LINE_OF_CREDIT'],
  ['CLOSE', 'Close', ['APPROVED', 'ACTIVE'], 'CLOSE_LINES_OF_CREDIT'], ['UNDO_CLOSE', 'Reopen', ['CLOSED'], 'CLOSE_LINES_OF_CREDIT'],
];

/** A credit arrangement (the reference platform's line of credit): its limit on both bases, its states and its accounts. */
async function creditArrangementDetail(id, holder = null) {
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
    ${open && can('ADD_ACCOUNTS_TO_LINE_OF_CREDIT') ? '<button class="secondary" id="ca-add">Add an account</button>' : ''}`;
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
async function depositDetail(a, holder = null) {
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
      ${can('DELETE_SAVINGS_ACCOUNT') && !(tx.body || []).length ? '<button class="secondary" id="dep-delete">Delete account</button>' : ''}</div>`)}
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
  ], tx.body || [], { empty: 'No transactions' }))}`;
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
}

/** A branch (the reference platform's branch view): what sits in it, its centres and holidays, and its report templates. */
async function branchDetail(code) {
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
}

// --------------------------------------------------------------------------
// Groups (the reference platform's groups: account holders with individual members in roles)
// --------------------------------------------------------------------------

const groupState = { offset: 0, limit: 25 };

async function groupsView() {
  const r = await api('GET', `/api/groups?offset=${groupState.offset}&limit=${groupState.limit}&paginationDetails=ON`);
  if (!r.ok) throw new Error(r.error);
  view().innerHTML = `
    <div class="toolbar"><h1>Groups</h1>${can('CREATE_GROUP') ? '<button id="g-new">New group</button>' : ''}</div>
    <p class="hint">A group holds loans and deposit accounts of its own; its members are individual members, each with any group role names.
    A group is inactive until it has a running account.</p>
    ${table([
    { label: 'ID', key: 'id' }, { label: 'Name', key: 'groupName' }, { label: 'Type', key: 'groupRoleKey' },
    { label: 'State', html: true, value: (g) => stateBadge(g.state) }, { label: 'Members', num: true, value: (g) => g.groupMembers.length },
  ], r.body, { onRow: true, empty: 'No groups yet' })}
    ${pager(groupState, r.total)}`;
  wireRows(r.body, (g) => memberDetail({ id: g.encodedKey }));
  wirePager(groupState, groupsView);
  const nb = $('#g-new');
  if (nb) nb.addEventListener('click', () => newHolder('GROUP', groupsView));
}

/** Organization: client and group types, group role names and the client controls. */
async function clientsSetup(box) {
  if (!box) return;
  const [types, roles, ctl] = await Promise.all([api('GET', '/api/client-types'), api('GET', '/api/group-role-names'), api('GET', '/api/client-controls')]);
  const setup = can('MANAGE_GENERAL_SETUP');
  const admin = S.user.role === 'TENANT_ADMIN';
  const c = ctl.body || {};
  const yes = (v) => (v ? 'yes' : '');
  box.innerHTML = `
    ${card('Client and group types', `${table([
    { label: 'ID', key: 'id' }, { label: 'Name', key: 'name' }, { label: 'For', value: (t) => (t.holderType === 'GROUP' ? 'groups' : 'members') },
    { label: 'ID pattern', key: 'idPattern' }, { label: 'Opens accounts', value: (t) => yes(t.canOpenAccounts) },
    { label: 'Guarantees', value: (t) => yes(t.canGuarantee) }, { label: 'ID documents', value: (t) => yes(t.requireIdentificationDocuments) },
    { label: 'In use', num: true, key: 'inUse' },
    { label: '', html: true, value: (t) => (setup ? `<button class="link" data-ctype="${esc(t.id)}">edit</button>${t.isDefault || t.inUse ? '' : ` <button class="link" data-ctype-drop="${esc(t.id)}">delete</button>`}` : '') },
  ], types.body || [], { empty: 'No types' })}
    <p class="hint">ID pattern: # a digit (the run of # counts up and widens past its length), @ a letter, $ either.</p>
    ${setup ? '<button class="secondary" id="ctype-add">New type</button>' : ''}`)}
    <div class="grid">
    ${card('Group role names', `${table([{ label: 'ID', key: 'id' }, { label: 'Name', key: 'name' }, { label: 'Held', num: true, key: 'inUse' },
    { label: '', html: true, value: (r) => (setup ? `<button class="link" data-grn="${esc(r.id)}">rename</button>${r.inUse ? '' : ` <button class="link" data-grn-drop="${esc(r.id)}">delete</button>`}` : '') },
  ], roles.body || [], { empty: 'No role names' })}
    ${setup ? '<button class="secondary" id="grn-add">New role name</button>' : ''}`)}
    ${card('Client controls', `<dl class="kv" id="client-controls">
      <dt>New members start</dt><dd>${esc(String(c.initialState || '').replace(/_/g, ' ').toLowerCase())}</dd>
      <dt>Duplicate checks</dt><dd>${esc(Object.entries(c.duplicateChecks || {}).map(([k, v]) => `${k.replace(/_/g, ' ').toLowerCase()}: ${v.toLowerCase()}`).join(', '))}</dd>
      <dt>Required</dt><dd>${esc((c.requiredAssignments || []).map((x) => x.replace(/_/g, ' ').toLowerCase()).join(', ') || 'nothing')}</dd>
      <dt>In more than one group</dt><dd>${c.multipleGroups ? 'allowed' : 'not allowed'}</dd>
      <dt>Group size limit</dt><dd>${c.groupSizeLimitType === 'NONE' ? 'none' : `${esc(c.groupSizeLimit)} (${esc(String(c.groupSizeLimitType).toLowerCase())})`}</dd>
      <dt>Anonymize after exit</dt><dd>${c.anonymizeAfterDays === null || c.anonymizeAfterDays === undefined ? 'not set (anonymizing is off)' : `${esc(c.anonymizeAfterDays)} days`}</dd>
      <dt>New credit arrangements start</dt><dd>${esc(String(c.creditArrangementInitialState || 'PENDING_APPROVAL').replace(/_/g, ' ').toLowerCase())}</dd></dl>
      ${admin ? '<button class="secondary" id="cc-edit">Edit</button>' : ''}`)}
  </div>`;
  const done = (res, msg) => { toast(res.ok ? msg : res.error, !res.ok); if (res.ok) clientsSetup(box); };
  const bool = (v) => v === 'true';
  const typeForm = (t = {}) => ask([
    ...(t.id ? [] : [{ label: 'For', name: 'holderType', options: ['CLIENT', 'GROUP'] }, opt({ label: 'ID (blank: generated)', name: 'id' })]),
    { label: 'Name', name: 'name', value: t.name || '' }, opt({ label: 'Description', name: 'description', value: t.description || '' }),
    opt({ label: 'ID pattern', name: 'idPattern', value: t.idPattern || '', hint: 'e.g. M######; blank: the default' }),
    { label: 'May open accounts', name: 'canOpenAccounts', options: ['true', 'false'], value: String(t.canOpenAccounts ?? true) },
    { label: 'May guarantee', name: 'canGuarantee', options: ['true', 'false'], value: String(t.canGuarantee ?? true) },
    { label: 'Must bring the mandatory ID documents (members)', name: 'requireIdentificationDocuments', options: ['true', 'false'], value: String(t.requireIdentificationDocuments ?? true) },
    { label: 'Show the address fields', name: 'useDefaultAddress', options: ['true', 'false'], value: String(t.useDefaultAddress ?? true) },
  ], t.id ? `Type ${t.id}` : 'New type');
  const typeBody = (d) => ({ ...d, id: d.id || undefined, idPattern: d.idPattern || null, description: d.description || null, canOpenAccounts: bool(d.canOpenAccounts),
    canGuarantee: bool(d.canGuarantee), requireIdentificationDocuments: bool(d.requireIdentificationDocuments), useDefaultAddress: bool(d.useDefaultAddress) });
  const on = (sel, fn) => { const b = $(sel, box); if (b) b.addEventListener('click', fn); };
  const each = (attr, fn) => box.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', () => fn(b.getAttribute(`data-${attr}`))));
  on('#ctype-add', async () => { const d = await typeForm(); if (d) done(await api('POST', '/api/client-types', typeBody(d)), 'Type created'); });
  each('ctype', async (id) => { const d = await typeForm((types.body || []).find((t) => t.id === id)); if (d) done(await api('PATCH', `/api/client-types/${id}`, typeBody(d)), 'Type saved'); });
  each('ctype-drop', async (id) => done(await api('DELETE', `/api/client-types/${id}`), 'Type deleted'));
  on('#grn-add', async () => { const d = await ask([{ label: 'Name', name: 'name' }, opt({ label: 'ID (blank: generated)', name: 'id' })], 'New group role name'); if (d) done(await api('POST', '/api/group-role-names', { name: d.name, id: d.id || undefined }), 'Role name created'); });
  each('grn', async (id) => { const d = await ask([{ label: 'Name', name: 'name', value: (roles.body || []).find((r) => r.id === id)?.name }], `Role name ${id}`); if (d) done(await api('PATCH', `/api/group-role-names/${id}`, d), 'Saved'); });
  each('grn-drop', async (id) => done(await api('DELETE', `/api/group-role-names/${id}`), 'Role name deleted'));
  on('#cc-edit', async () => {
    const lv = ['NONE', 'WARNING', 'ERROR'];
    const dc = c.duplicateChecks || {};
    const d = await ask([
      { label: 'New members start', name: 'initialState', options: ['INACTIVE', 'PENDING_APPROVAL'], value: c.initialState },
      { label: 'Duplicate document number', name: 'DOCUMENT_ID', options: lv, value: dc.DOCUMENT_ID },
      { label: 'Duplicate name and birth date', name: 'NAME_AND_BIRTH_DATE', options: lv, value: dc.NAME_AND_BIRTH_DATE },
      { label: 'Duplicate phone', name: 'PHONE', options: lv, value: dc.PHONE }, { label: 'Duplicate email', name: 'EMAIL', options: lv, value: dc.EMAIL },
      opt({ label: 'Required (comma separated: BRANCH, CENTRE, CREDIT_OFFICER)', name: 'requiredAssignments', value: (c.requiredAssignments || []).join(', ') }),
      { label: 'Members may be in more than one group', name: 'multipleGroups', options: ['true', 'false'], value: String(c.multipleGroups) },
      { label: 'Group size limit', name: 'groupSizeLimitType', options: ['NONE', 'WARNING', 'HARD'], value: c.groupSizeLimitType },
      opt({ label: 'Most members in a group', name: 'groupSizeLimit', type: 'number', value: c.groupSizeLimit ?? '' }),
      opt({ label: 'Days after exit before anonymizing (blank: not set)', name: 'anonymizeAfterDays', type: 'number', value: c.anonymizeAfterDays ?? '' }),
      { label: 'New credit arrangements start', name: 'creditArrangementInitialState', options: ['PENDING_APPROVAL', 'APPROVED'], value: c.creditArrangementInitialState || 'PENDING_APPROVAL' },
    ], 'Client controls');
    if (!d) return;
    done(await api('PATCH', '/api/client-controls', {
      initialState: d.initialState, duplicateChecks: { DOCUMENT_ID: d.DOCUMENT_ID, NAME_AND_BIRTH_DATE: d.NAME_AND_BIRTH_DATE, PHONE: d.PHONE, EMAIL: d.EMAIL },
      requiredAssignments: String(d.requiredAssignments || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
      multipleGroups: bool(d.multipleGroups), groupSizeLimitType: d.groupSizeLimitType,
      groupSizeLimit: d.groupSizeLimit === '' ? null : Number(d.groupSizeLimit),
      anonymizeAfterDays: d.anonymizeAfterDays === '' ? null : Number(d.anonymizeAfterDays),
      creditArrangementInitialState: d.creditArrangementInitialState,
    }), 'Client controls saved');
  });
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

// --------------------------------------------------------------------------
// Bulk repayment collection
// --------------------------------------------------------------------------

const collectState = { view: 'REPAYMENTS', from: '', to: '', asOf: '', productId: '', branchId: '' };

async function collectionsView(result = null) {
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

async function loanDetail(row) {
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
    ${loanCf.ok ? customFieldsCard(loanCf.body) : ''}`;

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

// --------------------------------------------------------------------------
// Teller
// --------------------------------------------------------------------------

async function tellerView() {
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

// --------------------------------------------------------------------------
// Reports
// --------------------------------------------------------------------------

const reportState = { which: 'trial-balance', from: '', to: '', asAt: '', branch: '', groupBy: '', interval: 'MONTHLY', zero: false, offset: 0, limit: 50 };
let branchList = null;

// Which filters each report takes, and the export it offers.
const REPORTS = [
  ['trial-balance', 'Trial balance', { dates: true, branch: true, exp: '/api/accounting/trial-balance' }],
  ['balance-sheet', 'Balance sheet', { dates: true, branch: true, exp: '/api/reports/balance-sheet' }],
  ['income-statement', 'Income statement', { dates: true, branch: true, exp: '/api/reports/income-statement' }],
  ['portfolio-at-risk', 'Portfolio at risk', { asAt: true, branch: true, exp: '/api/reports/portfolio-at-risk' }],
  ['par-loans', 'Loans at risk', { asAt: true, branch: true, exp: '/api/reports/portfolio-at-risk/loans' }],
  ['risk', 'Risk', { asAt: true, branch: true, group: ['BRANCH', 'CREDIT_OFFICER', 'CENTRE', 'PRODUCT'], exp: '/api/reports/risk' }],
  ['indicators', 'Indicators', { branch: true, exp: '/api/reports/indicators' }],
  ['portfolio', 'Portfolio', { dates: true, branch: true, interval: true, exp: '/api/reports/portfolio' }],
  ['organization', 'Organization', { exp: '/api/reports/organization' }],
  ['earnings', 'Earnings', { dates: true, branch: true, group: ['PRODUCT', 'BRANCH'], exp: '/api/reports/earnings' }],
  ['cashflow', 'Cashflow', { dates: true, branch: true, exp: '/api/reports/cashflow' }],
  ['outreach', 'Outreach', { dates: true, exp: '/api/reports/outreach' }],
  ['write-offs', 'Written-off loans', { dates: true }],
  ['prudential', 'Prudential ratios', { asAt: true }],
  ['templates', 'Other reports (templates)', {}],
];
const reportDef = (w) => (REPORTS.find(([v]) => v === w) || REPORTS[0])[2];
const ACCOUNTING_REPORTS = ['trial-balance', 'balance-sheet', 'income-statement', 'prudential'];
const reportAllowed = ([v]) => (ACCOUNTING_REPORTS.includes(v) ? can('VIEW_ACCOUNTING_REPORTS') : v === 'indicators' ? can('VIEW_INTELLIGENCE') : can('VIEW_REPORTS'));

async function reportsView() {
  const R = reportState;
  if (!branchList) {
    const b = await api('GET', '/api/branches');
    branchList = b.ok ? b.body : [];
  }
  const shown = REPORTS.filter(reportAllowed);
  if (!shown.length) { view().innerHTML = '<p class="hint">Your role has no reports.</p>'; return; }
  if (!shown.some(([v]) => v === R.which)) R.which = shown[0][0];
  const d = reportDef(R.which);
  view().innerHTML = `
    <div class="toolbar">
      <label>Report<select id="r-which">
        ${shown.map(([v, label]) => `<option value="${v}" ${R.which === v ? 'selected' : ''}>${label}</option>`).join('')}
      </select></label>
      ${d.dates ? `<label>From<input id="r-from" type="date" value="${R.from}"></label>` : ''}
      ${d.dates || d.asAt ? `<label>${d.asAt ? 'As at' : 'To'}<input id="r-to" type="date" value="${R.to}"></label>` : ''}
      ${d.branch ? `<label>Branch<select id="r-branch"><option value="">All branches</option>
        ${branchList.map((b) => `<option value="${esc(b.code)}" ${R.branch === b.code ? 'selected' : ''}>${esc(b.code)} ${esc(b.name)}</option>`).join('')}</select></label>` : ''}
      ${d.group ? `<label>By<select id="r-group">${d.group.map((g) => `<option ${R.groupBy === g ? 'selected' : ''}>${g}</option>`).join('')}</select></label>` : ''}
      ${d.interval ? `<label>Interval<select id="r-interval">${['DAILY', 'WEEKLY', 'MONTHLY'].map((g) => `<option ${R.interval === g ? 'selected' : ''}>${g}</option>`).join('')}</select></label>` : ''}
      ${R.which === 'trial-balance' ? `<label class="check"><input id="r-zero" type="checkbox" ${R.zero ? 'checked' : ''}> Zero balance accounts</label>` : ''}
      <button id="r-run">Run</button>
      ${d.exp ? '<button class="secondary" id="r-csv">CSV</button><button class="secondary" id="r-xlsx">Excel</button>' : ''}
    </div>
    <div id="r-out"><p class="hint">Loading…</p></div>`;

  $('#r-which').addEventListener('change', (e) => { R.which = e.target.value; R.offset = 0; R.groupBy = ''; reportsView(); });
  if ($('#r-from')) $('#r-from').addEventListener('change', (e) => { R.from = e.target.value; });
  if ($('#r-to')) $('#r-to').addEventListener('change', (e) => { R.to = e.target.value; });
  if ($('#r-branch')) $('#r-branch').addEventListener('change', (e) => { R.branch = e.target.value; });
  if ($('#r-group')) $('#r-group').addEventListener('change', (e) => { R.groupBy = e.target.value; });
  if ($('#r-interval')) $('#r-interval').addEventListener('change', (e) => { R.interval = e.target.value; });
  if ($('#r-zero')) $('#r-zero').addEventListener('change', (e) => { R.zero = e.target.checked; });
  $('#r-run').addEventListener('click', () => { R.offset = 0; runReport(); });
  const download = (fmt) => {
    const qs = reportQuery();
    qs.set('format', fmt);
    openFile(`${d.exp}?${qs}`, `${R.which}.${fmt}`, { save: true });
  };
  if ($('#r-csv')) $('#r-csv').addEventListener('click', () => download('csv'));
  if ($('#r-xlsx')) $('#r-xlsx').addEventListener('click', () => download('xlsx'));
  runReport();
}

function reportQuery() {
  const R = reportState;
  const d = reportDef(R.which);
  const qs = new URLSearchParams();
  if (d.dates && R.from) qs.set('from', R.from);
  if (R.to) { qs.set('to', R.to); qs.set('asAt', R.to); }
  if (d.branch && R.branch) {
    if (R.which === 'indicators') { qs.set('entityType', 'BRANCH'); qs.set('entityId', R.branch); } else qs.set('branchId', R.branch);
  }
  if (d.group) qs.set('groupBy', R.groupBy || d.group[0]);
  if (d.interval) qs.set('interval', R.interval);
  if (R.which === 'trial-balance' && R.zero) qs.set('zeroBalances', 'true');
  return qs;
}

const pctText = (n) => (n === null || n === undefined ? '' : `${Number(n).toFixed(2)}%`);
const sourceNote = (p) => (p.source === 'SNAPSHOT' ? `<p class="hint">From the end of day's positions for ${esc(p.asAt)}.</p>` : '');

async function runReport() {
  const R = reportState;
  const out = el('r-out');
  const qs = reportQuery();
  const fail = (r) => void (out.innerHTML = `<p class="error">${esc(r.error)}</p>`);

  if (R.which === 'templates') return templatesReport(out);
  if (R.which === 'trial-balance') {
    qs.set('offset', R.offset); qs.set('limit', R.limit);
    const r = await api('GET', `/api/accounting/trial-balance?${qs}`);
    if (!r.ok) return fail(r);
    const t = r.body;
    out.innerHTML = table([
      { label: 'Code', key: 'code' }, { label: 'Account', key: 'name' },
      { label: 'Opening', num: true, value: (x) => money(x.openingBalance) },
      { label: 'Debit', num: true, value: (x) => money(x.debit) },
      { label: 'Credit', num: true, value: (x) => money(x.credit) },
      { label: 'Net change', num: true, value: (x) => money(x.netChange) },
      { label: 'Closing', num: true, value: (x) => money(x.closingBalance) },
    ], t.rows) + `<table><tbody><tr class="total">
        <td>Total (whole book, not this page)</td>
        <td class="num">${money(t.totals.debit)}</td><td class="num">${money(t.totals.credit)}</td>
      </tr></tbody></table>`
      + (t.balanced ? '' : '<p class="error">The trial balance does not balance.</p>')
      + '<p class="hint">Assets and expenses read debit minus credit; liabilities, equity and income credit minus debit.</p>'
      + pager({ offset: t.page.offset, limit: t.page.limit || R.limit }, t.page.total);
    wirePager(R, runReport);
    return;
  }

  if (R.which === 'balance-sheet') {
    const r = await api('GET', `/api/reports/balance-sheet?${qs}`);
    if (!r.ok) return fail(r);
    const b = r.body;
    const block = (title, rows, total) => card(title, table([
      { label: 'Code', value: (x) => x.code || '' }, { label: 'Account', key: 'name' },
      { label: 'Amount', num: true, value: (x) => money(x.amount) },
    ], rows) + `<p class="num"><strong>${money(total)}</strong></p>`);
    out.innerHTML = `<p class="hint">As at ${esc(b.asAt)}${b.branch ? `, branch ${esc(b.branch.code)}` : ''}.</p><div class="grid">
      ${block('Assets', b.assets, b.totalAssets)}
      ${block('Liabilities', b.liabilities, b.totalLiabilities)}
      ${block('Equity', b.equity, b.totalEquity)}
    </div>${b.balances ? '' : `<p class="error">Out by ${money(b.difference)}</p>`}`;
    return;
  }

  if (R.which === 'income-statement') {
    const r = await api('GET', `/api/reports/income-statement?${qs}`);
    if (!r.ok) return fail(r);
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
    if (!r.ok) return fail(r);
    const p = r.body;
    out.innerHTML = sourceNote(p) + `<div class="grid">
      ${card('Buckets', table([
    { label: 'Bucket', key: 'bucket' }, { label: 'Loans', num: true, key: 'loans' },
    { label: 'Outstanding', num: true, value: (x) => money(x.outstanding) },
  ], p.buckets))}
      ${card('PAR', table([{ label: 'Measure', key: 'k' }, { label: 'Loans', num: true, key: 'loans' },
    { label: 'Outstanding', num: true, value: (x) => money(x.outstanding) }, { label: 'Of portfolio', num: true, value: (x) => pctText(x.percent) }],
  Object.entries(p.par).map(([k, x]) => ({ k, ...x }))))}
      ${card('VAR', table([{ label: 'Measure', key: 'k' }, { label: 'Loans', num: true, key: 'loans' },
    { label: 'Overdue', num: true, value: (x) => money(x.overdue) }, { label: 'Of portfolio', num: true, value: (x) => pctText(x.percent) }],
  Object.entries(p.var).map(([k, x]) => ({ k, ...x }))))}
    </div><p class="hint">PAR ${p.parPercent}% of ${money(p.totalOutstanding)} outstanding. Interest in suspense ${money(p.interestInSuspense)}.</p>`;
    return;
  }

  if (R.which === 'par-loans') {
    qs.set('offset', R.offset); qs.set('limit', R.limit);
    const r = await api('GET', `/api/reports/portfolio-at-risk/loans?${qs}`);
    if (!r.ok) return fail(r);
    const p = r.body;
    out.innerHTML = table([
      { label: 'Loan', key: 'account_no' },
      { label: 'Member', value: (x) => `${x.first_name} ${x.last_name}` },
      { label: 'Branch', key: 'branch_code' },
      { label: 'Officer', key: 'credit_officer' },
      { label: 'Bucket', key: 'bucket' },
      { label: 'Days late', num: true, key: 'days_late' },
      { label: 'Outstanding', num: true, value: (x) => money(x.outstanding) },
      { label: 'Overdue', num: true, value: (x) => money(x.principal_overdue) },
    ], p.items || []) + pager(R, p.total || 0);
    wirePager(R, runReport);
    return;
  }

  if (R.which === 'risk') {
    const r = await api('GET', `/api/reports/risk?${qs}`);
    if (!r.ok) return fail(r);
    const k = r.body;
    out.innerHTML = sourceNote(k) + table([
      { label: k.groupBy, key: 'label' }, { label: 'Loans', num: true, key: 'loans' },
      { label: 'Outstanding', num: true, value: (x) => money(x.principalOutstanding) },
      { label: 'Overdue', num: true, value: (x) => money(x.principalOverdue) },
      { label: 'Of portfolio', num: true, value: (x) => pctText(x.percentOfPortfolio) },
      { label: 'Provision', num: true, value: (x) => (x.provisionRequired === null ? 'rate not set' : money(x.provisionRequired)) },
    ], k.groups, { empty: 'No loans in arrears' }) + card('By risk level', table([
      { label: 'Level', key: 'label' }, { label: 'Days', value: (x) => `${x.daysFrom}–${x.daysTo ?? ''}` },
      { label: 'Rate', num: true, value: (x) => (x.ratePercent === null ? 'not set' : pctText(x.ratePercent)) },
      { label: 'Loans', num: true, key: 'loans' },
      { label: 'Outstanding', num: true, value: (x) => money(x.principalOutstanding) },
      { label: 'Provision', num: true, value: (x) => (x.provisionRequired === null ? '' : money(x.provisionRequired)) },
    ], k.bands)) + (k.ratesUnset.length ? `<p class="notice">Provision rates not set: ${esc(k.ratesUnset.join(', '))}. Enter them under Period and provisions.</p>` : '');
    return;
  }

  if (R.which === 'indicators') {
    const r = await api('GET', `/api/reports/indicators?${qs}`);
    if (!r.ok) return fail(r);
    out.innerHTML = indicatorCards(r.body.indicators);
    return;
  }

  if (R.which === 'portfolio') {
    const r = await api('GET', `/api/reports/portfolio?${qs}`);
    if (!r.ok) return fail(r);
    const p = r.body;
    out.innerHTML = card('Overview', `<dl class="kv">
        <dt>Gross loan portfolio</dt><dd>${money(p.overview.grossLoanPortfolio)}</dd>
        <dt>Loans outstanding</dt><dd>${p.overview.loansOutstanding ?? ''}</dd>
        <dt>PAR over 30</dt><dd>${pctText(p.overview.parOver30)}</dd>
        <dt>Disbursed in the period</dt><dd>${money(p.overview.disbursedInPeriod)} (${p.overview.loansDisbursedInPeriod} loans)</dd>
        <dt>Deposits now</dt><dd>${money(p.overview.depositBalanceNow)}</dd></dl>`)
      + table([
        { label: 'From', key: 'from' }, { label: 'To', key: 'to' }, { label: 'Created', num: true, key: 'created' },
        { label: 'Disbursed', num: true, value: (x) => money(x.disbursed.amount) },
        { label: 'Written off', num: true, value: (x) => money(x.writtenOff.amount) },
        { label: 'Repaid', num: true, key: 'repaid' },
        { label: 'Portfolio', num: true, value: (x, i) => money(x.h.grossLoanPortfolio) },
        { label: 'PAR>30', num: true, value: (x) => (x.h.portfolioRisk ? pctText(x.h.portfolioRisk.parOver30) : 'no positions') },
        { label: 'Assets', num: true, value: (x) => money(x.h.capitalStructure.assets) },
      ], p.accounts.map((a, i) => ({ ...a, h: p.historical[i] })));
    return;
  }

  if (R.which === 'organization') {
    const r = await api('GET', '/api/reports/organization');
    if (!r.ok) return fail(r);
    const o = r.body;
    const cols = [{ label: 'Members', num: true, key: 'members' }, { label: 'Borrowers', num: true, key: 'borrowers' },
      { label: 'Loans', num: true, key: 'loans' }, { label: 'Portfolio', num: true, value: (x) => money(x.grossLoanPortfolio) },
      { label: 'PAR>30', num: true, value: (x) => pctText(x.parOver30) }];
    out.innerHTML = card('Branches', table([{ label: 'Branch', value: (x) => `${x.code} ${x.name}` }, ...cols,
      { label: 'Centres', num: true, key: 'centres' }, { label: 'Deposits', num: true, value: (x) => money(x.deposits) }], o.branches))
      + card('Credit officers', table([{ label: 'Officer', value: (x) => x.name || x.email }, ...cols], o.creditOfficers, { empty: 'No credit officers assigned' }));
    return;
  }

  if (R.which === 'earnings') {
    const r = await api('GET', `/api/reports/earnings?${qs}`);
    if (!r.ok) return fail(r);
    const e = r.body;
    out.innerHTML = table([
      { label: e.groupBy, key: 'label' }, { label: 'Revenue', num: true, value: (x) => money(x.totalRevenue) },
      { label: 'Expenses', num: true, value: (x) => money(x.totalExpenses) }, { label: 'Net', num: true, value: (x) => money(x.net) },
    ], e.groups, { empty: 'No income or expense in the period' }) + `<p class="hint">Total ${money(e.net)}, the income statement's surplus for the period.</p>`;
    return;
  }

  if (R.which === 'cashflow') {
    const r = await api('GET', `/api/reports/cashflow?${qs}`);
    if (!r.ok) return fail(r);
    const f = r.body;
    const b = f.balanceChanges;
    out.innerHTML = `<div class="grid">
      ${card('Income', table([{ label: 'Line', key: 'label' }, { label: 'Amount', num: true, value: (x) => money(x.amount) }], f.income) + `<p class="num"><strong>${money(f.totalIncome)}</strong></p>`)}
      ${card('Expenses', table([{ label: 'Line', key: 'label' }, { label: 'Amount', num: true, value: (x) => money(x.amount) }], f.expenses) + `<p class="num"><strong>${money(f.totalExpenses)}</strong></p>`)}
      ${card('Balance changes', `<dl class="kv">
        <dt>Principal disbursed</dt><dd>${money(b.principalDisbursed)}</dd><dt>Principal collected</dt><dd>${money(b.principalCollected)}</dd>
        <dt>Principal written off</dt><dd>${money(b.principalWrittenOff)}</dd><dt>Change in portfolio</dt><dd><strong>${money(b.changeInPortfolio)}</strong></dd>
        <dt>Deposits</dt><dd>${money(b.deposits)}</dd><dt>Withdrawals</dt><dd>${money(b.withdrawals)}</dd>
        <dt>Change in deposits</dt><dd><strong>${money(b.changeInDeposits)}</strong></dd></dl>`)}
    </div><p class="hint">In ${esc(f.currency)}, the base currency.</p>`;
    return;
  }

  if (R.which === 'outreach') {
    const r = await api('GET', `/api/reports/outreach?${qs}`);
    if (!r.ok) return fail(r);
    const o = r.body;
    out.innerHTML = card('Outreach', `<dl class="kv">
        <dt>Clients</dt><dd>${o.clients} (${o.activeClients} active)</dd><dt>Female clients</dt><dd>${pctText(o.femaleClientsPercent)}</dd>
        <dt>Borrowers</dt><dd>${o.borrowers}</dd><dt>Female borrowers</dt><dd>${pctText(o.femaleBorrowersPercent)}</dd>
        <dt>Savers</dt><dd>${o.savers}</dd><dt>Joined / exited in the period</dt><dd>${o.joinedInPeriod} / ${o.exitedInPeriod}</dd></dl>`)
      + table([{ label: 'Branch', value: (x) => `${x.branch} ${x.branchName}` }, { label: 'Clients', num: true, key: 'clients' },
        { label: 'Borrowers', num: true, key: 'borrowers' }, { label: 'Female borrowers', num: true, value: (x) => pctText(x.femaleBorrowersPercent) },
        { label: 'Savers', num: true, key: 'savers' }], o.byBranch);
    return;
  }

  if (R.which === 'write-offs') {
    qs.set('offset', R.offset); qs.set('limit', R.limit);
    const r = await api('GET', `/api/loans/write-offs?${qs}`);
    if (!r.ok) return fail(r);
    const w = r.body;
    const t = w.totals;
    out.innerHTML = table([
      { label: 'Loan', key: 'account_no' },
      { label: 'Member', value: (x) => `${x.first_name} ${x.last_name}` },
      { label: 'Written off', value: (x) => day(x.written_off_on) },
      { label: 'Amount', num: true, value: (x) => money(x.written_off_amount) },
      { label: 'From allowance', num: true, value: (x) => money(x.allowance_used) },
      { label: 'Recovered', num: true, value: (x) => money(x.recovered) },
      { label: 'Still owed', num: true, value: (x) => money(x.outstanding) },
      { label: 'Asked by', value: (x) => x.requested_by || '' },
      { label: 'Approved by', value: (x) => x.approved_by || x.written_off_by || '' },
      { label: 'Reason', value: (x) => x.reason || '' },
    ], w.items || [], { empty: 'No loans written off in this period' }) + pager(R, w.total || 0)
      + card('Totals for the period', `<dl class="kv" id="wo-totals">
        <dt>Loans</dt><dd>${t.loans}</dd>
        <dt>Written off</dt><dd>${money(t.written_off)}</dd>
        <dt>of which principal / interest / fees / penalties</dt><dd>${money(t.principal)} / ${money(t.interest)} / ${money(t.fees)} / ${money(t.penalty)}</dd>
        <dt>Taken from the allowance</dt><dd>${money(t.allowance_used)}</dd>
        <dt>Recovered on these loans</dt><dd>${money(t.recovered)}</dd>
        <dt>Still owed</dt><dd>${money(t.outstanding)}</dd>
        <dt>Recoveries received in the period (any write-off date)</dt><dd>${money(w.recoveriesInPeriod.amount)}</dd></dl>`);
    wirePager(R, runReport);
    return;
  }

  const r = await api('GET', `/api/reports/prudential?${qs}`);
  if (!r.ok) return fail(r);
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

/** Indicators as cards by group. */
function indicatorCards(list) {
  const show = (x) => (x.value === null ? '<span class="hint">n/a</span>'
    : x.kind === 'PERCENT' ? pctText(x.value) : x.kind === 'AMOUNT' ? money(x.value) : esc(x.value));
  const groups = [...new Set(list.map((x) => x.group))];
  return `<div class="grid">${groups.map((g) => card(g.charAt(0) + g.slice(1).toLowerCase(), `<dl class="kv">${list.filter((x) => x.group === g)
    .map((x) => `<dt>${esc(x.label)}</dt><dd data-indicator="${esc(x.code)}">${show(x)}</dd>`).join('')}</dl>`)).join('')}</div>`;
}

// --------------------------------------------------------------------------
// Dashboard (the reference platform's dashboard widgets)
// --------------------------------------------------------------------------

const DASHBOARD_INDICATORS = ['ACTIVE_CLIENTS', 'ACTIVE_BORROWERS', 'GROSS_LOAN_PORTFOLIO', 'DEPOSIT_BALANCE', 'PAR_OVER_30',
  'LOANS_IN_ARREARS', 'LOANS_PENDING_APPROVAL', 'DISBURSED_THIS_MONTH'];

async function dashboardView() {
  const reader = can('VIEW_INTELLIGENCE');
  const activityReader = can('AUDIT_TRANSACTIONS', 'VIEW_REPORTS');
  const inWeek = new Date(Date.parse(`${today()}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
  const [tasks, tills, myTill] = await Promise.all([
    can('VIEW_TASK') ? api('GET', '/api/tasks/mine') : Promise.resolve(null),
    can('OPEN_TILL') ? api('GET', '/api/tills') : Promise.resolve(null),
    can('VIEW_SAVINGS_ACCOUNT_DETAILS', 'VIEW_LOAN_ACCOUNT_DETAILS') ? api('GET', '/api/tills/mine') : Promise.resolve(null),
  ]);
  const own = myTill && myTill.ok && (myTill.body.till || myTill.body.mustUseTill || S.user.role === 'TELLER') ? myTill.body : null;
  const [ind, act, favs, upcoming, mine] = await Promise.all([
    reader ? api('GET', `/api/reports/indicators?indicators=${DASHBOARD_INDICATORS.join(',')}`) : Promise.resolve(null),
    activityReader ? api('GET', '/api/reports/audit-log?limit=10') : Promise.resolve(null),
    api('GET', '/api/views?favourites=true'),
    api('POST', '/api/views/run?limit=10', {
      entity: 'LOANS', columns: ['accountNo', 'memberName', 'nextDueDate', 'nextDueAmount'], sortBy: 'nextDueDate',
      filters: [{ field: 'nextDueDate', operator: 'BETWEEN', value: today(), secondValue: inWeek }, { field: 'status', operator: 'IN', values: ['ACTIVE', 'IN_ARREARS'] }],
    }),
    api('POST', '/api/views/run?limit=10', {
      entity: 'MEMBERS', columns: ['memberNo', 'fullName', 'runningLoans', 'loanBalance'],
      filters: [{ field: 'creditOfficer', operator: 'EQUALS', value: S.user.email }],
    }),
  ]);
  view().innerHTML = `<h1>Dashboard</h1>
    ${ind && ind.ok ? card('Indicators', indicatorCards(ind.body.indicators)) : ''}
    <div class="grid">
      ${tasks && tasks.ok ? card('Your tasks', `<p id="your-tasks-counts"><span class="badge ${tasks.body.overdue ? 'bad' : ''}">${tasks.body.overdue} overdue</span>
        <span class="badge">${tasks.body.today} due today</span> <span class="badge">${tasks.body.upcoming} upcoming</span></p>
        <div id="your-tasks">${table(TASK_COLUMNS(taskButtons).filter((c) => c.label !== 'Assigned to'), tasks.body.tasks.slice(0, 10), { empty: 'No open tasks' })}</div>
        <div class="toolbar">${can('CREATE_TASK') ? '<button class="secondary" id="dash-task-new">New task</button>' : ''}<button class="link" id="dash-tasks">All tasks</button></div>`) : ''}
      ${telleringCard(own)}
      ${tills && tills.ok ? card('Tellers', `<div id="tellers">${table(TILL_COLUMNS().filter((c) => !['Difference', 'Opening'].includes(c.label)), tills.body, { empty: 'No open tills' })}</div>
        <div class="toolbar"><button class="secondary" id="dash-till-open">Open a till</button><button class="link" id="dash-tills">All tills</button></div>`) : ''}
      ${card('Upcoming repayments (next 7 days)', upcoming.ok ? table([
    { label: 'Loan', key: 'accountNo' }, { label: 'Member', key: 'memberName' }, { label: 'Due', key: 'nextDueDate' },
    { label: 'Amount', num: true, value: (x) => money(x.nextDueAmount) }], upcoming.body.items, { empty: 'Nothing due this week' }) : `<p class="error">${esc(upcoming.error)}</p>`)}
      ${card('Your clients', mine.ok ? table([{ label: 'Member', key: 'memberNo' }, { label: 'Name', key: 'fullName' },
    { label: 'Loans', num: true, key: 'runningLoans' }, { label: 'Owed', num: true, value: (x) => money(x.loanBalance) }], mine.body.items, { empty: 'No members assigned to you' }) : '')}
      ${card('Your favourite views', favs.ok && favs.body.length ? `<ul id="fav-views">${favs.body.map((v) => `<li><button class="link" data-open-view="${esc(v.id)}">${esc(v.name)}</button> <span class="hint">${esc(v.entity.toLowerCase())}</span></li>`).join('')}</ul>`
    : '<p class="hint">Mark a view as a favourite under Views and it appears here.</p>')}
      ${act && act.ok ? card('Latest activity', table([{ label: 'When', value: (x) => String(x.created_at).replace('T', ' ').slice(0, 16) },
    { label: 'Who', key: 'actor' }, { label: 'What', key: 'action' }], act.body || [])) : ''}
    </div>`;
  view().querySelectorAll('[data-open-view]').forEach((b) => b.addEventListener('click', () => {
    viewState.open = b.dataset.openView; viewState.offset = 0; go('views');
  }));
  if (tasks && tasks.ok) wireTasks(tasks.body.tasks, dashboardView);
  wireTills([...(tills?.body && tills.ok ? tills.body : []), ...(own?.till ? [own.till] : [])], dashboardView);
  $('#dash-task-new')?.addEventListener('click', async () => { if (await newTask()) dashboardView(); });
  $('#dash-tasks')?.addEventListener('click', () => go('tasks'));
  $('#dash-till-open')?.addEventListener('click', () => openTill(dashboardView));
  $('#dash-tills')?.addEventListener('click', () => go('tills'));
}

// --------------------------------------------------------------------------
// Custom views
// --------------------------------------------------------------------------

const viewState = { open: null, offset: 0, limit: 50, editing: null };

async function viewsView() {
  if (viewState.editing) return viewEditor();
  if (viewState.open) return viewRun();
  const [list, ents] = await Promise.all([api('GET', '/api/views'), api('GET', '/api/views/entities'), loadMenu()]);
  if (!list.ok) throw new Error(list.error);
  const menuCard = await menuItemsCard(ents.body);
  view().innerHTML = `<h1>Views</h1>
    <div class="toolbar"><button id="v-new">New view</button></div>
    ${ents.body.map((e) => {
    const vs = list.body.filter((v) => v.entity === e.entity);
    return card(e.label, table([
      { label: 'Name', html: true, value: (v) => `<button class="link" data-v-open="${esc(v.id)}">${esc(v.name)}</button>` },
      { label: 'Owner', key: 'owner' },
      { label: 'Shared', value: (v) => (v.usageRights.allUsers ? 'all users' : v.usageRights.roles.join(', ')) },
      { label: '', html: true, value: (v) => `<button class="link" data-v-fav="${esc(v.id)}" data-on="${v.favourite ? '' : '1'}">${v.favourite ? 'unfavourite' : 'favourite'}</button>
        <button class="link" data-v-copy="${esc(v.id)}">copy</button>${v.canEdit ? ` <button class="link" data-v-edit="${esc(v.id)}">edit</button> <button class="link" data-v-del="${esc(v.id)}">delete</button>` : ''}` },
    ], vs, { empty: 'No views' }));
  }).join('')}
    ${menuCard}`;
  wireMenuItems(ents.body, viewsView);
  $('#v-new').addEventListener('click', () => { viewState.editing = { entity: ents.body[0].entity }; viewsView(); });
  const on = (attr, fn) => view().querySelectorAll(`[${attr}]`).forEach((b) => b.addEventListener('click', () => fn(b.getAttribute(attr), b)));
  on('data-v-open', (id) => { viewState.open = id; viewState.offset = 0; viewsView(); });
  on('data-v-edit', (id) => { viewState.editing = list.body.find((v) => v.id === id); viewsView(); });
  on('data-v-fav', async (id, b) => { const r = await api(b.dataset.on ? 'PUT' : 'DELETE', `/api/views/${id}/favourite`); toast(r.ok ? 'Saved' : r.error, !r.ok); viewsView(); });
  on('data-v-copy', async (id) => { const r = await api('POST', `/api/views/${id}/copy`, {}); toast(r.ok ? `Copied as ${r.body.name}` : r.error, !r.ok); viewsView(); });
  on('data-v-del', async (id) => {
    if (!window.confirm('Delete this view?')) return;
    const r = await api('DELETE', `/api/views/${id}`); toast(r.ok ? 'Deleted' : r.error, !r.ok); viewsView();
  });
}

async function viewRun() {
  const qs = new URLSearchParams({ offset: viewState.offset, limit: viewState.limit });
  const r = await api('GET', `/api/views/${viewState.open}/run?${qs}`);
  if (!r.ok) { viewState.open = null; toast(r.error, true); return viewsView(); }
  const x = r.body;
  const cols = x.columns.map((c) => ({ label: c.label, num: ['NUMBER', 'MONEY'].includes(c.type), value: (row) => (c.type === 'MONEY' ? money(row[c.key]) : row[c.key]) }));
  const totals = x.totals ? `<table><tbody><tr class="total">${x.columns.map((c, i) => `<td class="${x.totals[c.key] !== undefined ? 'num' : ''}">${x.totals[c.key] !== undefined ? money(x.totals[c.key]) : i === 0 ? 'Total' : ''}</td>`).join('')}</tr></tbody></table>` : '';
  const detail = x.view.display === 'DETAIL';
  view().innerHTML = `<h1>${esc(x.view.name)}</h1>
    <div class="toolbar"><button class="secondary" id="v-back">All views</button>
      <button class="secondary" id="v-toggle">${detail ? 'List' : 'Detail'}</button>
      <button class="secondary" id="v-csv">CSV</button><button class="secondary" id="v-xlsx">Excel</button></div>
    <div id="v-out">${detail
    ? x.items.map((row) => card(String(row[x.columns[0].key] ?? ''), `<dl class="kv">${x.columns.map((c) => `<dt>${esc(c.label)}</dt><dd>${esc(c.type === 'MONEY' ? money(row[c.key]) : row[c.key] ?? '')}</dd>`).join('')}</dl>`)).join('')
    : table(cols, x.items, { empty: 'Nothing matches this view' }) + totals}</div>
    ${pager(viewState, x.total)}`;
  wirePager(viewState, viewsView);
  $('#v-back').addEventListener('click', () => { viewState.open = null; viewsView(); });
  $('#v-toggle').addEventListener('click', () => { x.view.display = detail ? 'LIST' : 'DETAIL'; api('PATCH', `/api/views/${x.view.id}`, { display: x.view.display }).then(() => viewsView()); });
  $('#v-csv').addEventListener('click', () => openFile(`/api/views/${x.view.id}/export?format=csv`, `${x.view.name}.csv`, { save: true }));
  $('#v-xlsx').addEventListener('click', () => openFile(`/api/views/${x.view.id}/export?format=xlsx`, `${x.view.name}.xlsx`, { save: true }));
}

async function viewEditor() {
  const v = viewState.editing;
  const admin = S.user.role === 'TENANT_ADMIN';
  const ents = (await api('GET', '/api/views/entities')).body;
  const meta = (await api('GET', `/api/views/fields/${v.entity}`)).body;
  const codes = admin ? await roleCodes() : [];
  if (!S.menu) await loadMenu();
  const menuItems = (S.menu?.items || []).filter((i) => i.type === v.entity);
  const cols = v.columns || meta.defaultColumns;
  const filters = v.filters || [];
  const fieldOpts = (sel) => meta.fields.map((f) => `<option value="${esc(f.key)}" ${f.key === sel ? 'selected' : ''}>${esc(f.label)}</option>`).join('');
  const filterRow = (x, i) => {
    const f = meta.fields.find((y) => y.key === x.field) || meta.fields[0];
    return `<div class="toolbar" data-filter="${i}">
      <select data-f="field">${fieldOpts(f.key)}</select>
      <select data-f="operator">${f.operators.map((o) => `<option ${o === x.operator ? 'selected' : ''}>${o}</option>`).join('')}</select>
      <input data-f="value" value="${esc(Array.isArray(x.values) ? x.values.join(',') : x.value ?? '')}" placeholder="value">
      <input data-f="secondValue" value="${esc(x.secondValue ?? '')}" placeholder="to (BETWEEN)">
      <button class="link" data-drop-filter="${i}">remove</button></div>`;
  };
  view().innerHTML = `<h1>${v.id ? 'Edit view' : 'New view'}</h1>
    <section class="card"><form id="v-form">
      <label>Records<select name="entity" ${v.id ? 'disabled' : ''}>${ents.map((e) => `<option value="${e.entity}" ${e.entity === v.entity ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}</select></label>
      <label>Name<input name="name" value="${esc(v.name || '')}" required maxlength="255"></label>
      <label>Match<select name="match"><option value="ALL" ${v.match !== 'ANY' ? 'selected' : ''}>All filters</option><option value="ANY" ${v.match === 'ANY' ? 'selected' : ''}>Any filter</option></select></label>
      <h2>Filters</h2><div id="v-filters">${filters.map(filterRow).join('')}</div>
      <button type="button" class="secondary" id="v-add-filter">Add filter</button>
      <h2>Columns</h2><select name="columns" multiple size="10">${meta.fields.map((f) => `<option value="${esc(f.key)}" ${cols.includes(f.key) ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>
      <label>Sort by<select name="sortBy"><option value="">(none)</option>${fieldOpts(v.sortBy)}</select></label>
      <label>Direction<select name="sortDir"><option ${v.sortDir !== 'DESC' ? 'selected' : ''}>ASC</option><option ${v.sortDir === 'DESC' ? 'selected' : ''}>DESC</option></select></label>
      <label class="check"><input type="checkbox" name="includeTotals" ${v.includeTotals ? 'checked' : ''}> Include totals</label>
      <label class="check"><input type="checkbox" name="includeTimestamp" ${v.includeTimestamp ? 'checked' : ''}> Include timestamp</label>
      <label>Menu item<select name="menuItemId"><option value="">(the ${esc(ents.find((e) => e.entity === v.entity)?.label || '')} item)</option>
        ${menuItems.filter((i) => !i.predefined).map((i) => `<option value="${esc(i.id)}" ${i.id === v.menuItemId ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select></label>
      <label>Opens in<select name="display"><option ${v.display !== 'DETAIL' ? 'selected' : ''}>LIST</option><option ${v.display === 'DETAIL' ? 'selected' : ''}>DETAIL</option></select></label>
      ${admin ? `<h2>Usage rights</h2><label class="check"><input type="checkbox" name="allUsers" ${v.usageRights?.allUsers ? 'checked' : ''}> All users</label>
        <select name="roles" multiple size="5">${codes.map((x) => `<option ${(v.usageRights?.roles || []).includes(x) ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>` : ''}
      <div class="toolbar"><button type="submit">Save</button><button type="button" class="secondary" id="v-cancel">Cancel</button></div>
    </form></section>`;
  const form = $('#v-form');
  const readFilters = () => [...view().querySelectorAll('[data-filter]')].map((row) => {
    const g = (k) => row.querySelector(`[data-f=${k}]`).value;
    const op = g('operator');
    return { field: g('field'), operator: op, ...(op === 'IN' ? { values: g('value').split(',').map((s) => s.trim()).filter(Boolean) } : { value: g('value') }), ...(op === 'BETWEEN' ? { secondValue: g('secondValue') } : {}) };
  });
  const keep = () => {
    v.filters = readFilters();
    v.name = form.name.value;
    v.columns = [...form.columns.selectedOptions].map((o) => o.value);
  };
  form.entity.addEventListener('change', (e) => { viewState.editing = { entity: e.target.value, name: form.name.value }; viewsView(); });
  $('#v-add-filter').addEventListener('click', () => { keep(); v.filters.push({ field: meta.fields[0].key, operator: meta.fields[0].operators[0] }); viewsView(); });
  view().querySelectorAll('[data-drop-filter]').forEach((b) => b.addEventListener('click', () => { keep(); v.filters.splice(Number(b.dataset.dropFilter), 1); viewsView(); }));
  view().querySelectorAll('[data-f=field]').forEach((s) => s.addEventListener('change', () => { keep(); viewsView(); }));
  $('#v-cancel').addEventListener('click', () => { viewState.editing = null; viewsView(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      entity: v.entity, name: form.name.value, match: form.match.value, filters: readFilters(),
      columns: [...form.columns.selectedOptions].map((o) => o.value), sortBy: form.sortBy.value || null, sortDir: form.sortDir.value,
      includeTotals: form.includeTotals.checked, includeTimestamp: form.includeTimestamp.checked, display: form.display.value,
      menuItemId: form.menuItemId.value || null,
      ...(admin ? { usageRights: { allUsers: form.allUsers.checked, roles: [...form.roles.selectedOptions].map((o) => o.value) } } : {}),
    };
    const r = v.id ? await api('PATCH', `/api/views/${v.id}`, body) : await api('POST', '/api/views', body);
    if (!r.ok) return toast(r.error, true);
    toast('View saved');
    loadMenu();
    viewState.editing = null; viewState.open = r.body.id; viewState.offset = 0;
    return viewsView();
  });
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

// The product form, in the order the reference platform's form runs: identity, type and
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
  { label: 'Interest type', name: 'interestType', options: ['SIMPLE', 'CAPITALIZED', 'COMPOUND', 'COMPOUND_DAILY_REST'], value: p.interestType || 'SIMPLE' },
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
  { label: 'Leftover principal goes on', name: 'residualInstallment', options: ['LAST', 'FIRST'], value: p.residualInstallment || 'LAST' },
  { label: 'Installment on a non-working day', name: 'nonWorkingDays', options: ['MOVE_FORWARD', 'MOVE_BACKWARD', 'DO_NOT_RESCHEDULE', 'EXTEND_SCHEDULE'], value: p.nonWorkingDays || 'MOVE_FORWARD' },
  { label: 'First due date offset, days', name: 'firstDueOffsetDays', type: 'number', value: p.firstDueOffsetDays ?? 0 },
  { label: 'Grace', name: 'graceType', options: ['NONE', 'PRINCIPAL', 'PURE'], value: p.graceType || 'NONE' },
  { label: 'Grace periods', name: 'gracePeriods', type: 'number', value: p.gracePeriods ?? 0 },
  opt({ label: 'Amortise over (periods, for a balloon)', name: 'amortizationPeriods', type: 'number', value: p.amortizationPeriods ?? '' }),
  { label: 'Rounding of payments', name: 'rounding', options: ['NONE', 'WHOLE', 'WHOLE_UP'], value: p.rounding || 'NONE' },
  { label: 'Processing fee (legacy upfront flat fee)', name: 'processingFee', type: 'number', step: '0.01', value: p.processingFee ?? 0 },
  { label: 'Allow arbitrary fees', name: 'allowArbitraryFees', options: ['false', 'true'], value: String(p.allowArbitraryFees ?? false) },
  { label: 'Times own deposits a member may borrow', name: 'maxMultiplier', type: 'number', step: '0.1', value: p.maxMultiplier ?? 3 },
  { label: 'Enforce that multiplier at approval', name: 'enforceDepositMultiplier', options: ['true', 'false'], value: String(p.enforceDepositMultiplier ?? true) },
  { label: 'Require securities cover (checked at approval and disbursement)', name: 'requireGuarantorCover', options: ['true', 'false'], value: String(p.requireGuarantorCover ?? false) },
  { label: 'Cover required, % of the loan', name: 'minCoverPercent', type: 'number', step: '0.01', value: p.minCoverPercent ?? 100 },
  { label: 'Member\'s own deposits count towards cover', name: 'coverCountsDeposits', options: ['true', 'false'], value: String(p.coverCountsDeposits ?? true) },
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
  opt({ label: 'Arrears tolerance days, minimum for a loan', name: 'arrearsToleranceDaysMin', type: 'number', value: p.arrearsToleranceDaysMin ?? '' }),
  opt({ label: 'Arrears tolerance days, maximum for a loan', name: 'arrearsToleranceDaysMax', type: 'number', value: p.arrearsToleranceDaysMax ?? '' }),
  opt({ label: 'Arrears tolerance, % of outstanding', name: 'arrearsTolerancePercent', type: 'number', step: '0.001', value: p.arrearsTolerancePercent ?? '' }),
  opt({ label: 'Arrears tolerance %, minimum for a loan', name: 'arrearsTolerancePercentMin', type: 'number', step: '0.001', value: p.arrearsTolerancePercentMin ?? '' }),
  opt({ label: 'Arrears tolerance %, maximum for a loan', name: 'arrearsTolerancePercentMax', type: 'number', step: '0.001', value: p.arrearsTolerancePercentMax ?? '' }),
  opt({ label: 'with a floor of', name: 'arrearsToleranceFloor', type: 'number', step: '0.01', value: p.arrearsToleranceFloor ?? '' }),
  { label: 'Count days in arrears from', name: 'arrearsCountFrom', options: ['OLDEST_LATE', 'FIRST_ARREARS'], value: p.arrearsCountFrom || 'OLDEST_LATE' },
  { label: 'Non-working days in tolerance', name: 'arrearsNonWorkingDays', options: ['INCLUDE', 'EXCLUDE'], value: p.arrearsNonWorkingDays || 'INCLUDE' },
  { label: 'Penalty rate, % a day (on outstanding principal: per the interest rate period)', name: 'penaltyRate', type: 'number', step: '0.001', value: p.penaltyRate ?? 0 },
  { label: 'Penalty basis', name: 'penaltyBasis', options: ['OVERDUE_ALL', 'OVERDUE_PRINCIPAL', 'OVERDUE_PRINCIPAL_INTEREST', 'OUTSTANDING_PRINCIPAL', 'NONE'], value: p.penaltyBasis || 'OVERDUE_ALL' },
  { label: 'Penalty tolerance, days', name: 'penaltyToleranceDays', type: 'number', value: p.penaltyToleranceDays ?? 0 },
  opt({ label: 'Cap on charges, % of principal (blank: none)', name: 'chargeCapPercent', type: 'number', step: '0.001', value: p.chargeCapPercent ?? '' }),
  { label: 'Cap base', name: 'chargeCapBase', options: ['OUTSTANDING_PRINCIPAL', 'ORIGINAL_PRINCIPAL'], value: p.chargeCapBase || 'OUTSTANDING_PRINCIPAL' },
  { label: 'Cap mode', name: 'chargeCapMode', options: ['HARD', 'SOFT'], value: p.chargeCapMode || 'HARD' },
  opt({ label: 'Lock after days in arrears (blank: never)', name: 'autoLockArrearsDays', type: 'number', value: p.autoLockArrearsDays ?? '' }),
  { label: 'Count accrued, unapplied charges towards the cap', name: 'capIncludesAccrued', options: ['false', 'true'], value: String(p.capIncludesAccrued ?? false) },
  opt({ label: 'Close a loan that owes nothing after days (blank: never)', name: 'autoClosePaidOffDays', type: 'number', value: p.autoClosePaidOffDays ?? '' }),
  { label: 'Settlement deposit accounts', name: 'settlementEnabled', options: ['false', 'true'], value: String(p.settlement?.enabled ?? false) },
  opt({ label: 'Settlement deposit product (blank: any)', name: 'settlementProductId', value: p.settlement?.productId || '' }),
  { label: 'Auto-set the member\'s account of that product', name: 'settlementAutoSet', options: ['false', 'true'], value: String(p.settlement?.autoSet ?? false) },
  { label: 'Auto-create one when there is none', name: 'settlementAutoCreate', options: ['false', 'true'], value: String(p.settlement?.autoCreate ?? false) },
  { label: 'Settlement transfers', name: 'settlementOption', options: ['FULL_DUES', 'PARTIAL', 'NONE'], value: p.settlement?.option || 'FULL_DUES' },
  { label: 'Offset: the linked deposit account lowers the balance interest is charged on (dynamic term, equal instalments, simple on principal and interest)', name: 'offsetEnabled', options: ['false', 'true'], value: String(p.offsetEnabled ?? false) },
  { label: 'Accounting (fixed once loans exist; use Change accounting method)', name: 'accountingMethod', options: ['ACCRUAL', 'CASH', 'NONE'], value: p.accountingMethod || 'ACCRUAL' },
  { label: 'Accrued interest reaches the ledger (ACCRUAL only)', name: 'interestAccruedAccounting', options: ['DAILY', 'MONTHLY', 'NONE'], value: p.interestAccruedAccounting || 'DAILY' },
  { label: 'Accrual entries', name: 'accrualGranularity', options: ['PER_ACCOUNT', 'AGGREGATED'], value: p.accrualGranularity || 'PER_ACCOUNT' },
  { label: 'Interest added to what is owed', name: 'interestAccrual', options: ['DAILY', 'MONTHLY', 'NONE'], value: p.interestAccrual || 'DAILY' },
  { label: 'Day count', name: 'dayCount', options: ['THIRTY_360', 'ACTUAL_365', 'ACTUAL_360', 'ACTUAL_ACTUAL', 'BUS_252'], value: p.dayCount || 'THIRTY_360' },
  { label: 'Interest rate source (INDEX: the rate above is the spread)', name: 'interestRateSource', options: ['FIXED', 'INDEX'], value: p.interestRateSource || 'FIXED' },
  { label: 'Index source (INDEX products)', name: 'indexSourceId', value: p.indexSourceId || '', required: false },
  { label: 'Rate floor', name: 'rateFloor', type: 'number', step: '0.0001', value: p.rateFloor ?? '', required: false },
  { label: 'Rate ceiling', name: 'rateCeiling', type: 'number', step: '0.0001', value: p.rateCeiling ?? '', required: false },
  { label: 'Review the index every', name: 'rateReviewCount', type: 'number', value: p.rateReviewCount ?? '', required: false },
  { label: 'Review unit', name: 'rateReviewUnit', options: ['MONTHS', 'WEEKS', 'DAYS'], value: p.rateReviewUnit || 'MONTHS' },
  { label: 'Adjustable rate periods on loans', name: 'adjustableRates', options: ['false', 'true'], value: String(p.adjustableRates ?? false) },
  { label: 'Allow negative spreads', name: 'allowNegativeRate', options: ['false', 'true'], value: String(p.allowNegativeRate ?? false) },
  { label: 'Payment allocation', name: 'paymentMethod', options: ['VERTICAL', 'HORIZONTAL'], value: p.paymentMethod || 'VERTICAL' },
  { label: 'Accept prepayments', name: 'allowPrepayments', options: ['true', 'false'], value: String(p.allowPrepayments ?? true) },
  { label: 'Interest on prepayments (dynamic)', name: 'prepaymentInterest', options: ['AUTOMATIC', 'MANUAL'], value: p.prepaymentInterest || 'AUTOMATIC' },
  { label: 'Prepayment allocation (dynamic equal installments)', name: 'prepaymentAllocation', options: ['UPCOMING_PENDING', 'NEXT_INSTALLMENTS'], value: p.prepaymentAllocation || 'UPCOMING_PENDING' },
  { label: 'Mark installment paid when (dynamic equal installments)', name: 'markPaidWhen', options: ['FULL_DUE', 'PRINCIPAL_EXPECTED'], value: p.markPaidWhen || 'FULL_DUE' },
  { label: 'Interest paid in advance (fixed term): a payment before the due date takes the whole interest of', name: 'interestPrepayment', options: ['NONE', 'NEXT_INSTALLMENT', 'ALL_INSTALLMENTS'], value: p.interestPrepayment || 'NONE' },
  { label: 'Accept postdated payments (fixed term)', name: 'allowPostdatedPayments', options: ['false', 'true'], value: String(p.allowPostdatedPayments ?? false) },
  { label: 'Schedule edits allowed (comma separated: PAYMENT_DATES, PRINCIPAL, INTEREST, FEES, PAYMENT_HOLIDAYS, NUMBER_OF_INSTALLMENTS)', name: 'scheduleEditing', value: (p.scheduleEditing || []).join(', '), required: false },
];

const PRODUCT_ENUM_FIELDS = ['category', 'idMode', 'initialState', 'productType', 'method', 'interestType', 'simpleBase', 'interestPosting',
  'rateFrequency', 'prepaymentRecalculation', 'repaymentIntervalUnit', 'shortMonthHandling', 'nonWorkingDays', 'residualInstallment', 'graceType', 'rounding',
  'arrearsCountFrom', 'arrearsNonWorkingDays', 'penaltyBasis', 'chargeCapBase', 'chargeCapMode', 'accountingMethod', 'interestAccrual', 'dayCount',
  'taxMethod', 'funderAllocation', 'interestAccruedAccounting', 'accrualGranularity', 'interestRateSource', 'rateReviewUnit',
  'paymentMethod', 'prepaymentInterest', 'prepaymentAllocation', 'markPaidWhen', 'interestPrepayment', 'settlementOption'];
const PRODUCT_NUM_FIELDS = ['monthlyRate', 'rateMin', 'rateMax', 'minPrincipal', 'defaultPrincipal', 'maxPrincipal', 'minTerm', 'defaultTerm', 'maxTerm',
  'repaymentIntervalCount', 'firstDueOffsetDays', 'gracePeriods', 'amortizationPeriods', 'processingFee', 'maxMultiplier',
  'arrearsToleranceDays', 'arrearsTolerancePercent', 'arrearsToleranceFloor', 'penaltyRate', 'penaltyToleranceDays',
  'chargeCapPercent', 'autoLockArrearsDays', 'maxTranches', 'revolvingRepaymentValue', 'revolvingRepaymentFloor', 'revolvingRepaymentCeiling',
  'maxCreditBalance', 'taxRatePercent', 'orgCommission', 'funderRateDefault', 'funderRateMin', 'funderRateMax',
  'rateFloor', 'rateCeiling', 'rateReviewCount',
  'arrearsToleranceDaysMin', 'arrearsToleranceDaysMax', 'arrearsTolerancePercentMin', 'arrearsTolerancePercentMax',
  'minCoverPercent', 'autoClosePaidOffDays'];
const PRODUCT_BOOL_FIELDS = ['accrueLateInterest', 'allowArbitraryFees', 'enforceDepositMultiplier', 'requireGuarantorCover',
  'creditBalanceEnabled', 'enableGuarantors', 'enableCollateral', 'taxOnInterest', 'taxOnFees', 'taxOnPenalties', 'fundingEnabled', 'lockFundsAtApproval',
  'adjustableRates', 'allowNegativeRate', 'allowPrepayments', 'allowPostdatedPayments', 'coverCountsDeposits', 'capIncludesAccrued',
  'settlementEnabled', 'settlementAutoSet', 'settlementAutoCreate', 'offsetEnabled'];
// Optional numbers that a blank field sets back to "unset".
const PRODUCT_NULLABLE = ['rateMin', 'rateMax', 'minPrincipal', 'defaultPrincipal', 'maxPrincipal', 'minTerm', 'defaultTerm',
  'amortizationPeriods', 'arrearsTolerancePercent', 'arrearsToleranceFloor', 'chargeCapPercent', 'autoLockArrearsDays',
  'maxTranches', 'revolvingRepaymentValue', 'revolvingRepaymentFloor', 'revolvingRepaymentCeiling', 'maxCreditBalance', 'taxRatePercent',
  'orgCommission', 'funderRateDefault', 'funderRateMin', 'funderRateMax', 'rateFloor', 'rateCeiling', 'rateReviewCount',
  'arrearsToleranceDaysMin', 'arrearsToleranceDaysMax', 'arrearsTolerancePercentMin', 'arrearsTolerancePercentMax', 'autoClosePaidOffDays'];

function productBody(d) {
  const out = { name: d.name, idPattern: d.idPattern };
  for (const k of PRODUCT_ENUM_FIELDS) if (d[k] !== undefined) out[k] = d[k];
  for (const k of PRODUCT_BOOL_FIELDS) if (d[k] !== undefined) out[k] = d[k] === 'true';
  for (const k of PRODUCT_NUM_FIELDS) {
    if (d[k] === undefined) continue;
    if (d[k] === '') { if (PRODUCT_NULLABLE.includes(k)) out[k] = null; continue; }
    out[k] = Number(d[k]);
  }
  if (d.scheduleEditing !== undefined) out.scheduleEditing = d.scheduleEditing.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  if (d.indexSourceId !== undefined) out.indexSourceId = d.indexSourceId.trim() ? d.indexSourceId.trim().toUpperCase() : null;
  if (d.fixedDaysOfMonth !== undefined) {
    out.fixedDaysOfMonth = d.fixedDaysOfMonth.trim() ? d.fixedDaysOfMonth.split(',').map((x) => Number(x.trim())).filter(Boolean) : null;
  }
  if (d.revolvingRepaymentMethod !== undefined) out.revolvingRepaymentMethod = d.revolvingRepaymentMethod || null;
  if (d.settlementProductId !== undefined) out.settlementProductId = d.settlementProductId.trim() ? d.settlementProductId.trim().toUpperCase() : null;
  // Mappings go only where the settings use them: a product refuses an
  // account it would never post to.
  const linked = out.accountingMethod !== 'NONE';
  if (d.glCreditBalance !== undefined) out.glCreditBalance = linked && out.creditBalanceEnabled ? d.glCreditBalance || null : null;
  if (d.glTaxPayable !== undefined) out.glTaxPayable = linked && (out.taxOnInterest || out.taxOnFees || out.taxOnPenalties) ? d.glTaxPayable || null : null;
  if (out.accountingMethod && out.accountingMethod !== 'ACCRUAL') out.interestAccruedAccounting = 'NONE';
  if (out.productType === 'INTEREST_FREE') out.monthlyRate = 0;
  return out;
}

const FEE_FIELDS = (f = {}) => [
  opt({ label: 'Code (blank: made from the name)', name: 'code', value: f.code || '' }),
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
  opt({ label: 'Fee write-off GL (blank: product default)', name: 'glWriteOff', value: f.glWriteOff || '' }),
  { label: 'Manual fee goes on (schedule allocation)', name: 'allocation', options: ['NEXT_INSTALLMENT', 'NO_ALLOCATION'], value: f.allocation || 'NEXT_INSTALLMENT' },
  { label: 'Amortise the income (accrual)', name: 'amortizationProfile', options: ['NONE', 'STRAIGHT_LINE', 'SUM_OF_YEARS_DIGITS', 'EFFECTIVE_INTEREST_RATE'], value: f.amortizationProfile || 'NONE' },
  { label: 'Amortisation frequency', name: 'amortizationFrequency', options: ['INSTALLMENT_DUE_DATES', 'INSTALLMENT_DUE_DATES_DAILY', 'CUSTOM_INTERVAL'], value: f.amortizationFrequency || 'INSTALLMENT_DUE_DATES' },
  opt({ label: 'Custom interval: every', name: 'amortizationIntervalCount', type: 'number', value: f.amortizationIntervalCount ?? '' }),
  { label: 'Custom interval unit', name: 'amortizationIntervalUnit', options: ['MONTHS', 'WEEKS', 'DAYS', 'YEARS'], value: f.amortizationIntervalUnit || 'MONTHS' },
  opt({ label: 'Custom interval: number of intervals', name: 'amortizationIntervals', type: 'number', value: f.amortizationIntervals ?? '' }),
  { label: 'On reschedule or refinance', name: 'amortizationOnReschedule', options: ['END_ON_ORIGINAL', 'CONTINUE_ON_NEW'], value: f.amortizationOnReschedule || 'END_ON_ORIGINAL' },
  opt({ label: 'Deferred fee income GL (blank: product default)', name: 'glDeferredIncome', value: f.glDeferredIncome || '' }),
  { label: 'Active', name: 'isActive', options: ['true', 'false'], value: String(f.isActive ?? true) },
];
function feeBody(d) {
  const num = (v) => (v === '' || v === undefined ? null : Number(v));
  return {
    code: d.code ? d.code.toUpperCase() : undefined, name: d.name, feeType: d.feeType, calculation: d.calculation,
    amount: num(d.amount), percent: num(d.percent), minAmount: num(d.minAmount), maxAmount: num(d.maxAmount),
    required: d.required === 'true', isActive: d.isActive === 'true',
    glIncome: d.glIncome || null, glReceivable: d.glReceivable || null, glWriteOff: d.glWriteOff || null,
    allocation: d.allocation || undefined, amortizationProfile: d.amortizationProfile || undefined,
    amortizationFrequency: d.amortizationFrequency || undefined,
    amortizationIntervalCount: num(d.amortizationIntervalCount), amortizationIntervals: num(d.amortizationIntervals),
    amortizationIntervalUnit: d.amortizationFrequency === 'CUSTOM_INTERVAL' ? d.amortizationIntervalUnit : null,
    amortizationOnReschedule: d.amortizationOnReschedule || undefined, glDeferredIncome: d.glDeferredIncome || null,
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
      <button id="p-edit" class="secondary">Edit settings</button><button id="p-method" class="secondary">Change accounting method</button><button id="p-fee">Add fee</button></div>
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
        <dt>Eligibility</dt><dd>${p.maxMultiplier}× deposits${p.enforceDepositMultiplier ? '' : ' (not enforced)'}${p.requireGuarantorCover ? `, ${p.minCoverPercent}% cover${p.coverCountsDeposits === false ? ' from guarantees and collateral only' : ' counting own deposits'}, at approval and disbursement` : ''}</dd>
        <dt>Settlement accounts</dt><dd id="p-settlement">${p.settlement?.enabled ? `${p.settlement.productId ? esc(p.settlement.productId) : 'any deposit product'} · ${esc(p.settlement.option.toLowerCase().replace(/_/g, ' '))}${p.settlement.autoSet ? ' · auto-set' : ''}${p.settlement.autoCreate ? ' · auto-create' : ''}` : 'not linked'}</dd>
        <dt>Accounting</dt><dd>${esc(p.accountingMethod)}${p.accountingMethod === 'ACCRUAL' ? ` · accrued interest to the ledger ${esc(p.interestAccruedAccounting)}, ${esc(p.accrualGranularity.toLowerCase().replace('_', ' '))}` : ''}</dd>
        <dt>GL rules</dt><dd>${p.accountingRules.length ? p.accountingRules.map((r) => `${esc(r.resource)} ${esc(r.glCode || '(default)')}`).join(' · ') : 'none: not linked to accounting'}</dd>
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
  $('#p-method').addEventListener('click', () => changeMethod('loan-products', p, productDetail));
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
    <div class="toolbar"><h1>Loan products</h1><span class="spacer"></span><button id="p-index" class="secondary">Index rates</button><button id="p-new">New product</button></div>
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

  $('#p-index').addEventListener('click', async () => {
    const list = await api('GET', '/api/index-rates');
    const current = (list.body || []).map((x) => `${x.id} ${x.current_rate ?? '-'}%`).join(', ') || 'none yet';
    const d = await ask([
      { label: `Index source id (now: ${current})`, name: 'id' },
      { label: 'Name (for a new source)', name: 'name', required: false },
      { label: 'Rate, %', name: 'rate', type: 'number', step: '0.0001' },
      { label: 'Valid from', name: 'validFrom', type: 'date' },
    ], 'Set an index rate');
    if (!d) return;
    const id = d.id.trim().toUpperCase();
    if (!(list.body || []).some((x) => x.id === id)) {
      const made = await api('POST', '/api/index-rates', { id, name: d.name || id });
      if (!made.ok) return toast(made.error, true);
    }
    const res = await api('POST', `/api/index-rates/${id}/rates`, { rate: Number(d.rate), validFrom: d.validFrom });
    toast(res.ok ? `${id} is ${d.rate}% from ${d.validFrom}; indexed loans take it at their next review` : res.error, !res.ok);
  });

  $('#p-new').addEventListener('click', async () => {
    const d = await ask([
      { label: 'Id (2 to 16 letters, digits or underscore)', name: 'id' },
      ...PRODUCT_FIELDS(),
      { label: 'Portfolio GL account', name: 'glPortfolio', value: '100-100' },
      { label: 'Interest income GL account', name: 'glInterestInc', value: '400-100' },
      { label: 'Fee income GL account', name: 'glFeeInc', value: '400-200' },
    ], 'New loan product');
    if (!d) return;
    const body = { id: d.id, ...productBody(d) };
    if (body.accountingMethod !== 'NONE') Object.assign(body, { glPortfolio: d.glPortfolio, glInterestInc: d.glInterestInc, glFeeInc: d.glFeeInc });
    const res = await api('POST', '/api/loan-products', body);
    toast(res.ok ? `${res.body.id} created` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) productsView();
  });
  depositProductsSection();
}

// A product's accounting method changes through its own action, after the
// previous month is closed; the open balances are converted and the change
// is recorded with its reason.
async function changeMethod(kind, p, reload) {
  const d = await ask([
    { label: 'New accounting method', name: 'accountingMethod', options: ['ACCRUAL', 'CASH', 'NONE'], value: p.accountingMethod },
    { label: 'Accrued interest reaches the ledger (ACCRUAL only)', name: 'interestAccruedAccounting', options: ['DAILY', 'MONTHLY', 'NONE'], value: p.interestAccruedAccounting || 'NONE' },
    { label: 'Reason (kept with the change)', name: 'reason' },
  ], `Change the accounting method of ${p.id}`);
  if (!d) return;
  const res = await api('POST', `/api/${kind}/${p.id}/accounting-method`, {
    accountingMethod: d.accountingMethod, interestAccruedAccounting: d.accountingMethod === 'ACCRUAL' ? d.interestAccruedAccounting : 'NONE', reason: d.reason,
  });
  toast(res.ok ? `${p.id} is now ${d.accountingMethod}; ${res.body.accounts} account(s) converted` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
  if (res.ok) reload(p);
}

// --------------------------------------------------------------------------
// Deposit products
// --------------------------------------------------------------------------

const DEPOSIT_TYPES = ['SAVINGS_ACCOUNT', 'CURRENT_ACCOUNT', 'FIXED_DEPOSIT', 'SAVINGS_PLAN', 'INVESTOR_ACCOUNT'];
const DEPOSIT_CATEGORIES = ['UNCATEGORIZED', 'PERSONAL_DEPOSIT', 'BUSINESS_DEPOSIT', 'DAILY_BANKING', 'BUSINESS_BANKING', 'STORED_VALUE'];
const INTEREST_POSTING = ['MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL', 'DAILY', 'FIRST_DAY_OF_MONTH', 'WEEKLY', 'EVERY_OTHER_WEEK',
  'MONTHLY_FROM_ACTIVATION', 'QUARTERLY_FROM_ACTIVATION', 'SEMI_ANNUAL_FROM_ACTIVATION', 'ANNUAL_FROM_ACTIVATION', 'FIXED_DATES', 'ON_MATURITY'];
const DEPOSIT_FIELDS = (p = {}) => [
  { label: 'Name', name: 'name', value: p.name || '' },
  { label: 'Type (fixed once accounts exist)', name: 'productType', options: DEPOSIT_TYPES, value: p.productType || 'SAVINGS_ACCOUNT' },
  { label: 'Category', name: 'category', options: DEPOSIT_CATEGORIES, value: p.category || 'UNCATEGORIZED' },
  { label: 'New account numbers', name: 'idGeneratorType', options: ['SHARED_SA_SERIES', 'INCREMENTAL_NUMBER', 'RANDOM_PATTERN'], value: p.newAccounts?.idGeneratorType || 'SHARED_SA_SERIES' },
  opt({ label: 'Starting number or pattern (# digit, @ letter, $ either)', name: 'idPattern', value: p.newAccounts?.idPattern || '' }),
  { label: 'Withdrawable', name: 'withdrawable', options: ['true', 'false'], value: String(p.withdrawable ?? true) },
  { label: 'Minimum balance', name: 'minBalance', type: 'number', step: '0.01', value: p.minBalance ?? 0 },
  { label: 'Pays interest into the account', name: 'interestPaidIntoAccount', options: ['false', 'true'], value: String(p.interest?.paidIntoAccount ?? false) },
  { label: 'Rate terms', name: 'interestRateTerms', options: ['FIXED', 'INDEX', 'TIERED_BALANCE', 'TIERED_BANDS', 'TIERED_PERIOD'], value: p.interest?.rateTerms || 'FIXED' },
  { label: 'Rate, percent (the default for FIXED)', name: 'annualRate', type: 'number', step: '0.0001', value: p.interest?.annualRate ?? 0 },
  opt({ label: 'Lowest and highest account rate (FIXED), e.g. 2,8', name: 'rateRange', value: p.interest?.rateMin !== null && p.interest?.rateMin !== undefined ? `${p.interest.rateMin},${p.interest.rateMax ?? ''}` : '' }),
  { label: 'Rate given per', name: 'interestRateFrequency', options: ['ANNUALIZED', 'EVERY_MONTH', 'EVERY_FOUR_WEEKS', 'EVERY_WEEK', 'EVERY_X_DAYS'], value: p.interest?.rateFrequency || 'ANNUALIZED' },
  opt({ label: 'X days (EVERY_X_DAYS)', name: 'interestRateXDays', type: 'number', value: p.interest?.rateXDays ?? '' }),
  opt({ label: 'Index rate source (INDEX)', name: 'interestIndexSourceId', value: p.interest?.indexSourceId || '' }),
  opt({ label: 'Spread default, lowest, highest (INDEX), e.g. 1.5,0,3', name: 'spread', value: p.interest?.spread?.default !== null && p.interest?.spread?.default !== undefined ? `${p.interest.spread.default},${p.interest.spread.min ?? ''},${p.interest.spread.max ?? ''}` : '' }),
  opt({ label: 'Tiers (TIERED_*): ending:rate, comma separated, last ending blank, e.g. 50000:2,:5', name: 'tiers', value: (p.interest?.tiers || []).map((t) => `${t.ending ?? ''}:${t.rate}`).join(',') }),
  { label: 'Interest on', name: 'interestCalcBalance', options: ['END_OF_DAY', 'MINIMUM_DAILY', 'AVERAGE_DAILY', 'MINIMUM'], value: p.interest?.calcBalance || 'END_OF_DAY',
    hint: 'MINIMUM is the lowest balance in the interest period (the platform\'s first rule); MINIMUM_DAILY and AVERAGE_DAILY are the reference platform\'s.' },
  opt({ label: 'Maximum balance earning interest (END_OF_DAY)', name: 'interestMaxBalance', type: 'number', step: '0.01', value: p.interest?.maxBalance ?? '' }),
  { label: 'Day count', name: 'interestDayCount', options: ['ACTUAL_365', 'ACTUAL_360', 'THIRTY_360', 'ACTUAL_ACTUAL_ISDA'], value: p.interest?.dayCount || 'ACTUAL_365' },
  { label: 'Applied', name: 'interestApplication', options: INTEREST_POSTING, value: p.interest?.application || 'MONTHLY' },
  opt({ label: 'Fixed dates (FIXED_DATES), MM-DD comma separated', name: 'interestFixedDates', value: (p.interest?.fixedDates || []).join(',') }),
  { label: 'A locked account earns interest', name: 'collectInterestWhenLocked', options: ['true', 'false'], value: String(p.interest?.collectWhenLocked ?? true) },
  { label: 'Interest after maturity', name: 'accrueInterestAfterMaturity', options: ['false', 'true'], value: String(p.interest?.accrueAfterMaturity ?? false) },
  opt({ label: 'Term unit (fixed deposit, savings plan)', name: 'termUnit', options: ['', 'DAYS', 'WEEKS', 'MONTHS'], value: p.term?.unit || '' }),
  opt({ label: 'Term default, lowest, highest, e.g. 6,3,12', name: 'termRange', value: p.term ? `${p.term.default ?? ''},${p.term.min ?? ''},${p.term.max ?? ''}` : '' }),
  opt({ label: 'Opening balance lowest, highest, default', name: 'openingRange', value: p.limits ? [p.limits.openingBalance.min, p.limits.openingBalance.max, p.limits.openingBalance.default].map((x) => x ?? '').join(',') : '' }),
  opt({ label: 'Recommended deposit (fixed deposit, savings plan)', name: 'recommendedDepositAmount', type: 'number', step: '0.01', value: p.limits?.recommendedDepositAmount ?? '' }),
  opt({ label: 'Maximum withdrawal in one transaction', name: 'maxWithdrawalAmount', type: 'number', step: '0.01', value: p.limits?.maxWithdrawalAmount ?? '' }),
  opt({ label: 'Days without activity before dormant', name: 'dormancyDays', type: 'number', value: p.dormancyDays ?? '' }),
  { label: 'Allow arbitrary fees', name: 'allowArbitraryFees', options: ['true', 'false'], value: String(p.allowArbitraryFees ?? true) },
  { label: 'New accounts start', name: 'initialState', options: ['ACTIVE', 'PENDING_APPROVAL', 'APPROVED'], value: p.initialState || 'ACTIVE' },
  { label: 'Allow accounts to be used for offset', name: 'allowOffset', options: ['false', 'true'], value: String(p.allowOffset ?? false) },
  opt({ label: 'Index interest rate reviewed every (blank: daily)', name: 'interestReviewCount', type: 'number', value: p.interest?.review?.count ?? '' }),
  { label: 'Review unit', name: 'interestReviewUnit', options: ['', 'DAYS', 'WEEKS', 'MONTHS'], value: p.interest?.review?.unit || '' },
  opt({ label: 'Index overdraft rate reviewed every (blank: daily)', name: 'overdraftReviewCount', type: 'number', value: p.overdraft?.review?.count ?? '' }),
  { label: 'Overdraft review unit', name: 'overdraftReviewUnit', options: ['', 'DAYS', 'WEEKS', 'MONTHS'], value: p.overdraft?.review?.unit || '' },
  opt({ label: 'Minimum balance to earn interest', name: 'minBalanceForInterest', type: 'number', step: '0.01', value: p.interest?.minBalanceForInterest ?? '' }),
  { label: 'Allow a negative rate', name: 'allowNegativeRate', options: ['false', 'true'], value: String(p.interest?.allowNegativeRate ?? false) },
  opt({ label: 'Withholding tax, percent (blank: none)', name: 'withholdingTaxPercent', type: 'number', step: '0.001', value: p.interest?.withholdingTaxPercent ?? '' }),
  { label: 'Allow overdrafts', name: 'allowOverdraft', options: ['false', 'true'], value: String(p.overdraft?.allowed ?? false) },
  opt({ label: 'Maximum overdraft limit', name: 'maxOverdraftLimit', type: 'number', step: '0.01', value: p.overdraft?.maxLimit ?? '' }),
  { label: 'Overdraft rate terms', name: 'overdraftRateTerms', options: ['FIXED', 'INDEX', 'TIERED_BALANCE'], value: p.overdraft?.rateTerms || 'FIXED' },
  { label: 'Overdraft annual rate, percent (the default for FIXED)', name: 'overdraftAnnualRate', type: 'number', step: '0.0001', value: p.overdraft?.annualRate ?? 0 },
  opt({ label: 'Lowest and highest account overdraft rate, e.g. 10,30', name: 'odRange', value: p.overdraft?.rateMin !== null && p.overdraft?.rateMin !== undefined ? `${p.overdraft.rateMin},${p.overdraft.rateMax ?? ''}` : '' }),
  opt({ label: 'Overdraft index source (INDEX)', name: 'overdraftIndexSourceId', value: p.overdraft?.indexSourceId || '' }),
  opt({ label: 'Overdraft spread default, lowest, highest (INDEX)', name: 'odSpread', value: p.overdraft?.spread?.default !== null && p.overdraft?.spread?.default !== undefined ? `${p.overdraft.spread.default},${p.overdraft.spread.min ?? ''},${p.overdraft.spread.max ?? ''}` : '' }),
  opt({ label: 'Overdraft tiers by amount overdrawn: ending:rate', name: 'odTiers', value: (p.overdraft?.tiers || []).map((t) => `${t.ending ?? ''}:${t.rate}`).join(',') }),
  { label: 'Overdraft interest on', name: 'overdraftCalcBalance', options: ['END_OF_DAY', 'MINIMUM_DAILY'], value: p.overdraft?.calcBalance || 'END_OF_DAY' },
  { label: 'Allow technical overdrafts (charges past zero)', name: 'allowTechnicalOverdraft', options: ['false', 'true'], value: String(p.overdraft?.technicalAllowed ?? false) },
  { label: 'Accounting (fixed once accounts exist; use Change accounting method)', name: 'accountingMethod', options: ['CASH', 'ACCRUAL', 'NONE'], value: p.accountingMethod || 'CASH' },
  { label: 'Accrued interest reaches the ledger (ACCRUAL only)', name: 'interestAccruedAccounting', options: ['NONE', 'DAILY', 'MONTHLY'], value: p.interestAccruedAccounting || 'NONE' },
  { label: 'Accrual entries', name: 'accrualGranularity', options: ['PER_ACCOUNT', 'AGGREGATED'], value: p.accrualGranularity || 'PER_ACCOUNT' },
  opt({ label: 'GL: Savings Control', name: 'glSavingsControl', value: p.gl?.savingsControl || '200-100' }),
  opt({ label: 'GL: Fee Income', name: 'glFeeIncome', value: p.gl?.feeIncome || '400-200' }),
  opt({ label: 'GL: Interest Expense', name: 'glInterestExpense', value: p.gl?.interestExpense || '500-100' }),
  opt({ label: 'GL: Interest Payable (accrual)', name: 'glInterestPayable', value: p.gl?.interestPayable || '200-110' }),
  opt({ label: 'GL: Withholding Tax Payable', name: 'glTaxPayable', value: p.gl?.taxPayable || '200-330' }),
  opt({ label: 'GL: Negative Interest Income', name: 'glNegativeInterestIncome', value: p.gl?.negativeInterestIncome || '400-310' }),
  opt({ label: 'GL: Negative Interest Receivable (accrual)', name: 'glNegativeInterestReceivable', value: p.gl?.negativeInterestReceivable || '100-330' }),
  opt({ label: 'GL: Overdraft Portfolio', name: 'glOverdraftPortfolio', value: p.gl?.overdraftPortfolio || '100-400' }),
  opt({ label: 'GL: Overdraft Write-off', name: 'glOverdraftWriteOff', value: p.gl?.overdraftWriteOff || '500-320' }),
  opt({ label: 'GL: Overdraft Interest Income', name: 'glOverdraftInterestIncome', value: p.gl?.overdraftInterestIncome || '400-300' }),
  opt({ label: 'GL: Overdraft Interest Receivable (accrual)', name: 'glOverdraftInterestReceivable', value: p.gl?.overdraftInterestReceivable || '100-410' }),
];

// Build the body, then ask the server which mappings those settings use and
// send only those: a product refuses an account it would never post to.
async function depositBody(d) {
  const num = (v) => (v === '' || v === undefined ? null : Number(v));
  const parts = (v, n) => { const x = String(v || '').split(',').map((y) => num(y.trim())); while (x.length < n) x.push(null); return x; };
  const tiers = (v) => String(v || '').split(',').filter((x) => x.includes(':')).map((x) => { const [e, r] = x.split(':'); return { ending: num(e.trim()), rate: Number(r) }; });
  const [rateMin, rateMax] = parts(d.rateRange, 2);
  const [spreadDefault, spreadMin, spreadMax] = parts(d.spread, 3);
  const [termDefault, termMin, termMax] = parts(d.termRange, 3);
  const [openMin, openMax, openDefault] = parts(d.openingRange, 3);
  const [odMin, odMax] = parts(d.odRange, 2);
  const [odSpreadDefault, odSpreadMin, odSpreadMax] = parts(d.odSpread, 3);
  const term = d.termUnit ? { termUnit: d.termUnit, termDefault, termMin, termMax } : {};
  const extra = {
    productType: d.productType, category: d.category,
    idGeneratorType: d.idGeneratorType === 'SHARED_SA_SERIES' ? null : d.idGeneratorType, idPattern: d.idGeneratorType === 'SHARED_SA_SERIES' ? null : d.idPattern || null,
    interestRateTerms: d.interestRateTerms, interestRateMin: rateMin, interestRateMax: rateMax, interestRateFrequency: d.interestRateFrequency,
    interestRateXDays: num(d.interestRateXDays), interestIndexSourceId: d.interestIndexSourceId || null,
    interestSpreadDefault: spreadDefault, interestSpreadMin: spreadMin, interestSpreadMax: spreadMax, interestRateTiers: tiers(d.tiers),
    interestMaxBalance: num(d.interestMaxBalance), interestFixedDates: String(d.interestFixedDates || '').split(',').map((x) => x.trim()).filter(Boolean),
    collectInterestWhenLocked: d.collectInterestWhenLocked !== 'false', accrueInterestAfterMaturity: d.accrueInterestAfterMaturity === 'true',
    ...term, minOpeningBalance: openMin, maxOpeningBalance: openMax, defaultOpeningBalance: openDefault,
    recommendedDepositAmount: num(d.recommendedDepositAmount), maxWithdrawalAmount: num(d.maxWithdrawalAmount), dormancyDays: num(d.dormancyDays),
    allowArbitraryFees: d.allowArbitraryFees !== 'false', initialState: d.initialState || 'ACTIVE', allowOffset: d.allowOffset === 'true',
    interestReviewCount: num(d.interestReviewCount), interestReviewUnit: d.interestReviewUnit || null,
    overdraftReviewCount: num(d.overdraftReviewCount), overdraftReviewUnit: d.overdraftReviewUnit || null, overdraftRateTerms: d.overdraftRateTerms, overdraftRateMin: odMin, overdraftRateMax: odMax,
    overdraftIndexSourceId: d.overdraftIndexSourceId || null, overdraftSpreadDefault: odSpreadDefault, overdraftSpreadMin: odSpreadMin,
    overdraftSpreadMax: odSpreadMax, overdraftRateTiers: tiers(d.odTiers), overdraftCalcBalance: d.overdraftCalcBalance,
  };
  const out = {
    ...extra,
    name: d.name, withdrawable: d.withdrawable === 'true', minBalance: num(d.minBalance) ?? 0,
    interestPaidIntoAccount: d.interestPaidIntoAccount === 'true', annualRate: num(d.annualRate) ?? 0,
    interestCalcBalance: d.interestCalcBalance, interestDayCount: d.interestDayCount, interestApplication: d.interestApplication,
    minBalanceForInterest: num(d.minBalanceForInterest), allowNegativeRate: d.allowNegativeRate === 'true',
    withholdingTaxPercent: num(d.withholdingTaxPercent), allowOverdraft: d.allowOverdraft === 'true',
    maxOverdraftLimit: num(d.maxOverdraftLimit), overdraftAnnualRate: num(d.overdraftAnnualRate) ?? 0,
    allowTechnicalOverdraft: d.allowTechnicalOverdraft === 'true', accountingMethod: d.accountingMethod,
    interestAccruedAccounting: d.accountingMethod === 'ACCRUAL' ? d.interestAccruedAccounting : 'NONE', accrualGranularity: d.accrualGranularity,
  };
  const r = await api('POST', '/api/deposit-products/accounting-rules', out);
  const byColumn = {
    gl_liability: 'glSavingsControl', gl_fee_inc: 'glFeeIncome', gl_interest_exp: 'glInterestExpense', gl_interest_payable: 'glInterestPayable',
    gl_tax_payable: 'glTaxPayable', gl_neg_interest_inc: 'glNegativeInterestIncome', gl_neg_interest_rec: 'glNegativeInterestReceivable',
    gl_od_portfolio: 'glOverdraftPortfolio', gl_od_writeoff: 'glOverdraftWriteOff', gl_od_interest_inc: 'glOverdraftInterestIncome',
    gl_od_interest_rec: 'glOverdraftInterestReceivable',
  };
  for (const rule of (r.ok ? r.body : [])) {
    const k = byColumn[rule.column];
    if (k) out[k] = rule.used ? d[k] || null : null;
  }
  return out;
}

async function depositProductDetail(p0) {
  const r = await api('GET', `/api/deposit-products/${p0.id}`);
  if (!r.ok) throw new Error(r.error);
  const p = r.body;
  view().innerHTML = `
    <button class="secondary" id="back">← Products</button>
    <div class="toolbar"><h1>${esc(p.id)} · ${esc(p.name)}</h1><span class="spacer"></span>
      <button id="d-edit" class="secondary">Edit settings</button><button id="d-method" class="secondary">Change accounting method</button><button id="d-fee">Add fee</button>
      ${p.accounts === 0 && can('DELETE_SAVINGS_PRODUCT') ? '<button id="d-delete" class="secondary">Delete</button>' : ''}</div>
    <div class="grid">
      ${card('Type and limits', `<dl class="kv" id="deposit-product-type">
        <dt>Type</dt><dd>${esc(String(p.productType).replace(/_/g, ' ').toLowerCase())} · ${esc(String(p.category).replace(/_/g, ' ').toLowerCase())}</dd>
        <dt>Account numbers</dt><dd>${p.newAccounts.idGeneratorType ? `${esc(p.newAccounts.idGeneratorType.replace(/_/g, ' ').toLowerCase())} ${esc(p.newAccounts.idPattern)}` : 'the shared SA series'}</dd>
        <dt>Rate terms</dt><dd>${esc(p.interest.rateTerms)}${p.interest.rateTerms === 'FIXED' && p.interest.rateMin !== null ? `, ${p.interest.rateMin}% to ${p.interest.rateMax ?? 'any'}%` : ''}${p.interest.tiers.length ? `, tiers ${p.interest.tiers.map((t) => `${t.ending ?? 'above'}: ${t.rate}%`).join(' · ')}` : ''}${p.interest.indexSourceId ? `, ${esc(p.interest.indexSourceId)} + ${p.interest.spread.default ?? 0}` : ''}</dd>
        <dt>Term</dt><dd>${p.term ? `${p.term.default} ${esc(p.term.unit.toLowerCase())} (${p.term.min ?? '—'} to ${p.term.max ?? '—'})` : 'none'}</dd>
        <dt>Maximum withdrawal</dt><dd>${p.limits.maxWithdrawalAmount ?? 'none'}</dd><dt>Dormant after</dt><dd>${p.dormancyDays ? `${p.dormancyDays} days` : 'never'}</dd>
        <dt>Arbitrary fees</dt><dd>${p.allowArbitraryFees ? 'allowed' : 'not allowed'}</dd>
        <dt>New accounts start</dt><dd>${esc(String(p.initialState || 'ACTIVE').replace(/_/g, ' ').toLowerCase())}</dd>
        <dt>Offset</dt><dd>${p.allowOffset ? 'accounts may offset loans' : 'no'}</dd>
      </dl>`)}
      ${card('Interest', `<dl class="kv">
        <dt>Paid</dt><dd>${p.interest.paidIntoAccount ? `${p.interest.annualRate}% a year on the ${esc(p.interest.calcBalance.toLowerCase().replace(/_/g, ' '))} balance, ${esc(p.interest.dayCount)}, applied ${esc(p.interest.application.toLowerCase().replace('_', ' '))}` : 'no interest'}</dd>
        <dt>Threshold</dt><dd>${p.interest.minBalanceForInterest ?? 'none'}</dd>
        <dt>Withholding tax</dt><dd>${p.interest.withholdingTaxPercent === null ? 'not set' : `${p.interest.withholdingTaxPercent}%`}</dd>
      </dl>`)}
      ${card('Overdraft', `<dl class="kv">
        <dt>Authorised</dt><dd>${p.overdraft.allowed ? `up to ${p.overdraft.maxLimit ?? 'any amount'} at ${p.overdraft.annualRate}% a year` : 'no'}</dd>
        <dt>Technical</dt><dd>${p.overdraft.technicalAllowed ? 'charges may take the balance below zero' : 'no'}</dd>
      </dl>`)}
      ${card('Accounting', `<dl class="kv">
        <dt>Method</dt><dd>${esc(p.accountingMethod)}${p.accountingMethod === 'ACCRUAL' ? ` · accrued interest to the ledger ${esc(p.interestAccruedAccounting)}, ${esc(p.accrualGranularity.toLowerCase().replace('_', ' '))}` : ''}</dd>
        <dt>GL rules</dt><dd>${p.accountingRules.length ? p.accountingRules.map((x) => `${esc(x.resource)} ${esc(x.glCode)}`).join(' · ') : 'none: not linked to accounting'}</dd>
        <dt>Accounts</dt><dd>${p.accounts}</dd>
      </dl>`)}
    </div>
    ${card('Fees', table([
    { label: 'Code', key: 'code' }, { label: 'Fee', key: 'name' }, { label: 'When', value: (f) => `${f.trigger}${f.applyDateMethod ? ` · ${f.applyDateMethod.replace(/_/g, ' ').toLowerCase()}` : ''}` },
    { label: '', html: true, value: (f) => `<button class="link" data-fee-drop="${esc(f.code)}">delete</button>` },
    { label: 'Amount', num: true, value: (f) => (f.amount === null ? 'set when charged' : money(f.amount)) },
    { label: 'Income GL', value: (f) => f.glIncome || 'product default' },
  ], p.fees, { empty: 'No fees defined.' }))}`;
  $('#back').addEventListener('click', productsView);
  $('#d-edit').addEventListener('click', async () => {
    const d = await ask(DEPOSIT_FIELDS(p), `Edit ${p.id}`);
    if (!d) return;
    const body = await depositBody(d);
    if (p.accounts > 0) { delete body.accountingMethod; delete body.interestAccruedAccounting; }
    const res = await api('PATCH', `/api/deposit-products/${p.id}`, body);
    toast(res.ok ? `${p.id} saved` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) depositProductDetail(p);
  });
  $('#d-method').addEventListener('click', () => changeMethod('deposit-products', p, depositProductDetail));
  const del = $('#d-delete');
  if (del) del.addEventListener('click', async () => {
    if (!(await ask([], `Delete ${p.id}? Only a product that never had accounts is deleted.`))) return;
    const res = await api('DELETE', `/api/deposit-products/${p.id}`);
    toast(res.ok ? `${p.id} deleted` : res.error, !res.ok);
    if (res.ok) productsView();
  });
  view().querySelectorAll('[data-fee-drop]').forEach((b) => b.addEventListener('click', async () => {
    const res = await api('DELETE', `/api/deposit-products/${p.id}/fees/${b.dataset.feeDrop}`);
    toast(res.ok ? 'Fee deleted' : res.error, !res.ok);
    if (res.ok) depositProductDetail(p);
  }));
  $('#d-fee').addEventListener('click', async () => {
    const d = await ask([
      { label: 'Code', name: 'code' }, { label: 'Name', name: 'name' },
      { label: 'When', name: 'trigger', options: ['MANUAL', 'MONTHLY'], value: 'MANUAL' },
      { label: 'Monthly fees are charged', name: 'applyDateMethod', options: ['END_OF_MONTH', 'FIRST_DAY_OF_MONTH', 'MONTHLY_FROM_ACTIVATION'], value: 'END_OF_MONTH' },
      opt({ label: 'Amount', name: 'amount', type: 'number', step: '0.01', value: '' }),
      opt({ label: 'Income GL (blank: product default)', name: 'glIncome', value: '' }),
    ], `New fee on ${p.id}`);
    if (!d) return;
    const res = await api('POST', `/api/deposit-products/${p.id}/fees`, {
      code: d.code.toUpperCase(), name: d.name, trigger: d.trigger, amount: d.amount === '' ? null : Number(d.amount), glIncome: d.glIncome || null,
      applyDateMethod: d.trigger === 'MONTHLY' ? d.applyDateMethod : undefined,
    });
    toast(res.ok ? `Fee ${res.body.code} added` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) depositProductDetail(p);
  });
}

async function depositProductsSection() {
  const r = await api('GET', '/api/deposit-products');
  if (!r.ok) return;
  const holder = document.createElement('section');
  holder.innerHTML = `
    <div class="toolbar"><h1>Deposit products</h1><span class="spacer"></span><button id="d-new">New deposit product</button></div>
    ${table([
    { label: 'Id', key: 'id' }, { label: 'Name', key: 'name' },
    { label: 'Interest', value: (p) => (p.interest.paidIntoAccount ? `${p.interest.annualRate}% ${p.interest.application.toLowerCase()}` : 'none') },
    { label: 'Overdraft', value: (p) => (p.overdraft.allowed ? `to ${p.overdraft.maxLimit ?? 'any'}` : p.overdraft.technicalAllowed ? 'technical only' : 'no') },
    { label: 'Accounting', value: (p) => `${p.accountingMethod}${p.accountingMethod === 'ACCRUAL' ? ` · ${p.interestAccruedAccounting}` : ''}` },
    { label: 'Accounts', num: true, key: 'accounts' },
  ], r.body, { onRow: true, empty: 'No deposit products' })}`;
  view().appendChild(holder);
  holder.querySelectorAll('tr[data-row]').forEach((tr) => tr.addEventListener('click', () => depositProductDetail(r.body[Number(tr.dataset.row)])));
  $('#d-new').addEventListener('click', async () => {
    const d = await ask([{ label: 'Id (2 to 16 letters, digits or underscore)', name: 'id' }, ...DEPOSIT_FIELDS()], 'New deposit product');
    if (!d) return;
    const res = await api('POST', '/api/deposit-products', { id: d.id, ...(await depositBody(d)) });
    toast(res.ok ? `${res.body.id} created` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) productsView();
  });
}

// --------------------------------------------------------------------------
// Accounting: branches, inter-branch rules, closures
// --------------------------------------------------------------------------

async function accountingView() {
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
// Lending controls
// --------------------------------------------------------------------------

const CONTROL_ROLES = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'TELLER', 'AUDITOR'];
let lastControlsRun = null;

async function controlsView() {
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

// --------------------------------------------------------------------------
// Organization (the reference platform's Administration: organization details, branding,
// end of day, branches and centres, holidays, channels, ID templates, rates,
// currencies, custom fields and product documents)
// --------------------------------------------------------------------------

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const listOf = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);
const rolesOf = (v) => { const l = listOf(v).map((x) => x.toUpperCase()); return l.length ? l : null; };

async function fileBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let k = 0; k < bytes.length; k += 1) bin += String.fromCharCode(bytes[k]);
  return btoa(bin);
}

/** The logo on the login screen, for the SACCO typed or remembered. */
async function showLoginLogo(tenant) {
  const img = el('login-logo');
  if (!img || !tenant) return;
  const r = await fetch('/api/organization/branding/logo', { headers: { 'x-tenant': tenant } }).catch(() => null);
  if (!r || !r.ok) { img.hidden = true; return; }
  img.src = URL.createObjectURL(await r.blob());
  img.hidden = false;
}

async function showHeaderIcon() {
  const img = el('sacco-icon');
  if (!img) return;
  const r = await fetch('/api/organization/branding/icon', { headers: { 'x-tenant': S.tenant } }).catch(() => null);
  if (!r || !r.ok) { img.hidden = true; return; }
  img.src = URL.createObjectURL(await r.blob());
  img.hidden = false;
}

/**
 * A record's custom fields as a card, with an editor: one field per
 * definition in a standard set, a JSON list for a grouped set.
 */
function customFieldsCard(cf) {
  if (!cf || !cf.definitions || !cf.definitions.length) return '';
  const sets = [...new Set(cf.definitions.map((d) => d.setId || ''))];
  const show = (d, v) => {
    if (v === undefined || v === null) return '—';
    if (d.type === 'SELECTION') return (d.options || []).find((o) => o.id === v)?.label || v;
    if (d.type === 'CHECKBOX') return v ? 'yes' : 'no';
    return v;
  };
  const body = sets.map((sid) => {
    const defs = cf.definitions.filter((d) => (d.setId || '') === sid);
    const vals = sid ? cf.values[sid] : cf.values;
    const title = defs[0].setName || 'Fields';
    if (Array.isArray(vals) || defs[0].setType === 'GROUPED') {
      return `<h3>${esc(title)}</h3>${table(defs.map((d) => ({ label: d.name, value: (g) => show(d, g[d.id]) })), vals || [], { empty: 'None' })}`;
    }
    return `<h3>${esc(title)}${cf.scores && cf.scores[sid] !== undefined ? ` <span class="badge">score ${cf.scores[sid]}</span>` : ''}</h3>
      <dl class="kv">${defs.map((d) => `<dt>${esc(d.name)}${d.usage.required ? ' *' : ''}</dt><dd>${esc(show(d, (vals || {})[d.id]))}</dd>`).join('')}</dl>`;
  }).join('');
  return `<div id="custom-fields">${card('Custom fields', `${body}<button class="secondary" id="cf-edit">Edit custom fields</button>`)}</div>`;
}

function wireCustomFields(cf, entity, id, reload) {
  const b = $('#cf-edit');
  if (!b) return;
  b.addEventListener('click', async () => {
    const defs = cf.definitions.filter((d) => d.isActive && d.usage.available && d.editable);
    const sets = [...new Set(defs.map((d) => d.setId || ''))];
    const fields = [];
    for (const sid of sets) {
      const sd = defs.filter((d) => (d.setId || '') === sid);
      const vals = sid ? cf.values[sid] : cf.values;
      if (sd[0].setType === 'GROUPED') {
        fields.push({ label: `${sd[0].setName} (a JSON list of groups with ${sd.map((d) => d.id).join(', ')})`, name: `grouped:${sid}`,
          type: 'textarea', rows: 4, value: JSON.stringify(vals || []), required: false });
        continue;
      }
      for (const d of sd) {
        const v = (vals || {})[d.id];
        const f = { label: `${d.setName ? `${d.setName}: ` : ''}${d.name}${d.usage.required ? ' (required)' : ''}`, name: `${sid}|${d.id}`, required: false };
        if (d.type === 'SELECTION') { f.options = ['', ...(d.options || []).map((o) => o.id)]; f.value = v ?? ''; f.hint = (d.options || []).map((o) => `${o.id} = ${o.label}`).join(', '); }
        else if (d.type === 'CHECKBOX') { f.options = ['', 'true', 'false']; f.value = v === undefined ? '' : String(v); }
        else if (d.type === 'NUMBER') { f.type = 'number'; f.step = 'any'; f.value = v ?? ''; }
        else if (d.type === 'DATE') { f.type = 'date'; f.value = v ?? ''; }
        else { f.value = v ?? ''; if (d.format) f.hint = `Format ${d.format}`; }
        fields.push(f);
      }
    }
    if (!fields.length) return toast('No custom fields you may edit here', true);
    const d = await ask(fields, 'Custom fields');
    if (!d) return;
    const patch = {};
    for (const [k, v] of Object.entries(d)) {
      if (k.startsWith('grouped:')) {
        try { patch[k.slice(8)] = JSON.parse(v || '[]'); } catch { return toast('A grouped set must be a JSON list', true); }
        continue;
      }
      const [sid, fid] = k.split('|');
      if (!sid) { patch[fid] = v === '' ? null : v; continue; }
      patch[sid] = patch[sid] || {};
      patch[sid][fid] = v === '' ? null : v;
    }
    const res = await api('PUT', `/api/custom-fields/values/${entity}/${id}`, patch);
    toast(res.ok ? 'Custom fields saved' : res.error, !res.ok);
    if (res.ok) reload();
  });
}

async function orgView() {
  const admin = S.user.role === 'TENANT_ADMIN';
  const manage = ['TENANT_ADMIN', 'MANAGER'].includes(S.user.role);
  const [org, eodS, branches, centres, cal, chans, idt, rates, curs, sets, defs] = await Promise.all([
    api('GET', '/api/organization'), api('GET', '/api/organization/eod'), api('GET', '/api/branches'), api('GET', '/api/centres'),
    api('GET', '/api/holidays'), api('GET', '/api/transaction-channels'), api('GET', '/api/id-templates'), api('GET', '/api/index-rates'),
    api('GET', '/api/currencies'), api('GET', '/api/custom-fields/sets'), api('GET', '/api/custom-fields/definitions'),
  ]);
  if (!org.ok) throw new Error(org.error);
  const o = org.body;
  const e = eodS.body || {};
  const c = cal.body || { general: [], branches: [], currencies: [], nonWorkingDays: [] };
  const holidayRows = [...c.general, ...c.branches, ...c.currencies];
  const con = (x) => (!x ? 'unconstrained' : `${x.match}: ${x.filters.map((f) => (f.type === 'AMOUNT' ? `amount ${f.min ?? ''}–${f.max ?? ''}` : `${f.type.toLowerCase()} ${f.values.join('/')}`)).join(', ') || 'none'}`);
  view().innerHTML = `
    <div class="toolbar"><h1>Organization</h1></div>
    <p class="hint">The organization's setup, after the reference platform's Managing your Organization pages. Changes are audited.</p>
    <div class="grid">
      ${card('Organization details', `<dl class="kv" id="org-details">
        <dt>Institution name</dt><dd id="org-name">${esc(o.institutionName)}</dd>
        <dt>Base currency</dt><dd>${esc(o.currency)}</dd>
        <dt>Time zone</dt><dd id="org-tz">${esc(o.timeZone)}</dd>
        <dt>Date format</dt><dd>${esc(o.localDateFormat)} · ${esc(o.localDateTimeFormat)}</dd>
        <dt>Decimal mark</dt><dd>${esc(o.decimalMark)}</dd>
        <dt>Address</dt><dd>${esc([o.contact.streetAddress, o.contact.city, o.contact.region, o.contact.postcode, o.contact.country].filter(Boolean).join(', ') || '—')}</dd>
        <dt>Phone · email</dt><dd>${esc(o.contact.phone || '—')} · ${esc(o.contact.email || '—')}</dd></dl>
        ${admin ? '<button class="secondary" id="org-edit">Edit details</button>' : ''}`)}
      ${card('Branding', `<p class="hint">The logo shows on the sign-in screen (best 300 × 50, transparent PNG); the icon at the top left (16 × 16 or a larger square).</p>
        <dl class="kv"><dt>Logo</dt><dd id="brand-logo">${o.branding.logo ? 'set' : 'none'}</dd><dt>Icon</dt><dd>${o.branding.icon ? 'set' : 'none'}</dd></dl>
        ${admin ? '<button class="secondary" data-brand="logo">Upload logo</button> <button class="secondary" data-brand="icon">Upload icon</button>' : ''}`)}
      ${card('End of day', `<dl class="kv">
        <dt>Mode</dt><dd id="eod-mode">${esc(e.mode)}</dd>
        <dt>Runs at</dt><dd>${esc(e.eodHour)}:00 ${esc(e.timeZone)}${e.mode === 'MANUAL' ? ' (not while manual)' : ''}</dd>
        <dt>Accounting cutoff</dt><dd>${esc(e.accountingCutoff || 'none (the posting day)')}</dd>
        <dt>Retry loans left out hourly</dt><dd>${e.retryExcluded ? 'yes' : 'no'} (${esc(e.excludedLoans)} left out now)</dd></dl>
        ${admin ? '<button class="secondary" id="eod-edit">Edit</button>' : ''} ${admin && e.mode === 'MANUAL' ? '<button id="eod-run">Run now</button>' : ''}
        ${table([
    { label: 'Business date', value: (x) => day(x.business_date) },
    { label: 'Trigger', key: 'trigger' },
    { label: 'State', key: 'state' },
    { label: 'Failed jobs', num: true, key: 'failed_jobs' },
    { label: 'Loans left out', num: true, key: 'failed_loans' },
  ], (e.completions || []).slice(0, 5), { empty: 'No end of day recorded yet' })}`)}
    </div>
    <div id="org-clients"></div>
    ${card('Branches and centres', `<div id="org-branches">${table([
    { label: 'Code', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Status', key: 'status' },
    { label: 'Email', key: 'email' }, { label: 'Members', num: true, key: 'members' },
    { label: '', html: true, value: (b) => `<button class="link" data-branch-open="${esc(b.code)}">open</button>${manage ? ` <button class="link" data-branch="${esc(b.code)}">edit</button>` : ''}` },
  ], branches.body || [], { empty: 'No branches' })}</div>
    ${manage ? '<button class="secondary" id="branch-add">New branch</button>' : ''}
    <h3>Centres</h3><div id="org-centres">${table([
    { label: 'Code', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Branch', key: 'branch_code' }, { label: 'Status', key: 'status' },
    { label: 'Meeting day', value: (x) => (x.meeting_day === null ? '—' : DAYS[x.meeting_day]) }, { label: 'Members', num: true, key: 'members' },
    { label: '', html: true, value: (x) => (manage ? `<button class="link" data-centre="${esc(x.code)}">edit</button>` : '') },
  ], centres.body || [], { empty: 'No centres' })}</div>
    ${manage ? '<button class="secondary" id="centre-add">New centre</button>' : ''}`)}
    ${card('Holidays and non-working days', `<p id="non-working">Non-working days: <strong>${esc(c.nonWorkingDays.map((d) => DAYS[d]).join(', ') || 'none')}</strong></p>
    ${c.pendingSyncFrom ? `<p class="notice" id="calendar-pending">The calendar changed from ${esc(c.pendingSyncFrom)}: open loans are re-dated at the next end of day, or now with Sync.</p>` : ''}
    <div id="org-holidays">${table([
    { label: 'ID', key: 'id' }, { label: 'Description', key: 'description' }, { label: 'Date', key: 'date' },
    { label: 'Recurring', value: (h) => (h.recurring ? 'every year' : '') },
    { label: 'Scope', value: (h) => (h.scope === 'BRANCH' ? `branch ${h.branchCode}` : h.scope === 'CURRENCY' ? `currency ${h.currencyCode}` : 'organization') },
    { label: '', html: true, value: (h) => (manage ? `<button class="link" data-holiday="${esc(h.key)}">delete</button>` : '') },
  ], holidayRows, { empty: 'No holidays' })}</div>
    ${manage ? '<button class="secondary" id="holiday-add">Add holiday</button> <button class="secondary" id="nwd-edit">Non-working days</button> <button class="secondary" id="calendar-sync">Sync open loans</button>' : ''}`)}
    ${card('Transaction channels', `<div id="org-channels">${table([
    { label: '#', num: true, key: 'sort_order' }, { label: 'ID', key: 'id' }, { label: 'Name', key: 'name' }, { label: 'GL', key: 'gl_account_code' },
    { label: 'Roles', value: (x) => (x.usage_roles ? x.usage_roles.join(', ') : 'all users') },
    { label: 'Loans', value: (x) => con(x.loan_constraints) }, { label: 'Deposits', value: (x) => con(x.savings_constraints) },
    { label: 'Active', value: (x) => (x.is_active ? (x.is_default ? 'yes (default)' : 'yes') : 'no') },
    { label: '', html: true, value: (x) => (manage ? `<button class="link" data-channel="${esc(x.id)}">edit</button> <button class="link" data-channel-up="${esc(x.id)}">up</button>` : '') },
  ], chans.body || [], { empty: 'No channels' })}</div>
    ${manage ? '<button class="secondary" id="channel-add">New channel</button>' : ''}`)}
    <div class="grid">
      ${card('ID templates', `<div id="org-idt">${table([
    { label: 'ID', key: 'id' }, { label: 'Type', key: 'id_type' }, { label: 'Issued by', key: 'issuing_authority' }, { label: 'Template', key: 'mask' },
    { label: 'Mandatory', value: (t) => (t.mandatory ? 'yes' : '') }, { label: 'Attachments', value: (t) => (t.allow_attachments ? 'yes' : '') },
    { label: 'National ID', value: (t) => (t.national_id ? 'yes' : '') },
    { label: '', html: true, value: (t) => (manage ? `<button class="link" data-idt="${esc(t.id)}">edit</button>` : '') },
  ], idt.body?.templates || [], { empty: 'No ID templates' })}</div>
      <p class="hint">Other documents without a template: ${idt.body?.allowOther ? 'allowed' : 'not allowed'}. Template: # a digit, @ a letter, $ either.</p>
      ${manage ? '<button class="secondary" id="idt-add">New template</button> <button class="secondary" id="idt-other">Toggle Other</button>' : ''}`)}
      ${card('Rates', `<div id="org-rates">${table([
    { label: 'Source', key: 'id' }, { label: 'Name', key: 'name' }, { label: 'Kind', key: 'kind' }, { label: 'Current', num: true, key: 'current_rate' },
    { label: '', html: true, value: (x) => (manage ? `<button class="link" data-rate="${esc(x.id)}">add value</button>` : '') },
  ], rates.body || [], { empty: 'No rate sources' })}</div>
      ${manage ? '<button class="secondary" id="rate-add">New rate source</button>' : ''}`)}
      ${card('Currencies', `<div id="org-currencies">${table([
    { label: 'Code', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Symbol', key: 'symbol' }, { label: 'Decimals', num: true, key: 'decimals' },
    { label: 'Exchange rate', value: (x) => (x.is_base ? 'BASE' : x.exchange_rate ? `buy ${x.exchange_rate.buy_rate} · sell ${x.exchange_rate.sell_rate}` : 'not set') },
    { label: '', html: true, value: (x) => (!x.is_base && manage ? `<button class="link" data-fx="${esc(x.code)}">set rate</button>` : '') },
  ], curs.body || [], { empty: 'No currencies' })}</div>
      ${admin ? '<button class="secondary" id="currency-add">Add currency</button>' : ''}`)}
    </div>
    ${card('Custom fields', `<div id="org-cf">${table([
    { label: 'Entity', key: 'entity' }, { label: 'Set', value: (d) => d.set_name || '—' }, { label: 'ID', key: 'id' }, { label: 'Name', key: 'name' },
    { label: 'Type', key: 'field_type' },
    { label: 'Usage', value: (d) => (d.usage.items ? `per item: ${Object.keys(d.usage.items).join(', ')}` : d.usage.required ? 'required' : d.usage.default ? 'default' : 'available') },
    { label: 'Edit roles', value: (d) => (d.edit_roles ? d.edit_roles.join(', ') : 'all') },
    { label: 'Active', value: (d) => (d.is_active ? 'yes' : 'no') },
    { label: '', html: true, value: (d) => (manage ? `<button class="link" data-cf="${esc(d.id)}">${d.is_active ? 'deactivate' : 'activate'}</button>` : '') },
  ], defs.body || [], { empty: 'No custom fields' })}</div>
    <p class="hint">Sets: ${esc((sets.body || []).map((x) => `${x.id} (${x.entity.toLowerCase()}, ${x.set_type.toLowerCase()})`).join('; ') || 'none')}</p>
    ${manage ? '<button class="secondary" id="cf-set-add">New set</button> <button class="secondary" id="cf-add">New field</button>' : ''}`)}
    ${card('Product documents', `<p class="hint">Templates per product, for an account or a transaction. Placeholders such as {{member.fullName}}, {{account.totalBalance}},
      {{transaction.amount}}, blocks {{#statement}}…{{/statement}} and {{#schedule}}…{{/schedule}}; a page break is &lt;div class="page-break"&gt;&lt;/div&gt;.</p>
      ${manage ? '<button class="secondary" id="doc-list">Templates of a product</button> <button class="secondary" id="doc-add">New template</button>' : ''}
      <div id="org-docs"></div>`)}`;

  clientsSetup($('#org-clients'));
  const done = (res, msg) => { toast(res.ok ? msg : res.error, !res.ok); if (res.ok) orgView(); };
  const on = (sel, fn) => { const b = $(sel); if (b) b.addEventListener('click', fn); };
  const each = (attr, fn) => view().querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', () => fn(b.dataset[attr.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())])));

  on('#org-edit', async () => {
    const d = await ask([
      { label: 'Institution name', name: 'institutionName', value: o.institutionName },
      { label: 'Time zone', name: 'timeZone', value: o.timeZone },
      { label: 'Base currency (only while nothing is posted)', name: 'currency', value: o.currency },
      { label: 'Date format', name: 'localDateFormat', value: o.localDateFormat },
      { label: 'Date and time format', name: 'localDateTimeFormat', value: o.localDateTimeFormat },
      { label: 'Decimal mark', name: 'decimalMark', options: ['.', ','], value: o.decimalMark },
      ...['streetAddress', 'city', 'region', 'postcode', 'country', 'phone', 'email'].map((k) => opt({ label: k.replace(/[A-Z]/g, (x) => ` ${x.toLowerCase()}`), name: k, value: o.contact[k] || '' })),
    ], 'Organization details');
    if (!d) return;
    const contact = Object.fromEntries(['streetAddress', 'city', 'region', 'postcode', 'country', 'phone', 'email'].map((k) => [k, d[k]]));
    done(await api('PUT', '/api/organization', { institutionName: d.institutionName, timeZone: d.timeZone, currency: d.currency,
      localDateFormat: d.localDateFormat, localDateTimeFormat: d.localDateTimeFormat, decimalMark: d.decimalMark, contact }), 'Organization saved');
  });
  each('brand', async (kind) => {
    const d = await ask([{ label: `${kind} (PNG, JPEG, GIF or WebP, at most 512 KB)`, name: 'file', type: 'file' }], `Upload ${kind}`);
    if (!d || !d.file || !d.file.size) return;
    done(await api('PUT', `/api/organization/branding/${kind}`, { data: await fileBase64(d.file), type: d.file.type }), `${kind} uploaded`);
  });
  on('#eod-edit', async () => {
    const d = await ask([
      { label: 'Mode', name: 'mode', options: ['AUTOMATIC', 'MANUAL'], value: e.mode },
      opt({ label: 'Accounting cutoff (HH:MM, blank for none)', name: 'accountingCutoff', value: e.accountingCutoff || '' }),
      { label: 'Retry loans left out every hour', name: 'retryExcluded', options: ['true', 'false'], value: String(e.retryExcluded) },
    ], 'End of day');
    if (!d) return;
    done(await api('PUT', '/api/organization/eod', { mode: d.mode, accountingCutoff: d.accountingCutoff || null, retryExcluded: d.retryExcluded === 'true' }), 'End of day saved');
  });
  on('#eod-run', async () => {
    const d = await ask([opt({ label: 'Business date (blank: today)', name: 'businessDate', type: 'date' })], 'Run the end of day now');
    if (!d) return;
    const res = await api('POST', '/api/organization/eod/run', { businessDate: d.businessDate || undefined });
    done(res, res.ok ? `End of day ${res.body.completion ? res.body.completion.state.toLowerCase() : 'already run for that date'}` : '');
  });
  const branchForm = async (b = {}) => ask([
    ...(b.code ? [] : [{ label: 'ID (code)', name: 'code' }]),
    { label: 'Name', name: 'name', value: b.name || '' },
    opt({ label: 'Address', name: 'address', value: b.address || '' }), opt({ label: 'Phone', name: 'phone', value: b.phone || '' }),
    opt({ label: 'Email', name: 'email', value: b.email || '' }), opt({ label: 'Notes', name: 'notes', value: b.notes || '' }),
    ...(b.code ? [{ label: 'Status', name: 'status', options: ['ACTIVE', 'CLOSED'], value: b.status }] : []),
  ], b.code ? `Branch ${b.code}` : 'New branch');
  on('#branch-add', async () => { const d = await branchForm(); if (d) done(await api('POST', '/api/branches', d), 'Branch created'); });
  view().querySelectorAll('[data-branch-open]').forEach((b) => b.addEventListener('click', () => branchDetail(b.dataset.branchOpen)));
  each('branch', async (code) => {
    const b = (branches.body || []).find((x) => x.code === code);
    const d = await branchForm(b);
    if (d) done(await api('PATCH', `/api/branches/${code}`, d), 'Branch saved');
  });
  const centreForm = async (x = {}) => ask([
    ...(x.code ? [] : [{ label: 'ID (code)', name: 'code' }, { label: 'Branch code', name: 'branchId' }]),
    { label: 'Name', name: 'name', value: x.name || '' },
    { label: 'Weekly meeting day', name: 'meetingDay', options: ['', ...DAYS], value: x.meeting_day === null || x.meeting_day === undefined ? '' : DAYS[x.meeting_day] },
    opt({ label: 'Address', name: 'address', value: x.address || '' }),
    ...(x.code ? [{ label: 'Status', name: 'status', options: ['ACTIVE', 'INACTIVE'], value: x.status }] : []),
  ], x.code ? `Centre ${x.code}` : 'New centre');
  const md = (v) => (v === '' ? null : DAYS.indexOf(v));
  on('#centre-add', async () => { const d = await centreForm(); if (d) done(await api('POST', '/api/centres', { ...d, meetingDay: md(d.meetingDay) }), 'Centre created'); });
  each('centre', async (code) => {
    const x = (centres.body || []).find((y) => y.code === code);
    const d = await centreForm(x);
    if (d) done(await api('PATCH', `/api/centres/${code}`, { ...d, meetingDay: md(d.meetingDay) }), 'Centre saved');
  });
  on('#holiday-add', async () => {
    const d = await ask([
      { label: 'Description', name: 'description' }, { label: 'Date', name: 'date', type: 'date' },
      { label: 'Recurring every year', name: 'recurring', options: ['false', 'true'] },
      opt({ label: 'ID (blank: generated)', name: 'id' }),
      opt({ label: 'Branch code (a branch holiday)', name: 'branchId' }), opt({ label: 'Currency (a currency holiday)', name: 'currencyCode' }),
    ], 'Add holiday');
    if (!d) return;
    done(await api('POST', '/api/holidays', { ...d, recurring: d.recurring === 'true', id: d.id || null, branchId: d.branchId || null, currencyCode: d.currencyCode || null }), 'Holiday added');
  });
  each('holiday', async (key) => done(await api('DELETE', `/api/holidays/${key}`), 'Holiday deleted'));
  on('#nwd-edit', async () => {
    const d = await ask(DAYS.map((n, k) => ({ label: n, name: String(k), options: ['working', 'non-working'], value: c.nonWorkingDays.includes(k) ? 'non-working' : 'working' })), 'Non-working days');
    if (!d) return;
    done(await api('PUT', '/api/holidays/non-working-days', { days: Object.entries(d).filter(([, v]) => v === 'non-working').map(([k]) => Number(k)) }), 'Non-working days saved');
  });
  on('#calendar-sync', async () => { const res = await api('POST', '/api/holidays/sync', {}); done(res, res.ok ? `${res.body.installments || 0} installment(s) re-dated` : ''); });
  const channelForm = async (x = {}) => ask([
    ...(x.id ? [] : [{ label: 'ID (no spaces)', name: 'id' }]),
    { label: 'Name', name: 'name', value: x.name || '' },
    { label: 'Type', name: 'channelType', options: ['CASH', 'MOBILE', 'TRANSFER', 'CHEQUE', 'INTERNAL', 'PAYROLL'], value: x.channel_type || 'CASH' },
    { label: 'GL account', name: 'glAccount', value: x.gl_account_code || '' },
    opt({ label: 'Roles that may use it (comma separated; blank: all users)', name: 'usageRoles', value: (x.usage_roles || []).join(', ') }),
    { label: 'Loan constraints (JSON, blank: unconstrained)', name: 'loanConstraints', type: 'textarea', rows: 3, required: false,
      value: x.loan_constraints ? JSON.stringify(x.loan_constraints) : '', hint: '{"match":"ALL","filters":[{"type":"AMOUNT","max":50000},{"type":"TYPE","values":["REPAYMENT"]}]}' },
    { label: 'Deposit constraints (JSON, blank: unconstrained)', name: 'savingsConstraints', type: 'textarea', rows: 3, required: false,
      value: x.savings_constraints ? JSON.stringify(x.savings_constraints) : '', hint: 'Types DEPOSIT, WITHDRAWAL; products by ID' },
    ...(x.id ? [{ label: 'Active', name: 'isActive', options: ['true', 'false'], value: String(x.is_active) }] : []),
  ], x.id ? `Channel ${x.id}` : 'New channel');
  const channelBody = (d) => {
    const parse = (v) => (v ? JSON.parse(v) : null);
    return { ...d, usageRoles: rolesOf(d.usageRoles), loanConstraints: parse(d.loanConstraints), savingsConstraints: parse(d.savingsConstraints),
      ...(d.isActive !== undefined ? { isActive: d.isActive === 'true' } : {}) };
  };
  on('#channel-add', async () => {
    const d = await channelForm();
    if (!d) return;
    try { done(await api('POST', '/api/transaction-channels', channelBody(d)), 'Channel created'); } catch { toast('Constraints must be JSON', true); }
  });
  each('channel', async (id) => {
    const d = await channelForm((chans.body || []).find((x) => x.id === id));
    if (!d) return;
    try { done(await api('PATCH', `/api/transaction-channels/${id}`, channelBody(d)), 'Channel saved'); } catch { toast('Constraints must be JSON', true); }
  });
  each('channel-up', async (id) => {
    const ids = (chans.body || []).map((x) => x.id);
    const k = ids.indexOf(id);
    if (k > 0) [ids[k - 1], ids[k]] = [ids[k], ids[k - 1]];
    done(await api('PUT', '/api/transaction-channels/order', { order: ids }), 'Order saved');
  });
  const idtForm = (t = {}) => ask([
    ...(t.id ? [] : [opt({ label: 'Template ID (letters and digits)', name: 'id' })]),
    { label: 'ID type', name: 'idType', value: t.id_type || '' }, { label: 'Issuing authority', name: 'issuingAuthority', value: t.issuing_authority || '' },
    { label: 'ID document template', name: 'mask', value: t.mask || '', hint: '# a digit, @ a letter, $ either' },
    { label: 'Mandatory for members', name: 'mandatory', options: ['false', 'true'], value: String(Boolean(t.mandatory)) },
    { label: 'Allow attachments', name: 'allowAttachments', options: ['false', 'true'], value: String(Boolean(t.allow_attachments)) },
    { label: 'Fills the member\'s national ID', name: 'nationalId', options: ['false', 'true'], value: String(Boolean(t.national_id)) },
  ], t.id ? `ID template ${t.id}` : 'New ID template');
  const idtBody = (d) => ({ ...d, id: d.id || undefined, mandatory: d.mandatory === 'true', allowAttachments: d.allowAttachments === 'true', nationalId: d.nationalId === 'true' });
  on('#idt-add', async () => { const d = await idtForm(); if (d) done(await api('POST', '/api/id-templates', idtBody(d)), 'Template created'); });
  each('idt', async (id) => { const d = await idtForm((idt.body?.templates || []).find((t) => t.id === id)); if (d) done(await api('PATCH', `/api/id-templates/${id}`, idtBody(d)), 'Template saved'); });
  on('#idt-other', async () => done(await api('PUT', '/api/id-templates/other', { allow: !idt.body?.allowOther }), 'Saved'));
  on('#rate-add', async () => {
    const d = await ask([{ label: 'ID', name: 'id' }, { label: 'Name', name: 'name' }, { label: 'Kind', name: 'kind', options: ['INTEREST', 'VAT', 'WITHHOLDING'] }, opt({ label: 'Notes', name: 'notes' })], 'New rate source');
    if (d) done(await api('POST', '/api/index-rates', d), 'Rate source created');
  });
  each('rate', async (id) => {
    const d = await ask([{ label: 'Rate (%)', name: 'rate', type: 'number', step: '0.0001' }, { label: 'Valid from', name: 'validFrom', type: 'date', value: today() }], `New value for ${id}`);
    if (d) done(await api('POST', `/api/index-rates/${id}/rates`, { rate: Number(d.rate), validFrom: d.validFrom }), 'Rate saved');
  });
  on('#currency-add', async () => {
    const pre = await api('GET', '/api/currencies/presets');
    const d = await ask([{ label: 'Currency (ISO 4217)', name: 'code', options: (pre.body || []).map((x) => x.code), value: 'USD' },
      opt({ label: 'Symbol (blank: standard)', name: 'symbol' }), { label: 'Symbol position', name: 'symbolPosition', options: ['BEFORE', 'AFTER'] }], 'Add currency');
    if (d) done(await api('POST', '/api/currencies', { code: d.code, symbol: d.symbol || undefined, symbolPosition: d.symbolPosition }), 'Currency added');
  });
  each('fx', async (code) => {
    const d = await ask([{ label: `Buy rate (${code} in base)`, name: 'buyRate', type: 'number', step: 'any' }, { label: 'Sell rate', name: 'sellRate', type: 'number', step: 'any' }], `Exchange rate for ${code}`);
    if (d) done(await api('POST', `/api/currencies/${code}/exchange-rates`, { buyRate: Number(d.buyRate), sellRate: Number(d.sellRate) }), 'Exchange rate set');
  });
  const ENTITIES = ['MEMBER', 'GROUP', 'LOAN_ACCOUNT', 'SAVINGS_ACCOUNT', 'SAVINGS_PRODUCT', 'GUARANTOR', 'COLLATERAL', 'BRANCH', 'CENTRE', 'USER', 'TRANSACTION_CHANNEL'];
  on('#cf-set-add', async () => {
    const d = await ask([{ label: 'Entity', name: 'entity', options: ENTITIES }, { label: 'Name', name: 'name' }, opt({ label: 'ID (blank: from the name)', name: 'id' }),
      { label: 'Type', name: 'type', options: ['STANDARD', 'GROUPED'] }], 'New custom field set');
    if (d) done(await api('POST', '/api/custom-fields/sets', { ...d, id: d.id || undefined }), 'Set created');
  });
  on('#cf-add', async () => {
    const d = await ask([
      { label: 'Entity', name: 'entity', options: ENTITIES }, opt({ label: 'Set ID (none for guarantors and collateral)', name: 'setId' }),
      { label: 'Name', name: 'name' }, opt({ label: 'ID (blank: from the name)', name: 'id' }),
      { label: 'Type', name: 'type', options: ['FREE_TEXT', 'SELECTION', 'NUMBER', 'CHECKBOX', 'DATE', 'DATE_TIME', 'MEMBER_LINK', 'USER_LINK'] },
      { label: 'Selection options, one per line: id|label|score|parent', name: 'options', type: 'textarea', rows: 4, required: false },
      opt({ label: 'Depends on (a selection field in the set)', name: 'dependentOn' }), opt({ label: 'Format (free text)', name: 'format' }),
      { label: 'Unique value', name: 'uniqueValue', options: ['false', 'true'] },
      { label: 'Usage', name: 'usage', options: ['AVAILABLE', 'DEFAULT', 'REQUIRED'] },
      opt({ label: 'Only for these products, channels or client types (comma separated; blank: all)', name: 'items' }),
      opt({ label: 'Roles that may edit (comma separated; blank: all)', name: 'editRoles' }),
      opt({ label: 'Roles that may view (comma separated; blank: all)', name: 'viewRoles' }),
    ], 'New custom field');
    if (!d) return;
    const flags = { default: d.usage !== 'AVAILABLE', required: d.usage === 'REQUIRED' };
    const items = listOf(d.items);
    const options = String(d.options || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [id, label, score, parent] = l.split('|').map((x) => (x || '').trim());
      return { id, label: label || id, ...(score ? { score: Number(score) } : {}), ...(parent ? { parent } : {}) };
    });
    done(await api('POST', '/api/custom-fields/definitions', {
      entity: d.entity, setId: d.setId || undefined, name: d.name, id: d.id || undefined, type: d.type, options: options.length ? options : undefined,
      dependentOn: d.dependentOn || undefined, format: d.format || undefined, uniqueValue: d.uniqueValue === 'true',
      availableForAll: !items.length, usage: items.length ? { items: Object.fromEntries(items.map((i) => [i, flags])) } : flags,
      editRoles: rolesOf(d.editRoles), viewRoles: rolesOf(d.viewRoles),
    }), 'Custom field created');
  });
  each('cf', async (id) => {
    const dd = (defs.body || []).find((x) => x.id === id);
    done(await api('PATCH', `/api/custom-fields/definitions/${id}`, { isActive: !dd.is_active }), dd.is_active ? 'Deactivated' : 'Activated');
  });
  const docProduct = () => ask([{ label: 'Product kind', name: 'kind', options: ['loan', 'savings'] }, { label: 'Product ID', name: 'productId' }], 'Product');
  const showDocs = async (kind, productId) => {
    const r = await api('GET', `/api/documents/templates/${kind}/${productId}`);
    if (!r.ok) return toast(r.error, true);
    $('#org-docs').innerHTML = `<h3>${esc(kind)} product ${esc(productId)}</h3>${table([
      { label: 'Name', key: 'name' }, { label: 'For', key: 'availability' },
      { label: '', html: true, value: (x) => `<button class="link" data-doc-edit="${esc(x.id)}">edit</button> <button class="link" data-doc-del="${esc(x.id)}">delete</button>` },
    ], r.body, { empty: 'No templates' })}`;
    view().querySelectorAll('[data-doc-edit]').forEach((b) => b.addEventListener('click', async () => {
      const t = (await api('GET', `/api/documents/templates/${b.dataset.docEdit}`)).body;
      const d = await ask([{ label: 'Name', name: 'name', value: t.name }, { label: 'Content (HTML with placeholders)', name: 'content', type: 'textarea', rows: 14, value: t.content }], `Template ${t.name}`);
      if (!d) return;
      const res = await api('PATCH', `/api/documents/templates/${t.id}`, d);
      toast(res.ok ? 'Template saved' : res.error, !res.ok);
      if (res.ok) showDocs(kind, productId);
    }));
    view().querySelectorAll('[data-doc-del]').forEach((b) => b.addEventListener('click', async () => {
      const res = await api('DELETE', `/api/documents/templates/${b.dataset.docDel}`);
      toast(res.ok ? 'Template deleted' : res.error, !res.ok);
      if (res.ok) showDocs(kind, productId);
    }));
    return null;
  };
  on('#doc-list', async () => { const d = await docProduct(); if (d) showDocs(d.kind, d.productId); });
  on('#doc-add', async () => {
    const d = await ask([{ label: 'Product kind', name: 'kind', options: ['loan', 'savings'] }, { label: 'Product ID', name: 'productId' },
      { label: 'Name', name: 'name' }, { label: 'For', name: 'availability', options: ['ACCOUNT', 'TRANSACTION'] },
      { label: 'Content (HTML with placeholders)', name: 'content', type: 'textarea', rows: 12, required: false,
        value: '<h1>{{organization.name}}</h1>\n<p>{{member.fullName}} · {{account.accountNo}}</p>' }], 'New document template');
    if (!d) return;
    const res = await api('POST', `/api/documents/templates/${d.kind}/${d.productId}`, { name: d.name, availability: d.availability, content: d.content });
    toast(res.ok ? 'Template created' : res.error, !res.ok);
    if (res.ok) showDocs(d.kind, d.productId);
  });
}

// --------------------------------------------------------------------------
// Data: import, backups, dictionary, extract (the reference platform's Data Management)
// --------------------------------------------------------------------------

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const dataState = { table: 'members' };

async function dataView() {
  const role = S.user.role;
  const owner = role === 'TENANT_ADMIN';
  const importer = ['TENANT_ADMIN', 'MANAGER'].includes(role);
  const [imps, backups, dict, streams, prereq] = await Promise.all([
    ['TENANT_ADMIN', 'MANAGER', 'AUDITOR'].includes(role) ? api('GET', '/api/data-imports') : Promise.resolve({ ok: false, body: [] }),
    owner ? api('GET', '/api/database/backup') : Promise.resolve({ ok: false, body: [] }),
    api('GET', '/api/data-dictionary'),
    ['TENANT_ADMIN', 'ACCOUNTANT', 'AUDITOR'].includes(role) ? api('GET', '/api/extract') : Promise.resolve({ ok: false, body: [] }),
    importer ? api('GET', '/api/data-imports/prerequisites') : Promise.resolve({ ok: false, body: [] }),
  ]);
  const missing = (prereq.ok ? prereq.body : []).filter((p) => !p.ok);
  const tables = dict.ok ? dict.body.tables : [];
  const t = tables.find((x) => x.name === dataState.table) || tables[0];
  const importRows = imps.ok ? imps.body : [];
  view().innerHTML = `
    <div class="toolbar"><h1>Data</h1></div>
    <p class="hint">Data import, database backups, the data dictionary and the incremental extract, after the reference platform's Data Management pages.</p>
    ${importer ? card('Import from Excel', `
      <p class="hint">Download the template, fill in the sheets you need, and upload it. The template also reads the reference platform's layout
      (Clients, Savings Accounts, Loan Schedules, Loan Transactions, Chart of Accounts, dd.MM.yyyy dates). The upload is checked
      row by row and run without saving anything; nothing is created until it is approved.</p>
      ${missing.length ? `<p class="notice" id="imp-prereq">Set up first: ${esc(missing.map((p) => p.item).join(', '))}.</p>` : ''}
      <button class="secondary" id="imp-template">Download template</button>
      <label>Workbook (.xlsx, up to 5 MB)<input type="file" id="imp-file" accept=".xlsx,${XLSX_TYPE}"></label>
      <button id="imp-upload">Upload and check</button>
      <div id="imp-progress" hidden><progress max="100" value="0"></progress> <span class="hint"></span></div>
      <div id="imp-list">${table([
    { label: 'Uploaded', value: (x) => String(x.created_at).slice(0, 16).replace('T', ' ') },
    { label: 'File', key: 'file_name' },
    { label: 'Migration date', value: (x) => day(x.as_of) },
    { label: 'Status', value: (x) => (['QUEUED', 'IN_PROGRESS'].includes(x.status) ? `${x.status} ${x.progress}%` : x.import_state === 'DRAFT' ? 'Draft (pending approval)' : x.import_state === 'REVERTED' ? 'Reverted (rejected)' : x.status) },
    { label: 'Errors', num: true, value: (x) => (x.errors || []).length },
    { label: 'Warnings', num: true, value: (x) => (x.warnings || []).length },
    { label: 'By', key: 'created_by' },
    { label: '', html: true, value: (x) => `<button class="link" data-imp="${esc(x.id)}">review</button>` },
  ], importRows, { empty: 'No imports yet' })}</div>`) : ''}
    ${owner ? card('Database backup', `
      <p class="hint">A ZIP of one CSV per table from one snapshot, with the schema and the data dictionary. One runs at a time; each is kept for 30 days.
      Member PINs and portal sessions are never included.</p>
      <button id="bk-run">Back up now</button> <button class="secondary" id="bk-some">Back up some tables…</button>
      <div id="bk-list">${table([
    { label: 'Requested', value: (x) => String(x.created_at).slice(0, 16).replace('T', ' ') },
    { label: 'Status', key: 'status' },
    { label: 'Tables', value: (x) => (x.tables ? x.tables.join(', ') : 'all') },
    { label: 'From', value: (x) => (x.from_date ? String(x.from_date).slice(0, 16).replace('T', ' ') : '') },
    { label: 'Size', num: true, value: (x) => (x.file_size ? `${Math.ceil(x.file_size / 1024)} KB` : '') },
    { label: 'Expires', value: (x) => day(x.expires_at) },
    { label: '', html: true, value: (x) => (x.status === 'COMPLETE' ? `<button class="link" data-bk="${esc(x.id)}" data-name="${esc(x.file_name)}">download</button>` : esc(x.error || '')) },
  ], backups.ok ? backups.body : [], { empty: 'No backups yet' })}</div>`) : ''}
    ${card('Data dictionary', `
      <p class="hint">${esc(dict.body?.conventions?.dates || '')}</p>
      <label>Table<select id="dd-table">${tables.map((x) => `<option ${x.name === t?.name ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <p id="dd-desc">${esc(t?.description || '')}</p>
      <div id="dd-cols">${t ? table([
    { label: 'Column', key: 'name' }, { label: 'Type', key: 'type' },
    { label: 'Null', value: (c) => (c.nullable ? 'yes' : '') },
    { label: 'Key', value: (c) => (c.primaryKey ? 'PK' : c.references ? `→ ${c.references.table}.${c.references.column}` : '') },
    { label: 'Description', key: 'description' },
  ], t.columns) : ''}</div>
      <button class="secondary" id="dd-csv">Download as CSV</button>`)}
    ${streams.ok ? card('Incremental extract', `
      <p class="hint">For a data warehouse or Stitch: GET /api/extract/&lt;stream&gt;?cursor=… returns rows changed since the cursor, in order,
      with the next cursor. bin/tap-sacco.js is a Singer tap over it; run it with a user in the AUDITOR role.</p>
      ${table([{ label: 'Stream', key: 'stream' }, { label: 'Key', value: (x) => x.keyProperties.join(', ') },
    { label: 'Read on', key: 'replicationKey' }, { label: 'Holds', key: 'description' }], streams.body)}`) : ''}`;

  el('dd-table')?.addEventListener('change', (ev) => { dataState.table = ev.target.value; render(); });
  el('dd-csv')?.addEventListener('click', () => openFile('/api/data-dictionary?format=csv', 'data-dictionary.csv', { save: true }));
  el('imp-template')?.addEventListener('click', () => openFile('/api/data-imports/template', 'data-import-template.xlsx', { save: true }));
  el('imp-upload')?.addEventListener('click', async () => {
    const file = el('imp-file').files[0];
    if (!file) return toast('Choose a workbook first', true);
    const r = await apiRaw('POST', `/api/data-imports?fileName=${encodeURIComponent(file.name)}`, file, XLSX_TYPE);
    if (!r.ok) return toast(r.error, true);
    // The check runs in the background: show its progress until it is done.
    const bar = el('imp-progress');
    bar.hidden = false;
    let x = r.body;
    while (['QUEUED', 'IN_PROGRESS'].includes(x.status)) {
      $('progress', bar).value = x.progress || 0;
      $('span', bar).textContent = `${x.status === 'QUEUED' ? 'Queued' : 'Checking'}: ${x.progress || 0}%`;
      await new Promise((ok) => setTimeout(ok, 400));
      const g = await api('GET', `/api/data-imports/${x.id}`);
      if (!g.ok) return toast(g.error, true);
      x = g.body;
    }
    $('progress', bar).value = 100;
    toast(x.status === 'PENDING_APPROVAL' ? 'Checked: ready for review' : `${(x.errors || []).length} errors: download the workbook with the errors marked`, x.status !== 'PENDING_APPROVAL');
    await render();
    return showImport(x.id);
  });
  view().querySelectorAll('[data-imp]').forEach((b) => b.addEventListener('click', () => showImport(b.dataset.imp)));
  el('bk-run')?.addEventListener('click', async () => {
    const r = await api('POST', '/api/database/backup', {});
    toast(r.ok ? 'Backup started; it appears here when it is ready' : r.error, !r.ok);
    setTimeout(() => { if (S.view === 'data') render(); }, 1500);
  });
  el('bk-some')?.addEventListener('click', async () => {
    const d = await ask([
      { name: 'tables', label: 'Tables, comma separated', value: 'members, loan_accounts, savings_accounts' },
      { name: 'from', label: 'Only rows created or changed from (optional)', type: 'datetime-local', required: false },
    ], 'Back up some tables');
    if (!d) return;
    const r = await api('POST', '/api/database/backup', {
      tables: d.tables.split(',').map((x) => x.trim()).filter(Boolean),
      ...(d.from ? { createBackupFromDate: new Date(d.from).toISOString() } : {}),
    });
    toast(r.ok ? 'Backup started' : r.error, !r.ok);
    setTimeout(() => { if (S.view === 'data') render(); }, 1500);
  });
  view().querySelectorAll('[data-bk]').forEach((b) => b.addEventListener('click', () => openFile(`/api/database/backup/${b.dataset.bk}/file`, b.dataset.name, { save: true })));
}

async function showImport(id) {
  const r = await api('GET', `/api/data-imports/${id}`);
  if (!r.ok) return toast(r.error, true);
  const x = r.body;
  const owner = S.user.role === 'TENANT_ADMIN';
  const creates = x.summary?.created || x.summary?.creates || {};
  const dlg = document.createElement('dialog');
  dlg.id = 'import-review';
  const shown = x.import_state === 'DRAFT' ? 'Draft (pending approval)' : x.import_state === 'REVERTED' ? 'Reverted (rejected)' : x.status;
  dlg.innerHTML = `<div class="card wide"><h2>${esc(x.file_name)}: ${esc(shown)}</h2>
    <dl class="kv"><dt>Migration date</dt><dd>${esc(day(x.as_of))}</dd><dt>Uploaded by</dt><dd>${esc(x.created_by)}</dd>
    ${x.decided_by ? `<dt>Decided by</dt><dd>${esc(x.decided_by)} ${esc(x.decision_note || '')}</dd>` : ''}</dl>
    ${Object.keys(creates).length ? `<h3>${x.status === 'APPROVED' ? 'Created' : 'Will create'}</h3>${table([{ label: 'What', key: 'k' }, { label: 'Count', num: true, key: 'n' }],
    Object.entries(creates).map(([k, n]) => ({ k, n })))}` : ''}
    ${(x.warnings || []).length ? `<h3>Warnings</h3>${table([{ label: 'Sheet', key: 'sheet' }, { label: 'Row', key: 'row' }, { label: 'Warning', key: 'message' }], x.warnings)}` : ''}
    ${(x.errors || []).length ? `<h3>Errors</h3>${table([{ label: 'Sheet', key: 'sheet' }, { label: 'Row', key: 'row' }, { label: 'Column', key: 'column' }, { label: 'Error', key: 'message' }], x.errors.slice(0, 200))}` : ''}
    ${x.has_preview ? '<h3>Preview</h3><p class="hint">The records approval will create, as they will be.</p><div id="imp-kinds" class="toolbar"></div><div id="imp-preview"></div>' : ''}
    <menu class="dialog-actions">
      ${x.has_error_file ? '<button class="secondary" data-act="errors">Download with errors marked</button>' : ''}
      ${owner && ['PENDING_APPROVAL', 'INVALID'].includes(x.status) ? '<button class="secondary" data-act="reject">Reject</button>' : ''}
      ${owner && x.status === 'PENDING_APPROVAL' ? '<button data-act="approve">Approve</button>' : ''}
      <button class="secondary" data-act="close">Close</button>
    </menu></div>`;
  document.body.appendChild(dlg);
  if (x.has_preview) {
    const k = await api('GET', `/api/data-imports/${x.id}/preview`);
    const kinds = Object.entries(k.body?.kinds || {}).filter(([, n]) => n > 0);
    $('#imp-kinds', dlg).innerHTML = kinds.map(([kind, n]) => `<button class="secondary" data-kind="${esc(kind)}">${esc(kind)} (${n})</button>`).join(' ');
    const show = async (kind) => {
      const p = await api('GET', `/api/data-imports/${x.id}/preview?kind=${encodeURIComponent(kind)}&limit=100`);
      const items = p.body?.items || [];
      const cols = Object.keys(items[0] || {}).filter((c) => c !== 'schedule');
      const box = $('#imp-preview', dlg);
      box.innerHTML = `${table(cols.map((c) => ({ label: c, value: (r) => (Array.isArray(r[c]) ? r[c].join('; ') : r[c]) })), items, { onRow: kind === 'loans' ? 'imp' : null })}
        ${p.body.total > items.length ? `<p class="hint">First ${items.length} of ${p.body.total}.</p>` : ''}<div id="imp-schedule"></div>`;
      if (kind === 'loans') {
        box.querySelectorAll('tr[data-row]').forEach((tr) => tr.addEventListener('click', () => {
          const l = items[Number(tr.dataset.row)];
          $('#imp-schedule', box).innerHTML = l.schedule ? `<h3>${esc(l.accountNo)} schedule</h3>${table([
            { label: '#', key: 'number' }, { label: 'Due', value: (i) => day(i.due_date) }, { label: 'Status', key: 'status' },
            { label: 'Principal', num: true, value: (i) => `${money(i.principal_paid)} / ${money(i.principal_due)}` },
            { label: 'Interest', num: true, value: (i) => `${money(i.interest_paid)} / ${money(i.interest_due)}` },
            { label: 'Fees', num: true, value: (i) => `${money(i.fee_paid)} / ${money(i.fee_due)}` },
            { label: 'Late fee exempt', value: (i) => (i.late_fee_exempt ? 'yes' : '') }], l.schedule)}` : '<p class="hint">Schedule not kept in the preview for this loan.</p>';
        }));
        box.querySelectorAll('tr[data-row]').forEach((tr) => tr.classList.add('clickable'));
      }
    };
    $('#imp-kinds', dlg).addEventListener('click', (ev) => { if (ev.target.dataset.kind) show(ev.target.dataset.kind); });
    if (kinds.length) await show(kinds.find(([kd]) => kd === 'loans')?.[0] || kinds[0][0]);
  }
  dlg.addEventListener('click', async (ev) => {
    const act = ev.target.dataset?.act;
    if (!act) return;
    if (act === 'close') { dlg.close(); dlg.remove(); return; }
    if (act === 'errors') { openFile(`/api/data-imports/${x.id}/errors`, `${x.file_name.replace(/\.xlsx$/i, '')}-errors.xlsx`, { save: true }); return; }
    const d = await ask([{ name: 'note', label: act === 'approve' ? 'Note for the approval' : 'Why is it rejected?', required: act !== 'approve' }],
      act === 'approve' ? 'Approve the import' : 'Reject the import');
    if (!d) return;
    const res = await api('POST', `/api/data-imports/${x.id}/${act}`, { note: d.note || null });
    toast(res.ok ? (act === 'approve' ? 'Imported' : 'Rejected') : (res.body?.importErrors ? `Approval failed: ${res.body.importErrors.length} errors` : res.error), !res.ok);
    dlg.close(); dlg.remove();
    render();
  });
  dlg.showModal();
  return null;
}

// --------------------------------------------------------------------------
// Users (the reference platform's Users and Access Control)
// --------------------------------------------------------------------------

/** A read-only table in a dialog (sign-in history, key shown once and the like). */
function showDialog(title, inner) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<div class="card wide"><h2>${esc(title)}</h2>${inner}<menu class="dialog-actions"><button id="dlg-close">Close</button></menu></div>`;
  document.body.appendChild(dlg);
  $('#dlg-close', dlg).addEventListener('click', () => { dlg.close(); dlg.remove(); });
  dlg.showModal();
  return dlg;
}

const LIMIT_FIELDS = [['approvalLimit', 'approval_limit', 'Loan approval'], ['disbursementLimit', 'disbursement_limit', 'Loan disbursement'],
  ['feeLimit', 'fee_limit', 'Fee application'], ['depositLimit', 'deposit_limit', 'Deposits'], ['withdrawalLimit', 'withdrawal_limit', 'Withdrawals'],
  ['repaymentLimit', 'repayment_limit', 'Repayments']];

async function usersView() {
  const [users, roles, branches, rc] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/users/roles'), api('GET', '/api/branches'), rolesCard()]);
  if (!users.ok) throw new Error(users.error);
  const branchCode = new Map((branches.body || []).map((b) => [b.id, b.code]));
  const edit = can('EDIT_USER');
  view().innerHTML = `
    <div class="toolbar"><h1>Users</h1>${can('CREATE_USER') ? '<button id="user-add">New user</button>' : ''}</div>
    <p class="hint">Staff who sign in to the back office. A new user, and one whose password is reset, gets a temporary password shown once
    that must be changed at the first sign-in. Deactivating a user ends their sessions at once; a user locked out by failed sign-ins is unlocked here.
    A teller or credit officer belongs to a branch; a user sees every branch or only the ones given.</p>
    <div id="users-list">${table([
    { label: 'Email', key: 'email' }, { label: 'Name', key: 'full_name' }, { label: 'Role', value: (u) => (u.role_code ? `${u.role_code} (${u.role})` : u.role) },
    { label: 'Type', value: (u) => (u.user_type || '').toLowerCase().replace('_', ' ') },
    { label: 'State', html: true, value: (u) => `<span class="badge ${u.state === 'ACTIVE' ? '' : 'bad'}">${esc(u.state)}</span>` },
    { label: 'Branch', value: (u) => branchCode.get(u.branch_id) || '' },
    { label: 'Access', value: (u) => (u.all_branches ? 'all branches' : [u.branch_id, ...(u.branch_access || [])].filter(Boolean).map((id) => branchCode.get(id)).join(', ')) },
    { label: 'Extra permissions', value: (u) => (u.permissions || []).join(', ') },
    { label: 'Second factor', value: (u) => (u.mfa_enabled ? 'on' : '') },
    { label: 'Last sign-in', value: (u) => (u.last_login_at ? String(u.last_login_at).slice(0, 16).replace('T', ' ') : '') },
    { label: '', html: true, value: (u) => [
      edit ? `<button class="link" data-user="${esc(u.id)}">edit</button> <button class="link" data-limits-u="${esc(u.id)}">limits</button>` : '',
      edit && u.locked ? `<button class="link" data-unlock="${esc(u.id)}">unlock</button>` : '',
      S.user.role === 'TENANT_ADMIN' ? `<button class="link" data-reset="${esc(u.id)}">reset password</button>` : '',
      u.mfa_enabled && can('MANAGE_TWO_FACTOR_AUTHENTICATION') ? `<button class="link" data-mfa="${esc(u.id)}">reset second factor</button>` : '',
      `<button class="link" data-logins="${esc(u.id)}">sign-ins</button>`].filter(Boolean).join(' ') },
  ], users.body)}</div>
    ${rc.html}`;
  rc.wire(usersView);
  const roleList = [...new Set([...(roles.body || []), ...(rc.roles || []).map((r) => r.code)])];
  const branchList = ['', ...(branches.body || []).filter((b) => b.status === 'ACTIVE').map((b) => b.code)];
  const shown = (title, secret) => ask([{ name: 'p', label: 'Temporary password (shown once; give it to the user)', value: secret }], title);
  const codes = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  el('user-add')?.addEventListener('click', async () => {
    const d = await ask([
      { name: 'email', label: 'Email', type: 'email' }, { name: 'fullName', label: 'Name', required: false },
      { name: 'role', label: 'Role', options: roleList, value: 'TELLER' },
      { name: 'userType', label: 'User type', options: ['', 'TELLER', 'CREDIT_OFFICER'], value: '', hint: 'Blank: the role\'s. A teller or credit officer needs a branch.' },
      { name: 'branchId', label: 'Branch', options: branchList, value: '' },
    ], 'New user');
    if (!d) return;
    const r = await api('POST', '/api/users', { ...d, branchId: d.branchId || null, userType: d.userType || undefined });
    if (!r.ok) return toast(r.error, true);
    await shown(`${r.body.email} created`, r.body.temporaryPassword);
    render();
  });
  view().querySelectorAll('[data-user]').forEach((b) => b.addEventListener('click', async () => {
    const u = users.body.find((x) => x.id === b.dataset.user);
    const d = await ask([
      { name: 'fullName', label: 'Name', value: u.full_name || '', required: false },
      { name: 'title', label: 'Title', value: u.title || '', required: false },
      { name: 'role', label: 'Role', options: roleList, value: u.role_code || u.role },
      { name: 'userType', label: 'User type', options: ['', 'TELLER', 'CREDIT_OFFICER'], value: u.user_type === 'ADMINISTRATOR' ? '' : u.user_type || '' },
      { name: 'permissions', label: 'Extra permissions (codes, comma separated)', value: (u.permissions || []).join(', '), required: false },
      { name: 'status', label: 'Status', options: ['ACTIVE', 'SUSPENDED'], value: u.status },
      { name: 'branchId', label: 'Branch', options: branchList, value: branchCode.get(u.branch_id) || '' },
      { name: 'allBranches', label: 'Can access every branch', options: ['yes', 'no'], value: u.all_branches ? 'yes' : 'no' },
      { name: 'branches', label: 'Other branches (codes, comma separated)', value: (u.branch_access || []).map((id) => branchCode.get(id)).filter(Boolean).join(', '), required: false },
      { name: 'others', label: 'A credit officer sees other credit officers\' members', options: ['yes', 'no'], value: u.other_officers_clients ? 'yes' : 'no' },
    ], `Edit ${u.email}`);
    if (!d) return;
    const body = {
      fullName: d.fullName, title: d.title, role: d.role, status: d.status, branchId: d.branchId || null,
      permissions: codes(d.permissions).map((x) => x.toUpperCase()),
      accessRights: { allBranches: d.allBranches === 'yes', branches: codes(d.branches), otherCreditOfficersClients: d.others === 'yes' },
    };
    if ((d.userType || null) !== (u.user_type === 'ADMINISTRATOR' ? null : u.user_type || null)) body.userType = d.userType || null;
    let r = await api('PATCH', `/api/users/${u.id}`, body);
    if (!r.ok && /CREDIT_OFFICER_HAS_MEMBERS/.test(r.error) && window.confirm(`${r.error}\n\nDeactivate anyway?`)) {
      r = await api('PATCH', `/api/users/${u.id}`, { ...body, confirmCreditOfficerMembers: true });
    }
    toast(r.ok ? 'Saved' : r.error, !r.ok);
    if (r.ok) render();
  }));
  view().querySelectorAll('[data-limits-u]').forEach((b) => b.addEventListener('click', async () => {
    const u = users.body.find((x) => x.id === b.dataset.limitsU);
    const d = await ask(LIMIT_FIELDS.map(([k, col, label]) => ({ name: k, label: `${label} limit (blank: none)`, type: 'number', step: '0.01', value: u[col] ?? '', required: false })),
      `Transaction limits of ${u.email}`);
    if (!d) return;
    const r = await api('PATCH', `/api/users/${u.id}`, Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === '' ? null : Number(v)])));
    toast(r.ok ? 'Limits saved' : r.error, !r.ok);
    if (r.ok) render();
  }));
  view().querySelectorAll('[data-unlock]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api('POST', `/api/users/${b.dataset.unlock}/unlock`);
    toast(r.ok ? `${r.body.email} unlocked` : r.error, !r.ok);
    if (r.ok) render();
  }));
  view().querySelectorAll('[data-logins]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api('GET', `/api/users/${b.dataset.logins}/logins?limit=50`);
    if (!r.ok) return toast(r.error, true);
    showDialog('Sign-in history', loginsTable(r.body));
    return null;
  }));
  view().querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api('POST', `/api/users/${b.dataset.reset}/reset-password`);
    if (!r.ok) return toast(r.error, true);
    await shown(`Password reset for ${r.body.email}`, r.body.temporaryPassword);
    return render();
  }));
  view().querySelectorAll('[data-mfa]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api('POST', `/api/users/${b.dataset.mfa}/reset-mfa`);
    toast(r.ok ? 'Second factor reset; the user enrols again at the next sign-in' : r.error, !r.ok);
    if (r.ok) render();
  }));
}

const loginsTable = (rows) => table([{ label: 'When', value: (x) => String(x.created_at).replace('T', ' ').slice(0, 19) },
  { label: 'Result', value: (x) => (x.succeeded ? 'signed in' : (x.reason || 'refused').toLowerCase().replace(/_/g, ' ')) },
  { label: 'From', key: 'ip' }, { label: 'Browser', value: (x) => String(x.user_agent || '').slice(0, 60) }], rows, { empty: 'No sign-ins recorded' });

// --------------------------------------------------------------------------
// Access: what the signed-in user may do, from GET /api/auth/me
// --------------------------------------------------------------------------

/** True when the user holds any of the permission codes (an administrator holds them all). */
const can = (...codes) => S.user?.role === 'TENANT_ADMIN' || codes.some((c) => (S.user?.permissions || []).includes(c));

/** Load the user's permissions, hide the pages they may not open, and build their menu items. */
async function loadAccess() {
  const me = await api('GET', '/api/auth/me');
  if (me.ok) S.user = { ...S.user, ...me.body };
  for (const b of el('nav').querySelectorAll('button[data-perm]')) b.hidden = !can(...b.dataset.perm.split(' '));
  await loadMenu();
}

/** The menu items with views (GET /api/menu), as a second row of the navigation. */
async function loadMenu() {
  const m = await api('GET', '/api/menu');
  S.menu = m.ok ? m.body : { fixed: [], items: [] };
  el('menu-nav').innerHTML = S.menu.items.map((i) => `<button data-menu-item="${esc(i.id)}" class="${S.view === 'menu' && S.menuItem === i.id ? 'active' : ''}">${esc(i.name)}</button>`).join('');
}

el('menu-nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-menu-item]');
  if (!b) return;
  S.view = 'menu';
  S.menuItem = b.dataset.menuItem;
  for (const n of el('nav').children) n.classList.remove('active');
  for (const n of el('menu-nav').children) n.classList.toggle('active', n === b);
  render();
});

/** The tenant's role codes (built-in and its own), for usage rights. */
async function roleCodes() {
  const r = await api('GET', '/api/roles');
  return r.ok ? r.body.map((x) => x.code) : ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT', 'TELLER', 'AUDITOR'];
}

/** A usage rights editor inside a dialog of its own: all users, or the roles picked. */
async function usageRightsDialog(title, rights, codes) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog" class="card"><h2>${esc(title)}</h2>
      <label class="check"><input type="checkbox" name="allUsers" ${rights.allUsers ? 'checked' : ''}> All users</label>
      <label>Or the roles<select name="roles" multiple size="${Math.min(8, codes.length)}">${codes.map((c) => `<option ${rights.roles.includes(c) ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <menu class="dialog-actions"><button value="cancel" class="secondary">Cancel</button><button value="ok">Save</button></menu></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => {
      const f = $('form', dlg);
      const out = { allUsers: f.allUsers.checked, roles: [...f.roles.selectedOptions].map((o) => o.value) };
      dlg.remove();
      resolve(dlg.returnValue === 'ok' ? out : null);
    });
    dlg.showModal();
  });
}

// --------------------------------------------------------------------------
// Menu items (the reference platform's Menu Items)
// --------------------------------------------------------------------------

/** The page of one menu item: the views filed under it. */
async function menuView() {
  await loadMenu();
  const item = S.menu.items.find((i) => i.id === S.menuItem);
  if (!item) { S.view = 'views'; return viewsView(); }
  view().innerHTML = `<div class="toolbar"><h1>${esc(item.name)}</h1><span class="hint">${esc(item.type.toLowerCase().replace(/_/g, ' '))}</span></div>
    ${card('Views', item.views.length ? `<ul id="mi-views">${item.views.map((v) => `<li><button class="link" data-open-view="${esc(v.id)}">${esc(v.name)}</button>${v.favourite ? ' <span class="hint">favourite</span>' : ''}</li>`).join('')}</ul>`
    : '<p class="hint">No views are filed here yet. Make one under Views and choose this menu item for it.</p>')}`;
  view().querySelectorAll('[data-open-view]').forEach((b) => b.addEventListener('click', () => {
    viewState.open = b.dataset.openView; viewState.offset = 0; go('views');
  }));
}

/** Menu items, managed on the Views page: add, rename, share, move and delete. */
async function menuItemsCard(ents) {
  const admin = S.user.role === 'TENANT_ADMIN';
  const items = (S.menu?.items || []);
  const rows = items.map((i, k) => ({ ...i, k }));
  return card('Menu items', `<p class="hint">Views are filed under menu items, which show as the second row of the navigation.
    ${admin ? 'An administrator shares items with roles and puts them in order.' : 'Items you make are yours until an administrator shares them.'}</p>
    <div id="mi-list">${table([
    { label: 'Name', key: 'name' }, { label: 'Kind', value: (i) => (ents.find((e) => e.entity === i.type)?.label || i.type) },
    { label: 'Views', num: true, value: (i) => i.views.length },
    { label: 'Shared', value: (i) => (i.usageRights.allUsers ? 'all users' : i.usageRights.roles.join(', ')) },
    { label: '', html: true, value: (i) => [
      admin && i.k > 0 ? `<button class="link" data-mi-up="${esc(i.id)}">up</button>` : '',
      admin && i.k < rows.length - 1 ? `<button class="link" data-mi-down="${esc(i.id)}">down</button>` : '',
      i.canEdit ? `<button class="link" data-mi-edit="${esc(i.id)}">rename</button>` : '',
      admin ? `<button class="link" data-mi-share="${esc(i.id)}">share</button>` : '',
      i.canEdit && !i.predefined ? `<button class="link" data-mi-del="${esc(i.id)}">delete</button>` : ''].filter(Boolean).join(' ') },
  ], rows, { empty: 'No menu items' })}</div>
    <button class="secondary" id="mi-new">New menu item</button>`);
}

function wireMenuItems(ents, reload) {
  const items = S.menu?.items || [];
  const on = (attr, fn) => view().querySelectorAll(`[${attr}]`).forEach((b) => b.addEventListener('click', () => fn(b.getAttribute(attr))));
  const done = async (r, msg) => { toast(r.ok ? msg : r.error, !r.ok); if (r.ok) { await loadMenu(); reload(); } };
  $('#mi-new')?.addEventListener('click', async () => {
    const d = await ask([{ name: 'name', label: 'Name (at most 32 characters)' },
      { name: 'type', label: 'Kind of record', options: ents.map((e) => e.entity), value: ents[0]?.entity }], 'New menu item');
    if (!d) return;
    done(await api('POST', '/api/menu-items', d), 'Menu item added');
  });
  on('data-mi-edit', async (id) => {
    const i = items.find((x) => x.id === id);
    const d = await ask([{ name: 'name', label: 'Name', value: i.name }], `Rename ${i.name}`);
    if (d) done(await api('PATCH', `/api/menu-items/${id}`, d), 'Renamed');
  });
  on('data-mi-share', async (id) => {
    const i = items.find((x) => x.id === id);
    const rights = await usageRightsDialog(`Who sees ${i.name}`, i.usageRights, await roleCodes());
    if (rights) done(await api('PATCH', `/api/menu-items/${id}`, { usageRights: rights }), 'Usage rights saved');
  });
  on('data-mi-del', async (id) => {
    if (!window.confirm('Delete this menu item? Its views stay.')) return;
    done(await api('DELETE', `/api/menu-items/${id}`), 'Menu item deleted');
  });
  const move = async (id, by) => {
    const ids = items.map((x) => x.id);
    const k = ids.indexOf(id);
    [ids[k], ids[k + by]] = [ids[k + by], ids[k]];
    done(await api('PUT', '/api/menu-items/order', { ids }), 'Moved');
  };
  on('data-mi-up', (id) => move(id, -1));
  on('data-mi-down', (id) => move(id, 1));
}

// --------------------------------------------------------------------------
// Tasks (the reference platform's Tasks and the Your Tasks widget)
// --------------------------------------------------------------------------

const taskState = { status: 'OPEN', due: '', mine: true, offset: 0, limit: 25 };

async function newTask(prefill = {}) {
  const [tpl, users] = await Promise.all([api('GET', '/api/tasks/templates'),
    can('VIEW_USER_DETAILS') ? api('GET', '/api/users') : Promise.resolve({ ok: false })]);
  const templates = tpl.ok ? tpl.body : [];
  const emails = users.ok ? users.body.filter((u) => u.status === 'ACTIVE').map((u) => u.email) : [S.user.email];
  if (!emails.includes(S.user.email)) emails.unshift(S.user.email);
  const d = await ask([
    ...(templates.length ? [{ name: 'template', label: 'Template', options: ['', ...templates.map((t) => t.name)], value: '' }] : []),
    { name: 'title', label: 'Title', hint: 'Leave blank to take the template\'s title', required: !templates.length },
    { name: 'description', label: 'Description', type: 'textarea', rows: 3, required: false },
    { name: 'memberId', label: 'Member number', value: prefill.memberNo || '', required: false },
    { name: 'assignedTo', label: 'Assigned to', options: emails, value: S.user.email },
    { name: 'dueDate', label: 'Due', type: 'date', value: today() },
  ], 'New task');
  if (!d) return false;
  const body = { ...d };
  for (const k of ['template', 'title', 'description', 'memberId']) if (!body[k]) delete body[k];
  const r = await api('POST', '/api/tasks', body);
  toast(r.ok ? `Task added: ${r.body.title}` : r.error, !r.ok);
  return r.ok;
}

async function taskAction(t, action) {
  const r = action === 'delete' ? await api('DELETE', `/api/tasks/${t.id}`) : await api('POST', `/api/tasks/${t.id}/${action}`);
  toast(r.ok ? (action === 'complete' ? 'Task completed' : action === 'reopen' ? 'Task reopened' : 'Task deleted') : r.error, !r.ok);
  return r.ok;
}

const TASK_COLUMNS = (actions) => [
  { label: 'Task', key: 'title' }, { label: 'Member', value: (t) => (t.member ? `${t.member.memberNo} ${t.member.name}` : '') },
  { label: 'Assigned to', key: 'assignedTo' }, { label: 'Due', key: 'dueDate' },
  { label: 'State', html: true, value: (t) => `<span class="badge ${t.state === 'OVERDUE' ? 'bad' : ''}">${esc(t.state)}</span>` },
  { label: '', html: true, value: actions },
];

function wireTasks(list, reload) {
  view().querySelectorAll('[data-task]').forEach((b) => b.addEventListener('click', async () => {
    const t = list.find((x) => x.id === b.dataset.task);
    if (b.dataset.act === 'delete' && !window.confirm('Delete this task?')) return;
    if (await taskAction(t, b.dataset.act)) reload();
  }));
}

const taskButtons = (t) => [
  can('EDIT_TASK') && t.status === 'OPEN' ? `<button class="link" data-task="${esc(t.id)}" data-act="complete">complete</button>` : '',
  can('EDIT_TASK') && t.status === 'COMPLETED' ? `<button class="link" data-task="${esc(t.id)}" data-act="reopen">reopen</button>` : '',
  can('DELETE_TASK') ? `<button class="link" data-task="${esc(t.id)}" data-act="delete">delete</button>` : ''].filter(Boolean).join(' ');

async function tasksView() {
  const T = taskState;
  const qs = new URLSearchParams({ offset: T.offset, limit: T.limit });
  if (T.status) qs.set('status', T.status);
  if (T.due) qs.set('due', T.due);
  if (T.mine) qs.set('assignedTo', S.user.email);
  const [list, tpl] = await Promise.all([api('GET', `/api/tasks?${qs}`), api('GET', '/api/tasks/templates')]);
  if (!list.ok) throw new Error(list.error);
  const total = list.total;
  const templates = tpl.ok ? tpl.body : [];
  view().innerHTML = `<div class="toolbar"><h1>Tasks</h1>${can('CREATE_TASK') ? '<button id="task-new">New task</button>' : ''}</div>
    <div class="toolbar">
      <label>Status<select id="task-status">${['', 'OPEN', 'COMPLETED'].map((s) => `<option value="${s}" ${T.status === s ? 'selected' : ''}>${s || 'Any'}</option>`).join('')}</select></label>
      <label>Due<select id="task-due">${['', 'OVERDUE', 'TODAY', 'UPCOMING'].map((s) => `<option value="${s}" ${T.due === s ? 'selected' : ''}>${s || 'Any time'}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" id="task-mine" ${T.mine ? 'checked' : ''}> Assigned to me</label>
    </div>
    <div id="task-list">${table(TASK_COLUMNS(taskButtons), list.body, { empty: 'No tasks' })}</div>
    ${pager(T, total)}
    ${card('Task templates', `<p class="hint">A template fills a task's title and description. Placeholders such as {MEMBER_NAME} take the linked member's details.</p>
      ${table([{ label: 'Name', key: 'name' }, { label: 'Title', key: 'title' }, { label: 'Content', key: 'content' },
    { label: '', html: true, value: (t) => (can('EDIT_COMMUNICATION_TEMPLATES') ? `<button class="link" data-tpl-edit="${esc(t.id)}">edit</button> <button class="link" data-tpl-del="${esc(t.id)}">delete</button>` : '') }], templates, { empty: 'No templates' })}
      ${can('CREATE_COMMUNICATION_TEMPLATES') ? '<button class="secondary" id="tpl-new">New template</button>' : ''}`)}`;
  wirePager(T, tasksView);
  wireTasks(list.body, tasksView);
  $('#task-status').addEventListener('change', (e) => { T.status = e.target.value; T.offset = 0; tasksView(); });
  $('#task-due').addEventListener('change', (e) => { T.due = e.target.value; T.offset = 0; tasksView(); });
  $('#task-mine').addEventListener('change', (e) => { T.mine = e.target.checked; T.offset = 0; tasksView(); });
  $('#task-new')?.addEventListener('click', async () => { if (await newTask()) tasksView(); });
  const tplForm = async (t = {}) => ask([{ name: 'name', label: 'Name', value: t.name || '' }, { name: 'title', label: 'Task title', value: t.title || '' },
    { name: 'content', label: 'Task description', type: 'textarea', rows: 4, value: t.content || '', required: false }], t.id ? `Edit ${t.name}` : 'New task template');
  $('#tpl-new')?.addEventListener('click', async () => {
    const d = await tplForm();
    if (!d) return;
    const r = await api('POST', '/api/tasks/templates', d);
    toast(r.ok ? 'Template saved' : r.error, !r.ok);
    if (r.ok) tasksView();
  });
  view().querySelectorAll('[data-tpl-edit]').forEach((b) => b.addEventListener('click', async () => {
    const d = await tplForm(templates.find((t) => t.id === b.dataset.tplEdit));
    if (!d) return;
    const r = await api('PATCH', `/api/tasks/templates/${b.dataset.tplEdit}`, d);
    toast(r.ok ? 'Template saved' : r.error, !r.ok);
    if (r.ok) tasksView();
  }));
  view().querySelectorAll('[data-tpl-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!window.confirm('Delete this template?')) return;
    const r = await api('DELETE', `/api/tasks/templates/${b.dataset.tplDel}`);
    toast(r.ok ? 'Template deleted' : r.error, !r.ok);
    if (r.ok) tasksView();
  }));
}

/** The member page's tasks: open tasks linked to the member, and a new one. */
async function memberTasks(m) {
  if (!can('VIEW_TASK')) return;
  const r = await api('GET', `/api/tasks?memberId=${encodeURIComponent(m.id)}&status=OPEN&limit=20`);
  if (!r.ok) return;
  const box = document.createElement('div');
  box.id = 'member-tasks';
  box.innerHTML = card('Tasks', `${table(TASK_COLUMNS(taskButtons).filter((c) => c.label !== 'Member'), r.body, { empty: 'No open tasks' })}
    ${can('CREATE_TASK') ? '<button class="secondary" id="mt-new">New task</button>' : ''}`);
  view().appendChild(box);
  const again = () => memberDetail(m);
  wireTasks(r.body, again);
  $('#mt-new')?.addEventListener('click', async () => { if (await newTask({ memberNo: m.member_no })) again(); });
}

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

function wireTills(list, reload) {
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

const TILL_COLUMNS = (actions = tillButtons) => [
  { label: 'Till', key: 'tillId' }, { label: 'Teller', value: (t) => t.teller.name || t.teller.email },
  { label: 'Branch', value: (t) => t.branch?.code || '' }, { label: 'Status', key: 'status' },
  { label: 'Opening', num: true, value: (t) => money(t.openingAmount) },
  { label: 'Expected cash', num: true, html: true, value: (t) => `${money(t.expectedCash)}${t.outsideLimits ? ' <span class="badge bad">outside limits</span>' : ''}` },
  { label: 'Difference', num: true, value: (t) => (t.difference === null ? '' : money(t.difference)) },
  { label: '', html: true, value: actions },
];

async function openTill(reload) {
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

async function tillsView() {
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
function telleringCard(mine) {
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

// --------------------------------------------------------------------------
// Roles (the reference platform's Roles), managed on the Users page
// --------------------------------------------------------------------------

async function roleEditor(role, catalog) {
  return new Promise((resolve) => {
    const has = new Set(role.permissions || []);
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog" class="card wide" id="role-form"><h2>${esc(role.code ? `Role ${role.code}` : 'New role')}</h2>
      ${role.code ? '' : '<label>Code<input name="code" required pattern="[A-Z][A-Z0-9_]{1,31}" placeholder="LOAN_OFFICER"></label>'}
      <label>Name<input name="name" value="${esc(role.name || '')}" required></label>
      <label>Base role<select name="baseRole" ${role.builtin ? 'disabled' : ''}>${['MANAGER', 'ACCOUNTANT', 'TELLER', 'AUDITOR', 'TENANT_ADMIN'].map((b) => `<option ${b === (role.baseRole || 'TELLER') ? 'selected' : ''}>${b}</option>`).join('')}</select>
        <span class="hint">Its starting permissions, and the role lists that name built-in roles.</span></label>
      <label>User type<select name="userType" ${role.builtin ? 'disabled' : ''}>${['', 'ADMINISTRATOR', 'TELLER', 'CREDIT_OFFICER'].map((u) => `<option value="${u}" ${u === (role.userType || '') ? 'selected' : ''}>${u || '(none)'}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="reference" ${role.accessRights?.reference === false ? '' : 'checked'} ${role.code === 'TENANT_ADMIN' ? 'disabled' : ''}> Back office access (sign in with a password)</label>
      <label class="check"><input type="checkbox" name="api" ${role.accessRights?.api === false ? '' : 'checked'}> API access (may be given to an API consumer)</label>
      <div class="perm-groups">${catalog.map((g) => `<fieldset><legend>${esc(g.group)}</legend>${g.permissions.map((p) => `<label class="check" title="${esc(p.code)}">
        <input type="checkbox" name="perm" value="${esc(p.code)}" ${has.has(p.code) ? 'checked' : ''} ${role.code === 'TENANT_ADMIN' ? 'disabled' : ''}> ${esc(p.label)}${p.platform ? ' <span class="hint">(this platform)</span>' : ''}</label>`).join('')}</fieldset>`).join('')}</div>
      <label>Notes<input name="notes" value="${esc(role.notes || '')}"></label>
      <menu class="dialog-actions"><button value="cancel" class="secondary">Cancel</button><button value="ok">Save role</button></menu></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => {
      const f = $('form', dlg);
      const out = {
        ...(role.code ? {} : { code: f.code.value.trim().toUpperCase() }), name: f.name.value, notes: f.notes.value || null,
        ...(role.builtin ? {} : { baseRole: f.baseRole.value, userType: f.userType.value || null }),
        ...(role.code === 'TENANT_ADMIN' ? {} : { permissions: [...f.querySelectorAll('input[name=perm]:checked')].map((i) => i.value) }),
        accessRights: { reference: role.code === 'TENANT_ADMIN' ? true : f.reference.checked, api: f.api.checked },
      };
      dlg.remove();
      resolve(dlg.returnValue === 'ok' ? out : null);
    });
    dlg.showModal();
  });
}

async function rolesCard() {
  if (!can('VIEW_ROLE')) return { html: '', wire: () => {} };
  const [roles, cat] = await Promise.all([api('GET', '/api/roles'), api('GET', '/api/roles/permissions')]);
  if (!roles.ok) return { html: '', wire: () => {} };
  const html = card('Roles', `<p class="hint">A role is a set of permissions. The five built-in roles can be edited, not deleted; a SACCO's own roles sit on a base role.
    A user's own extra permissions are added to their role's.</p>
    <div id="roles-list">${table([{ label: 'Code', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Base role', key: 'baseRole' },
    { label: 'User type', key: 'userType' }, { label: 'Permissions', num: true, value: (r) => r.permissions.length }, { label: 'Users', num: true, key: 'users' },
    { label: '', html: true, value: (r) => `${can('EDIT_ROLE') ? `<button class="link" data-role="${esc(r.code)}">edit</button>` : ''}${can('DELETE_ROLE') && !r.builtin && !r.users ? ` <button class="link" data-role-del="${esc(r.code)}">delete</button>` : ''}` }], roles.body)}</div>
    ${can('CREATE_ROLE') ? '<button class="secondary" id="role-add">New role</button>' : ''}`);
  const wire = (reload) => {
    $('#role-add')?.addEventListener('click', async () => {
      const d = await roleEditor({ permissions: [] }, cat.body);
      if (!d) return;
      const r = await api('POST', '/api/roles', d);
      toast(r.ok ? `Role ${r.body.code} added` : r.error, !r.ok);
      if (r.ok) reload();
    });
    view().querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', async () => {
      const role = roles.body.find((x) => x.code === b.dataset.role);
      const d = await roleEditor(role, cat.body);
      if (!d) return;
      const r = await api('PATCH', `/api/roles/${role.code}`, d);
      toast(r.ok ? 'Role saved' : r.error, !r.ok);
      if (r.ok) reload();
    }));
    view().querySelectorAll('[data-role-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!window.confirm(`Delete role ${b.dataset.roleDel}?`)) return;
      const r = await api('DELETE', `/api/roles/${b.dataset.roleDel}`);
      toast(r.ok ? 'Role deleted' : r.error, !r.ok);
      if (r.ok) reload();
    }));
  };
  return { html, wire, roles: roles.body };
}

// --------------------------------------------------------------------------
// Report templates (in place of the reference platform's Jasper reports)
// --------------------------------------------------------------------------

/** Ask for a template's parameters, then run it and show the result. */
async function runTemplate(t, recordId = null) {
  let parameters = {};
  if (t.parameters.length) {
    const d = await ask(t.parameters.map((p) => ({
      name: p.name, label: p.label || p.name, required: Boolean(p.required),
      type: p.type === 'DATE' ? 'date' : p.type === 'NUMBER' ? 'number' : 'text',
      ...(p.type === 'SELECTION' ? { options: ['', ...(p.options || [])] } : {}),
      ...(p.type === 'BOOLEAN' ? { options: ['', 'true', 'false'] } : {}),
      value: ['TODAY', 'MONTH_START', 'YEAR_START'].includes(p.default) ? '' : (p.default ?? ''),
      hint: p.default && ['TODAY', 'MONTH_START', 'YEAR_START'].includes(p.default) ? `Blank: ${p.default.toLowerCase().replace('_', ' ')}` : undefined,
    })), `Run ${t.name}`);
    if (!d) return;
    parameters = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== ''));
  }
  const body = { parameters, recordId };
  const r = await api('POST', `/api/report-templates/${t.id}/run`, body);
  if (!r.ok) return toast(r.error, true);
  const x = r.body;
  const dlg = document.createElement('dialog');
  dlg.id = 'report-run';
  const show = (v, c) => (c.num && typeof v === 'number' ? money(v) : v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v);
  dlg.innerHTML = `<div class="card wide"><h2>${esc(x.title)}</h2>
    <p class="hint">${Object.entries(x.parameters || {}).map(([k, v]) => `${esc(k)}: ${esc(v ?? '')}`).join(' · ')}</p>
    ${x.sections.map((s) => `${s.title ? `<h3>${esc(s.title)}</h3>` : ''}${s.type === 'TEXT' ? `<p>${esc(s.text)}</p>`
    : s.type === 'FIELDS' ? `<dl class="kv">${s.columns.map((c) => `<dt>${esc(c.label)}</dt><dd>${esc(show((s.rows[0] || {})[c.key], c))}</dd>`).join('')}</dl>`
      : table(s.columns.map((c) => ({ label: c.label, num: c.num, value: (row) => show(row[c.key], c) })), s.totals ? [...s.rows, Object.fromEntries(s.columns.map((c, i) => [c.key, s.totals[c.key] ?? (i === 0 ? 'Total' : '')]))] : s.rows)}
      ${s.truncated ? `<p class="hint">First ${s.rows.length} of ${s.total} rows.</p>` : ''}`).join('')}
    ${x.footer ? `<p class="hint">${esc(x.footer)}</p>` : ''}
    <menu class="dialog-actions">${['pdf', 'html', ...(can('EXPORT_TO_EXCEL') ? ['xlsx', 'csv'] : [])].map((f) => `<button class="secondary" data-rt-fmt="${f}">${f.toUpperCase()}</button>`).join('')}
      <button id="rt-close">Close</button></menu></div>`;
  document.body.appendChild(dlg);
  $('#rt-close', dlg).addEventListener('click', () => { dlg.close(); dlg.remove(); });
  dlg.querySelectorAll('[data-rt-fmt]').forEach((b) => b.addEventListener('click', async () => {
    const fmt = b.dataset.rtFmt;
    const res = await fetch(`/api/report-templates/${t.id}/run?format=${fmt}`, {
      method: 'POST', headers: { authorization: `Bearer ${S.access}`, 'x-tenant': S.tenant, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) return toast(`Could not make the ${fmt.toUpperCase()}`, true);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    if (fmt === 'html') a.target = '_blank'; else a.download = `${String(t.name).replace(/\s+/g, '-').toLowerCase()}.${fmt}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return null;
  }));
  dlg.showModal();
}

/** Other reports: the templates not tied to a record, and managing all templates. */
async function templatesReport(out) {
  const r = await api('GET', '/api/report-templates');
  if (!r.ok) { out.innerHTML = `<p class="error">${esc(r.error)}</p>`; return; }
  const list = r.body;
  const manage = can('CREATE_REPORTS', 'EDIT_REPORTS', 'DELETE_REPORTS');
  out.innerHTML = `<p class="hint">Report templates are JSON files: sections built from custom views and the built-in reports, with parameters.
    Member, loan, deposit, branch and centre templates run from their record's page; Other templates run here. Each runs with the reader's own permissions.</p>
    <div id="rt-list">${table([{ label: 'Name', key: 'name' }, { label: 'On', value: (t) => t.reportType.toLowerCase() }, { label: 'Description', key: 'description' },
    { label: 'Shared', value: (t) => (t.usageRights.allUsers ? 'all users' : t.usageRights.roles.join(', ')) },
    { label: '', html: true, value: (t) => [t.reportType === 'OTHER' ? `<button class="link" data-rt-run="${esc(t.id)}">run</button>` : '',
      `<button class="link" data-rt-dl="${esc(t.id)}">template</button>`,
      can('EDIT_REPORTS') ? `<button class="link" data-rt-edit="${esc(t.id)}">replace</button> <button class="link" data-rt-share="${esc(t.id)}">share</button>` : '',
      can('DELETE_REPORTS') ? `<button class="link" data-rt-del="${esc(t.id)}">delete</button>` : ''].filter(Boolean).join(' ') }], list, { empty: 'No report templates yet' })}</div>
    ${manage && can('CREATE_REPORTS') ? `<div class="toolbar"><label>Upload a template<input type="file" id="rt-file" accept=".json,application/json"></label>
      <label>On<select id="rt-type">${['OTHER', 'MEMBER', 'LOAN', 'DEPOSIT', 'BRANCH', 'CENTRE'].map((x) => `<option>${x}</option>`).join('')}</select></label></div>` : ''}`;
  const reload = () => templatesReport(out);
  const on = (attr, fn) => out.querySelectorAll(`[${attr}]`).forEach((b) => b.addEventListener('click', () => fn(list.find((t) => t.id === b.getAttribute(attr)))));
  on('data-rt-run', (t) => runTemplate(t));
  on('data-rt-dl', (t) => openFile(`/api/report-templates/${t.id}/template`, `${t.fileName || t.name}.json`.replace(/\.json\.json$/, '.json'), { save: true }));
  on('data-rt-del', async (t) => {
    if (!window.confirm(`Delete ${t.name}?`)) return;
    const d = await api('DELETE', `/api/report-templates/${t.id}`);
    toast(d.ok ? 'Template deleted' : d.error, !d.ok);
    if (d.ok) reload();
  });
  on('data-rt-share', async (t) => {
    const rights = await usageRightsDialog(`Who sees ${t.name}`, t.usageRights, await roleCodes());
    if (!rights) return;
    const d = await api('PATCH', `/api/report-templates/${t.id}`, { usageRights: rights });
    toast(d.ok ? 'Usage rights saved' : d.error, !d.ok);
    if (d.ok) reload();
  });
  const pick = () => new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = '.json,application/json';
    i.addEventListener('change', () => resolve(i.files[0] || null));
    i.click();
  });
  const readJson = async (file) => { try { return JSON.parse(await file.text()); } catch { toast('That file is not JSON', true); return null; } };
  on('data-rt-edit', async (t) => {
    const file = await pick();
    const def = file && await readJson(file);
    if (!def) return;
    const d = await api('PATCH', `/api/report-templates/${t.id}`, { definition: def, fileName: file.name });
    toast(d.ok ? 'Template replaced' : d.error, !d.ok);
    if (d.ok) reload();
  });
  $('#rt-file', out)?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const def = file && await readJson(file);
    if (!def) return;
    const d = await api('POST', '/api/report-templates', {
      name: def.name || def.title || file.name.replace(/\.json$/i, ''), reportType: $('#rt-type', out).value,
      description: def.description || null, definition: def, fileName: file.name,
    });
    toast(d.ok ? `Template ${d.body.name} added` : d.error, !d.ok);
    if (d.ok) reload();
  });
}

/** The Reports card on a record's page: the templates for that kind of record. */
async function entityReports(type, recordId) {
  if (!can('VIEW_REPORTS')) return;
  const r = await api('GET', `/api/report-templates?type=${type}`);
  if (!r.ok || !r.body.length) return;
  const box = document.createElement('div');
  box.id = 'entity-reports';
  box.innerHTML = card('Reports', `<ul>${r.body.map((t) => `<li><button class="link" data-er="${esc(t.id)}">${esc(t.name)}</button>${t.description ? ` <span class="hint">${esc(t.description)}</span>` : ''}</li>`).join('')}</ul>`);
  view().appendChild(box);
  box.querySelectorAll('[data-er]').forEach((b) => b.addEventListener('click', () => runTemplate(r.body.find((t) => t.id === b.dataset.er), recordId)));
}

// --------------------------------------------------------------------------
// Access administration (the reference platform's Administration > Access)
// --------------------------------------------------------------------------

const auditState = { username: '', resource: '', code: '', offset: 0, limit: 50 };

async function accessView() {
  const parts = await Promise.all([
    can('MANAGE_ACCESS_PREFERENCES') ? api('GET', '/api/access-preferences') : Promise.resolve(null),
    can('MANAGE_ACCESS_PREFERENCES') ? api('GET', '/api/access-preferences/blocked-ips') : Promise.resolve(null),
    can('VIEW_API_CONSUMERS_AND_KEYS') ? api('GET', '/api/consumers') : Promise.resolve(null),
    can('VIEW_ROLE') ? roleCodes() : Promise.resolve([]),
  ]);
  const [prefs, ips, consumers, codes] = parts;
  const p = prefs?.ok ? prefs.body : null;
  view().innerHTML = `<h1>Access</h1>
    ${p ? card('Preferences', `<form id="ap-form" class="grid">
      <label>Sign out after minutes without activity<input name="sessionTimeoutMinutes" type="number" min="5" max="1440" value="${p.sessionTimeoutMinutes}"></label>
      <label>Password length at least<input name="minLength" type="number" min="8" value="${p.password.minLength}"></label>
      <label>Digits at least<input name="minDigits" type="number" min="1" value="${p.password.minDigits}"></label>
      <label>Capital letters at least<input name="minUppercase" type="number" min="0" value="${p.password.minUppercase}"></label>
      <label>Symbols at least<input name="minSpecial" type="number" min="0" value="${p.password.minSpecial}"></label>
      <label>Previous passwords refused<input name="history" type="number" min="1" max="10" value="${p.password.history}"></label>
      <label>Passwords expire after days (blank: never)<input name="expiryDays" type="number" min="1" value="${p.password.expiryDays ?? ''}"></label>
      <label>Lock after failed sign-ins (3 to 6)<input name="maxFailedLogins" type="number" min="3" max="6" value="${p.lockout.maxFailedLogins}"></label>
      <label>Locked for minutes (blank: until unlocked)<input name="lockMinutes" type="number" min="15" value="${p.lockout.lockMinutes ?? ''}"></label>
      <label class="check"><input type="checkbox" name="reauthenticate" ${p.reauthenticate ? 'checked' : ''}> Ask for the password again on critical actions</label>
      <label class="check"><input type="checkbox" name="ipEnabled" ${p.ipAllowlist.enabled ? 'checked' : ''}> Only let in from these addresses</label>
      <label>Addresses (one per line: 10.0.0.5, 10.0.0.*, 10.0.0.1-25, 10.0.0.0/24)<textarea name="ipEntries" rows="3">${esc(p.ipAllowlist.entries.join('\n'))}</textarea></label>
      <label>For<select name="applyTo" multiple size="3">${['ADMINS', 'USERS', 'API'].map((x) => `<option ${p.ipAllowlist.applyTo.includes(x) ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label>Roles that need a second factor<select name="mfaRoles" multiple size="5">${codes.map((x) => `<option ${p.mfaRequiredRoles.includes(x) ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
      <label>Grace period for rotated API keys, seconds<input name="grace" type="number" min="0" value="${p.apiKeys.rotationGraceSeconds}"></label>
      <label>Keep the audit trail for days<input name="retention" type="number" min="30" value="${p.auditRetentionDays}"></label>
      <div class="toolbar"><button type="submit">Save preferences</button></div></form>`) : ''}
    ${ips?.ok ? card('Blocked addresses', `<p class="hint">An address that sends ten requests with a bad API key is blocked for API keys until it is reset here.</p>
      <div id="ap-ips">${table([{ label: 'Address', key: 'ip' }, { label: 'Bad keys', num: true, key: 'failures' },
    { label: 'Blocked', value: (x) => (x.blocked_at ? String(x.blocked_at).slice(0, 16).replace('T', ' ') : '') },
    { label: '', html: true, value: (x) => `<button class="link" data-ip="${esc(x.ip)}">reset</button>` }], ips.body, { empty: 'No blocked addresses' })}</div>`) : ''}
    ${consumers?.ok ? card('API consumers', `<p class="hint">An API consumer makes API keys, sent in the apiKey header. A key has the consumer's access and is shown once.</p>
      <div id="ac-list">${table([{ label: 'Name', key: 'name' },
    { label: 'Access', value: (c) => (c.access.administrator ? 'administrator' : [c.access.role, ...c.access.permissions].filter(Boolean).join(', ')) },
    { label: 'Status', key: 'status' },
    { label: 'Keys', value: (c) => c.keys.map((k) => `${k.prefix}… ${k.state.toLowerCase().replace(/_/g, ' ')}`).join('; ') },
    { label: '', html: true, value: (c) => [can('CREATE_API_CONSUMERS_AND_KEYS') ? `<button class="link" data-ac-key="${esc(c.id)}">new key</button> <button class="link" data-ac-secret="${esc(c.id)}">secret key</button>` : '',
      can('DELETE_API_CONSUMERS_AND_KEYS') ? c.keys.map((k) => `<button class="link" data-ac-delkey="${esc(c.id)}:${esc(k.id)}">delete ${esc(k.prefix)}…</button>`).join(' ') : '',
      can('EDIT_API_CONSUMERS_AND_KEYS') ? `<button class="link" data-ac-status="${esc(c.id)}">${c.status === 'ACTIVE' ? 'deactivate' : 'activate'}</button>` : '',
      can('DELETE_API_CONSUMERS_AND_KEYS') ? `<button class="link" data-ac-del="${esc(c.id)}">delete</button>` : ''].filter(Boolean).join(' ') }], consumers.body, { empty: 'No API consumers' })}</div>
      ${can('CREATE_API_CONSUMERS_AND_KEYS') ? '<button class="secondary" id="ac-new">New API consumer</button>' : ''}`) : ''}
    ${can('MANAGE_AUDIT_TRAIL') ? card('Audit trail', `<p class="hint">Every request by staff and API consumers, with personal details and secrets taken out.</p>
      <div class="toolbar"><label>User<input id="at-user" value="${esc(auditState.username)}" placeholder="email"></label>
        <label>Resource<input id="at-res" value="${esc(auditState.resource)}" placeholder="members, loans, auth"></label>
        <label>Status<input id="at-code" value="${esc(auditState.code)}" placeholder="403"></label><button id="at-run">Search</button></div>
      <div id="at-out"><p class="hint">Loading…</p></div>`) : ''}`;
  if (!view().querySelector('.card')) view().innerHTML += '<p class="hint">Your role has no access administration.</p>';
  const reload = () => accessView();
  $('#ap-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const n = (v) => (v === '' ? null : Number(v));
    const r = await api('PATCH', '/api/access-preferences', {
      sessionTimeoutMinutes: Number(f.sessionTimeoutMinutes.value),
      password: { minLength: Number(f.minLength.value), minDigits: Number(f.minDigits.value), minUppercase: Number(f.minUppercase.value),
        minSpecial: Number(f.minSpecial.value), history: Number(f.history.value), expiryDays: n(f.expiryDays.value) },
      lockout: { maxFailedLogins: Number(f.maxFailedLogins.value), lockMinutes: n(f.lockMinutes.value) },
      reauthenticate: f.reauthenticate.checked,
      ipAllowlist: { enabled: f.ipEnabled.checked, entries: f.ipEntries.value.split(/\s+/).filter(Boolean), applyTo: [...f.applyTo.selectedOptions].map((o) => o.value) },
      mfaRequiredRoles: [...f.mfaRoles.selectedOptions].map((o) => o.value),
      apiKeys: { rotationGraceSeconds: Number(f.grace.value) }, auditRetentionDays: Number(f.retention.value),
    });
    toast(r.ok ? 'Access preferences saved' : r.error, !r.ok);
    if (r.ok) reload();
  });
  view().querySelectorAll('[data-ip]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api('POST', '/api/access-preferences/blocked-ips/reset', { ips: [b.dataset.ip] });
    toast(r.ok ? 'Address reset' : r.error, !r.ok);
    if (r.ok) reload();
  }));
  $('#ac-new')?.addEventListener('click', async () => {
    const d = await ask([{ name: 'name', label: 'Name' }, { name: 'role', label: 'Role', options: ['', ...codes], value: '' },
      { name: 'permissions', label: 'Or permissions (codes, comma separated)', required: false },
      ...(S.user.role === 'TENANT_ADMIN' ? [{ name: 'administrator', label: 'Administrator', options: ['no', 'yes'], value: 'no' }] : [])], 'New API consumer');
    if (!d) return;
    const r = await api('POST', '/api/consumers', { name: d.name, access: { role: d.role || null, administrator: d.administrator === 'yes',
      permissions: String(d.permissions || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) } });
    toast(r.ok ? `API consumer ${r.body.name} added` : r.error, !r.ok);
    if (r.ok) reload();
  });
  const on = (attr, fn) => view().querySelectorAll(`[${attr}]`).forEach((b) => b.addEventListener('click', () => fn(b.getAttribute(attr))));
  on('data-ac-key', async (id) => {
    const d = await ask([{ name: 'ttl', label: 'Expires after seconds (blank: never)', type: 'number', required: false }], 'New API key');
    if (!d) return;
    const r = await api('POST', `/api/consumers/${id}/keys`, { expirationTime: d.ttl === '' ? undefined : Number(d.ttl) });
    if (!r.ok) return toast(r.error, true);
    showDialog('API key (shown once)', `<p class="hint">Store it now; it cannot be shown again.</p><p class="mono" id="ac-key-value">${esc(r.body.apiKey)}</p>`);
    reload();
  });
  on('data-ac-secret', async (id) => {
    if (!window.confirm('Make a new secret key? The old one stops working.')) return;
    const r = await api('POST', `/api/consumers/${id}/secret-key`);
    if (!r.ok) return toast(r.error, true);
    showDialog('Secret key (shown once)', `<p class="hint">Used only to rotate keys (POST /api/consumers/keys/rotation, secretKey header).</p><p class="mono">${esc(r.body.secretKey)}</p>`);
  });
  on('data-ac-delkey', async (v) => {
    const [cid, kid] = v.split(':');
    if (!window.confirm('Delete this key? It stops working at once.')) return;
    const r = await api('DELETE', `/api/consumers/${cid}/keys/${kid}`);
    toast(r.ok ? 'Key deleted' : r.error, !r.ok);
    if (r.ok) reload();
  });
  on('data-ac-status', async (id) => {
    const c = consumers.body.find((x) => x.id === id);
    const r = await api('PATCH', `/api/consumers/${id}`, { status: c.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' });
    toast(r.ok ? 'Saved' : r.error, !r.ok);
    if (r.ok) reload();
  });
  on('data-ac-del', async (id) => {
    if (!window.confirm('Delete this API consumer and its keys?')) return;
    const r = await api('DELETE', `/api/consumers/${id}`);
    toast(r.ok ? 'API consumer deleted' : r.error, !r.ok);
    if (r.ok) reload();
  });
  const runAudit = async () => {
    const A = auditState;
    const qs = new URLSearchParams({ from: A.offset, size: A.limit });
    if (A.username) qs.set('username[contains]', A.username);
    if (A.resource) qs.set('resource[eq]', A.resource);
    if (A.code) qs.set('response_code[eq]', A.code);
    const r = await api('GET', `/api/audit-trail/events?${qs}`);
    const out = el('at-out');
    if (!out) return;
    if (!r.ok) { out.innerHTML = `<p class="error">${esc(r.error)}</p>`; return; }
    out.innerHTML = table([{ label: 'When', value: (x) => String(x.occurred_at).replace('T', ' ').slice(0, 19) }, { label: 'Source', key: 'event_source' },
      { label: 'User', key: 'username' }, { label: 'Request', value: (x) => `${x.request_method} ${x.request_uri}` }, { label: 'Status', num: true, key: 'response_code' },
      { label: 'From', key: 'client_ip' }, { label: 'Body', value: (x) => String(x.request_payload || '').slice(0, 80) }], r.body.events, { empty: 'Nothing matches' })
      + `<p class="hint">${r.body.totalItemsCount} event(s)</p>`;
  };
  $('#at-run')?.addEventListener('click', () => {
    auditState.username = $('#at-user').value.trim(); auditState.resource = $('#at-res').value.trim(); auditState.code = $('#at-code').value.trim();
    runAudit();
  });
  if (can('MANAGE_AUDIT_TRAIL')) runAudit();
}

/** Your own profile (the reference platform's Edit Your Profile) and sign-in history. */
async function profileDialog() {
  const [me, logins] = await Promise.all([api('GET', '/api/profile'), api('GET', '/api/auth/logins?limit=20')]);
  if (!me.ok) return toast(me.error, true);
  const u = me.body;
  const d = await ask([{ name: 'fullName', label: 'Name', value: u.full_name || '', required: false },
    { name: 'title', label: 'Title', value: u.title || '', required: false },
    { name: 'phone', label: 'Phone', value: u.phone || '', required: false },
    { name: 'language', label: 'Language', options: ['en', 'sw'], value: u.language || 'en' },
    { name: 'currentPassword', label: 'To change your password: the current one', type: 'password', required: false },
    { name: 'newPassword', label: 'and the new one', type: 'password', required: false }],
  `Your profile: ${u.email} (${u.role_code || u.role}${u.user_type ? `, ${u.user_type.toLowerCase().replace('_', ' ')}` : ''})`);
  if (d) {
    const { currentPassword, newPassword, ...profile } = d;
    const r = await api('PATCH', '/api/profile', profile);
    toast(r.ok ? 'Profile saved' : r.error, !r.ok);
    if (r.ok) S.user.name = r.body.full_name || S.user.name;
    if (newPassword) {
      const c = await api('POST', '/api/auth/password', { currentPassword, newPassword });
      if (!c.ok) return toast(c.error, true);
      toast('Password changed; sign in again');
      return signOut(true);
    }
  }
  if (logins.ok) showDialog('Your recent sign-ins', loginsTable(logins.body));
  return null;
}

/** Critical actions (access preferences): the password again, for five minutes. */
async function reauthenticate() {
  const d = await ask([{ name: 'password', label: 'Your password', type: 'password' }], 'Confirm it is you');
  if (!d) return false;
  const r = await api('POST', '/api/auth/reauth', { password: d.password }, { retry: false, reauth: false });
  if (!r.ok) { toast(r.error, true); return false; }
  S.reauth = { token: r.body.reauthToken, until: Date.now() + (r.body.expiresIn - 10) * 1000 };
  return true;
}

const VIEWS = {
  access: accessView,
  menu: menuView,
  tasks: tasksView,
  tills: tillsView,
  dashboard: dashboardView,
  views: viewsView,
  members: membersView,
  groups: groupsView,
  data: dataView,
  users: usersView,
  organization: orgView,
  controls: controlsView,
  products: productsView,
  loans: loansView,
  teller: tellerView,
  reports: reportsView,
  finance: financeView,
  returns: returnsView,
  accounting: accountingView,
};
