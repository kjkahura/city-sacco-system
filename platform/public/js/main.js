/**
 * SACCO back office.
 *
 * Plain JavaScript against the same API everything else uses. No build
 * step, no framework, no bundle: the console is served from public/ and
 * what is on disk is what runs, which matters for a system whose users may
 * have to audit it.
 *
 * This is the entry module (index.html loads it). It wires the sign-in form
 * and the navigation and resumes a session across a reload. The rest are ES
 * modules beside it, each importing what it uses:
 *
 *   base.js      state, DOM helpers, the API client
 *   session.js   start, sign out, profile, reauthentication
 *   ui.js        tables, pagers, cards, dialogs, the schedule editor
 *   menuDef.js   the menus, their entries and the Administration tabs, as data
 *   topbar.js    the top bar drawn from menuDef.js
 *   nav.js       the pages the navigation opens, and the address hash
 *   access.js    what the signed-in user may do, the menu
 *   one module per page or record: members, accounts, groups, loans,
 *   collections, teller, reports, dashboard, views, finance, products,
 *   depositProducts, accounting, controls, organization, data, users, menu,
 *   tasks, tills, roles, templates, accessAdmin
 */

import { S, api, el, refreshSession, toast } from './base.js';
import { profileDialog, signOut, start } from './session.js';
import { showLoginLogo } from './organization.js';
import { render } from './nav.js';
import { markActive } from './topbar.js';

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

el('whoami').addEventListener('click', () => profileDialog());

el('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout', { refreshToken: S.refresh });
  signOut();
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

el('menu-nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-menu-item]');
  if (!b) return;
  S.view = 'menu';
  S.filter = {};
  S.menuItem = b.dataset.menuItem;
  el('subnav').hidden = true;
  markActive('menu', {});
  for (const n of el('menu-nav').children) n.classList.toggle('active', n === b);
  render();
});
