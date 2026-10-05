/**
 * SMS: Administration > SMS (templates with a character and segment count,
 * and the settings: the provider and its fields, the switch, a test and the
 * delivery report address), and Send SMS on member, group and account pages.
 */

import { $, S, api, esc, toast } from './base.js';
import { card, table, view, wireRows } from './ui.js';
import { can } from './access.js';
import { conditionLines, loadCatalog, parseConditions } from './webhooks.js';
import { showDialog } from './users.js';

const admin = () => S.user?.role === 'TENANT_ADMIN';
const badge = (t) => `<span class="badge ${t.activated ? '' : 'bad'}">${t.activated ? 'active' : 'inactive'}</span>`;
const RECIPIENTS = [['CLIENT', 'the client or group'], ['GROUP_ROLE', 'group members with a role']];

// The same count as the platform's (domain/notifications/channels/sms): GSM-7 160 then 153, UCS-2 70 then 67.
const GSM = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
const GSM_EXT = new Set('^{}\\[~]|€\f');
export function segmentsOf(text) {
  const chars = [...String(text || '')];
  const gsm = chars.every((ch) => GSM.has(ch) || GSM_EXT.has(ch));
  const size = (ch) => (gsm ? (GSM_EXT.has(ch) ? 2 : 1) : ch.length);
  const units = chars.reduce((n, ch) => n + size(ch), 0);
  const [single, part] = gsm ? [160, 153] : [70, 67];
  const encoding = gsm ? 'GSM-7' : 'UCS-2';
  if (units <= single) return { encoding, units, count: 1 };
  let count = 1;
  let used = 0;
  for (const ch of chars) {
    const n = size(ch);
    if (used + n > part) { count += 1; used = 0; }
    used += n;
  }
  return { encoding, units, count };
}
// Placeholders count at their sample length, as the platform checks them.
const SAMPLE = { FIRST_NAME: 'Jane', LAST_NAME: 'Sample', CLIENT_NAME: 'Jane Sample', TRANSACTION_AMOUNT: '1000.00', ACCOUNT_ID: 'SV000001' };
const sampleFill = (text) => String(text || '').replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, n) => SAMPLE[n] ?? 'x'.repeat(10));
const countText = (text) => {
  const s = segmentsOf(sampleFill(text));
  return `${s.units} ${s.encoding} characters with sample values, ${s.count} segment${s.count === 1 ? '' : 's'}${s.count > 6 ? ': too long, at most 6' : ''}`;
};

// --------------------------------------------------------------------------
// Templates
// --------------------------------------------------------------------------

export async function smsTemplatesView() {
  const r = await api('GET', '/api/templates?type=SMS');
  if (!r.ok) throw new Error(r.error);
  view().innerHTML = `
    <div class="toolbar"><h1>SMS Templates</h1><span class="spacer"></span>
      ${can('CREATE_COMMUNICATION_TEMPLATES') ? '<button id="sms-new">New SMS</button>' : ''}</div>
    <p class="hint">An SMS is sent when its event happens, to the recipients it names who are subscribed, through the gateway in Settings.
      A message is at most six segments; each segment is billed by the gateway.</p>
    <div id="sms-list">${table([
    { label: 'Name', key: 'name' }, { label: 'Event', key: 'event' },
    { label: 'Recipient', value: (t) => (RECIPIENTS.find(([v]) => v === t.recipient)?.[1] || t.recipient) + (t.recipientRole ? ` (${t.recipientRole})` : '') },
    { label: 'Segments', num: true, key: 'segments' },
    { label: 'Subscription', value: (t) => (t.subscriptionOption === 'OPT_IN' ? 'opt in' : 'opt out') }, { label: 'Status', html: true, value: badge },
  ], r.body, { onRow: true, empty: 'No SMS templates yet' })}</div>`;
  wireRows(r.body, (t) => smsEditor(t));
  $('#sms-new')?.addEventListener('click', () => smsEditor(null));
}

async function smsEditor(t) {
  const [cat, roles] = await Promise.all([loadCatalog(), api('GET', '/api/group-role-names')]);
  const edit = Boolean(t);
  const people = ['CLIENT', 'GROUP', 'LOANS', 'SAVINGS'];
  const events = Object.entries(cat.events).flatMap(([e, targets]) => targets.filter((tg) => people.includes(tg)).map((tg) => [`${tg}:${e}`, `${tg}: ${e}`]));
  const chosen = t ? `${t.target}:${t.event}` : '';
  const canEdit = edit ? can('EDIT_COMMUNICATION_TEMPLATES') : can('CREATE_COMMUNICATION_TEMPLATES');
  view().innerHTML = `
    <button class="secondary" id="back">← SMS Templates</button>
    <h1>${edit ? esc(t.name) : 'New SMS'} ${edit ? badge(t) : ''}</h1>
    <div class="grid">
      ${card('Event and recipient', `
        <label>Name<input id="sms-name" value="${esc(t?.name || '')}" maxlength="255"></label>
        <label>Event<select id="sms-event">${events.map(([v, l]) => `<option value="${esc(v)}" ${v === chosen ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label>Recipient<select id="sms-recipient">${RECIPIENTS.map(([v, l]) => `<option value="${v}" ${t?.recipient === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label>Group role (for group members with a role)<select id="sms-role"><option value=""></option>${(roles.body || []).map((x) => `<option value="${esc(x.id)}" ${t?.recipientRole === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
        <label>Subscription<select id="sms-sub">${[['OPT_OUT', 'opt out: everyone until they unsubscribe'], ['OPT_IN', 'opt in: only those subscribed']].map(([v, l]) => `<option value="${v}" ${t?.subscriptionOption === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label>Days before the due date (repayment reminders)<input id="sms-days" type="number" min="0" max="365" value="${esc(t?.triggerDays ?? 0)}"></label>
        <label class="check"><input type="checkbox" id="sms-active" ${!t || t.activated ? 'checked' : ''}> Active</label>`)}
      ${card('Conditions', `<label>Send only when<select id="sms-link">${['MATCH_ALL', 'MATCH_ANY'].map((m) => `<option ${t?.filtersLinkingOperator === m ? 'selected' : ''} value="${m}">${m === 'MATCH_ALL' ? 'all conditions match' : 'any condition matches'}</option>`).join('')}</select></label>
        <label>Conditions, one "FIELD OPERATOR VALUE [SECOND]" a line (operators: ${esc(cat.operators.join(', '))})<textarea id="sms-conds" rows="3">${esc(conditionLines(t?.filterConstraints))}</textarea></label>`)}
    </div>
    ${card('Text', `<label>Text<textarea id="sms-body" rows="5">${esc(t?.body || '')}</textarea></label>
      <p class="hint" id="sms-count"></p>
      <div id="sms-placeholders" class="chips">${cat.placeholders.map((p) => `<button type="button" class="chip" data-ph="${esc(p)}">${esc(p)}</button>`).join('')}</div>`)}
    <div class="toolbar">
      ${canEdit ? '<button id="sms-save-tpl">Save</button>' : ''}
      ${edit && can('EDIT_COMMUNICATION_TEMPLATES') ? '<button id="sms-delete" class="secondary">Delete</button>' : ''}
    </div>`;
  $('#back').addEventListener('click', () => smsTemplatesView());
  const body = $('#sms-body');
  const recount = () => { $('#sms-count').textContent = countText(body.value); };
  body.addEventListener('input', recount);
  recount();
  view().querySelectorAll('[data-ph]').forEach((b) => b.addEventListener('click', () => {
    const tok = `{{${b.dataset.ph}}}`;
    const at = body.selectionStart ?? body.value.length;
    body.value = body.value.slice(0, at) + tok + body.value.slice(body.selectionEnd ?? at);
    body.focus();
    body.selectionStart = body.selectionEnd = at + tok.length;
    recount();
  }));
  const collect = () => {
    const [target, event] = $('#sms-event').value.split(':');
    return {
      name: $('#sms-name').value, target, event, body: body.value, recipient: $('#sms-recipient').value, recipientRole: $('#sms-role').value || null,
      subscriptionOption: $('#sms-sub').value, triggerDays: Number($('#sms-days').value || 0), activated: $('#sms-active').checked,
      filtersLinkingOperator: $('#sms-link').value, filterConstraints: parseConditions($('#sms-conds').value),
    };
  };
  $('#sms-save-tpl')?.addEventListener('click', async () => {
    const b = collect();
    const res = edit
      ? await api('PATCH', `/api/templates/${t.id}`, Object.entries(b).map(([k, v]) => ({ op: 'REPLACE', path: `/${k}`, value: v })))
      : await api('POST', '/api/templates', { ...b, type: 'SMS' });
    if (!res.ok) { toast(res.error, true); return; }
    toast(edit ? 'SMS saved' : 'SMS created');
    smsTemplatesView();
  });
  $('#sms-delete')?.addEventListener('click', async () => {
    if (!window.confirm(`Delete the SMS ${t.name}? Its log is kept.`)) return;
    const res = await api('DELETE', `/api/templates/${t.id}`);
    toast(res.ok ? 'SMS deleted' : res.error, !res.ok);
    if (res.ok) smsTemplatesView();
  });
}

// --------------------------------------------------------------------------
// Settings
// --------------------------------------------------------------------------

export async function smsSettingsView() {
  const [r, p] = await Promise.all([api('GET', '/api/notificationsettings/sms'), api('GET', '/api/notificationsettings/sms/providers')]);
  if (!r.ok) throw new Error(r.error);
  const s = r.body;
  const providers = p.ok ? p.body : [];
  const mine = admin();
  const ro = mine ? '' : 'disabled';
  view().innerHTML = `
    <div class="toolbar"><h1>SMS Settings</h1><span class="spacer"></span>
      <span id="sms-state" class="badge ${s.enabled ? '' : 'bad'}">SMS ${s.enabled ? 'on' : 'off'}</span>
      ${mine ? `<button id="sms-switch" class="secondary">${s.enabled ? 'Switch off' : 'Switch on'}</button>` : ''}</div>
    <p class="hint">SMS go out through the gateway this SACCO uses. The HTTPS gateway provider describes most gateways' APIs with the fields below;
      a gateway that needs code gets a provider of its own (src/domain/notifications/channels/sms-providers). The API key is stored encrypted and never shown.</p>
    <div class="grid" id="sms-settings">
      ${card('Sender', `
        <label>Provider<select id="sms-provider" ${ro}><option value=""></option>${providers.map((x) => `<option value="${esc(x.id)}" ${s.provider === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
        <label>Sender ID (up to 11 letters and digits, or a number)<input id="sms-senderId" value="${esc(s.senderId || '')}" ${ro}></label>
        <label>Messages a minute at most<input id="sms-pace" type="number" min="1" max="6000" value="${esc(s.pacePerMinute)}" ${ro}></label>
        <p class="hint">Delivery reports: ${s.deliveryReportsEnabled ? 'an address is set' : 'no address yet'}.</p>`)}
      <div id="sms-fields"></div>
    </div>
    ${mine ? `<div class="toolbar"><button id="sms-save">Save</button><button id="sms-callback" class="secondary">New delivery report address</button><span class="spacer"></span>
      <label>Send a test to<input id="sms-test-to" placeholder="0712 345 678"></label><button id="sms-test" class="secondary">Send test</button></div>
      <div id="sms-test-out"></div>` : ''}`;
  const renderFields = () => {
    const prov = providers.find((x) => x.id === $('#sms-provider').value);
    if (!prov) { $('#sms-fields').innerHTML = ''; return; }
    $('#sms-fields').innerHTML = card(prov.name, `<p class="hint">${esc(prov.description || '')}</p>${prov.fields.map((f) => {
      const id = `sms-f-${f.name}`;
      const val = f.secret ? '' : (s.provider === prov.id ? s[f.name] : null) ?? f.default ?? '';
      if (f.options) return `<label>${esc(f.label)}<select id="${id}" ${ro}>${f.options.map((o) => `<option ${String(val) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
      if (f.type === 'textarea') return `<label>${esc(f.label)}<textarea id="${id}" rows="4" ${ro}>${esc(val)}</textarea></label>`;
      if (f.secret) return `<label>${esc(f.label)}<input id="${id}" type="password" autocomplete="new-password" placeholder="${s.apiKeySet && s.provider === prov.id ? 'set; kept unless you type a new one' : ''}" ${ro}></label>`;
      return `<label>${esc(f.label)}<input id="${id}" value="${esc(val)}" ${ro}></label>`;
    }).join('')}`);
  };
  $('#sms-provider').addEventListener('change', renderFields);
  renderFields();
  const fields = () => {
    const prov = providers.find((x) => x.id === $('#sms-provider').value);
    const b = { provider: $('#sms-provider').value, senderId: $('#sms-senderId').value, pacePerMinute: Number($('#sms-pace').value || 60) };
    for (const f of prov?.fields || []) {
      const v = $(`#sms-f-${f.name}`)?.value ?? '';
      if (f.secret) { if (v) b[f.name] = v; } else b[f.name] = v;
    }
    return b;
  };
  $('#sms-save')?.addEventListener('click', async () => {
    const res = await api('PUT', '/api/notificationsettings/sms', fields());
    toast(res.ok ? 'SMS settings saved' : res.error, !res.ok);
    if (res.ok) smsSettingsView();
  });
  $('#sms-switch')?.addEventListener('click', async () => {
    const res = await api('PUT', '/api/notificationsettings/sms', { ...fields(), enabled: !s.enabled });
    toast(res.ok ? `SMS switched ${s.enabled ? 'off' : 'on'}` : res.error, !res.ok);
    if (res.ok) smsSettingsView();
  });
  $('#sms-test')?.addEventListener('click', async () => {
    $('#sms-test-out').innerHTML = '<p class="hint">Sending…</p>';
    const res = await api('POST', '/api/notificationsettings/sms:test', { to: $('#sms-test-to').value, settings: fields() });
    $('#sms-test-out').innerHTML = res.ok
      ? `<p id="sms-test-result" class="${res.body.ok ? '' : 'error'}">${res.body.ok ? `Sent: the gateway accepted the message${res.body.providerMessageId ? ` (${esc(res.body.providerMessageId)})` : ''}.`
        : esc(`${res.body.failureReason}: ${res.body.failureCause || ''}`)}</p>`
      : `<p class="error" id="sms-test-result">${esc(res.error)}</p>`;
  });
  $('#sms-callback')?.addEventListener('click', async () => {
    if (s.deliveryReportsEnabled && !window.confirm('Make a new address? The gateway must be given it; the old one stops working.')) return;
    const res = await api('POST', '/api/notificationsettings/sms:callbackToken');
    if (!res.ok) { toast(res.error, true); return; }
    showDialog('Delivery report address', `<p>Give this address to the gateway for its delivery reports. It is shown this once.</p>
      <pre id="sms-callback-url" class="secret">${esc(res.body.callbackUrl)}</pre>
      <p class="hint">Set where the report carries the message ID and the status, and which statuses mean delivered or not, in the provider's fields.</p>`);
  });
}

// --------------------------------------------------------------------------
// Send SMS (member, group, loan and deposit pages)
// --------------------------------------------------------------------------

/** `holder` is { clientKey } or { groupKey } or { loanAccountKey } or { depositAccountKey }. */
export async function sendSmsDialog(holder) {
  const tpls = await api('GET', '/api/communications/sms-templates');
  const list = tpls.ok ? tpls.body : [];
  const editTemplates = can('EDIT_COMMUNICATION_TEMPLATES');
  const dlg = showDialog('Send SMS', `
    <label>Template<select id="sms-send-tpl"><option value="">Free text</option>${list.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label>
    <label>Text (placeholders allowed)<textarea id="sms-send-body" rows="5"></textarea></label>
    <p class="hint" id="sms-send-count"></p>
    <p class="hint">The SMS goes to the account holder's phone number, whatever their subscriptions.</p>
    <p><button id="sms-send-go">Send</button></p><div id="sms-send-out"></div>`);
  const pick = $('#sms-send-tpl', dlg);
  const body = $('#sms-send-body', dlg);
  const recount = () => { $('#sms-send-count', dlg).textContent = countText(body.value); };
  body.addEventListener('input', recount);
  recount();
  pick.addEventListener('change', () => {
    const t = list.find((x) => x.id === pick.value);
    body.value = t?.body || '';
    body.readOnly = Boolean(t) && !editTemplates;
    recount();
  });
  $('#sms-send-go', dlg).addEventListener('click', async () => {
    const t = list.find((x) => x.id === pick.value);
    const b = { ...holder };
    if (t) b.templateKey = t.id;
    if (!t || body.value !== t.body) b.body = body.value;
    const res = await api('POST', '/api/communications/messages:sendSms', b);
    $('#sms-send-out', dlg).innerHTML = res.ok
      ? `<dl class="kv" id="sms-send-result"><dt>Type</dt><dd>SMS</dd><dt>State</dt><dd>${esc(res.body.state)}</dd>
          <dt>To</dt><dd>${esc(res.body.destination || '')}</dd><dt>Segments</dt><dd>${esc(res.body.segments ?? '')}</dd>
          <dt>Detail</dt><dd>${esc([res.body.failureReason, res.body.failureCause].filter(Boolean).join(': ') || 'accepted by the gateway')}</dd></dl>`
      : `<p class="error" id="sms-send-result">${esc(res.error)}</p>`;
  });
}
