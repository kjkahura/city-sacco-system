/**
 * The console's shared state, DOM helpers and API client.
 *
 * Tokens live in memory. The refresh token goes in sessionStorage so a page
 * reload does not sign a teller out mid-transaction, and it dies with the
 * tab. Nothing is written to localStorage, because a shared branch machine
 * would keep it.
 */

import { reauthenticate, signOut } from './session.js';

export const S = {
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

export const $ = (sel, root = document) => root.querySelector(sel);
export const el = (id) => document.getElementById(id);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export const money = (n) => (n === null || n === undefined || n === ''
  ? '' : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/** A page's filter from the navigation, or null when the page was called another way (a reload after an action, an event). */
export const navFilter = (f) => (f && Object.getPrototypeOf(f) === Object.prototype ? f : null);

export const day = (d) => (d ? String(d).slice(0, 10) : '');
// The organization's day, in its own time zone, as the server counts it.
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: S.sacco?.timezone || 'Africa/Nairobi' }).format(new Date());

export function toast(message, bad = false) {
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
export async function api(method, path, body, { retry = true, reauth = true, ifMatch = null } = {}) {
  const headers = { 'content-type': 'application/json' };
  // The version the change was made from (lib/versioning): refused with 412 if the record changed since.
  if (ifMatch) headers['if-match'] = ifMatch;
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
    if (ok) return api(method, path, body, { retry: false, reauth, ifMatch });
  }
  // A critical action with re-authentication on: the password, then once more.
  if (res.status === 403 && reauth && /^REAUTHENTICATION_REQUIRED/.test(payload?.errors?.[0]?.errorReason || '')) {
    if (await reauthenticate()) return api(method, path, body, { retry, reauth: false, ifMatch });
  }

  markEnvironment(res.headers.get('x-environment'));
  const out = {
    ok: res.ok,
    status: res.status,
    body: payload,
    total: Number(res.headers.get('items-total') || 0),
    etag: res.headers.get('etag'),
    // A report read from the reporting replica says how current it is (db/tenantContext withTenantReport).
    asAt: res.headers.get('data-source') === 'replica' ? res.headers.get('data-as-at') : null,
    error: res.ok ? null : (payload?.errors?.[0]?.errorReason || `HTTP ${res.status}`),
  };
  if (!res.ok && res.status === 401) {
    signOut(true);
    if (S.timedOut) { toast('Signed out after a time without activity', true); S.timedOut = false; }
  }
  return out;
}

/**
 * The "Sandbox Environment" bar, as on the reference platform: shown on every
 * page while the console talks to a sandbox, from the X-Environment header.
 */
export function markEnvironment(env) {
  if (!env) return;
  let bar = el('env-banner');
  if (!bar) {
    if (env !== 'SANDBOX') return;
    bar = document.createElement('div');
    bar.id = 'env-banner';
    bar.className = 'env-banner';
    bar.setAttribute('role', 'status');
    bar.textContent = 'Sandbox Environment';
    document.body.appendChild(bar);
  }
  bar.hidden = env !== 'SANDBOX';
  document.body.classList.toggle('sandbox', env === 'SANDBOX');
}

/** A file sent as the raw request body (an attachment), with the session's headers. */
export async function apiRaw(method, path, bytes, type) {
  const headers = { 'content-type': type || 'application/octet-stream' };
  if (S.tenant) headers['x-tenant'] = S.tenant;
  if (S.access) headers.authorization = `Bearer ${S.access}`;
  const res = await fetch(path, { method, headers, body: bytes });
  let payload = null;
  try { payload = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, body: payload, error: res.ok ? null : (payload?.errors?.[0]?.errorReason || `HTTP ${res.status}`) };
}

/** Fetch a file with the session's headers and open it (preview) or save it. */
export async function openFile(path, name, { save = false } = {}) {
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

export async function refreshSession() {
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
