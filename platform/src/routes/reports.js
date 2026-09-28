'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requirePermission } = require('../tenancy/resolve');
const PERMS = require('../lib/permissions');
const { pageParams, pageQuery, sendPage } = require('../lib/page');
const X = require('../lib/export');
const { once } = require('../lib/idempotency');
const R = require('../domain/reports');
const PF = require('../domain/portfolio');
const IND = require('../domain/indicators');
const MR = require('../domain/managementReports');
const AR = require('../domain/accountingReports');
const acct = require('../domain/accounting');
const runner = require('../ops/reportRunner');

/**
 * Reports (the reference platform's Data and Reporting > Reporting): the financial
 * statements, portfolio at risk, the risk report, indicators, the
 * management reports and the portfolio positions they read. Mounted under
 * /api/reports. Every report takes ?format=csv or ?format=xlsx to download
 * it instead, with the organization, the period and the branch in the header.
 */

const router = express.Router();
// The reference platform's permissions: the statements need VIEW_ACCOUNTING_REPORTS, the
// portfolio and management reports VIEW_REPORTS, indicators VIEW_INTELLIGENCE,
// and a download EXPORT_TO_EXCEL as well.
const ACCOUNTING = 'VIEW_ACCOUNTING_REPORTS';
const REPORTS = 'VIEW_REPORTS';
const INTELLIGENCE = 'VIEW_INTELLIGENCE';

const scopeOf = (q) => ({
  branchId: q.branchId || null, centreId: q.centreId || null, productId: q.productId || null, creditOfficer: q.creditOfficer || null,
});
const branchLabel = (b) => (b ? `${b.code || ''} ${b.name || ''}`.trim() : 'All branches');

/**
 * A report route: fn(c, query, req) returns the report; exp(report, req),
 * when given, turns it into an export for ?format=.
 */
function report(fn, exp = null, perm = REPORTS) {
  return [requirePermission(perm), async (req, res, next) => {
    try {
      const fmt = X.format(req.query.format);
      if (req.query.format && !fmt) return next(Object.assign(new Error('FORMAT_MUST_BE_CSV_OR_XLSX'), { status: 400 }));
      if (fmt && !PERMS.can(req.auth, 'EXPORT_TO_EXCEL')) return next(Object.assign(new Error('PERMISSION_REQUIRED: EXPORT_TO_EXCEL'), { status: 403 }));
      const out = await withTenantRead(req.tenant.schema_name, (c) => fn(c, req.query, req, Boolean(fmt)));
      if (fmt && exp) {
        const e = exp(out, req);
        e.header = [['Organization', req.tenant.name], ...e.header, ['Generated', new Date().toISOString()]];
        return X.send(res, fmt, e, `${req.tenant.slug}-${e.file}`);
      }
      if (fmt) return next(Object.assign(new Error('THIS_REPORT_HAS_NO_EXPORT'), { status: 400 }));
      res.json(out);
    } catch (e) { next(e); }
  }];
}

// A statement returns every line by default, because that is what a
// statement is. Paging engages only when the caller asks for it, and the
// totals stay whole either way.
const lines = (q, whole) => (q.limit === undefined || whole ? { offset: 0, limit: null } : pageParams(q));

// --- financial statements ------------------------------------------------------

router.get('/balance-sheet', ...report((c, q, _r, whole) =>
  R.balanceSheet(c, { asAt: q.asAt || null, month: q.month || null, branchId: q.branchId || null, ...lines(q, whole) }),
(b) => ({
  file: `balance-sheet-${b.asAt}`, title: 'Balance sheet',
  header: [['Report', 'Balance sheet'], [b.mode === 'MONTH' ? 'Month' : 'As at', b.mode === 'MONTH' ? `${b.month} (to ${b.asAt})` : b.asAt], ['Branch', branchLabel(b.branch)]],
  columns: [{ key: 'section', label: 'Section' }, { key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, { key: 'amount', label: 'Amount', num: true }],
  rows: [
    ...b.assets.map((r) => ({ section: 'Assets', ...r })), { section: 'Assets', name: 'Total assets', amount: b.totalAssets },
    ...b.liabilities.map((r) => ({ section: 'Liabilities', ...r })), { section: 'Liabilities', name: 'Total liabilities', amount: b.totalLiabilities },
    ...b.equity.map((r) => ({ section: 'Equity', ...r })), { section: 'Equity', name: 'Total equity', amount: b.totalEquity },
  ],
}), ACCOUNTING));

router.get('/income-statement', ...report((c, q, _r, whole) =>
  R.incomeStatement(c, { from: q.from || null, to: q.to || null, branchId: q.branchId || null, ...lines(q, whole) }),
(s) => ({
  file: `income-statement-${s.period.from || 'start'}-${s.period.to || 'now'}`, title: 'Income statement',
  header: [['Report', 'Income statement (profit and loss)'], ['From', s.period.from || 'the start of the book'], ['To', s.period.to || 'today'], ['Branch', branchLabel(s.branch)]],
  columns: [{ key: 'section', label: 'Section' }, { key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, { key: 'amount', label: 'Amount', num: true }],
  rows: [
    ...s.income.map((r) => ({ section: 'Income', ...r })), { section: 'Income', name: 'Total income', amount: s.totalIncome },
    ...s.expenses.map((r) => ({ section: 'Expenses', ...r })), { section: 'Expenses', name: 'Total expenses', amount: s.totalExpenses },
    { section: '', name: 'Surplus', amount: s.surplus },
  ],
}), ACCOUNTING));

router.get('/prudential', ...report((c, q) => R.prudentialRatios(c, { asAt: q.asAt || null }), null, ACCOUNTING));

// --- portfolio at risk ---------------------------------------------------------

router.get('/portfolio-at-risk', ...report((c, q) => R.portfolioAtRisk(c, { asAt: q.asAt || null, ...scopeOf(q) }),
  (p) => ({
    file: `portfolio-at-risk-${p.asAt}`, title: 'Portfolio at risk',
    header: [['Report', 'Portfolio at risk'], ['As at', p.asAt], ['Source', p.source], ['Branch', branchLabel(p.scope.branch)], ['Gross loan portfolio', String(p.totalOutstanding)]],
    columns: [{ key: 'measure', label: 'Measure' }, { key: 'loans', label: 'Loans', num: true }, { key: 'amount', label: 'Amount', num: true }, { key: 'percent', label: 'Percent of portfolio', num: true }],
    rows: [
      ...Object.entries(p.par).map(([k, v]) => ({ measure: k, loans: v.loans, amount: v.outstanding, percent: v.percent })),
      ...Object.entries(p.var).map(([k, v]) => ({ measure: k, loans: v.loans, amount: v.overdue, percent: v.percent })),
      { measure: 'INTEREST_IN_SUSPENSE', amount: p.interestInSuspense },
    ],
  })));

// The loan-by-loan version behind the buckets. Unbounded, so paged; an
// export holds every loan.
router.get('/portfolio-at-risk/loans', ...report((c, q, _r, whole) =>
  R.portfolioAtRiskLoans(c, {
    asAt: q.asAt || null, bucket: q.bucket || null, minDaysLate: q.minDaysLate, maxDaysLate: q.maxDaysLate, ...scopeOf(q),
    ...(whole ? { offset: 0, limit: 100000 } : pageParams(q)),
  }),
(p) => ({
  file: `loans-at-risk-${p.asAt}`, title: 'Loans at risk',
  header: [['Report', 'Loans at risk'], ['As at', p.asAt], ['Bucket', p.bucket], ['Branch', branchLabel(p.scope.branch)]],
  columns: [
    { key: 'account_no', label: 'Loan' }, { key: 'member_no', label: 'Member' }, { key: 'first_name', label: 'First name' },
    { key: 'last_name', label: 'Last name' }, { key: 'product_id', label: 'Product' }, { key: 'branch_code', label: 'Branch' },
    { key: 'credit_officer', label: 'Credit officer' }, { key: 'status', label: 'State' }, { key: 'days_late', label: 'Days late', num: true },
    { key: 'bucket', label: 'Bucket' }, { key: 'outstanding', label: 'Principal outstanding', num: true },
    { key: 'principal_overdue', label: 'Principal overdue', num: true }, { key: 'interest_overdue', label: 'Interest overdue', num: true },
    { key: 'fees_overdue', label: 'Fees overdue', num: true },
  ],
  rows: p.items,
})));

// --- risk report -------------------------------------------------------------------

router.get('/risk', ...report((c, q) => PF.riskReport(c, {
  asAt: q.asAt || null, minDaysLate: q.minDaysLate ?? 1, maxDaysLate: q.maxDaysLate ?? null, band: q.band || null,
  groupBy: q.groupBy || 'BRANCH', ...scopeOf(q),
}), (r) => ({
  file: `risk-${r.asAt}`, title: 'Risk report',
  header: [['Report', 'Risk'], ['As at', r.asAt], ['Days late', `${r.filter.minDaysLate} to ${r.filter.maxDaysLate ?? 'any'}`],
    ['Risk level', r.filter.band || 'All'], ['Grouped by', r.groupBy], ['Gross loan portfolio', String(r.grossLoanPortfolio)]],
  columns: [{ key: 'label', label: r.groupBy }, { key: 'loans', label: 'Loans', num: true }, { key: 'principalOutstanding', label: 'Principal outstanding', num: true },
    { key: 'principalOverdue', label: 'Principal overdue', num: true }, { key: 'percentOfPortfolio', label: 'Percent of portfolio', num: true },
    { key: 'provisionRequired', label: 'Provision required', num: true }],
  rows: r.groups,
  totals: { loans: r.loans, principalOutstanding: r.principalOutstanding, principalOverdue: r.principalOverdue, percentOfPortfolio: r.percentOfPortfolio, provisionRequired: r.provisionRequired },
})));

// --- portfolio positions -------------------------------------------------------------

router.get('/positions', ...report(async (c, q) => {
  const range = await PF.snapshotRange(c);
  if (!q.asAt) return range;
  const p = await PF.positions(c, { asAt: q.asAt, ...scopeOf(q) });
  return { ...range, asAt: p.asAt, source: p.source, takenAt: p.takenAt, scope: p.scope, positions: p.rows };
}));
// Take today's positions now (the end of day does this itself).
router.post('/positions', requirePermission('MANAGE_EOD_PROCESSING'), async (req, res, next) => {
  try {
    res.status(201).json(await withTenant(req.tenant.schema_name, (c) => PF.snapshot(c, { takenBy: req.auth.email })));
  } catch (e) { next(e); }
});

// --- indicators --------------------------------------------------------------------

const indicatorExport = (o, title) => ({
  file: `indicators-${String(o.entity.label).replace(/\s+/g, '-')}`, title: title || 'Indicators',
  header: [['Report', title || 'Indicators'], ['For', `${o.entity.type} ${o.entity.label}`]],
  columns: [{ key: 'group', label: 'Group' }, { key: 'label', label: 'Indicator' }, { key: 'code', label: 'Code' }, { key: 'value', label: 'Value', num: true }, { key: 'kind', label: 'Kind' }],
  rows: o.indicators,
});
router.get('/indicators/catalog', requirePermission(INTELLIGENCE), (req, res) => res.json({ groups: IND.GROUPS, entityTypes: IND.ENTITY_TYPES, indicators: IND.catalog() }));
router.get('/indicators', ...report((c, q) => IND.compute(c, {
  entityType: q.entityType || 'ORGANIZATION', entityId: q.entityId || null,
  codes: q.indicators ? String(q.indicators).split(',').filter(Boolean) : null,
}), (o) => indicatorExport(o), INTELLIGENCE));

router.get('/indicator-reports', ...report((c) => IND.list(c), null, INTELLIGENCE));
router.get('/indicator-reports/:id', ...report((c, _q, req) => IND.run(c, req.params.id), (o) => indicatorExport(o, o.report.name), INTELLIGENCE));
const write = (fn, status = 200, perm = 'EDIT_REPORTS') => [requirePermission(perm), async (req, res, next) => {
  try { res.status(status).json(await withTenant(req.tenant.schema_name, (c) => fn(c, req))); } catch (e) { next(e); }
}];
router.post('/indicator-reports', ...write((c, req) => IND.create(c, req.body, { createdBy: req.auth.email }), 201, 'CREATE_REPORTS'));
router.put('/indicator-reports/:id', ...write((c, req) => IND.update(c, req.params.id, req.body)));
router.patch('/indicator-reports/:id', ...write((c, req) => IND.update(c, req.params.id, req.body)));
router.delete('/indicator-reports/:id', ...write((c, req) => IND.remove(c, req.params.id), 200, 'DELETE_REPORTS'));

// --- management reports ------------------------------------------------------------

router.get('/portfolio', ...report((c, q) => MR.portfolio(c, { from: q.from || null, to: q.to || null, interval: q.interval || 'MONTHLY', branchId: q.branchId || null }),
  (p) => ({
    file: `portfolio-${p.period.from}-${p.period.to}`, title: 'Portfolio',
    header: [['Report', 'Portfolio'], ['From', p.period.from], ['To', p.period.to], ['Interval', p.interval], ['Branch', branchLabel(p.branch)]],
    columns: [
      { key: 'from', label: 'From' }, { key: 'to', label: 'To' }, { key: 'created', label: 'Loans created', num: true },
      { key: 'disbursedLoans', label: 'Loans disbursed', num: true }, { key: 'disbursedAmount', label: 'Amount disbursed', num: true },
      { key: 'writtenOffLoans', label: 'Loans written off', num: true }, { key: 'writtenOffAmount', label: 'Amount written off', num: true },
      { key: 'repaid', label: 'Loans repaid in full', num: true }, { key: 'source', label: 'Positions' },
      { key: 'glp', label: 'Gross loan portfolio', num: true }, { key: 'parOver30', label: 'PAR over 30', num: true },
      { key: 'averageLoanBalance', label: 'Average loan balance', num: true },
      { key: 'assets', label: 'Assets', num: true }, { key: 'liabilities', label: 'Liabilities', num: true }, { key: 'equity', label: 'Equity', num: true },
    ],
    rows: p.accounts.map((a, i) => {
      const h = p.historical[i];
      return {
        from: a.from, to: a.to, created: a.created, disbursedLoans: a.disbursed.loans, disbursedAmount: a.disbursed.amount,
        writtenOffLoans: a.writtenOff.loans, writtenOffAmount: a.writtenOff.amount, repaid: a.repaid, source: h.source,
        glp: h.grossLoanPortfolio, parOver30: h.portfolioRisk ? h.portfolioRisk.parOver30 : null, averageLoanBalance: h.averageLoanBalance,
        ...h.capitalStructure,
      };
    }),
  })));

router.get('/organization', ...report((c) => MR.organization(c), (o) => ({
  file: `organization-${o.asAt}`, title: 'Organization',
  header: [['Report', 'Organization'], ['As at', o.asAt]],
  columns: [{ key: 'kind', label: 'Kind' }, { key: 'code', label: 'Branch or officer' }, { key: 'name', label: 'Name' },
    { key: 'members', label: 'Members', num: true }, { key: 'borrowers', label: 'Borrowers', num: true }, { key: 'loans', label: 'Loans', num: true },
    { key: 'grossLoanPortfolio', label: 'Gross loan portfolio', num: true }, { key: 'parOver30', label: 'PAR over 30', num: true },
    { key: 'deposits', label: 'Deposits', num: true }],
  rows: [
    ...o.branches.map((b) => ({ kind: 'Branch', ...b })),
    ...o.creditOfficers.map((x) => ({ kind: 'Credit officer', code: x.email, ...x })),
  ],
})));

router.get('/earnings', ...report((c, q) => MR.earnings(c, { from: q.from || null, to: q.to || null, groupBy: q.groupBy || 'PRODUCT', branchId: q.branchId || null }),
  (e) => ({
    file: `earnings-${e.period.from}-${e.period.to}`, title: 'Earnings',
    header: [['Report', 'Earnings'], ['From', e.period.from], ['To', e.period.to], ['Grouped by', e.groupBy], ['Branch', branchLabel(e.branch)]],
    columns: [{ key: 'group', label: e.groupBy }, { key: 'kind', label: 'Revenue or expense' }, { key: 'code', label: 'GL account' }, { key: 'name', label: 'Account' }, { key: 'amount', label: 'Amount', num: true }],
    rows: e.groups.flatMap((g) => [
      ...g.revenues.map((r) => ({ group: g.label, kind: 'Revenue', ...r })),
      ...g.expenses.map((r) => ({ group: g.label, kind: 'Expense', ...r })),
      { group: g.label, kind: 'Net', amount: g.net },
    ]),
  })));

router.get('/cashflow', ...report((c, q) => MR.cashflow(c, { from: q.from || null, to: q.to || null, branchId: q.branchId || null }),
  (f) => ({
    file: `cashflow-${f.period.from}-${f.period.to}`, title: 'Cashflow',
    header: [['Report', 'Cashflow'], ['From', f.period.from], ['To', f.period.to], ['Currency', f.currency], ['Branch', branchLabel(f.branch)]],
    columns: [{ key: 'section', label: 'Section' }, { key: 'label', label: 'Line' }, { key: 'amount', label: 'Amount', num: true }],
    rows: [
      ...f.income.map((r) => ({ section: 'Income', ...r })), { section: 'Income', label: 'Total income', amount: f.totalIncome },
      ...f.expenses.map((r) => ({ section: 'Expenses', ...r })), { section: 'Expenses', label: 'Total expenses', amount: f.totalExpenses },
      ...Object.entries(f.balanceChanges).map(([k, v]) => ({ section: 'Balance changes', label: k, amount: v })),
    ],
  })));

router.get('/outreach', ...report((c, q) => MR.outreach(c, { from: q.from || null, to: q.to || null }), (o) => ({
  file: `outreach-${o.period.from}-${o.period.to}`, title: 'Outreach',
  header: [['Report', 'Outreach'], ['From', o.period.from], ['To', o.period.to], ['Clients as at', o.asAt]],
  columns: [{ key: 'branch', label: 'Branch' }, { key: 'clients', label: 'Clients', num: true }, { key: 'activeClients', label: 'Active clients', num: true },
    { key: 'femaleClientsPercent', label: 'Female clients %', num: true }, { key: 'borrowers', label: 'Borrowers', num: true },
    { key: 'femaleBorrowersPercent', label: 'Female borrowers %', num: true }, { key: 'savers', label: 'Savers', num: true },
    { key: 'joinedInPeriod', label: 'Joined', num: true }, { key: 'exitedInPeriod', label: 'Exited', num: true }],
  rows: o.byBranch,
})));

// --- reference ---------------------------------------------------------------------

router.get('/limits', requirePermission(ACCOUNTING), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, async (c) =>
      (await c.query('SELECT * FROM prudential_limits ORDER BY code')).rows));
  } catch (e) { next(e); }
});

router.get('/audit-log', requirePermission('AUDIT_TRANSACTIONS', REPORTS), async (req, res, next) => {
  try {
    const page = await withTenantRead(req.tenant.schema_name, (c) => pageQuery(
      c,
      `SELECT id, actor, action, entity, entity_id, created_at
       FROM audit_log
       WHERE ($1::text IS NULL OR action = $1::text)
         AND ($2::text IS NULL OR entity = $2::text)
       ORDER BY created_at DESC, id DESC`,
      [req.query.action || null, req.query.entity || null],
      req.query
    ));
    sendPage(res, page);
  } catch (e) { next(e); }
});

// --- accounting reports in the background (the reference platform: /accounting/reports) ------------------
//
// POST /accounting/reports             { startDate, endDate, balanceTypes, glTypes, branchId, currencyCode }
//                                      -> 202 { reportKey, status: QUEUED }; Idempotency-Key supported
// GET  /accounting/reports/{reportKey} -> { reportKey, status, items: [{ glAccount, amounts }] }

const accountingReports = express.Router();
accountingReports.post('/', requirePermission(ACCOUNTING), async (req, res, next) => {
  try {
    const out = await withTenant(req.tenant.schema_name, (c) => once(c, req, 'accounting-report', async () =>
      ({ status: 202, body: await AR.create(c, req.body || {}, { createdBy: req.auth.email }) })));
    if (!out.replayed) {
      const job = runner.start(req.tenant, out.body.reportKey);
      if (String(req.query.wait || '') === 'true') {
        await job;
        return res.status(200).json(await withTenantRead(req.tenant.schema_name, (c) => AR.get(c, out.body.reportKey)));
      }
    }
    res.status(out.status).json(out.body);
  } catch (e) { next(e); }
});
accountingReports.get('/:reportKey', requirePermission(ACCOUNTING), async (req, res, next) => {
  try {
    const r = await withTenantRead(req.tenant.schema_name, (c) => AR.get(c, req.params.reportKey));
    // A branch-limited user reads only reports of their branches (lib/ledgerScope).
    if (Array.isArray(req.auth.branches) && !req.auth.branches.includes(r.request?.branchId)) {
      throw Object.assign(new Error('OUTSIDE_YOUR_BRANCH_ACCESS'), { status: 403 });
    }
    res.json(r);
  } catch (e) { next(e); }
});

// --- the trial balance export (the route itself is /accounting/trial-balance) -----------

function trialBalanceExport(t) {
  return {
    file: `trial-balance-${t.period.from || 'start'}-${t.period.to || 'now'}`, title: 'Trial balance',
    header: [['Report', 'Trial balance'], ['From', t.period.from || 'the start of the book'], ['To', t.period.to || 'today'],
      ['Branch', branchLabel(t.branch)], ['Zero balance accounts', t.zeroBalances ? 'shown' : 'left out']],
    columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, { key: 'type', label: 'Type' },
      { key: 'openingBalance', label: 'Opening balance', num: true }, { key: 'debit', label: 'Debits', num: true },
      { key: 'credit', label: 'Credits', num: true }, { key: 'netChange', label: 'Net change', num: true },
      { key: 'closingBalance', label: 'Closing balance', num: true }],
    rows: t.rows,
    totals: { debit: t.totals.debit, credit: t.totals.credit },
  };
}

async function trialBalance(req, res, next) {
  try {
    const fmt = X.format(req.query.format);
    if (req.query.format && !fmt) return next(Object.assign(new Error('FORMAT_MUST_BE_CSV_OR_XLSX'), { status: 400 }));
    if (fmt && !PERMS.can(req.auth, 'EXPORT_TO_EXCEL')) return next(Object.assign(new Error('PERMISSION_REQUIRED: EXPORT_TO_EXCEL'), { status: 403 }));
    // Unlike the statements, the trial balance pages by default: it is the
    // one report that lists every account that moved, and a mature chart of
    // accounts is long. An export holds every row.
    const { offset, limit } = fmt ? { offset: 0, limit: null } : pageParams(req.query);
    const t = await withTenantRead(req.tenant.schema_name, (c) => acct.trialBalance(c, {
      from: req.query.from || null, to: req.query.to || null, offset, limit, branchId: req.query.branchId || null,
      zeroBalances: ['true', '1'].includes(String(req.query.zeroBalances || '').toLowerCase()),
      glTypes: req.query.glTypes ? String(req.query.glTypes).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null,
    }));
    if (!fmt) return res.json(t);
    const e = trialBalanceExport(t);
    e.header = [['Organization', req.tenant.name], ...e.header, ['Generated', new Date().toISOString()]];
    return X.send(res, fmt, e, `${req.tenant.slug}-${e.file}`);
  } catch (e) { next(e); }
}

module.exports = router;
module.exports.accountingReports = accountingReports;
module.exports.trialBalance = trialBalance;
