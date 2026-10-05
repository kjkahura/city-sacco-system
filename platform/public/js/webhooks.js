/**
 * Administration > Webhooks: the webhooks (list, form with a placeholder
 * picker, test, signing secret, the tenant-wide switch) and the
 * communication log (search, a message's body, resend of failed ones).
 */

import { $, S, api, esc, toast } from './base.js';
import { card, pager, table, view, wirePager, wireRows } from './ui.js';
import { can } from './access.js';
import { showDialog } from './users.js';

let catalog = null;
export async function loadCatalog() {
  if (catalog) return catalog;
  const r = await api('GET', '/api/templates/catalog');
  catalog = r.ok ? r.body : { events: {}, placeholders: [], operators: [] };
  return catalog;
}

const admin = () => S.user?.role === 'TENANT_ADMIN';
const badge = (t) => `<span class="badge ${t.activated ? '' : 'bad'}">${t.activated ? 'active' : 'inactive'}</span>`;
const secretDialog = (title, secret) => showDialog(title, `<p>Give this secret to the receiver so it can check each request's
  <code>x-sacco-signature</code>. It is shown this once.</p><pre id="wh-secret" class="secret">${esc(secret)}</pre>
  <p class="hint">The signature is HMAC-SHA256 of "&lt;t&gt;.&lt;body&gt;" with this secret, where t is the header's t value (Unix seconds).</p>`);

// --------------------------------------------------------------------------
// The webhooks
// --------------------------------------------------------------------------

export async function webhooksView() {
  const [r, st] = await Promise.all([api('GET', '/api/templates?type=WEB_HOOK'), admin() ? api('GET', '/api/notificationsettings/webhook') : Promise.resolve(null)]);
  if (!r.ok) throw new Error(r.error);
  const on = st?.body?.state !== 'DISABLED';
  view().innerHTML = `
    <div class="toolbar"><h1>Webhooks</h1><span class="spacer"></span>
      ${st ? `<span id="wh-state" class="badge ${on ? '' : 'bad'}">webhooks ${on ? 'on' : 'off'}</span>
        <button id="wh-switch" class="secondary">${on ? 'Switch off' : 'Switch on'}</button>` : ''}
      ${can('CREATE_COMMUNICATION_TEMPLATES') ? '<button id="wh-new">New webhook</button>' : ''}</div>
    <p class="hint">A webhook sends a request to another system when an event happens. Only a 2xx answer counts as delivered;
      anything else is retried for 24 hours, then shown as failed in the communication log, where it can be resent.</p>
    <div id="wh-list">${table([
    { label: 'Name', key: 'name' }, { label: 'Event', key: 'event' }, { label: 'URL', key: 'url' },
    { label: 'Status', html: true, value: badge },
    { label: 'State', value: (t) => (t.state === 'IN_USE' ? 'in use' : 'not in use') },
    { label: 'Last sent', value: (t) => String(t.lastSentDate || '').replace('T', ' ').slice(0, 16) },
    { label: '', value: (t) => (t.circuit ? 'paused: endpoint failing' : '') },
  ], r.body, { onRow: true, empty: 'No webhooks yet' })}</div>`;
  wireRows(r.body, (t) => webhookEditor(t));
  $('#wh-new')?.addEventListener('click', () => webhookEditor(null));
  $('#wh-switch')?.addEventListener('click', async () => {
    const res = await api('PUT', '/api/notificationsettings/webhook', { state: on ? 'DISABLED' : 'ENABLED' });
    toast(res.ok ? `Webhooks switched ${on ? 'off' : 'on'}` : res.error, !res.ok);
    webhooksView();
  });
}

const headerLines = (list) => (list || []).map((h) => `${h.key}: ${h.value}`).join('\n');
export const conditionLines = (list) => (list || []).map((f) => [f.field, f.filterElement, f.value ?? '', f.secondValue ?? ''].join(' ').trim()).join('\n');
const parseHeaders = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const i = l.indexOf(':');
  return { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
});
export const parseConditions = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const [field, filterElement, value, secondValue] = l.split(/\s+/);
  return { field, filterElement, value: value ?? null, secondValue: secondValue ?? null };
});

async function webhookEditor(t) {
  const cat = await loadCatalog();
  const edit = Boolean(t);
  const events = Object.entries(cat.events).flatMap(([e, targets]) => targets.map((tg) => [`${tg}:${e}`, `${tg}: ${e}`]));
  const chosen = t ? `${t.target}:${t.event}` : '';
  const canEdit = edit ? can('EDIT_COMMUNICATION_TEMPLATES') : can('CREATE_COMMUNICATION_TEMPLATES');
  view().innerHTML = `
    <button class="secondary" id="back">← Webhooks</button>
    <h1>${edit ? esc(t.name) : 'New webhook'} ${edit ? badge(t) : ''}</h1>
    <div class="grid">
      ${card('Event and endpoint', `
        <label>Name<input id="wh-name" value="${esc(t?.name || '')}" maxlength="255"></label>
        <label>Event<select id="wh-event">${events.map(([v, l]) => `<option value="${esc(v)}" ${v === chosen ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label>URL (https)<input id="wh-url" value="${esc(t?.url || '')}" placeholder="https://"></label>
        <label>Request type<select id="wh-method">${['POST', 'PUT', 'PATCH'].map((m) => `<option ${t?.requestType === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label>Content type<select id="wh-ctype">${['JSON', 'XML', 'PLAIN_TEXT'].map((m) => `<option ${t?.contentType === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label>Days before the due date (repayment reminders)<input id="wh-days" type="number" min="0" max="365" value="${esc(t?.triggerDays ?? 0)}"></label>
        <label class="check"><input type="checkbox" id="wh-active" ${!t || t.activated ? 'checked' : ''}> Active</label>`)}
      ${card('Security', `
        <label>Authorization<select id="wh-auth">${['NONE', 'BASIC'].map((m) => `<option ${t?.authorization?.type === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label>Username<input id="wh-user" value="${esc(t?.authorization?.username || '')}"></label>
        <label>Password<input id="wh-pass" type="password" placeholder="${t?.authorization?.passwordSet ? 'kept unless you type a new one' : ''}"></label>
        <label class="check"><input type="checkbox" id="wh-sign" ${!t || t.signingEnabled ? 'checked' : ''}> Sign each request (x-sacco-signature)</label>
        <label>Headers, one "name: value" a line<textarea id="wh-headers" rows="3">${esc(headerLines(t?.headers))}</textarea></label>`)}
    </div>
    ${card('Body', `<label>Body<textarea id="wh-body" rows="10">${esc(t?.body || '')}</textarea></label>
      <p class="hint">Click a placeholder to put it at the cursor. In a JSON body a value is escaped, so put text placeholders inside quotation marks.</p>
      <div id="wh-placeholders" class="chips">${cat.placeholders.map((p) => `<button type="button" class="chip" data-ph="${esc(p)}">${esc(p)}</button>`).join('')}</div>`)}
    ${card('Conditions', `<label>Send only when<select id="wh-link">${['MATCH_ALL', 'MATCH_ANY'].map((m) => `<option ${t?.filtersLinkingOperator === m ? 'selected' : ''} value="${m}">${m === 'MATCH_ALL' ? 'all conditions match' : 'any condition matches'}</option>`).join('')}</select></label>
      <label>Conditions, one "FIELD OPERATOR VALUE [SECOND]" a line (operators: ${esc(cat.operators.join(', '))})<textarea id="wh-conds" rows="3">${esc(conditionLines(t?.filterConstraints))}</textarea></label>`)}
    <div class="toolbar">
      ${canEdit ? '<button id="wh-save">Save</button>' : ''}
      ${edit && can('EDIT_COMMUNICATION_TEMPLATES') ? '<button id="wh-test" class="secondary">Send a test</button> <button id="wh-rotate" class="secondary">New signing secret</button> <button id="wh-delete" class="secondary">Delete</button>' : ''}
    </div>
    <div id="wh-test-out"></div>`;

  $('#back').addEventListener('click', () => webhooksView());
  const body = $('#wh-body');
  view().querySelectorAll('[data-ph]').forEach((b) => b.addEventListener('click', () => {
    const tok = `{{${b.dataset.ph}}}`;
    const at = body.selectionStart ?? body.value.length;
    body.value = body.value.slice(0, at) + tok + body.value.slice(body.selectionEnd ?? at);
    body.focus();
    body.selectionStart = body.selectionEnd = at + tok.length;
  }));
  const collect = () => {
    const [target, event] = $('#wh-event').value.split(':');
    const auth = { type: $('#wh-auth').value, username: $('#wh-user').value.trim() || undefined };
    if ($('#wh-pass').value) auth.password = $('#wh-pass').value;
    return {
      name: $('#wh-name').value, target, event, url: $('#wh-url').value.trim(), requestType: $('#wh-method').value, contentType: $('#wh-ctype').value,
      triggerDays: Number($('#wh-days').value || 0), activated: $('#wh-active').checked, authorization: auth, signingEnabled: $('#wh-sign').checked,
      headers: parseHeaders($('#wh-headers').value), body: body.value, filtersLinkingOperator: $('#wh-link').value, filterConstraints: parseConditions($('#wh-conds').value),
    };
  };
  $('#wh-save')?.addEventListener('click', async () => {
    const b = collect();
    const res = edit
      ? await api('PATCH', `/api/templates/${t.id}`, Object.entries(b).map(([k, v]) => ({ op: 'REPLACE', path: `/${k}`, value: v })))
      : await api('POST', '/api/templates', b);
    if (!res.ok) { toast(res.error, true); return; }
    toast(edit ? 'Webhook saved' : 'Webhook created');
    if (res.body.signingSecret) secretDialog('Signing secret', res.body.signingSecret);
    webhooksView();
  });
  $('#wh-test')?.addEventListener('click', async () => {
    $('#wh-test-out').innerHTML = '<p class="hint">Sending…</p>';
    const res = await api('POST', `/api/templates/${t.id}:test`);
    $('#wh-test-out').innerHTML = res.ok
      ? card('Test', `<dl class="kv" id="wh-test-result"><dt>State</dt><dd>${esc(res.body.state)}</dd>
          <dt>Answer</dt><dd>${esc(res.body.responseStatus ?? '')} ${esc(res.body.failureReason || '')}</dd>
          <dt>Detail</dt><dd>${esc(res.body.failureCause || 'delivered')}</dd></dl><pre>${esc(res.body.body || '')}</pre>`)
      : `<p class="error" id="wh-test-result">${esc(res.error)}</p>`;
  });
  $('#wh-rotate')?.addEventListener('click', async () => {
    const res = await api('POST', `/api/templates/${t.id}:rotateSecret`);
    if (!res.ok) { toast(res.error, true); return; }
    secretDialog('New signing secret', res.body.signingSecret);
  });
  $('#wh-delete')?.addEventListener('click', async () => {
    if (!window.confirm(`Delete the webhook ${t.name}? Its log is kept.`)) return;
    const res = await api('DELETE', `/api/templates/${t.id}`);
    toast(res.ok ? 'Webhook deleted' : res.error, !res.ok);
    if (res.ok) webhooksView();
  });
}

// --------------------------------------------------------------------------
// The communication log
// --------------------------------------------------------------------------

const logState = { offset: 0, limit: 25, type: '', state: '', event: '', from: '', to: '' };

export async function messagesView() {
  const s = logState;
  const criteria = [];
  if (s.type) criteria.push({ field: 'type', operator: 'EQUALS', value: s.type });
  if (s.state) criteria.push({ field: 'state', operator: 'EQUALS', value: s.state });
  if (s.event) criteria.push({ field: 'event', operator: 'EQUALS', value: s.event });
  if (s.from) criteria.push({ field: 'creationDate', operator: 'AFTER_INCLUSIVE', value: s.from });
  if (s.to) criteria.push({ field: 'creationDate', operator: 'BEFORE_INCLUSIVE', value: s.to });
  const r = await api('POST', `/api/communications/messages:search?paginationDetails=ON&offset=${s.offset}&limit=${s.limit}`, criteria);
  if (!r.ok) throw new Error(r.error);
  const resend = can('RESEND_FAILED_MESSAGES');
  view().innerHTML = `
    <div class="toolbar"><h1>Communication Log</h1>
      <label>Type<select id="msg-type">${[['', 'Any'], ['WEB_HOOK', 'Webhook'], ['EMAIL', 'Email']].map(([v, l]) => `<option value="${v}" ${v === s.type ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>State<select id="msg-state">${['', 'QUEUED', 'WAITING', 'SENT', 'FAILED'].map((v) => `<option value="${v}" ${v === s.state ? 'selected' : ''}>${v || 'Any'}</option>`).join('')}</select></label>
      <label>Event<input id="msg-event" value="${esc(s.event)}" placeholder="e.g. SAVINGS_DEPOSIT"></label>
      <label>From<input id="msg-from" type="date" value="${esc(s.from)}"></label>
      <label>To<input id="msg-to" type="date" value="${esc(s.to)}"></label>
      <span class="spacer"></span>${resend ? '<button id="msg-resend" class="secondary">Resend selected</button>' : ''}</div>
    <div id="msg-list">${table([
    ...(resend ? [{ label: '', html: true, value: (m) => (m.state === 'FAILED' ? `<input type="checkbox" data-pick="${esc(m.encodedKey)}" aria-label="select">` : '') }] : []),
    { label: 'Created', value: (m) => String(m.creationDate || '').replace('T', ' ').slice(0, 19) },
    { label: 'Type', value: (m) => (m.type === 'EMAIL' ? 'email' : 'webhook') },
    { label: 'Event', key: 'event' }, { label: 'State', key: 'state' }, { label: 'Retries', num: true, key: 'numRetries' },
    { label: 'Destination', key: 'destination' }, { label: 'Subject', value: (m) => m.subject || '' }, { label: 'Reason', value: (m) => m.failureReason || m.waitingReason || '' },
    { label: '', value: (m) => (m.test ? 'test' : '') },
  ], r.body, { onRow: true, empty: 'No messages match' })}</div>
    ${pager(s, r.total)}`;
  view().querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', (e) => e.stopPropagation()));
  wireRows(r.body, async (m) => {
    const one = await api('GET', `/api/communications/messages/${m.encodedKey}`);
    if (!one.ok) { toast(one.error, true); return; }
    const x = one.body;
    showDialog(`${x.event} · ${x.state}`, `<dl class="kv"><dt>Destination</dt><dd>${esc(x.destination)}</dd>
      <dt>Created</dt><dd>${esc(x.creationDate)}</dd><dt>Sent</dt><dd>${esc(x.sendDate || '')}</dd>
      <dt>Retries</dt><dd>${esc(x.numRetries)}</dd><dt>Answer</dt><dd>${esc(x.responseStatus ?? '')}</dd>
      <dt>Failure</dt><dd>${esc([x.failureReason, x.failureCause].filter(Boolean).join(': '))}</dd></dl>
      <pre id="msg-body">${esc(x.body ?? '(no longer kept)')}</pre>`);
  });
  wirePager(s, messagesView);
  const on = (id, key) => $(id).addEventListener('change', (e) => { s[key] = e.target.value.trim(); s.offset = 0; messagesView(); });
  on('#msg-type', 'type'); on('#msg-state', 'state'); on('#msg-event', 'event'); on('#msg-from', 'from'); on('#msg-to', 'to');
  $('#msg-resend')?.addEventListener('click', async () => {
    const keys = [...view().querySelectorAll('[data-pick]:checked')].map((x) => x.dataset.pick);
    if (!keys.length) { toast('Select failed messages first', true); return; }
    const res = await api('POST', '/api/communications/messages:resend', { messages: keys });
    toast(res.ok ? `${keys.length} message(s) queued again` : res.error, !res.ok);
    if (res.ok) messagesView();
  });
}
