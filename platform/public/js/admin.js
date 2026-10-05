/**
 * Administration: one page with the tabs of menuDef.js ADMIN_TABS, drawn in
 * #subnav above the page. Each tab shows screens that exist elsewhere,
 * limited to the parts that belong to it. A tab with more than one screen
 * (Access: users and roles, then access preferences) shows them one at a
 * time, chosen in a second row, because each screen redraws the whole page
 * when it saves.
 */

import { S, el, esc, navFilter } from './base.js';
import { view } from './ui.js';
import { can } from './access.js';
import { visibleTabs } from './menuDef.js';
import { orgView } from './organization.js';
import { accountingView } from './accounting.js';
import { usersView } from './users.js';
import { accessView } from './accessAdmin.js';
import { productsView } from './products.js';
import { controlsView } from './controls.js';
import { viewsView } from './views.js';
import { reportsView } from './reports.js';
import { returnsView } from './finance.js';
import { dataView } from './data.js';
import { messagesView, webhooksView } from './webhooks.js';
import { streamTemplatesView, subscriptionsView } from './streaming.js';

const GENERAL = ['details', 'branding', 'eod', 'holidays', 'channels', 'idTemplates', 'rates', 'currencies'];

// Each tab's screens: [label, render].
const PARTS = {
  general: [['General Setup', () => orgView({ only: GENERAL })]],
  clients: [['Client Setup', () => orgView({ only: ['clients'] })]],
  accounting: [['Accounting Setup', () => accountingView({ only: ['rules', 'closures'] })]],
  organization: [['Branches and Centres', () => orgView({ only: ['branches'] })]],
  access: [['Users and Roles', () => usersView()], ['Access Preferences, API Consumers, Audit Trail', () => accessView()]],
  products: [['Loan and Deposit Products', () => productsView({ only: ['loan', 'deposit'] })], ['Lending Controls', () => controlsView()]],
  fields: [['Fields', () => orgView({ only: ['fields'] })]],
  views: [['Custom Views and Menu Items', () => viewsView()]],
  webhooks: [['Webhooks', () => webhooksView()], ['Communication Log', () => messagesView()]],
  events: [['Streaming Templates', () => streamTemplatesView()], ['Subscriptions', () => subscriptionsView()]],
  templates: [['Report Templates', () => reportsView({ which: 'templates' })], ['Product Documents', () => orgView({ only: ['documents'] })]],
  reports: [['Regulatory Return Templates', () => returnsView()]],
  data: [['Import, Backups, Data Dictionary, Extract', () => dataView()]],
};

const state = { tab: null, part: 0 };

/** A tab whose feature is not built yet. */
export async function placeholderTab(tab) {
  view().innerHTML = `<div class="toolbar"><h1>${esc(tab.label)}</h1></div><p class="notice">${esc(tab.placeholder)}</p>`;
}

export async function adminView(filter) {
  const f = navFilter(filter);
  const tabs = visibleTabs(can);
  if (!tabs.length) {
    el('subnav').hidden = true;
    view().innerHTML = '<p class="hint">Your role has no administration rights.</p>';
    return;
  }
  const wanted = f?.tab || state.tab;
  const tab = tabs.find((t) => t.key === wanted) || tabs[0];
  if (tab.key !== state.tab) state.part = 0;
  if (f && Number.isInteger(f.part)) state.part = f.part;
  state.tab = tab.key;
  // The hash names the tab shown, also when the one asked for was hidden or unknown.
  if (S.filter?.tab !== tab.key) {
    S.filter = { tab: tab.key };
    history.replaceState(null, '', `#admin/${tab.key}`);
    S.hash = location.hash;
  }
  const parts = PARTS[tab.key] || [];
  if (state.part >= parts.length) state.part = 0;
  const sub = el('subnav');
  sub.hidden = false;
  sub.innerHTML = `<div class="tabs">${tabs.map((t) => `<button data-tab="${esc(t.key)}" class="${t.key === tab.key ? 'active' : ''}">${esc(t.label)}</button>`).join('')}</div>
    ${parts.length > 1 ? `<div class="parts">${parts.map(([label], i) => `<button data-part="${i}" class="${i === state.part ? 'active' : ''}">${esc(label)}</button>`).join('')}</div>` : ''}`;
  if (tab.placeholder) return placeholderTab(tab);
  return parts[state.part][1]();
}

/** Tab and part clicks, wired once. go is passed in to keep this module free of nav.js. */
export function wireAdmin(go) {
  el('subnav').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) return go('admin', { tab: t.dataset.tab });
    const p = e.target.closest('[data-part]');
    if (p) return go('admin', { tab: state.tab, part: Number(p.dataset.part) });
    return null;
  });
}
