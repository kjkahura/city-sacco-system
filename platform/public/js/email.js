/**
 * Email: Administration > Email (templates with a sandboxed preview, and the
 * settings with the switch and a test), Send email on member, group and
 * account pages, and a member's email subscriptions.
 */

import { $, S, api, esc, toast } from './base.js';
import { card, table, view, wireRows } from './ui.js';
import { can } from './access.js';
import { conditionLines, loadCatalog, parseConditions } from './webhooks.js';
import { showDialog } from './users.js';

const admin = () => S.user?.role === 'TENANT_ADMIN';
const badge = (t) => `<span class="badge ${t.activated ? '' : 'bad'}">${t.activated ? 'active' : 'inactive'}</span>`;
const RECIPIENTS = [['CLIENT', 'the client or group'], ['CREDIT_OFFICER', 'the credit officer'], ['GROUP_ROLE', 'group members with a role']];
const recipientLabel = (t) => (RECIPIENTS.find(([v]) => v === t.recipient)?.[1] || t.recipient) + (t.recipientRole ? ` (${t.recipientRole})` : '');

// The placeholders filled with sample values, escaped as the platform escapes them, for the preview.
const htmlText = (v) => String(v).replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;' }[ch]));
const SAMPLE = { FIRST_NAME: 'Jane', LAST_NAME: 'Sample', CLIENT_NAME: 'Jane Sample', ORGANIZATION_NAME: 'Sample SACCO', TRANSACTION_AMOUNT: '1000.00', ACCOUNT_ID: 'SV000001' };
const sampleFill = (text) => String(text || '').replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, n) => htmlText(SAMPLE[n] ?? `[${n}]`));

// --------------------------------------------------------------------------
// Templates
// --------------------------------------------------------------------------

export async function emailTemplatesView() {
  const r = await api('GET', '/api/templates?type=EMAIL');
  if (!r.ok) throw new Error(r.error);
  view().innerHTML = `
    <div class="toolbar"><h1>Email Templates</h1><span class="spacer"></span>
      ${can('CREATE_COMMUNICATION_TEMPLATES') ? '<button id="em-new">New email</button>' : ''}</div>
    <p class="hint">An email is sent when its event happens, to the recipients it names who are subscribed. Opt-out templates reach everyone
      who has not unsubscribed; opt-in ones only those subscribed. Members change their own subscriptions in the portal.</p>
    <div id="em-list">${table([
    { label: 'Name', key: 'name' }, { label: 'Event', key: 'event' }, { label: 'Subject', key: 'subject' },
    { label: 'Recipient', value: recipientLabel }, { label: 'Subscription', value: (t) => (t.subscriptionOption === 'OPT_IN' ? 'opt in' : 'opt out') },
    { label: 'Status', html: true, value: badge },
  ], r.body, { onRow: true, empty: 'No email templates yet' })}</div>`;
  wireRows(r.body, (t) => emailEditor(t));
  $('#em-new')?.addEventListener('click', () => emailEditor(null));
}

async function emailEditor(t) {
  const [cat, roles] = await Promise.all([loadCatalog(), api('GET', '/api/group-role-names')]);
  const edit = Boolean(t);
  const people = ['CLIENT', 'GROUP', 'LOANS', 'SAVINGS'];
  const events = Object.entries(cat.events).flatMap(([e, targets]) => targets.filter((tg) => people.includes(tg)).map((tg) => [`${tg}:${e}`, `${tg}: ${e}`]));
  const chosen = t ? `${t.target}:${t.event}` : '';
  const canEdit = edit ? can('EDIT_COMMUNICATION_TEMPLATES') : can('CREATE_COMMUNICATION_TEMPLATES');
  view().innerHTML = `
    <button class="secondary" id="back">← Email Templates</button>
    <h1>${edit ? esc(t.name) : 'New email'} ${edit ? badge(t) : ''}</h1>
    <div class="grid">
      ${card('Event and recipient', `
        <label>Name<input id="em-name" value="${esc(t?.name || '')}" maxlength="255"></label>
        <label>Event<select id="em-event">${events.map(([v, l]) => `<option value="${esc(v)}" ${v === chosen ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label>Recipient<select id="em-recipient">${RECIPIENTS.map(([v, l]) => `<option value="${v}" ${t?.recipient === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label>Group role (for group members with a role)<select id="em-role"><option value=""></option>${(roles.body || []).map((x) => `<option value="${esc(x.id)}" ${t?.recipientRole === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
        <label>Subscription<select id="em-sub">${[['OPT_OUT', 'opt out: everyone until they unsubscribe'], ['OPT_IN', 'opt in: only those subscribed']].map(([v, l]) => `<option value="${v}" ${t?.subscriptionOption === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label>Days before the due date (repayment reminders)<input id="em-days" type="number" min="0" max="365" value="${esc(t?.triggerDays ?? 0)}"></label>
        <label class="check"><input type="checkbox" id="em-active" ${!t || t.activated ? 'checked' : ''}> Active</label>`)}
      ${card('Conditions', `<label>Send only when<select id="em-link">${['MATCH_ALL', 'MATCH_ANY'].map((m) => `<option ${t?.filtersLinkingOperator === m ? 'selected' : ''} value="${m}">${m === 'MATCH_ALL' ? 'all conditions match' : 'any condition matches'}</option>`).join('')}</select></label>
        <label>Conditions, one "FIELD OPERATOR VALUE [SECOND]" a line (operators: ${esc(cat.operators.join(', '))})<textarea id="em-conds" rows="3">${esc(conditionLines(t?.filterConstraints))}</textarea></label>`)}
    </div>
    ${card('Message', `<label>Subject<input id="em-subject" value="${esc(t?.subject || '')}" maxlength="255"></label>
      <label>Body (HTML)<textarea id="em-body" rows="12">${esc(t?.body || '')}</textarea></label>
      <p class="hint">Click a placeholder to put it at the cursor. Values are escaped, so a member's name cannot change the layout.
        In an attribute, put the placeholder inside quotation marks, and start a link with https:// or mailto:.
        A plain-text copy is made from the HTML for mail apps that show text only.</p>
      <div id="em-placeholders" class="chips">${cat.placeholders.map((p) => `<button type="button" class="chip" data-ph="${esc(p)}">${esc(p)}</button>`).join('')}</div>
      <p><button type="button" class="secondary" id="em-preview-btn">Preview</button></p><div id="em-preview-box"></div>`)}
    <div class="toolbar">
      ${canEdit ? '<button id="em-save-tpl">Save</button>' : ''}
      ${edit && can('EDIT_COMMUNICATION_TEMPLATES') ? '<button id="em-delete" class="secondary">Delete</button>' : ''}
    </div>`;

  $('#back').addEventListener('click', () => emailTemplatesView());
  let focused = $('#em-body');
  ['#em-subject', '#em-body'].forEach((id) => $(id).addEventListener('focus', (e) => { focused = e.target; }));
  view().querySelectorAll('[data-ph]').forEach((b) => b.addEventListener('click', () => {
    const f = focused;
    const tok = `{{${b.dataset.ph}}}`;
    const at = f.selectionStart ?? f.value.length;
    f.value = f.value.slice(0, at) + tok + f.value.slice(f.selectionEnd ?? at);
    f.focus();
    f.selectionStart = f.selectionEnd = at + tok.length;
  }));
  // The preview runs no script and reaches nothing: a sandboxed frame with the body filled with samples.
  $('#em-preview-btn').addEventListener('click', () => {
    const frame = document.createElement('iframe');
    frame.id = 'em-preview';
    frame.setAttribute('sandbox', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = 'Preview';
    frame.className = 'email-preview';
    // Mail apps run no script either; dropping it here keeps the frame from reporting each blocked one.
    const body = sampleFill($('#em-body').value).replace(/<script[\s\S]*?(<\/script>|$)/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    frame.srcdoc = `<p><b>Subject:</b> ${sampleFill($('#em-subject').value)}</p><hr>${body}`;
    $('#em-preview-box').replaceChildren(frame);
  });
  const collect = () => {
    const [target, event] = $('#em-event').value.split(':');
    return {
      name: $('#em-name').value, target, event, subject: $('#em-subject').value, body: $('#em-body').value, recipient: $('#em-recipient').value,
      recipientRole: $('#em-role').value || null, subscriptionOption: $('#em-sub').value, triggerDays: Number($('#em-days').value || 0),
      activated: $('#em-active').checked, filtersLinkingOperator: $('#em-link').value, filterConstraints: parseConditions($('#em-conds').value),
    };
  };
  $('#em-save-tpl')?.addEventListener('click', async () => {
    const b = collect();
    const res = edit
      ? await api('PATCH', `/api/templates/${t.id}`, Object.entries(b).map(([k, v]) => ({ op: 'REPLACE', path: `/${k}`, value: v })))
      : await api('POST', '/api/templates', { ...b, type: 'EMAIL' });
    if (!res.ok) { toast(res.error, true); return; }
    toast(edit ? 'Email saved' : 'Email created');
    emailTemplatesView();
  });
  $('#em-delete')?.addEventListener('click', async () => {
    if (!window.confirm(`Delete the email ${t.name}? Its log is kept.`)) return;
    const res = await api('DELETE', `/api/templates/${t.id}`);
    toast(res.ok ? 'Email deleted' : res.error, !res.ok);
    if (res.ok) emailTemplatesView();
  });
}

// --------------------------------------------------------------------------
// Settings
// --------------------------------------------------------------------------

export async function emailSettingsView() {
  const r = await api('GET', '/api/notificationsettings/email');
  if (!r.ok) throw new Error(r.error);
  const s = r.body;
  const mine = admin();
  const ro = mine ? '' : 'disabled';
  view().innerHTML = `
    <div class="toolbar"><h1>Email Settings</h1><span class="spacer"></span>
      <span id="em-state" class="badge ${s.enabled ? '' : 'bad'}">email ${s.enabled ? 'on' : 'off'}</span>
      ${mine ? `<button id="em-switch" class="secondary">${s.enabled ? 'Switch off' : 'Switch on'}</button>` : ''}</div>
    <p class="hint">Emails go out through this SACCO's own mail server or provider, over TLS (port 465 with SSL/TLS, or 587 with STARTTLS).
      The password is stored encrypted and never shown. Only an administrator changes or tests these settings.</p>
    <div class="grid" id="em-settings">
      ${card('Sender', `
        <label>From Name<input id="em-fromName" value="${esc(s.fromName || '')}" ${ro}></label>
        <label>From Email<input id="em-fromEmail" type="email" value="${esc(s.fromEmail || '')}" ${ro}></label>
        <label>Reply-to email<input id="em-replyTo" type="email" value="${esc(s.replyTo || '')}" ${ro}></label>
        <label>Emails a minute at most<input id="em-pace" type="number" min="1" max="6000" value="${esc(s.pacePerMinute)}" ${ro}></label>`)}
      ${card('Server', `
        <label>SMTP Host<input id="em-host" value="${esc(s.host || '')}" ${ro}></label>
        <label>SMTP Port<input id="em-port" type="number" value="${esc(s.port || 587)}" ${ro}></label>
        <label>Transport Encryption<select id="em-encryption" ${ro}>${[['STARTTLS', 'STARTTLS (587)'], ['SSL_TLS', 'SSL/TLS (465)']].map(([v, l]) => `<option value="${v}" ${s.encryption === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Username<input id="em-username" value="${esc(s.username || '')}" autocomplete="off" ${ro}></label>
        <label>Password<input id="em-password" type="password" autocomplete="new-password" placeholder="${s.passwordSet ? 'set; kept unless you type a new one' : ''}" ${ro}></label>`)}
    </div>
    ${mine ? `<div class="toolbar"><button id="em-save">Save</button><span class="spacer"></span>
      <label>Send a test to<input id="em-test-to" type="email" placeholder="you@example.org"></label><button id="em-test" class="secondary">Send test</button></div>
      <div id="em-test-out"></div>` : ''}`;
  const fields = () => {
    const b = {
      fromName: $('#em-fromName').value, fromEmail: $('#em-fromEmail').value, replyTo: $('#em-replyTo').value || null, host: $('#em-host').value,
      port: Number($('#em-port').value), encryption: $('#em-encryption').value, username: $('#em-username').value || null,
      pacePerMinute: Number($('#em-pace').value || 60),
    };
    if ($('#em-password').value) b.password = $('#em-password').value;
    return b;
  };
  $('#em-save')?.addEventListener('click', async () => {
    const res = await api('PUT', '/api/notificationsettings/email', fields());
    toast(res.ok ? 'Email settings saved' : res.error, !res.ok);
    if (res.ok) emailSettingsView();
  });
  $('#em-switch')?.addEventListener('click', async () => {
    const res = await api('PUT', '/api/notificationsettings/email', { ...fields(), enabled: !s.enabled });
    toast(res.ok ? `Email switched ${s.enabled ? 'off' : 'on'}` : res.error, !res.ok);
    if (res.ok) emailSettingsView();
  });
  $('#em-test')?.addEventListener('click', async () => {
    $('#em-test-out').innerHTML = '<p class="hint">Sending…</p>';
    const res = await api('POST', '/api/notificationsettings/email:test', { to: $('#em-test-to').value, settings: fields() });
    $('#em-test-out').innerHTML = res.ok
      ? `<p id="em-test-result" class="${res.body.ok ? '' : 'error'}">${res.body.ok ? 'Sent: the server accepted the test email.'
        : esc(`${res.body.failureReason}: ${res.body.failureCause || ''}`)}</p>`
      : `<p class="error" id="em-test-result">${esc(res.error)}</p>`;
  });
}

// --------------------------------------------------------------------------
// Send email (member, group, loan and deposit pages)
// --------------------------------------------------------------------------

/** `holder` is { clientKey } or { groupKey } or { loanAccountKey } or { depositAccountKey }. */
export async function sendEmailDialog(holder) {
  const tpls = await api('GET', '/api/communications/email-templates');
  const list = tpls.ok ? tpls.body : [];
  const editTemplates = can('EDIT_COMMUNICATION_TEMPLATES');
  const dlg = showDialog('Send email', `
    <label>Template<select id="em-send-tpl"><option value="">Free text</option>${list.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label>
    <label>Subject<input id="em-send-subject" maxlength="255"></label>
    <label>Body (HTML, placeholders allowed)<textarea id="em-send-body" rows="10"></textarea></label>
    <p class="hint">The email goes to the account holder's address, whatever their subscriptions.${editTemplates ? '' : ' A template\'s text cannot be changed without the permission to edit templates.'}</p>
    <p><button id="em-send-go">Send</button></p><div id="em-send-out"></div>`);
  const pick = $('#em-send-tpl', dlg);
  pick.addEventListener('change', () => {
    const t = list.find((x) => x.id === pick.value);
    $('#em-send-subject', dlg).value = t?.subject || '';
    $('#em-send-body', dlg).value = t?.body || '';
    $('#em-send-subject', dlg).readOnly = Boolean(t) && !editTemplates;
    $('#em-send-body', dlg).readOnly = Boolean(t) && !editTemplates;
  });
  $('#em-send-go', dlg).addEventListener('click', async () => {
    const t = list.find((x) => x.id === pick.value);
    const b = { ...holder };
    if (t) b.templateKey = t.id;
    const subject = $('#em-send-subject', dlg).value;
    const body = $('#em-send-body', dlg).value;
    if (!t || subject !== t.subject) b.subject = subject;
    if (!t || body !== t.body) b.body = body;
    const res = await api('POST', '/api/communications/messages:sendEmail', b);
    $('#em-send-out', dlg).innerHTML = res.ok
      ? `<dl class="kv" id="em-send-result"><dt>Type</dt><dd>EMAIL</dd><dt>State</dt><dd>${esc(res.body.state)}</dd>
          <dt>To</dt><dd>${esc(res.body.destination || '')}</dd><dt>Detail</dt><dd>${esc([res.body.failureReason, res.body.failureCause].filter(Boolean).join(': ') || 'accepted by the mail server')}</dd></dl>`
      : `<p class="error" id="em-send-result">${esc(res.error)}</p>`;
  });
}

// --------------------------------------------------------------------------
// A member's or group's subscriptions
// --------------------------------------------------------------------------

export async function subscriptionsCard(box, memberId, { isGroup = false } = {}) {
  const base = `/api/${isGroup ? 'groups' : 'clients'}/${memberId}/notification-subscriptions`;
  const r = await api('GET', base);
  if (!r.ok) { box.innerHTML = ''; return; }
  const edit = can(isGroup ? 'EDIT_GROUP' : 'EDIT_CLIENT');
  box.innerHTML = card('Email subscriptions', `${table([
    { label: 'Template', key: 'name' }, { label: 'Event', key: 'event' },
    { label: 'Option', value: (x) => (x.subscriptionOption === 'OPT_IN' ? 'opt in' : 'opt out') },
    { label: 'Subscribed', value: (x) => (x.subscribed ? 'subscribed' : 'not subscribed') },
    { label: 'Changed by', value: (x) => x.lastModifiedBy || '' },
    { label: '', html: true, value: (x) => (edit ? `<button class="link" data-sub-toggle="${esc(x.templateKey)}" data-now="${x.subscribed}">${x.subscribed ? 'unsubscribe' : 'subscribe'}</button>` : '') },
  ], r.body, { empty: 'No email templates write to members yet' })}`);
  box.querySelectorAll('[data-sub-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const res = await api('PUT', `${base}/${b.dataset.subToggle}`, { subscribed: b.dataset.now !== 'true' });
    toast(res.ok ? 'Subscription changed' : res.error, !res.ok);
    subscriptionsCard(box, memberId, { isGroup });
  }));
}
