'use strict';

const acct = require('./accounting');
const { round2 } = acct;

/**
 * Financial statements, built from posted journal lines.
 *
 * Sign convention: acct.balance is debit-positive. Assets and expenses are
 * naturally positive; liabilities, equity and income are naturally negative
 * and are flipped for presentation so a report reads the way an accountant
 * expects.
 */

async function byType(c, { from = null, to = null } = {}) {
  const { rows } = await c.query(
    `SELECT g.code, g.name, g.type, g.regulatory_class,
            COALESCE(SUM(CASE WHEN l.direction='DEBIT' THEN l.amount ELSE -l.amount END), 0) AS net
     FROM gl_accounts g
     LEFT JOIN journal_lines l ON l.gl_code = g.code
     LEFT JOIN journal_entries e ON e.id = l.entry_id
       AND ($1::date IS NULL OR e.booking_date >= $1::date)
       AND ($2::date IS NULL OR e.booking_date <= $2::date)
     GROUP BY g.code, g.name, g.type, g.regulatory_class
     ORDER BY g.code`,
    [from, to]
  );
  return rows.map((r) => ({ ...r, net: round2(r.net) }));
}

const sum = (rows, pred) => round2(rows.filter(pred).reduce((s, r) => s + r.net, 0));

/**
 * Income statement for a period.
 * Surplus is what a SACCO calls profit, and it is what feeds retained
 * earnings on the balance sheet.
 */
async function incomeStatement(c, { from = null, to = null } = {}) {
  const rows = await byType(c, { from, to });
  const income = rows.filter((r) => r.type === 'INCOME' && r.net !== 0)
    .map((r) => ({ code: r.code, name: r.name, amount: round2(-r.net) }));
  const expenses = rows.filter((r) => r.type === 'EXPENSE' && r.net !== 0)
    .map((r) => ({ code: r.code, name: r.name, amount: r.net }));

  const totalIncome = round2(income.reduce((s, r) => s + r.amount, 0));
  const totalExpenses = round2(expenses.reduce((s, r) => s + r.amount, 0));

  return {
    period: { from, to },
    income,
    expenses,
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
async function balanceSheet(c, { asAt = null } = {}) {
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

  return {
    asAt: asAt || new Date().toISOString().slice(0, 10),
    assets,
    liabilities,
    equity,
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
    `WITH arrears AS (
       SELECT l.id,
              GREATEST(0, MAX($1::date - i.due_date)) AS days_late
       FROM loan_accounts l
       LEFT JOIN loan_installments i
         ON i.loan_id = l.id AND i.status <> 'PAID' AND i.due_date < $1::date
       WHERE l.status IN ('ACTIVE','IN_ARREARS')
       GROUP BY l.id
     )
     SELECT
       CASE
         WHEN a.days_late IS NULL OR a.days_late = 0 THEN 'CURRENT'
         WHEN a.days_late <= 30  THEN 'PAR_1_30'
         WHEN a.days_late <= 90  THEN 'PAR_31_90'
         WHEN a.days_late <= 180 THEN 'PAR_91_180'
         WHEN a.days_late <= 360 THEN 'PAR_181_360'
         ELSE 'PAR_OVER_360'
       END AS bucket,
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

module.exports = { balanceSheet, incomeStatement, prudentialRatios, portfolioAtRisk, byType };
