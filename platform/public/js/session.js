/**
 * Signing in and out, the session across a reload, the user's own profile,
 * and confirming a critical action with the password again.
 */

import { S, api, el, toast } from './base.js';
import { ask } from './ui.js';
import { showHeaderIcon } from './organization.js';
import { loginsTable, showDialog } from './users.js';
import { loadAccess } from './access.js';
import { go, openFromHash } from './nav.js';

export function start(session) {
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
    if (location.hash && location.hash !== '#') openFromHash(); else go(S.view || 'members', {}, { replace: true });
  });
}

export function signOut(silent) {
  S.access = null; S.refresh = null; S.user = null;
  sessionStorage.removeItem('refresh');
  el('app').hidden = true;
  el('login').hidden = false;
  el('mfa-code').hidden = true;
  S.mfaTicket = null;
  if (!silent) toast('Signed out');
}

/** Your own profile (the reference platform's Edit Your Profile) and sign-in history. */
export async function profileDialog() {
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
export async function reauthenticate() {
  const d = await ask([{ name: 'password', label: 'Your password', type: 'password' }], 'Confirm it is you');
  if (!d) return false;
  const r = await api('POST', '/api/auth/reauth', { password: d.password }, { retry: false, reauth: false });
  if (!r.ok) { toast(r.error, true); return false; }
  S.reauth = { token: r.body.reauthToken, until: Date.now() + (r.body.expiresIn - 10) * 1000 };
  return true;
}
