'use strict';

const { orgToday, addDays } = require('../lib/orgDate');
const acct = require('./accounting');
const PF = require('./portfolio');

/**
 * Management reports (the reference platform's Reporting menu): Portfolio, Organization,
 * Earnings, Cashflow and Outreach. The risk report and the indicators are in
 * ./portfolio and ./indicators.
 *
 * Figures come from three places, each named in the report:
 *   positions  the loan portfolio loan by loan (./portfolio): today's live,
 *              a past day's from the end of day's positions;
 *   ledger     posted journal lines, through the daily rollups;
 *   transactions  the movements themselves, for what was disbursed,
 *              collected, deposited and withdrawn. Reversed transactions and
 *              the opening balances of a data import are left out.
 */

function err(msg, status = 400) { return Object.assign(new Error(msg), { status }); }
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pct = (a, b) => (Number(b) > 0 ? round2((Number(a) / Number(b)) * 100) : 0);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => ISO.test(String(s)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** A checked period: to defaults to today, from to the start of to's month; at most 366 days. */
async function period(c, { from = null, to = null, maxDays = 366 } = {}) {
  const today = await orgToday(c);
  const t = to || today;
  if (!validDate(t)) throw err(`INVALID_DATE: ${t}`);
  const f = from || `${t.slice(0, 7)}-01`;
  if (!validDate(f)) throw err(`INVALID_DATE: ${f}`);
  if (f > t) throw err('FROM_AFTER_TO');
  if (t > today) throw err(`TO_IN_THE_FUTURE: ${t} (today is ${today})`);
  const days = Math.round((Date.parse(t) - Date.parse(f)) / 86400000) + 1;
  if (days > maxDays) throw err(`PERIOD_TOO_LONG: at most ${maxDays} days`);
  return { from: f, to: t, today, days };
}

/** Periods of a range by interval: DAILY, WEEKLY (7 days from `from`) or MONTHLY (calendar months). */
function intervals(from, to, interval) {
  const out = [];
  const kind = String(interval || 'MONTHLY').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(kind)) throw err(`UNKNOWN_INTERVAL: ${interval} (use DAILY, WEEKLY or MONTHLY)`);
  let start = from;
  while (start <= to) {
    let end;
    if (kind === 'DAILY') end = start;
    else if (kind === 'WEEKLY') end = addDays(start, 6);
    else {
      const d = new Date(`${start}T00:00:00Z`);
      end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    }
    if (end > to) end = to;
    out.push({ from: start, to: end });
    start = addDays(end, 1);
  }
  return { interval: kind, periods: out };
}

// Transactions that count: not reversed, not a reversal, not imported.
const COUNTED = `t.reversed_by IS NULL AND t.kind <> 'REVERSAL' AND NOT (COALESCE(t.allocation, '{}'::jsonb) ? 'imported')`;
const num = (k) => `COALESCE((t.allocation->>'${k}')::numeric, 0)`;

// --------------------------------------------------------------------------
// Portfolio
// --------------------------------------------------------------------------

/**
 * The portfolio report: an overview at the end of the range; loans created,
 * disbursed, written off and closed in each interval; and, at the end of
 * each interval, loans by state, the portfolio's risk and average balance
 * (from the positions of that day) and the capital structure (from the
 * ledger). An interval end with no positions shows those figures as null.
 */
async function portfolio(c, { from = null, to = null, interval = 'MONTHLY', branchId = null } = {}) {
  const p = await period(c, { from, to });
  const { periods, interval: kind } = intervals(p.from, p.to, interval);
  const branch = await acct.branchScope(c, branchId);
  const bId = branch && branch.id !== 'NONE' ? branch.id : null;

  // Accounts: per interval, from the loan rows and transactions.
  const { rows: flows } = await c.query(
    `WITH per AS (SELECT (x->>'from')::date AS f, (x->>'to')::date AS t FROM jsonb_array_elements($1::jsonb) x)
     SELECT per.f::text AS from, per.t::text AS to,
       (SELECT count(*) FROM loan_accounts l WHERE l.applied_on BETWEEN per.f AND per.t AND ($2::uuid IS NULL OR l.branch_id = $2::uuid))::int AS created,
       (SELECT count(DISTINCT t.loan_account_id) FROM transactions t WHERE t.kind = 'LOAN_DISBURSEMENT' AND ${COUNTED}
          AND t.value_date BETWEEN per.f AND per.t AND ($2::uuid IS NULL OR t.branch_id = $2::uuid))::int AS disbursed_loans,
       (SELECT COALESCE(SUM(t.amount), 0) FROM transactions t WHERE t.kind = 'LOAN_DISBURSEMENT' AND ${COUNTED}
          AND t.value_date BETWEEN per.f AND per.t AND ($2::uuid IS NULL OR t.branch_id = $2::uuid)) AS disbursed_amount,
       (SELECT count(*) FROM loan_accounts l WHERE l.written_off_on BETWEEN per.f AND per.t AND ($2::uuid IS NULL OR l.branch_id = $2::uuid))::int AS written_off_loans,
       (SELECT COALESCE(SUM(l.written_off_amount), 0) FROM loan_accounts l WHERE l.written_off_on BETWEEN per.f AND per.t AND ($2::uuid IS NULL OR l.branch_id = $2::uuid)) AS written_off_amount,
       (SELECT count(*) FROM loan_accounts l WHERE l.closed_on BETWEEN per.f AND per.t AND l.status = 'CLOSED_REPAID' AND ($2::uuid IS NULL OR l.branch_id = $2::uuid))::int AS repaid_loans
     FROM per ORDER BY per.f`,
    [JSON.stringify(periods), bId]);

  // Capital structure: cumulative debit-positive balances by account type.
  const byBranch = Boolean(branch);
  const { rows: daily } = await c.query(
    byBranch
      ? `SELECT b.booking_date::text AS d, g.type, SUM(b.debit - b.credit) AS net
         FROM gl_branch_daily_balances b JOIN gl_accounts g ON g.code = b.gl_code
         WHERE b.booking_date <= $1::date AND b.branch_key = $2::uuid GROUP BY 1, 2 ORDER BY 1`
      : `SELECT b.booking_date::text AS d, g.type, SUM(b.debit - b.credit) AS net
         FROM gl_daily_balances b JOIN gl_accounts g ON g.code = b.gl_code
         WHERE b.booking_date <= $1::date GROUP BY 1, 2 ORDER BY 1`,
    byBranch ? [p.to, branch.id === 'NONE' ? '00000000-0000-0000-0000-000000000000' : branch.id] : [p.to]);
  const capitalAt = (date) => {
    const t = { ASSET: 0, LIABILITY: 0, EQUITY: 0, INCOME: 0, EXPENSE: 0 };
    for (const r of daily) if (r.d <= date) t[r.type] += Number(r.net);
    const surplus = -(t.INCOME) - t.EXPENSE;
    return { assets: round2(t.ASSET), liabilities: round2(-t.LIABILITY), equity: round2(-t.EQUITY + surplus) };
  };

  // Historical: positions at each interval end.
  const historical = [];
  for (const per of periods) {
    let pos = null;
    try { pos = await PF.positions(c, { asAt: per.to, branchId: bId }); } catch (e) { if (e.status !== 409) throw e; }
    const rows = pos ? pos.rows : null;
    const m = rows ? PF.measures(rows) : null;
    historical.push({
      date: per.to,
      source: pos ? pos.source : 'NONE',
      loansByStatus: rows ? ['ACTIVE', 'IN_ARREARS', 'LOCKED'].reduce((o, s) => ({ ...o, [s]: rows.filter((r) => r.status === s).length }), {}) : null,
      grossLoanPortfolio: m ? m.glp : null,
      averageLoanBalance: rows ? (rows.length ? round2(m.glp / rows.length) : 0) : null,
      portfolioRisk: m ? { par: m.par.PAR.percent, parOver30: m.par.PAR_OVER_30.percent, parOver90: m.par.PAR_OVER_90.percent } : null,
      capitalStructure: capitalAt(per.to),
    });
  }

  const last = historical[historical.length - 1];
  const { rows: [dep] } = await c.query(
    `SELECT COALESCE(SUM(GREATEST(balance, 0)), 0) AS balance, count(*)::int AS n FROM savings_accounts
     WHERE status = 'ACTIVE' AND ($1::uuid IS NULL OR branch_id = $1::uuid)`, [bId]);
  return {
    period: { from: p.from, to: p.to }, interval: kind,
    branch: branch ? { id: branch.id, code: branch.code, name: branch.name } : null,
    overview: {
      date: p.to,
      source: last.source,
      grossLoanPortfolio: last.grossLoanPortfolio,
      loansOutstanding: last.loansByStatus ? Object.values(last.loansByStatus).reduce((s, n) => s + n, 0) : null,
      averageLoanBalance: last.averageLoanBalance,
      parOver30: last.portfolioRisk ? last.portfolioRisk.parOver30 : null,
      disbursedInPeriod: round2(flows.reduce((s, r) => s + Number(r.disbursed_amount), 0)),
      loansDisbursedInPeriod: flows.reduce((s, r) => s + r.disbursed_loans, 0),
      depositBalanceNow: round2(dep.balance),
      depositAccountsNow: dep.n,
    },
    accounts: flows.map((r) => ({
      from: r.from, to: r.to, created: r.created,
      disbursed: { loans: r.disbursed_loans, amount: round2(r.disbursed_amount) },
      writtenOff: { loans: r.written_off_loans, amount: round2(r.written_off_amount) },
      repaid: r.repaid_loans,
    })),
    historical,
  };
}

// --------------------------------------------------------------------------
// Organization
// --------------------------------------------------------------------------

/** Branches and credit officers: their members, borrowers, loans, portfolio and PAR over 30, now. */
async function organization(c) {
  const pos = await PF.positions(c, {});
  const byKey = (key) => {
    const m = new Map();
    for (const r of pos.rows) {
      const k = r[key] == null ? null : String(key === 'credit_officer' ? r[key].toLowerCase() : r[key]);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const summary = (rows) => {
    const x = PF.measures(rows);
    return {
      borrowers: new Set(rows.map((r) => r.member_id)).size,
      loans: rows.length,
      grossLoanPortfolio: x.glp,
      parOver30: x.par.PAR_OVER_30.percent,
    };
  };
  const { rows: branches } = await c.query(
    `SELECT b.id::text AS id, b.code, b.name, b.status,
            (SELECT count(*) FROM members m WHERE m.branch_id = b.id AND m.status = 'ACTIVE')::int AS members,
            (SELECT count(*) FROM centres ce WHERE ce.branch_id = b.id AND ce.status = 'ACTIVE')::int AS centres,
            (SELECT COALESCE(SUM(GREATEST(a.balance, 0)), 0) FROM savings_accounts a WHERE a.branch_id = b.id AND a.status = 'ACTIVE') AS deposits
     FROM branches b ORDER BY b.code`);
  const lb = byKey('branch_id');
  const { rows: officers } = await c.query(
    `SELECT lower(m.credit_officer) AS email, count(*) FILTER (WHERE m.status = 'ACTIVE')::int AS members
     FROM members m WHERE m.credit_officer IS NOT NULL GROUP BY 1`);
  const lo = byKey('credit_officer');
  const emails = [...new Set([...officers.map((o) => o.email), ...[...lo.keys()].filter(Boolean)])];
  const { rows: users } = await c.query(
    `SELECT lower(u.email) AS email, u.full_name, u.status FROM platform.users u JOIN platform.tenants t ON t.id = u.tenant_id
     WHERE t.schema_name = current_schema() AND lower(u.email) = ANY($1)`, [emails]);
  const uName = new Map(users.map((u) => [u.email, u]));
  const mCount = new Map(officers.map((o) => [o.email, o.members]));
  return {
    asAt: pos.asAt,
    branches: branches.map((b) => ({
      id: b.id, code: b.code, name: b.name, status: b.status, members: b.members, centres: b.centres,
      deposits: round2(b.deposits), ...summary(lb.get(b.id) || []),
    })),
    unassignedBranch: lb.has(null) ? summary(lb.get(null)) : null,
    creditOfficers: emails.sort().map((e) => ({
      email: e, name: uName.get(e)?.full_name || null, userStatus: uName.get(e)?.status || 'NOT_A_USER',
      members: mCount.get(e) || 0, ...summary(lo.get(e) || []),
    })),
    withoutOfficer: lo.has(null) ? summary(lo.get(null)) : null,
  };
}

// --------------------------------------------------------------------------
// Earnings
// --------------------------------------------------------------------------

/**
 * Revenues and expenses for a period, by product or by branch, from the
 * ledger: each income and expense line is attributed to the product of the
 * loan or deposit account that posted it (through the entry's source or its
 * transaction), and to the branch on the line. Lines with neither (a manual
 * journal entry, the provisioning run) are OTHER. The grand totals equal the
 * income statement for the same period.
 */
async function earnings(c, { from = null, to = null, groupBy = 'PRODUCT', branchId = null } = {}) {
  const p = await period(c, { from, to });
  const g = String(groupBy || 'PRODUCT').toUpperCase();
  if (!['PRODUCT', 'BRANCH'].includes(g)) throw err(`UNKNOWN_GROUP: ${groupBy} (use PRODUCT or BRANCH)`);
  const branch = await acct.branchScope(c, branchId);
  const { rows } = await c.query(
    `SELECT gl.code, gl.name, gl.type,
            CASE WHEN $3 = 'BRANCH' THEN COALESCE(br.code, 'NONE')
                 ELSE COALESCE('LOAN:' || COALESCE(la.product_id, la2.product_id), 'DEPOSIT:' || COALESCE(sa.product_id, sa2.product_id), 'OTHER') END AS grp,
            SUM(CASE WHEN jl.direction = 'DEBIT' THEN jl.amount ELSE -jl.amount END) AS net
     FROM journal_lines jl
     JOIN journal_entries e ON e.id = jl.entry_id
     JOIN gl_accounts gl ON gl.code = jl.gl_code AND gl.type IN ('INCOME', 'EXPENSE')
     LEFT JOIN branches br ON br.id = jl.branch_id
     LEFT JOIN loan_accounts la ON la.id = e.source_id
     LEFT JOIN savings_accounts sa ON sa.id = e.source_id
     LEFT JOIN LATERAL (SELECT t.loan_account_id, t.savings_account_id FROM transactions t WHERE t.entry_id = e.id LIMIT 1) tx
       ON la.id IS NULL AND sa.id IS NULL
     LEFT JOIN loan_accounts la2 ON la2.id = tx.loan_account_id
     LEFT JOIN savings_accounts sa2 ON sa2.id = tx.savings_account_id
     WHERE e.booking_date BETWEEN $1::date AND $2::date
       AND COALESCE(e.source_type, '') NOT IN ('YEAR_END_CLOSE', 'STATUTORY_RESERVE')
       AND ($4::uuid IS NULL OR jl.branch_id IS NOT DISTINCT FROM (CASE WHEN $4::uuid = '00000000-0000-0000-0000-000000000000'::uuid THEN NULL ELSE $4::uuid END))
     GROUP BY 1, 2, 3, 4 ORDER BY 4, 1`,
    [p.from, p.to, g, branch ? (branch.id === 'NONE' ? '00000000-0000-0000-0000-000000000000' : branch.id) : null]);

  const { rows: products } = await c.query(
    "SELECT 'LOAN:' || id AS k, name FROM loan_products UNION ALL SELECT 'DEPOSIT:' || id, name FROM savings_products");
  const { rows: brs } = await c.query('SELECT code AS k, name FROM branches');
  const label = new Map([...products, ...brs].map((r) => [r.k, r.name]));
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.grp)) groups.set(r.grp, { key: r.grp, label: label.get(r.grp) || (r.grp === 'OTHER' ? 'Not attributed to a product' : r.grp === 'NONE' ? 'No branch' : r.grp), revenues: [], expenses: [] });
    const x = groups.get(r.grp);
    const net = Number(r.net);
    if (r.type === 'INCOME' && net !== 0) x.revenues.push({ code: r.code, name: r.name, amount: round2(-net) });
    if (r.type === 'EXPENSE' && net !== 0) x.expenses.push({ code: r.code, name: r.name, amount: round2(net) });
  }
  const out = [...groups.values()].map((x) => {
    const totalRevenue = round2(x.revenues.reduce((s, r) => s + r.amount, 0));
    const totalExpenses = round2(x.expenses.reduce((s, r) => s + r.amount, 0));
    return { ...x, totalRevenue, totalExpenses, net: round2(totalRevenue - totalExpenses) };
  }).filter((x) => x.revenues.length || x.expenses.length);
  const totalRevenue = round2(out.reduce((s, x) => s + x.totalRevenue, 0));
  const totalExpenses = round2(out.reduce((s, x) => s + x.totalExpenses, 0));
  return {
    period: { from: p.from, to: p.to }, groupBy: g,
    branch: branch ? { id: branch.id, code: branch.code, name: branch.name } : null,
    groups: out, totalRevenue, totalExpenses, net: round2(totalRevenue - totalExpenses),
  };
}

// --------------------------------------------------------------------------
// Cashflow
// --------------------------------------------------------------------------

/**
 * Cash in and out for a period, in the base currency, from the transactions:
 * income received (interest, fees and penalties collected on loans,
 * overdraft interest and fees collected, deposit account fees, recoveries on
 * written-off loans), expenses (deposit interest paid to members, principal
 * written off) and balance changes (principal collected and disbursed, the
 * change in the portfolio, deposits and withdrawals and the change in
 * deposits).
 */
async function cashflow(c, { from = null, to = null, branchId = null } = {}) {
  const p = await period(c, { from, to });
  const branch = await acct.branchScope(c, branchId);
  const bId = branch && branch.id !== 'NONE' ? branch.id : null;
  const { rows: [x] } = await c.query(
    `SELECT
       COALESCE(SUM(${num('interest')} + ${num('interestFromArrears')}) FILTER (WHERE t.kind = 'LOAN_REPAYMENT'), 0) AS interest,
       COALESCE(SUM(${num('fees')}) FILTER (WHERE t.kind = 'LOAN_REPAYMENT'), 0) AS fees,
       COALESCE(SUM(${num('penalty')}) FILTER (WHERE t.kind = 'LOAN_REPAYMENT'), 0) AS penalties,
       COALESCE(SUM(${num('principal')}) FILTER (WHERE t.kind = 'LOAN_REPAYMENT'), 0) AS principal_collected,
       COALESCE(SUM(t.amount) FILTER (WHERE t.kind = 'LOAN_DISBURSEMENT'), 0) AS principal_disbursed,
       COALESCE(SUM(${num('principal')}) FILTER (WHERE t.kind = 'LOAN_WRITE_OFF'), 0) AS principal_written_off,
       COALESCE(SUM(t.amount) FILTER (WHERE t.kind = 'LOAN_RECOVERY'), 0) AS recoveries,
       COALESCE(SUM(${num('odInterest')}) FILTER (WHERE t.kind = 'SAVINGS_DEPOSIT'), 0) AS od_interest,
       COALESCE(SUM(${num('odFees')}) FILTER (WHERE t.kind = 'SAVINGS_DEPOSIT'), 0) AS od_fees,
       COALESCE(SUM(t.amount) FILTER (WHERE t.kind = 'SAVINGS_FEE'), 0) AS savings_fees,
       COALESCE(SUM(t.amount) FILTER (WHERE t.kind = 'SAVINGS_INTEREST_APPLIED'), 0) AS deposit_interest,
       COALESCE(SUM(CASE WHEN t.allocation ? 'savings' THEN ${num('savings')} ELSE t.amount END) FILTER (WHERE t.kind = 'SAVINGS_DEPOSIT'), 0) AS deposits,
       COALESCE(SUM(t.amount) FILTER (WHERE t.kind = 'SAVINGS_WITHDRAWAL'), 0) AS withdrawals
     FROM transactions t
     WHERE ${COUNTED} AND t.value_date BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR t.branch_id = $3::uuid)`,
    [p.from, p.to, bId]);
  const n = (k) => round2(x[k]);
  const income = [
    { code: 'LOAN_INTEREST', label: 'Loan interest collected', amount: n('interest') },
    { code: 'LOAN_FEES', label: 'Loan fees collected', amount: n('fees') },
    { code: 'PENALTIES', label: 'Penalties collected', amount: n('penalties') },
    { code: 'OVERDRAFT_INTEREST', label: 'Overdraft interest collected', amount: n('od_interest') },
    { code: 'OVERDRAFT_FEES', label: 'Overdraft fees collected', amount: n('od_fees') },
    { code: 'DEPOSIT_FEES', label: 'Deposit account fees', amount: n('savings_fees') },
    { code: 'RECOVERIES', label: 'Recoveries on written-off loans', amount: n('recoveries') },
  ];
  const expenses = [
    { code: 'DEPOSIT_INTEREST', label: 'Deposit interest paid to members', amount: n('deposit_interest') },
    { code: 'PRINCIPAL_WRITTEN_OFF', label: 'Principal written off', amount: n('principal_written_off') },
  ];
  const changeInPortfolio = round2(n('principal_disbursed') - n('principal_collected') - n('principal_written_off'));
  const changeInDeposits = round2(n('deposits') - n('withdrawals') + n('deposit_interest') - n('savings_fees'));
  const totalIncome = round2(income.reduce((s, r) => s + r.amount, 0));
  const totalExpenses = round2(expenses.reduce((s, r) => s + r.amount, 0));
  const { rows: [t] } = await c.query('SELECT currency_code FROM platform.tenants WHERE schema_name = current_schema()');
  return {
    period: { from: p.from, to: p.to }, currency: t.currency_code,
    branch: branch ? { id: branch.id, code: branch.code, name: branch.name } : null,
    income, totalIncome, expenses, totalExpenses, net: round2(totalIncome - totalExpenses),
    balanceChanges: {
      principalCollected: n('principal_collected'),
      principalDisbursed: n('principal_disbursed'),
      principalWrittenOff: n('principal_written_off'),
      changeInPortfolio,
      deposits: n('deposits'),
      withdrawals: n('withdrawals'),
      changeInDeposits,
    },
  };
}

// --------------------------------------------------------------------------
// Outreach
// --------------------------------------------------------------------------

/** Clients, borrowers and savers now, with joiners and leavers in the period, by gender and branch. */
async function outreach(c, { from = null, to = null } = {}) {
  const p = await period(c, { from, to });
  const { rows } = await c.query(
    `WITH borrowers AS (SELECT DISTINCT member_id FROM loan_accounts WHERE status IN ('ACTIVE','IN_ARREARS','LOCKED')),
          savers AS (SELECT DISTINCT member_id FROM savings_accounts WHERE status = 'ACTIVE' AND balance > 0)
     SELECT COALESCE(b.code, 'NONE') AS branch, COALESCE(b.name, 'No branch') AS branch_name,
            count(*) FILTER (WHERE m.status NOT IN ('EXITED','DECEASED'))::int AS clients,
            count(*) FILTER (WHERE m.status = 'ACTIVE')::int AS active_clients,
            count(*) FILTER (WHERE m.status NOT IN ('EXITED','DECEASED') AND m.gender = 'FEMALE')::int AS female_clients,
            count(*) FILTER (WHERE m.status NOT IN ('EXITED','DECEASED') AND m.gender = 'MALE')::int AS male_clients,
            count(*) FILTER (WHERE bo.member_id IS NOT NULL)::int AS borrowers,
            count(*) FILTER (WHERE bo.member_id IS NOT NULL AND m.gender = 'FEMALE')::int AS female_borrowers,
            count(*) FILTER (WHERE sv.member_id IS NOT NULL)::int AS savers,
            count(*) FILTER (WHERE m.joined_on BETWEEN $1::date AND $2::date)::int AS joined,
            count(*) FILTER (WHERE m.exited_on BETWEEN $1::date AND $2::date)::int AS exited
     FROM members m
     LEFT JOIN branches b ON b.id = m.branch_id
     LEFT JOIN borrowers bo ON bo.member_id = m.id
     LEFT JOIN savers sv ON sv.member_id = m.id
     GROUP BY 1, 2 ORDER BY 1`, [p.from, p.to]);
  const total = rows.reduce((t, r) => {
    for (const k of ['clients', 'active_clients', 'female_clients', 'male_clients', 'borrowers', 'female_borrowers', 'savers', 'joined', 'exited']) t[k] = (t[k] || 0) + r[k];
    return t;
  }, {});
  const shape = (r) => ({
    clients: r.clients || 0, activeClients: r.active_clients || 0,
    femaleClients: r.female_clients || 0, maleClients: r.male_clients || 0,
    femaleClientsPercent: pct(r.female_clients, r.clients),
    borrowers: r.borrowers || 0, femaleBorrowers: r.female_borrowers || 0, femaleBorrowersPercent: pct(r.female_borrowers, r.borrowers),
    savers: r.savers || 0, joinedInPeriod: r.joined || 0, exitedInPeriod: r.exited || 0,
  });
  return {
    period: { from: p.from, to: p.to },
    asAt: p.today,
    groups: 'NOT_APPLICABLE: the platform has no groups',
    ...shape(total),
    byBranch: rows.map((r) => ({ branch: r.branch, branchName: r.branch_name, ...shape(r) })),
  };
}

module.exports = { period, intervals, portfolio, organization, earnings, cashflow, outreach };
