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
import { accountingView, accrualsView, chartView, journalView } from './accounting.js';
import { activitiesView, creditArrangementsView, depositTransactionsView, depositsView, loanTransactionsView } from './lists.js';
import { controlsView } from './controls.js';
import { orgView } from './organization.js';
import { dataView } from './data.js';
import { usersView } from './users.js';
import { menuView } from './menu.js';
import { tasksView } from './tasks.js';
import { tillsView } from './tills.js';
import { accessView } from './accessAdmin.js';
import { adminView, wireAdmin } from './admin.js';

/**
 * Open a page, as the navigation does. The filter is passed to the page
 * (for example { state: 'IN_ARREARS' }) and kept in the address hash, so
 * Back, a reload and a bookmark open the same page.
 */
let adminWired = false;

export function go(name, filter = {}) {
  if (!adminWired) { wireAdmin(go); adminWired = true; }
  // Administration's tabs show only on its page.
  if (name !== 'admin') el('subnav').hidden = true;
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

// Pages draw one at a time, the latest last: a page opened while another is
// still loading waits for it, and one opened and left before it started is skipped.
// Without this, a slow page could finish after a later one and draw over it.
let drawing = Promise.resolve();
let latest = 0;

export function render() {
  const seq = ++latest;
  closeMenus();
  view().innerHTML = '<p class="hint">Loading…</p>';
  drawing = drawing.then(async () => {
    if (seq !== latest) return;
    const fn = VIEWS[S.view] || VIEWS.dashboard;
    try {
      await fn(S.filter || {});
    } catch (e) {
      if (seq === latest) view().innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  });
  return drawing;
}

// Back and Forward, and a hash typed or followed from a bookmark.
window.addEventListener('hashchange', () => {
  if (!S.user || location.hash === S.hash) return;
  S.hash = location.hash;
  openFromHash();
});

const VIEWS = {
  admin: adminView,
  deposits: depositsView,
  loanTransactions: loanTransactionsView,
  depositTransactions: depositTransactionsView,
  activities: activitiesView,
  creditArrangements: creditArrangementsView,
  accruals: accrualsView,
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
