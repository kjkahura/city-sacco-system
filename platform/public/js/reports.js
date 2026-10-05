/**
 * Reports: the list, the filters each takes, running and exporting one.
 */

import { $, api, day, el, esc, money, navFilter, openFile } from './base.js';
import { card, pager, table, view, wirePager } from './ui.js';
import { can } from './access.js';
import { templatesReport } from './templates.js';
import { appTabs } from './apps.js';

// --------------------------------------------------------------------------
// Reports
// --------------------------------------------------------------------------

const reportState = { which: 'trial-balance', from: '', to: '', asAt: '', branch: '', groupBy: '', interval: 'MONTHLY', zero: false, offset: 0, limit: 50 };
let branchList = null;

// Which filters each report takes, and the export it offers.
const REPORTS = [
  ['trial-balance', 'Trial balance', { dates: true, branch: true, exp: '/api/accounting/trial-balance' }],
  ['balance-sheet', 'Balance sheet', { dates: true, branch: true, exp: '/api/reports/balance-sheet' }],
  ['income-statement', 'Income statement', { dates: true, branch: true, exp: '/api/reports/income-statement' }],
  ['portfolio-at-risk', 'Portfolio at risk', { asAt: true, branch: true, exp: '/api/reports/portfolio-at-risk' }],
  ['par-loans', 'Loans at risk', { asAt: true, branch: true, exp: '/api/reports/portfolio-at-risk/loans' }],
  ['risk', 'Risk', { asAt: true, branch: true, group: ['BRANCH', 'CREDIT_OFFICER', 'CENTRE', 'PRODUCT'], exp: '/api/reports/risk' }],
  ['indicators', 'Indicators', { branch: true, exp: '/api/reports/indicators' }],
  ['portfolio', 'Portfolio', { dates: true, branch: true, interval: true, exp: '/api/reports/portfolio' }],
  ['organization', 'Organization', { exp: '/api/reports/organization' }],
  ['earnings', 'Earnings', { dates: true, branch: true, group: ['PRODUCT', 'BRANCH'], exp: '/api/reports/earnings' }],
  ['cashflow', 'Cashflow', { dates: true, branch: true, exp: '/api/reports/cashflow' }],
  ['outreach', 'Outreach', { dates: true, exp: '/api/reports/outreach' }],
  ['write-offs', 'Written-off loans', { dates: true }],
  ['prudential', 'Prudential ratios', { asAt: true }],
  ['templates', 'Other reports (templates)', {}],
];
const reportDef = (w) => (REPORTS.find(([v]) => v === w) || REPORTS[0])[2];
const ACCOUNTING_REPORTS = ['trial-balance', 'balance-sheet', 'income-statement', 'prudential'];
const reportAllowed = ([v]) => (ACCOUNTING_REPORTS.includes(v) ? can('VIEW_ACCOUNTING_REPORTS') : v === 'indicators' ? can('VIEW_INTELLIGENCE') : can('VIEW_REPORTS'));

export async function reportsView(filter) {
  const R = reportState;
  const f = navFilter(filter);
  if (f?.which && f.which !== R.which) { R.which = f.which; R.offset = 0; R.groupBy = ''; }
  if (!branchList) {
    const b = await api('GET', '/api/branches');
    branchList = b.ok ? b.body : [];
  }
  const shown = REPORTS.filter(reportAllowed);
  if (!shown.length) { view().innerHTML = '<p class="hint">Your role has no reports.</p>'; return; }
  if (!shown.some(([v]) => v === R.which)) R.which = shown[0][0];
  const d = reportDef(R.which);
  view().innerHTML = `
    <div class="toolbar">
      <label>Report<select id="r-which">
        ${shown.map(([v, label]) => `<option value="${v}" ${R.which === v ? 'selected' : ''}>${label}</option>`).join('')}
      </select></label>
      ${d.dates ? `<label>From<input id="r-from" type="date" value="${R.from}"></label>` : ''}
      ${d.dates || d.asAt ? `<label>${d.asAt ? 'As at' : 'To'}<input id="r-to" type="date" value="${R.to}"></label>` : ''}
      ${d.branch ? `<label>Branch<select id="r-branch"><option value="">All branches</option>
        ${branchList.map((b) => `<option value="${esc(b.code)}" ${R.branch === b.code ? 'selected' : ''}>${esc(b.code)} ${esc(b.name)}</option>`).join('')}</select></label>` : ''}
      ${d.group ? `<label>By<select id="r-group">${d.group.map((g) => `<option ${R.groupBy === g ? 'selected' : ''}>${g}</option>`).join('')}</select></label>` : ''}
      ${d.interval ? `<label>Interval<select id="r-interval">${['DAILY', 'WEEKLY', 'MONTHLY'].map((g) => `<option ${R.interval === g ? 'selected' : ''}>${g}</option>`).join('')}</select></label>` : ''}
      ${R.which === 'trial-balance' ? `<label class="check"><input id="r-zero" type="checkbox" ${R.zero ? 'checked' : ''}> Zero balance accounts</label>` : ''}
      <button id="r-run">Run</button>
      ${d.exp ? '<button class="secondary" id="r-csv">CSV</button><button class="secondary" id="r-xlsx">Excel</button>' : ''}
    </div>
    <div id="r-out"><p class="hint">Loading…</p></div>`;

  $('#r-which').addEventListener('change', (e) => { R.which = e.target.value; R.offset = 0; R.groupBy = ''; reportsView(); });
  if ($('#r-from')) $('#r-from').addEventListener('change', (e) => { R.from = e.target.value; });
  if ($('#r-to')) $('#r-to').addEventListener('change', (e) => { R.to = e.target.value; });
  if ($('#r-branch')) $('#r-branch').addEventListener('change', (e) => { R.branch = e.target.value; });
  if ($('#r-group')) $('#r-group').addEventListener('change', (e) => { R.groupBy = e.target.value; });
  if ($('#r-interval')) $('#r-interval').addEventListener('change', (e) => { R.interval = e.target.value; });
  if ($('#r-zero')) $('#r-zero').addEventListener('change', (e) => { R.zero = e.target.checked; });
  $('#r-run').addEventListener('click', () => { R.offset = 0; runReport(); });
  const download = (fmt) => {
    const qs = reportQuery();
    qs.set('format', fmt);
    openFile(`${d.exp}?${qs}`, `${R.which}.${fmt}`, { save: true });
  };
  if ($('#r-csv')) $('#r-csv').addEventListener('click', () => download('csv'));
  if ($('#r-xlsx')) $('#r-xlsx').addEventListener('click', () => download('xlsx'));
  runReport();
  appTabs('REPORTING_VIEW');
}

function reportQuery() {
  const R = reportState;
  const d = reportDef(R.which);
  const qs = new URLSearchParams();
  if (d.dates && R.from) qs.set('from', R.from);
  if (R.to) { qs.set('to', R.to); qs.set('asAt', R.to); }
  if (d.branch && R.branch) {
    if (R.which === 'indicators') { qs.set('entityType', 'BRANCH'); qs.set('entityId', R.branch); } else qs.set('branchId', R.branch);
  }
  if (d.group) qs.set('groupBy', R.groupBy || d.group[0]);
  if (d.interval) qs.set('interval', R.interval);
  if (R.which === 'trial-balance' && R.zero) qs.set('zeroBalances', 'true');
  return qs;
}

const pctText = (n) => (n === null || n === undefined ? '' : `${Number(n).toFixed(2)}%`);
const sourceNote = (p) => (p.source === 'SNAPSHOT' ? `<p class="hint">From the end of day's positions for ${esc(p.asAt)}.</p>` : '');

async function runReport() {
  const R = reportState;
  const out = el('r-out');
  const qs = reportQuery();
  const fail = (r) => void (out.innerHTML = `<p class="error">${esc(r.error)}</p>`);

  if (R.which === 'templates') return templatesReport(out);
  if (R.which === 'trial-balance') {
    qs.set('offset', R.offset); qs.set('limit', R.limit);
    const r = await api('GET', `/api/accounting/trial-balance?${qs}`);
    if (!r.ok) return fail(r);
    const t = r.body;
    out.innerHTML = table([
      { label: 'Code', key: 'code' }, { label: 'Account', key: 'name' },
      { label: 'Opening', num: true, value: (x) => money(x.openingBalance) },
      { label: 'Debit', num: true, value: (x) => money(x.debit) },
      { label: 'Credit', num: true, value: (x) => money(x.credit) },
      { label: 'Net change', num: true, value: (x) => money(x.netChange) },
      { label: 'Closing', num: true, value: (x) => money(x.closingBalance) },
    ], t.rows) + `<table><tbody><tr class="total">
        <td>Total (whole book, not this page)</td>
        <td class="num">${money(t.totals.debit)}</td><td class="num">${money(t.totals.credit)}</td>
      </tr></tbody></table>`
      + (t.balanced ? '' : '<p class="error">The trial balance does not balance.</p>')
      + '<p class="hint">Assets and expenses read debit minus credit; liabilities, equity and income credit minus debit.</p>'
      + pager({ offset: t.page.offset, limit: t.page.limit || R.limit }, t.page.total);
    wirePager(R, runReport);
    return;
  }

  if (R.which === 'balance-sheet') {
    const r = await api('GET', `/api/reports/balance-sheet?${qs}`);
    if (!r.ok) return fail(r);
    const b = r.body;
    const block = (title, rows, total) => card(title, table([
      { label: 'Code', value: (x) => x.code || '' }, { label: 'Account', key: 'name' },
      { label: 'Amount', num: true, value: (x) => money(x.amount) },
    ], rows) + `<p class="num"><strong>${money(total)}</strong></p>`);
    out.innerHTML = `<p class="hint">As at ${esc(b.asAt)}${b.branch ? `, branch ${esc(b.branch.code)}` : ''}.</p><div class="grid">
      ${block('Assets', b.assets, b.totalAssets)}
      ${block('Liabilities', b.liabilities, b.totalLiabilities)}
      ${block('Equity', b.equity, b.totalEquity)}
    </div>${b.balances ? '' : `<p class="error">Out by ${money(b.difference)}</p>`}`;
    return;
  }

  if (R.which === 'income-statement') {
    const r = await api('GET', `/api/reports/income-statement?${qs}`);
    if (!r.ok) return fail(r);
    const s = r.body;
    out.innerHTML = `<div class="grid">
      ${card('Income', table([{ label: 'Account', key: 'name' },
    { label: 'Amount', num: true, value: (x) => money(x.amount) }], s.income))}
      ${card('Expenses', table([{ label: 'Account', key: 'name' },
    { label: 'Amount', num: true, value: (x) => money(x.amount) }], s.expenses))}
    </div>
    ${card('Result', `<dl class="kv">
      <dt>Total income</dt><dd>${money(s.totalIncome)}</dd>
      <dt>Total expenses</dt><dd>${money(s.totalExpenses)}</dd>
      <dt>Surplus</dt><dd><strong>${money(s.surplus)}</strong></dd></dl>
      <p class="hint">Year-end closing entries are excluded, so a closed year still shows what it earned.</p>`)}`;
    return;
  }

  if (R.which === 'portfolio-at-risk') {
    const r = await api('GET', `/api/reports/portfolio-at-risk?${qs}`);
    if (!r.ok) return fail(r);
    const p = r.body;
    out.innerHTML = sourceNote(p) + `<div class="grid">
      ${card('Buckets', table([
    { label: 'Bucket', key: 'bucket' }, { label: 'Loans', num: true, key: 'loans' },
    { label: 'Outstanding', num: true, value: (x) => money(x.outstanding) },
  ], p.buckets))}
      ${card('PAR', table([{ label: 'Measure', key: 'k' }, { label: 'Loans', num: true, key: 'loans' },
    { label: 'Outstanding', num: true, value: (x) => money(x.outstanding) }, { label: 'Of portfolio', num: true, value: (x) => pctText(x.percent) }],
  Object.entries(p.par).map(([k, x]) => ({ k, ...x }))))}
      ${card('VAR', table([{ label: 'Measure', key: 'k' }, { label: 'Loans', num: true, key: 'loans' },
    { label: 'Overdue', num: true, value: (x) => money(x.overdue) }, { label: 'Of portfolio', num: true, value: (x) => pctText(x.percent) }],
  Object.entries(p.var).map(([k, x]) => ({ k, ...x }))))}
    </div><p class="hint">PAR ${p.parPercent}% of ${money(p.totalOutstanding)} outstanding. Interest in suspense ${money(p.interestInSuspense)}.</p>`;
    return;
  }

  if (R.which === 'par-loans') {
    qs.set('offset', R.offset); qs.set('limit', R.limit);
    const r = await api('GET', `/api/reports/portfolio-at-risk/loans?${qs}`);
    if (!r.ok) return fail(r);
    const p = r.body;
    out.innerHTML = table([
      { label: 'Loan', key: 'account_no' },
      { label: 'Member', value: (x) => `${x.first_name} ${x.last_name}` },
      { label: 'Branch', key: 'branch_code' },
      { label: 'Officer', key: 'credit_officer' },
      { label: 'Bucket', key: 'bucket' },
      { label: 'Days late', num: true, key: 'days_late' },
      { label: 'Outstanding', num: true, value: (x) => money(x.outstanding) },
      { label: 'Overdue', num: true, value: (x) => money(x.principal_overdue) },
    ], p.items || []) + pager(R, p.total || 0);
    wirePager(R, runReport);
    return;
  }

  if (R.which === 'risk') {
    const r = await api('GET', `/api/reports/risk?${qs}`);
    if (!r.ok) return fail(r);
    const k = r.body;
    out.innerHTML = sourceNote(k) + table([
      { label: k.groupBy, key: 'label' }, { label: 'Loans', num: true, key: 'loans' },
      { label: 'Outstanding', num: true, value: (x) => money(x.principalOutstanding) },
      { label: 'Overdue', num: true, value: (x) => money(x.principalOverdue) },
      { label: 'Of portfolio', num: true, value: (x) => pctText(x.percentOfPortfolio) },
      { label: 'Provision', num: true, value: (x) => (x.provisionRequired === null ? 'rate not set' : money(x.provisionRequired)) },
    ], k.groups, { empty: 'No loans in arrears' }) + card('By risk level', table([
      { label: 'Level', key: 'label' }, { label: 'Days', value: (x) => `${x.daysFrom}–${x.daysTo ?? ''}` },
      { label: 'Rate', num: true, value: (x) => (x.ratePercent === null ? 'not set' : pctText(x.ratePercent)) },
      { label: 'Loans', num: true, key: 'loans' },
      { label: 'Outstanding', num: true, value: (x) => money(x.principalOutstanding) },
      { label: 'Provision', num: true, value: (x) => (x.provisionRequired === null ? '' : money(x.provisionRequired)) },
    ], k.bands)) + (k.ratesUnset.length ? `<p class="notice">Provision rates not set: ${esc(k.ratesUnset.join(', '))}. Enter them under Period and provisions.</p>` : '');
    return;
  }

  if (R.which === 'indicators') {
    const r = await api('GET', `/api/reports/indicators?${qs}`);
    if (!r.ok) return fail(r);
    out.innerHTML = indicatorCards(r.body.indicators);
    return;
  }

  if (R.which === 'portfolio') {
    const r = await api('GET', `/api/reports/portfolio?${qs}`);
    if (!r.ok) return fail(r);
    const p = r.body;
    out.innerHTML = card('Overview', `<dl class="kv">
        <dt>Gross loan portfolio</dt><dd>${money(p.overview.grossLoanPortfolio)}</dd>
        <dt>Loans outstanding</dt><dd>${p.overview.loansOutstanding ?? ''}</dd>
        <dt>PAR over 30</dt><dd>${pctText(p.overview.parOver30)}</dd>
        <dt>Disbursed in the period</dt><dd>${money(p.overview.disbursedInPeriod)} (${p.overview.loansDisbursedInPeriod} loans)</dd>
        <dt>Deposits now</dt><dd>${money(p.overview.depositBalanceNow)}</dd></dl>`)
      + table([
        { label: 'From', key: 'from' }, { label: 'To', key: 'to' }, { label: 'Created', num: true, key: 'created' },
        { label: 'Disbursed', num: true, value: (x) => money(x.disbursed.amount) },
        { label: 'Written off', num: true, value: (x) => money(x.writtenOff.amount) },
        { label: 'Repaid', num: true, key: 'repaid' },
        { label: 'Portfolio', num: true, value: (x, i) => money(x.h.grossLoanPortfolio) },
        { label: 'PAR>30', num: true, value: (x) => (x.h.portfolioRisk ? pctText(x.h.portfolioRisk.parOver30) : 'no positions') },
        { label: 'Assets', num: true, value: (x) => money(x.h.capitalStructure.assets) },
      ], p.accounts.map((a, i) => ({ ...a, h: p.historical[i] })));
    return;
  }

  if (R.which === 'organization') {
    const r = await api('GET', '/api/reports/organization');
    if (!r.ok) return fail(r);
    const o = r.body;
    const cols = [{ label: 'Members', num: true, key: 'members' }, { label: 'Borrowers', num: true, key: 'borrowers' },
      { label: 'Loans', num: true, key: 'loans' }, { label: 'Portfolio', num: true, value: (x) => money(x.grossLoanPortfolio) },
      { label: 'PAR>30', num: true, value: (x) => pctText(x.parOver30) }];
    out.innerHTML = card('Branches', table([{ label: 'Branch', value: (x) => `${x.code} ${x.name}` }, ...cols,
      { label: 'Centres', num: true, key: 'centres' }, { label: 'Deposits', num: true, value: (x) => money(x.deposits) }], o.branches))
      + card('Credit officers', table([{ label: 'Officer', value: (x) => x.name || x.email }, ...cols], o.creditOfficers, { empty: 'No credit officers assigned' }));
    return;
  }

  if (R.which === 'earnings') {
    const r = await api('GET', `/api/reports/earnings?${qs}`);
    if (!r.ok) return fail(r);
    const e = r.body;
    out.innerHTML = table([
      { label: e.groupBy, key: 'label' }, { label: 'Revenue', num: true, value: (x) => money(x.totalRevenue) },
      { label: 'Expenses', num: true, value: (x) => money(x.totalExpenses) }, { label: 'Net', num: true, value: (x) => money(x.net) },
    ], e.groups, { empty: 'No income or expense in the period' }) + `<p class="hint">Total ${money(e.net)}, the income statement's surplus for the period.</p>`;
    return;
  }

  if (R.which === 'cashflow') {
    const r = await api('GET', `/api/reports/cashflow?${qs}`);
    if (!r.ok) return fail(r);
    const f = r.body;
    const b = f.balanceChanges;
    out.innerHTML = `<div class="grid">
      ${card('Income', table([{ label: 'Line', key: 'label' }, { label: 'Amount', num: true, value: (x) => money(x.amount) }], f.income) + `<p class="num"><strong>${money(f.totalIncome)}</strong></p>`)}
      ${card('Expenses', table([{ label: 'Line', key: 'label' }, { label: 'Amount', num: true, value: (x) => money(x.amount) }], f.expenses) + `<p class="num"><strong>${money(f.totalExpenses)}</strong></p>`)}
      ${card('Balance changes', `<dl class="kv">
        <dt>Principal disbursed</dt><dd>${money(b.principalDisbursed)}</dd><dt>Principal collected</dt><dd>${money(b.principalCollected)}</dd>
        <dt>Principal written off</dt><dd>${money(b.principalWrittenOff)}</dd><dt>Change in portfolio</dt><dd><strong>${money(b.changeInPortfolio)}</strong></dd>
        <dt>Deposits</dt><dd>${money(b.deposits)}</dd><dt>Withdrawals</dt><dd>${money(b.withdrawals)}</dd>
        <dt>Change in deposits</dt><dd><strong>${money(b.changeInDeposits)}</strong></dd></dl>`)}
    </div><p class="hint">In ${esc(f.currency)}, the base currency.</p>`;
    return;
  }

  if (R.which === 'outreach') {
    const r = await api('GET', `/api/reports/outreach?${qs}`);
    if (!r.ok) return fail(r);
    const o = r.body;
    out.innerHTML = card('Outreach', `<dl class="kv">
        <dt>Clients</dt><dd>${o.clients} (${o.activeClients} active)</dd><dt>Female clients</dt><dd>${pctText(o.femaleClientsPercent)}</dd>
        <dt>Borrowers</dt><dd>${o.borrowers}</dd><dt>Female borrowers</dt><dd>${pctText(o.femaleBorrowersPercent)}</dd>
        <dt>Savers</dt><dd>${o.savers}</dd><dt>Joined / exited in the period</dt><dd>${o.joinedInPeriod} / ${o.exitedInPeriod}</dd></dl>`)
      + table([{ label: 'Branch', value: (x) => `${x.branch} ${x.branchName}` }, { label: 'Clients', num: true, key: 'clients' },
        { label: 'Borrowers', num: true, key: 'borrowers' }, { label: 'Female borrowers', num: true, value: (x) => pctText(x.femaleBorrowersPercent) },
        { label: 'Savers', num: true, key: 'savers' }], o.byBranch);
    return;
  }

  if (R.which === 'write-offs') {
    qs.set('offset', R.offset); qs.set('limit', R.limit);
    const r = await api('GET', `/api/loans/write-offs?${qs}`);
    if (!r.ok) return fail(r);
    const w = r.body;
    const t = w.totals;
    out.innerHTML = table([
      { label: 'Loan', key: 'account_no' },
      { label: 'Member', value: (x) => `${x.first_name} ${x.last_name}` },
      { label: 'Written off', value: (x) => day(x.written_off_on) },
      { label: 'Amount', num: true, value: (x) => money(x.written_off_amount) },
      { label: 'From allowance', num: true, value: (x) => money(x.allowance_used) },
      { label: 'Recovered', num: true, value: (x) => money(x.recovered) },
      { label: 'Still owed', num: true, value: (x) => money(x.outstanding) },
      { label: 'Asked by', value: (x) => x.requested_by || '' },
      { label: 'Approved by', value: (x) => x.approved_by || x.written_off_by || '' },
      { label: 'Reason', value: (x) => x.reason || '' },
    ], w.items || [], { empty: 'No loans written off in this period' }) + pager(R, w.total || 0)
      + card('Totals for the period', `<dl class="kv" id="wo-totals">
        <dt>Loans</dt><dd>${t.loans}</dd>
        <dt>Written off</dt><dd>${money(t.written_off)}</dd>
        <dt>of which principal / interest / fees / penalties</dt><dd>${money(t.principal)} / ${money(t.interest)} / ${money(t.fees)} / ${money(t.penalty)}</dd>
        <dt>Taken from the allowance</dt><dd>${money(t.allowance_used)}</dd>
        <dt>Recovered on these loans</dt><dd>${money(t.recovered)}</dd>
        <dt>Still owed</dt><dd>${money(t.outstanding)}</dd>
        <dt>Recoveries received in the period (any write-off date)</dt><dd>${money(w.recoveriesInPeriod.amount)}</dd></dl>`);
    wirePager(R, runReport);
    return;
  }

  const r = await api('GET', `/api/reports/prudential?${qs}`);
  if (!r.ok) return fail(r);
  const p = r.body;
  out.innerHTML = `<p class="notice">${esc(p.disclaimer)}</p>` + table([
    { label: 'Measure', key: 'label' },
    { label: 'Value', num: true, value: (m) => (m.value === null ? '—' : money(m.value)) },
    { label: 'Minimum', num: true, value: (m) => (m.minimum === null ? '—' : money(m.minimum)) },
    {
      label: 'Status',
      html: true,
      value: (m) => (m.compliant === null ? '<span class="badge">unknown</span>'
        : m.compliant ? '<span class="badge">met</span>' : '<span class="badge bad">below</span>'),
    },
  ], p.measures);
}

/** Indicators as cards by group. */
export function indicatorCards(list) {
  const show = (x) => (x.value === null ? '<span class="hint">n/a</span>'
    : x.kind === 'PERCENT' ? pctText(x.value) : x.kind === 'AMOUNT' ? money(x.value) : esc(x.value));
  const groups = [...new Set(list.map((x) => x.group))];
  return `<div class="grid">${groups.map((g) => card(g.charAt(0) + g.slice(1).toLowerCase(), `<dl class="kv">${list.filter((x) => x.group === g)
    .map((x) => `<dt>${esc(x.label)}</dt><dd data-indicator="${esc(x.code)}">${show(x)}</dd>`).join('')}</dl>`)).join('')}</div>`;
}
