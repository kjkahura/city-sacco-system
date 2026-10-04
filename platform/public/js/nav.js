/**
 * The pages the navigation opens, and moving between them.
 */

import { S, el, esc } from './base.js';
import { view } from './ui.js';
import { hashOf, parseHash } from './menuDef.js';
import { closeMenus, markActive } from './topbar.js';
import { membersView } from './members.js';
import { groupsView } from './groups.js';
import { loansView } from './loans.js';
import { tellerView } from './teller.js';
import { reportsView } from './reports.js';
import { dashboardView } from './dashboard.js';
import { viewsView } from './views.js';
import { financeView, returnsView } from './finance.js';
import { productsView } from './products.js';
import { accountingView, chartView, journalView } from './accounting.js';
import { controlsView } from './controls.js';
import { orgView } from './organization.js';
import { dataView } from './data.js';
import { usersView } from './users.js';
import { menuView } from './menu.js';
import { tasksView } from './tasks.js';
import { tillsView } from './tills.js';
import { accessView } from './accessAdmin.js';

/**
 * Open a page, as the navigation does. The filter is passed to the page
 * (for example { state: 'IN_ARREARS' }) and kept in the address hash, so
 * Back, a reload and a bookmark open the same page.
 */
export function go(name, filter = {}) {
  S.view = name;
  S.filter = filter || {};
  const h = hashOf(name, S.filter);
  if (location.hash !== h) {
    S.hash = h;
    location.hash = h;
  }
  markActive(name, S.filter);
  for (const n of el('menu-nav').children) n.classList.remove('active');
  render();
}

/** Open the page the address hash names (an unknown one opens the dashboard). */
export function openFromHash() {
  const { view: v, filter } = parseHash(location.hash);
  go(VIEWS[v] ? v : 'dashboard', filter);
}

export function render() {
  const fn = VIEWS[S.view] || VIEWS.dashboard;
  closeMenus();
  view().innerHTML = '<p class="hint">Loading…</p>';
  fn(S.filter || {}).catch((e) => { view().innerHTML = `<p class="error">${esc(e.message)}</p>`; });
}

// Back and Forward, and a hash typed or followed from a bookmark.
window.addEventListener('hashchange', () => {
  if (!S.user || location.hash === S.hash) return;
  S.hash = location.hash;
  openFromHash();
});

const VIEWS = {
  access: accessView,
  menu: menuView,
  tasks: tasksView,
  tills: tillsView,
  dashboard: dashboardView,
  views: viewsView,
  members: membersView,
  groups: groupsView,
  data: dataView,
  users: usersView,
  organization: orgView,
  controls: controlsView,
  products: productsView,
  loans: loansView,
  teller: tellerView,
  reports: reportsView,
  finance: financeView,
  returns: returnsView,
  accounting: accountingView,
  chart: chartView,
  journal: journalView,
};
