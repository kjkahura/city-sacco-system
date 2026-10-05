/**
 * Administration > Events Streaming: the streaming templates (each with
 * its topic) and the subscriptions API consumers have made, with how far
 * each has read. The streams themselves are read over the API
 * (/api/v1/subscriptions).
 */

import { $, api, esc, toast } from './base.js';
import { card, table, view, wireRows } from './ui.js';
import { can } from './access.js';
import { conditionLines, loadCatalog, parseConditions } from './webhooks.js';

const badge = (t) => `<span class="badge ${t.activated ? '' : 'bad'}">${t.activated ? 'active' : 'inactive'}</span>`;

// --------------------------------------------------------------------------
// The streaming templates
// --------------------------------------------------------------------------

export async function streamTemplatesView() {
  const r = await api('GET', '/api/templates?type=EVENT_STREAM');
  if (!r.ok) throw new Error(r.error);
  view().innerHTML = `
    <div class="toolbar"><h1>Events Streaming</h1><span class="spacer"></span>
      ${can('CREATE_COMMUNICATION_TEMPLATES') ? '<button id="es-new">New streaming template</button>' : ''}</div>
    <p class="hint">A streaming template publishes each matching event to its topic. API consumers with the permission
      to read event streams subscribe to topics at /api/v1/subscriptions and read the events in order. Events are kept for 7 days.</p>
    <div id="es-list">${table([
    { label: 'Name', key: 'name' }, { label: 'Event', key: 'event' }, { label: 'Topic', key: 'topic' },
    { label: 'Status', html: true, value: badge },
  ], r.body, { onRow: true, empty: 'No streaming templates yet' })}</div>`;
  wireRows(r.body, (t) => streamEditor(t));
  $('#es-new')?.addEventListener('click', () => streamEditor(null));
}

async function streamEditor(t) {
  const cat = await loadCatalog();
  const edit = Boolean(t);
  const events = Object.entries(cat.events).flatMap(([e, targets]) => targets.map((tg) => [`${tg}:${e}`, `${tg}: ${e}`]));
  const chosen = t ? `${t.target}:${t.event}` : '';
  const canEdit = edit ? can('EDIT_COMMUNICATION_TEMPLATES') : can('CREATE_COMMUNICATION_TEMPLATES');
  view().innerHTML = `
    <button class="secondary" id="back">← Events Streaming</button>
    <h1>${edit ? esc(t.name) : 'New streaming template'} ${edit ? badge(t) : ''}</h1>
    ${card('Event', `
      <label>Name<input id="es-name" value="${esc(t?.name || '')}" maxlength="255"></label>
      ${edit ? `<p>Topic: <code id="es-topic">${esc(t.topic)}</code></p><p class="hint">The topic stays the same when the template is renamed.</p>` : ''}
      <label>Event<select id="es-event">${events.map(([v, l]) => `<option value="${esc(v)}" ${v === chosen ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label>Content type<select id="es-ctype">${['JSON', 'XML', 'PLAIN_TEXT'].map((m) => `<option ${t?.contentType === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label>Days before the due date (repayment reminders)<input id="es-days" type="number" min="0" max="365" value="${esc(t?.triggerDays ?? 0)}"></label>
      <label class="check"><input type="checkbox" id="es-active" ${!t || t.activated ? 'checked' : ''}> Active</label>`)}
    ${card('Body', `<label>Body<textarea id="es-body" rows="10">${esc(t?.body || '')}</textarea></label>
      <p class="hint">Click a placeholder to put it at the cursor. In a JSON body a value is escaped, so put text placeholders inside quotation marks.</p>
      <div id="es-placeholders" class="chips">${cat.placeholders.map((p) => `<button type="button" class="chip" data-ph="${esc(p)}">${esc(p)}</button>`).join('')}</div>`)}
    ${card('Conditions', `<label>Publish only when<select id="es-link">${['MATCH_ALL', 'MATCH_ANY'].map((m) => `<option ${t?.filtersLinkingOperator === m ? 'selected' : ''} value="${m}">${m === 'MATCH_ALL' ? 'all conditions match' : 'any condition matches'}</option>`).join('')}</select></label>
      <label>Conditions, one "FIELD OPERATOR VALUE [SECOND]" a line (operators: ${esc(cat.operators.join(', '))})<textarea id="es-conds" rows="3">${esc(conditionLines(t?.filterConstraints))}</textarea></label>`)}
    <div class="toolbar">
      ${canEdit ? '<button id="es-save">Save</button>' : ''}
      ${edit && can('EDIT_COMMUNICATION_TEMPLATES') ? '<button id="es-delete" class="secondary">Delete</button>' : ''}
    </div>`;

  $('#back').addEventListener('click', () => streamTemplatesView());
  const body = $('#es-body');
  view().querySelectorAll('[data-ph]').forEach((b) => b.addEventListener('click', () => {
    const tok = `{{${b.dataset.ph}}}`;
    const at = body.selectionStart ?? body.value.length;
    body.value = body.value.slice(0, at) + tok + body.value.slice(body.selectionEnd ?? at);
    body.focus();
    body.selectionStart = body.selectionEnd = at + tok.length;
  }));
  const collect = () => {
    const [target, event] = $('#es-event').value.split(':');
    return {
      name: $('#es-name').value, target, event, contentType: $('#es-ctype').value, triggerDays: Number($('#es-days').value || 0),
      activated: $('#es-active').checked, body: body.value, filtersLinkingOperator: $('#es-link').value, filterConstraints: parseConditions($('#es-conds').value),
    };
  };
  $('#es-save')?.addEventListener('click', async () => {
    const b = collect();
    const res = edit
      ? await api('PATCH', `/api/templates/${t.id}`, Object.entries(b).map(([k, v]) => ({ op: 'REPLACE', path: `/${k}`, value: v })))
      : await api('POST', '/api/templates', { ...b, type: 'EVENT_STREAM' });
    if (!res.ok) { toast(res.error, true); return; }
    toast(edit ? 'Streaming template saved' : `Streaming template created: ${res.body.topic}`);
    streamTemplatesView();
  });
  $('#es-delete')?.addEventListener('click', async () => {
    if (!window.confirm(`Delete the streaming template ${t.name}? Events already published stay readable until they expire.`)) return;
    const res = await api('DELETE', `/api/templates/${t.id}`);
    toast(res.ok ? 'Streaming template deleted' : res.error, !res.ok);
    if (res.ok) streamTemplatesView();
  });
}

// --------------------------------------------------------------------------
// The subscriptions
// --------------------------------------------------------------------------

export async function subscriptionsView() {
  const r = await api('GET', '/api/v1/subscriptions');
  if (!r.ok) throw new Error(r.error);
  const del = can('CONSUME_EVENT_STREAMS');
  view().innerHTML = `
    <div class="toolbar"><h1>Subscriptions</h1></div>
    <p class="hint">Each subscription is read by one stream at a time. Unconsumed events are those published after its committed offset;
      a subscription not read for 7 days misses the events that expire.</p>
    <div id="es-subs">${table([
    { label: 'Application', key: 'owning_application' }, { label: 'Consumer group', key: 'consumer_group' },
    { label: 'Topics', html: true, value: (s) => s.cursors.map((k) => `<code>${esc(k.event_type)}</code>`).join('<br>') },
    { label: 'Committed offset', html: true, value: (s) => s.cursors.map((k) => esc(String(Number(k.offset)))).join('<br>') },
    { label: 'Unconsumed', html: true, value: (s) => s.cursors.map((k) => esc(String(k.unconsumed_events))).join('<br>') },
    { label: 'Stream', value: (s) => (s.state === 'assigned' ? 'reading' : 'no stream') },
    { label: 'Created', value: (s) => String(s.created_at || '').replace('T', ' ').slice(0, 16) },
    ...(del ? [{ label: '', html: true, value: (s) => `<button class="secondary" data-del="${esc(s.id)}">Delete</button>` }] : []),
  ], r.body, { empty: 'No subscriptions yet' })}</div>`;
  view().querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!window.confirm('Delete this subscription? Its consumer will have to subscribe again, from the beginning or the end.')) return;
    const res = await api('DELETE', `/api/v1/subscriptions/${b.dataset.del}`);
    toast(res.ok ? 'Subscription deleted' : res.error, !res.ok);
    if (res.ok) subscriptionsView();
  }));
}
