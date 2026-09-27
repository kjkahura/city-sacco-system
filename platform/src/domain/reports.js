'use strict';

const { orgToday } = require('../lib/orgDate');
const acct = require('./accounting');
const PF = require('./portfolio');
const { round2 } = acct;

/**
 * Financial statements, built from posted journal lines.
 *
 * Sign convention: acct.balance is debit-positive. Assets and expenses are
 * naturally positive; liabilities, equity and income are naturally negative
 * and are flipped for presentation so a report reads the way an accountant
 * expects.
 */

/**
 * Net movement per account for a period, debit-positive.
 *
 * The period filter sits inside the aggregate (see accounting.MOVEMENT_SQL)
 * rather than in an outer join onto journal_entries. Put it in the outer join
 * and the line rows survive with their entry columns nulled, so every line is
 * counted whatever the dates say, which is how a statement for one month ends
 * up reporting the whole book.
 */
async function byType(c, { from = null, to = null, includeClosing = true, branchId = null } = {}) {
  const mv = acct.movement({ from, to, branchId, trading: !includeClosing });
  const { rows } = await c.query(
    `SELECT g.code, g.name, g.type, g.regulatory_class,
            COALESCE(m.debit, 0) - COALESCE(m.credit, 0) AS net
     FROM gl_accounts g
     LEFT JOIN (${mv.sql}) m ON m.gl_code = g.code
     ORDER BY g.code`,
    mv.params
  );
  return rows.map((r) => ({ ...r, net: round2(r.net) }));
}

const branchOut = (b) => (b ? { id: b.id, code: b.code, name: b.name } : null);

const sum = (rows, pred) => round2(rows.filter(pred).reduce((s, r) => s + r.net, 0));

/**
 * Line paging for the statements.
 *
 * These two are the one place where slicing in JavaScript is the right
 * answer: the row count is bounded by the chart of accounts, not by the size
 * of the book, and both statements need every line anyway to compute totals
 * that are true. So the totals are always over the whole set and only the
 * presentation is cut. Anything that grows with members or postings pages in
 * SQL instead, through lib/page.js.
 */
function pageLines(lines, { offset = 0, limit = null } = {}) {
  const off = Math.max(0, Number(offset) || 0);
  if (limit === null || limit === undefined) {
    return { page: lines, meta: { offset: 0, limit: null, total: lines.length } };
  }
  const lim = Math.max(1, Number(limit));
  return {
    page: lines.slice(off, off + lim),
    meta: { offset: off, limit: lim, total: lines.length },
  };
}

/**
 * Income statement for a period.
 * Surplus is what a SACCO calls profit, and it is what feeds retained
 * earnings on the balance sheet.
 */
async function incomeStatement(c, {
  from = null, to = null, offset = 0, limit = null, includeClosing = false, branchId = null,
} = {}) {
  const branch = await acct.branchScope(c, branchId);
  // Trading only by default: the year-end sweep and the reserve transfer are
  // postings, not performance, and counting them makes a closed year look
  // like it broke exactly even.
  const rows = await byType(c, { from, to, includeClosing, branchId: branch ? branch.id : null });
  const income = rows.filter((r) => r.type === 'INCOME' && r.net !== 0)
    .map((r) => ({ code: r.code, name: r.name, amount: round2(-r.net) }));
  const expenses = rows.filter((r) => r.type === 'EXPENSE' && r.net !== 0)
    .map((r) => ({ code: r.code, name: r.name, amount: r.net }));

  const totalIncome = round2(income.reduce((s, r) => s + r.amount, 0));
  const totalExpenses = round2(expenses.reduce((s, r) => s + r.amount, 0));

  const i = pageLines(income, { offset, limit });
  const e = pageLines(expenses, { offset, limit });

  return {
    period: { from, to },
    branch: branchOut(branch),
    income: i.page,
    expenses: e.page,
    page: { income: i.meta, expenses: e.meta },
    totalIncome,
    totalExpenses,
    surplus: round2(totalIncome - totalExpenses),
  };
}

/**
 * Balance sheet as at a date.
 *
 * The current period surplus is carried into equity explicitly rather than
 * being posted to retained earnings, because a year-end closing entry has
 * not happened yet. Without that line the sheet would not balance, and a
 * balance sheet that does not balance is worse than no balance sheet.
 */
async function balanceSheet(c, { asAt = null, month = null, offset = 0, limit = null, branchId = null } = {}) {
  const today = await orgToday(c);
  const branch = await acct.branchScope(c, branchId);
  // The reference platform's two modes: Date, everything from the start of the book to the
  // date; Month, that month's postings only (to today, for the current month).
  let from = null;
  let to = asAt || today;
  if (month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) throw acct.err(`INVALID_MONTH: ${month} (use yyyy-MM)`, 400);
    from = `${month}-01`;
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    to = last < today ? last : today;
  }
  const rows = await byType(c, { from, to, branchId: branch ? branch.id : null });

  const assets = rows.filter((r) => r.type === 'ASSET' && r.net !== 0)
    .map((r) => ({ code: r.code, name: r.name, amount: r.net }));
  const liabilities = rows.filter((r) => r.type === 'LIABILITY' && r.net !== 0)
    .map((r) => ({ code: r.code, name: r.name, amount: round2(-r.net) }));
  const equityAccounts = rows.filter((r) => r.type === 'EQUITY' && r.net !== 0)
    .map((r) => ({ code: r.code, name: r.name, amount: round2(-r.net) }));

  const surplus = round2(
    sum(rows, (r) => r.type === 'INCOME') * -1 - sum(rows, (r) => r.type === 'EXPENSE')
  );

  const totalAssets = round2(assets.reduce((s, r) => s + r.amount, 0));
  const totalLiabilities = round2(liabilities.reduce((s, r) => s + r.amount, 0));
  const totalEquityAccounts = round2(equityAccounts.reduce((s, r) => s + r.amount, 0));
  const totalEquity = round2(totalEquityAccounts + surplus);

  const equity = [...equityAccounts];
  if (surplus !== 0) {
    equity.push({ code: null, name: 'Surplus for the period (not yet closed)', amount: surplus });
  }

  const difference = round2(totalAssets - (totalLiabilities + totalEquity));

  const a = pageLines(assets, { offset, limit });
  const l = pageLines(liabilities, { offset, limit });
  const q = pageLines(equity, { offset, limit });

  return {
    asAt: to,
    mode: month ? 'MONTH' : 'DATE',
    ...(month ? { month, period: { from, to } } : {}),
    branch: branchOut(branch),
    assets: a.page,
    liabilities: l.page,
    equity: q.page,
    page: { assets: a.meta, liabilities: l.meta, equity: q.meta },
    totalAssets,
    totalLiabilities,
    totalEquity,
    balances: difference === 0,
    difference,
  };
}

/**
 * Prudential ratios.
 *
 * The thresholds come from the prudential_limits table, not from constants
 * in this file. Regulators move them, and the exact SASRA figures must be
 * confirmed against the current circular: the seeded values are flagged
 * UNVERIFIED in their source_note for that reason. The arithmetic here is
 * right; the limits are yours to confirm.
 */
async function prudentialRatios(c, { asAt = null } = {}) {
  asAt = asAt || await orgToday(c);
  const rows = await byType(c, { to: asAt });
  const cls = (name) => sum(rows, (r) => r.regulatory_class === name);

  // Debit-positive: assets positive, liabilities and equity negative.
  const liquidAssets = cls('LIQUID_ASSET');
  const loanPortfolio = cls('LOAN_PORTFOLIO');
  const otherAssets = cls('OTHER_ASSET');
  const totalAssets = round2(liquidAssets + loanPortfolio + otherAssets);

  const memberDeposits = round2(-cls('MEMBER_DEPOSIT'));
  const shortTerm = round2(-cls('SHORT_TERM_LIABILITY'));
  const shareCapital = round2(-cls('SHARE_CAPITAL'));
  const institutionalCapital = round2(-cls('INSTITUTIONAL_CAPITAL'));

  const surplus = round2(
    sum(rows, (r) => r.type === 'INCOME') * -1 - sum(rows, (r) => r.type === 'EXPENSE')
  );
  // Core capital is member share capital plus institutional capital.
  // Institutional capital is the part that is not members' own shares:
  // retained earnings and statutory reserves.
  const institutionalTotal = round2(institutionalCapital + surplus);
  const coreCapital = round2(shareCapital + institutionalTotal);

  const pct = (num, den) => (den > 0 ? round2((num / den) * 100) : null);

  const { rows: limits } = await c.query('SELECT * FROM prudential_limits');
  const limit = (code) => limits.find((l) => l.code === code) || null;

  const measures = [
    {
      code: 'MIN_CORE_CAPITAL',
      value: coreCapital,
      unit: 'AMOUNT',
    },
    {
      code: 'CORE_CAPITAL_TO_ASSETS',
      value: pct(coreCapital, totalAssets),
      unit: 'PERCENT',
    },
    {
      code: 'CORE_CAPITAL_TO_DEPOSITS',
      value: pct(coreCapital, memberDeposits),
      unit: 'PERCENT',
    },
    {
      code: 'INSTITUTIONAL_CAPITAL_TO_ASSETS',
      value: pct(institutionalTotal, totalAssets),
      unit: 'PERCENT',
    },
    {
      code: 'LIQUIDITY_RATIO',
      value: pct(liquidAssets, round2(memberDeposits + shortTerm)),
      unit: 'PERCENT',
    },
  ].map((m) => {
    const l = limit(m.code);
    return {
      ...m,
      label: l?.label || m.code,
      minimum: l ? Number(l.minimum) : null,
      compliant: l && m.value !== null ? m.value >= Number(l.minimum) : null,
      sourceNote: l?.source_note || null,
    };
  });

  return {
    asAt: asAt || (await orgToday(c)),
    inputs: {
      totalAssets, liquidAssets, loanPortfolio, otherAssets,
      memberDeposits, shortTermLiabilities: shortTerm,
      shareCapital, institutionalCapital: institutionalTotal, coreCapital,
    },
    measures,
    // Never present this as a filing. The arithmetic is checked; the
    // thresholds are defaults that have to be confirmed.
    disclaimer: 'Ratio arithmetic is tested. The minimum thresholds in prudential_limits '
      + 'are defaults and must be confirmed against the current SASRA circular before '
      + 'this is used for any regulatory purpose.',
  };
}

/**
 * Loan portfolio quality, the other half of what a board looks at. The
 * positions, buckets and thresholds live in ./portfolio, which the risk
 * report, the indicators and the management reports share.
 */
async function portfolioAtRisk(c, opts = {}) {
  return PF.portfolioAtRisk(c, opts);
}

/** The loans behind the PAR buckets, one row each, paged in SQL. */
async function portfolioAtRiskLoans(c, opts = {}) {
  return PF.loans(c, opts);
}

module.exports = {
  balanceSheet, incomeStatement, prudentialRatios,
  portfolioAtRisk, portfolioAtRiskLoans, byType, pageLines,
};
