/**
 * The pages the navigation opens, and moving between them.
 */

import { S, el, esc } from './base.js';
import { view } from './ui.js';
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

/** Open a view from code, as the navigation does. */
export function go(name) {
  S.view = name;
  for (const n of el('nav').children) n.classList.toggle('active', n.dataset.view === name);
  for (const n of el('menu-nav').children) n.classList.remove('active');
  render();
}

export function render() {
  const fn = VIEWS[S.view];
  view().innerHTML = '<p class="hint">Loading…</p>';
  fn().catch((e) => { view().innerHTML = `<p class="error">${esc(e.message)}</p>`; });
}

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
