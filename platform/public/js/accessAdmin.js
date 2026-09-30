/**
 * Access administration: access preferences and the audit of access.
 */

import { $, S, api, el, esc, toast } from './base.js';
import { ask, card, table, view } from './ui.js';
import { showDialog } from './users.js';
import { can, roleCodes } from './access.js';

// --------------------------------------------------------------------------
// Access administration (the reference platform's Administration > Access)
// --------------------------------------------------------------------------

const auditState = { username: '', resource: '', code: '', offset: 0, limit: 50 };

export async function accessView() {
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
      <label class="check"><input type="checkbox" name="requireUserAgent" ${p.requireUserAgent ? 'checked' : ''}> Refuse requests without a User-Agent header</label>
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
      apiKeys: { rotationGraceSeconds: Number(f.grace.value) }, auditRetentionDays: Number(f.retention.value), requireUserAgent: f.requireUserAgent.checked,
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
      { label: 'From', key: 'client_ip' }, { label: 'Body', value: (x) => String(x.request_payload || '').slice(0, 80) },
      { label: 'Response', value: (x) => String(x.response_payload || '').slice(0, 80) }], r.body.events, { empty: 'Nothing matches' })
      + `<p class="hint">${r.body.totalItemsCount} event(s)</p>`;
  };
  $('#at-run')?.addEventListener('click', () => {
    auditState.username = $('#at-user').value.trim(); auditState.resource = $('#at-res').value.trim(); auditState.code = $('#at-code').value.trim();
    runAudit();
  });
  if (can('MANAGE_AUDIT_TRAIL')) runAudit();
}
