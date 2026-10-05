/**
 * Administration > Getting Started (the setup steps and their state, each
 * linking to its page) and Administration > Sandbox (create, reset, clone
 * and delete the SACCO's sandbox, for its administrators).
 */

import { $, api, esc, toast } from './base.js';
import { card, view } from './ui.js';
import { showDialog } from './users.js';

const STATE = { DONE: ['done', ''], DEFAULT: ['defaults in place', ''], TODO: ['to do', 'bad'] };

export async function gettingStartedView() {
  const r = await api('GET', '/api/setup-checklist');
  if (!r.ok) throw new Error(r.error);
  const { steps, done, of } = r.body;
  view().innerHTML = `
    <div class="toolbar"><h1>Getting Started</h1><span class="spacer"></span><span class="hint">${done} of ${of} done${r.body.defaults ? `, ${r.body.defaults} on the defaults` : ''}</span></div>
    <p class="hint">The steps to set up a new SACCO, roughly in order. Each state is read from the SACCO's own data.
      Optional steps have working defaults. Data from an earlier system is imported after setup, from Administration &gt; Data.
      Try changes in the sandbox first.</p>
    <ol id="gs-steps" class="gs-steps">${steps.map((s) => {
    const [label, cls] = STATE[s.state] || [s.state, ''];
    return `<li><span class="gs-title">${esc(s.title)}${s.optional ? ' <span class="hint">(optional)</span>' : ''}</span>
        <span class="badge ${cls}">${esc(label)}</span>
        <a href="#${esc(s.screen)}" data-screen="${esc(s.screen)}">Open</a></li>`;
  }).join('')}</ol>`;
}

const when = (t) => (t ? new Date(t).toLocaleString() : '');
const opLine = (o) => (o ? `${o.kind.toLowerCase()}${o.kind === 'CLONE' ? (o.anonymize ? ' (anonymized)' : ' (production data)') : ''}: ${o.state.toLowerCase()}
  ${o.finishedAt ? `on ${when(o.finishedAt)}` : `requested ${when(o.requestedAt)}`} by ${o.requestedBy}${o.detail ? `, ${o.detail}` : ''}` : '');

function passwordDialog(r) {
  showDialog('Sandbox administrator', `<p>The operation is queued. When it finishes, sign in to <b>${esc(r.sandbox.slug)}</b> as
    <b>${esc(r.adminEmail)}</b> with this temporary password, shown this once. You will be asked to choose a new one.</p>
    <p><code id="sbx-password">${esc(r.temporaryPassword)}</code></p>
    <p class="hint">Other staff are copied by a clone without passwords; set theirs from Access in the sandbox.</p>`);
}

export async function sandboxView() {
  const r = await api('GET', '/api/sandbox');
  if (!r.ok) throw new Error(r.error);
  const s = r.body;
  if (s.environment === 'SANDBOX') {
    view().innerHTML = `<div class="toolbar"><h1>Sandbox</h1></div><p id="sbx-status" class="notice">${esc(s.note)}</p>`;
    return;
  }
  const busy = ['QUEUED', 'RUNNING'].includes(s.lastOperation?.state);
  const state = busy ? s.lastOperation.state : (s.exists ? s.state : null);
  const statusText = state
    ? `<b>${esc(s.slug || '')}</b> <span class="badge ${state === 'FAILED' ? 'bad' : ''}">${esc(state.toLowerCase())}</span>`
    : 'There is no sandbox yet.';
  view().innerHTML = `
    <div class="toolbar"><h1>Sandbox</h1><span class="spacer"></span><button class="secondary" id="sbx-refresh">Refresh</button></div>
    <p class="hint">A second SACCO, <code>${esc(s.slug || '<slug>_sbx')}</code>, on the same platform, to try products, settings, imports and integrations
      before production. It sends no webhooks, email or SMS until they are switched on there, has no API keys until made there, and is not backed up.</p>
    <div class="grid">
      ${card('State', `<div id="sbx-status">${statusText}
        ${s.lastOperation ? `<p class="hint">Last operation: ${esc(opLine(s.lastOperation))}</p>` : ''}</div>`)}
      ${card('Operations', s.exists ? `
        <p class="hint">Each replaces everything in the sandbox. You become its administrator with a new temporary password.</p>
        <button id="sbx-reset" ${busy ? 'disabled' : ''}>Reset to empty</button>
        <label><input type="checkbox" id="sbx-anon" checked> Anonymize members (recommended)</label>
        <button id="sbx-clone" ${busy ? 'disabled' : ''}>Clone production</button>
        <button class="secondary" id="sbx-delete" ${busy ? 'disabled' : ''}>Delete the sandbox</button>` : `
        <p class="hint">An empty sandbox with the platform's defaults. You become its administrator. Clone production into it afterwards if you want its data.</p>
        <button id="sbx-create" ${busy ? 'disabled' : ''}>Create a sandbox</button>`)}
    </div>`;
  const run = async (method, path, body, question, showPassword = true) => {
    if (!window.confirm(question)) return;
    const x = await api(method, path, body);
    if (!x.ok) return toast(x.error, true);
    await sandboxView();
    if (showPassword && x.body.temporaryPassword) passwordDialog(x.body);
    return null;
  };
  $('#sbx-refresh').addEventListener('click', () => sandboxView());
  $('#sbx-create')?.addEventListener('click', () => run('POST', '/api/sandbox', {}, 'Create an empty sandbox?'));
  $('#sbx-reset')?.addEventListener('click', () => run('POST', '/api/sandbox:reset', {}, 'Empty the sandbox? Everything in it is lost.'));
  $('#sbx-clone')?.addEventListener('click', () => {
    const anonymize = $('#sbx-anon').checked;
    return run('POST', '/api/sandbox:clone', { anonymize },
      anonymize ? 'Replace the sandbox with a copy of production, members anonymized?'
        : 'Replace the sandbox with an exact copy of production, members\' personal data included?');
  });
  $('#sbx-delete')?.addEventListener('click', () => run('DELETE', '/api/sandbox', undefined, 'Delete the sandbox and everything in it?', false));
}
