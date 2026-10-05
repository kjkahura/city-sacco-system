/**
 * Apps (docs/audits/audit-apps.md): Administration > Apps, and the apps'
 * tabs on the pages they extend. An app opens in a sandboxed frame through
 * a one-time launch page, which posts the signed request to it; the App Key
 * and the signed request never reach this code.
 */

import { $, api, esc, toast } from './base.js';
import { ask, card, table, view, wireRows } from './ui.js';
import { showDialog } from './users.js';

const badge = (s) => `<span class="badge ${s === 'ENABLED' ? '' : 'bad'}">${esc(s.toLowerCase())}</span>`;

// --------------------------------------------------------------------------
// The apps on a page
// --------------------------------------------------------------------------

/**
 * Add the apps of a location to the page drawn: a card with a tab per
 * extension point; a tab opens its app in a frame. objectId is the record
 * the page shows (none for the dashboard's menu apps and the reports).
 */
export async function appTabs(location, objectId = null, root = view()) {
  // The page drawn now; if another replaces it before the answer, the apps are not added to that one.
  const page = root.firstElementChild;
  const r = await api('GET', `/api/apps/extensions?location=${encodeURIComponent(location)}`);
  if (!r.ok || !r.body.length || (page && !page.isConnected)) return;
  const box = document.createElement('section');
  box.className = 'card app-card';
  box.dataset.location = location;
  box.innerHTML = `<h2>Apps</h2>
    <div class="tabs app-tabs">${r.body.map((p, i) => `<button class="secondary" data-app="${esc(p.appId)}" data-i="${i}">${esc(p.label)}</button>`).join('')}</div>
    <div class="app-frame-box"></div>`;
  root.appendChild(box);
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-app]');
    if (!b) return;
    box.querySelectorAll('[data-app]').forEach((x) => x.classList.toggle('active', x === b));
    const l = await api('POST', `/api/apps/${encodeURIComponent(b.dataset.app)}/launch`, { location, objectId });
    if (!l.ok) { toast(l.error, true); return; }
    const frame = document.createElement('iframe');
    frame.className = 'app-frame';
    frame.title = b.textContent;
    // Scripts and forms for the app; no top navigation, so it cannot take the console's page.
    // allow-same-origin lets the app keep its own origin (cookies, storage). The launch page is ours and
    // same-origin, so it is effectively unsandboxed: it must only ever run appframe.js.
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.src = l.body.frameUrl;
    const holder = $('.app-frame-box', box);
    holder.replaceChildren(frame);
  });
}

// --------------------------------------------------------------------------
// Administration > Apps
// --------------------------------------------------------------------------

export async function appsAdminView() {
  const r = await api('GET', '/api/apps');
  if (!r.ok) throw new Error(r.error);
  view().innerHTML = `
    <div class="toolbar"><h1>Apps</h1><span class="spacer"></span><button id="app-add">Add app</button></div>
    <p class="hint">An app is another provider's web application shown on the pages it extends: members, groups, accounts,
      credit arrangements, branches, products, reports or the dashboard. It is loaded from its definition (XML) and secured with an
      App Key you agree with the provider. Each opening sends the app a signed request naming the record and the user.</p>
    <div id="apps-list">${table([
    { label: 'Name', key: 'name' }, { label: 'Provider', key: 'provider' },
    { label: 'Shows on', value: (a) => [...new Set(a.extensionPoints.map((p) => p.location))].join(', ') },
    { label: 'Who sees it', value: (a) => (a.usage.allUsers ? 'everyone' : a.usage.roles.join(', ')) },
    { label: 'State', html: true, value: (a) => badge(a.state) },
  ], r.body, { onRow: true, empty: 'No apps installed' })}</div>`;
  wireRows(r.body, (a) => appDetail(a.id));
  $('#app-add').addEventListener('click', addApp);
}

async function addApp() {
  const f = await ask([
    { name: 'sourceUrl', label: 'Definition address (HTTPS)', required: false, hint: 'Or paste the definition below' },
    { name: 'definition', label: 'Definition (XML)', type: 'textarea', rows: 6, required: false },
    { name: 'appKey', label: 'App Key (up to 32 characters, agreed with the provider)' },
    { name: 'roles', label: 'Who sees it: role codes, comma separated (empty: everyone)', required: false },
    { name: 'apiRole', label: 'API access: a role for the app\'s own API consumer (empty: none)', required: false },
  ], 'Add an app');
  if (!f) return;
  const roles = String(f.roles || '').split(',').map((x) => x.trim()).filter(Boolean);
  const body = {
    appKey: f.appKey, ...(f.definition.trim() ? { definition: f.definition } : { sourceUrl: f.sourceUrl.trim() }),
    ...(roles.length ? { roles } : {}), ...(f.apiRole.trim() ? { api: { role: f.apiRole.trim() } } : {}),
  };
  const r = await api('POST', '/api/apps', body);
  if (!r.ok) { toast(r.error, true); return; }
  await appDetail(r.body.id);
  if (r.body.apiKey) {
    showDialog('The app\'s API key', `<p>Give this key to the provider so the app can call the API. It is shown this once.</p>
      <p><code id="app-api-key">${esc(r.body.apiKey)}</code></p>`);
  } else toast(`${r.body.name} installed`);
}

async function appDetail(id) {
  const r = await api('GET', `/api/apps/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(r.error);
  const a = r.body;
  view().innerHTML = `
    <button class="secondary" id="back">← Apps</button>
    <h1>${esc(a.name)} ${badge(a.state)}</h1>
    <div class="grid">
      ${card('The app', `<dl class="kv"><dt>ID</dt><dd>${esc(a.id)}</dd><dt>Provider</dt><dd>${esc(a.provider || '')}</dd>
        <dt>Description</dt><dd>${esc(a.description || '')}</dd><dt>Definition</dt><dd>${esc(a.sourceUrl || 'pasted')}</dd>
        <dt>Who sees it</dt><dd>${esc(a.usage.allUsers ? 'everyone who sees the page' : a.usage.roles.join(', '))}</dd>
        <dt>API consumer</dt><dd>${a.apiConsumer ? esc(a.apiConsumer.id) : 'none'}</dd>
        <dt>Installed</dt><dd>${esc(a.installedBy || '')} ${esc(String(a.installedAt || '').slice(0, 10))}</dd></dl>`)}
      ${card('Where it shows', table([{ label: 'Location', key: 'location' }, { label: 'Label', key: 'label' }, { label: 'Address', key: 'url' }], a.extensionPoints))}
      ${card('Actions', `
        <button id="app-state">${a.state === 'ENABLED' ? 'Disable' : 'Enable'}</button>
        <button class="secondary" id="app-key">New App Key</button>
        ${a.sourceUrl ? '<button class="secondary" id="app-reload">Reload the definition</button>' : ''}
        <button class="secondary" id="app-remove">Uninstall</button>`)}
    </div>`;
  $('#back').addEventListener('click', appsAdminView);
  const patch = async (body, done) => {
    const x = await api('PATCH', `/api/apps/${encodeURIComponent(a.id)}`, body);
    if (!x.ok) return toast(x.error, true);
    toast(done);
    return appDetail(a.id);
  };
  $('#app-state').addEventListener('click', () => patch({ state: a.state === 'ENABLED' ? 'DISABLED' : 'ENABLED' }, 'Saved'));
  $('#app-key').addEventListener('click', async () => {
    const f = await ask([{ name: 'appKey', label: 'New App Key (up to 32 characters)' }], 'New App Key');
    if (f) await patch({ appKey: f.appKey }, 'The App Key is changed');
  });
  $('#app-reload')?.addEventListener('click', async () => {
    const x = await api('POST', `/api/apps/${encodeURIComponent(a.id)}:reload`);
    if (!x.ok) return toast(x.error, true);
    toast('The definition is reloaded');
    return appDetail(a.id);
  });
  $('#app-remove').addEventListener('click', async () => {
    if (!window.confirm(`Uninstall ${a.name}? The provider is told, and its API consumer is deactivated.`)) return;
    const x = await api('DELETE', `/api/apps/${encodeURIComponent(a.id)}`);
    if (!x.ok) { toast(x.error, true); return; }
    toast(`${a.name} uninstalled`);
    await appsAdminView();
  });
}
