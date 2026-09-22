'use strict';

const acct = require('./accounting');
const { pageQuery } = require('../lib/page');
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
async function byType(c, { from = null, to = null, includeClosing = true } = {}) {
  const movement = includeClosing ? acct.MOVEMENT_SQL : acct.MOVEMENT_SQL_TRADING;
  const { rows } = await c.query(
    `SELECT g.code, g.name, g.type, g.regulatory_class,
            COALESCE(m.debit, 0) - COALESCE(m.credit, 0) AS net
     FROM gl_accounts g
     LEFT JOIN (${movement}) m ON m.gl_code = g.code
     ORDER BY g.code`,
    [from, to]
  );
  return rows.map((r) => ({ ...r, net: round2(r.net) }));
}

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
  from = null, to = null, offset = 0, limit = null, includeClosing = false,
} = {}) {
  // Trading only by default: the year-end sweep and the reserve transfer are
  // postings, not performance, and counting them makes a closed year look
  // like it broke exactly even.
  const rows = await byType(c, { from, to, includeClosing });
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
async function balanceSheet(c, { asAt = null, offset = 0, limit = null } = {}) {
  const rows = await byType(c, { to: asAt });

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
    asAt: asAt || new Date().toISOString().slice(0, 10),
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
    asAt: asAt || new Date().toISOString().slice(0, 10),
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

/** Loan portfolio quality, the other half of what a board looks at. */
async function portfolioAtRisk(c, { asAt = null } = {}) {
  const date = asAt || new Date().toISOString().slice(0, 10);
  const { rows } = await c.query(
    `WITH arrears AS (${PAR_ARREARS_SQL})
     SELECT ${PAR_BUCKET_SQL} AS bucket,
       count(*)::int AS loans,
       COALESCE(SUM(l.principal_disbursed - l.principal_paid), 0) AS outstanding
     FROM arrears a JOIN loan_accounts l ON l.id = a.id
     GROUP BY 1 ORDER BY 1`,
    [date]
  );

  const total = round2(rows.reduce((s, r) => s + Number(r.outstanding), 0));
  const atRisk = round2(rows.filter((r) => r.bucket !== 'CURRENT')
    .reduce((s, r) => s + Number(r.outstanding), 0));

  return {
    asAt: date,
    buckets: rows.map((r) => ({ ...r, outstanding: round2(r.outstanding) })),
    totalOutstanding: total,
    atRisk,
    parPercent: total > 0 ? round2((atRisk / total) * 100) : 0,
  };
}

/**
 * The loans behind the PAR buckets, one row each.
 *
 * This is the report a credit committee actually works from, and it is the
 * one that grows without limit, so it pages in SQL. The bucket boundaries are
 * the same expression as the summary above; they live in one SQL fragment so
 * the two cannot drift apart and report different numbers for the same day.
 */
const PAR_BUCKET_SQL = `
  CASE
    WHEN a.days_late IS NULL OR a.days_late = 0 THEN 'CURRENT'
    WHEN a.days_late <= 30  THEN 'PAR_1_30'
    WHEN a.days_late <= 90  THEN 'PAR_31_90'
    WHEN a.days_late <= 180 THEN 'PAR_91_180'
    WHEN a.days_late <= 360 THEN 'PAR_181_360'
    ELSE 'PAR_OVER_360'
  END`;

const PAR_ARREARS_SQL = `
  SELECT l.id, GREATEST(0, MAX($1::date - i.due_date)) AS days_late
  FROM loan_accounts l
  LEFT JOIN loan_installments i
    ON i.loan_id = l.id AND i.status <> 'PAID' AND i.due_date < $1::date
  WHERE l.status IN ('ACTIVE','IN_ARREARS')
  GROUP BY l.id`;

async function portfolioAtRiskLoans(c, { asAt = null, bucket = null, offset = 0, limit = 50 } = {}) {
  const date = asAt || new Date().toISOString().slice(0, 10);
  const sql = `
    WITH arrears AS (${PAR_ARREARS_SQL})
    SELECT l.account_no, l.status, m.member_no, m.first_name, m.last_name,
           COALESCE(a.days_late, 0)::int AS days_late,
           ${PAR_BUCKET_SQL} AS bucket,
           round(l.principal_disbursed - l.principal_paid, 2) AS outstanding
    FROM arrears a
    JOIN loan_accounts l ON l.id = a.id
    JOIN members m ON m.id = l.member_id
    WHERE ($2::text IS NULL OR ${PAR_BUCKET_SQL} = $2::text)
    ORDER BY COALESCE(a.days_late, 0) DESC, l.account_no`;

  const p = await pageQuery(c, sql, [date, bucket], { offset, limit });
  return { asAt: date, bucket: bucket || 'ALL', ...p };
}

module.exports = {
  balanceSheet, incomeStatement, prudentialRatios,
  portfolioAtRisk, portfolioAtRiskLoans, byType, pageLines,
};
