'use strict';

const acct = require('./accounting');
const { err } = require('../lib/errors');

/**
 * Accounting reports generated in the background (the reference platform's accounting
 * reports API): POST /accounting/reports starts one for a date range and
 * filters and returns its key QUEUED; GET /accounting/reports/{reportKey}
 * returns the state and, once COMPLETE, one item per GL account with the
 * balance types asked for. A report can be read for 24 hours.
 *
 * The lines are the trial balance's (./accounting trialBalance), so the
 * report and the Trial Balance page agree to the cent.
 */

const BALANCE_TYPES = ['OPENING_BALANCE', 'NET_CHANGE', 'CLOSING_BALANCE'];
const GL_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => ISO.test(String(s)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;


/** Check and normalise a request; throws 400 or 404 with the reason. */
async function check(c, body = {}) {
  const { startDate, endDate } = body;
  if (!startDate || !validDate(startDate)) throw err('START_DATE_REQUIRED: yyyy-MM-dd');
  if (!endDate || !validDate(endDate)) throw err('END_DATE_REQUIRED: yyyy-MM-dd');
  if (startDate > endDate) throw err('START_DATE_AFTER_END_DATE');
  const balanceTypes = body.balanceTypes === undefined || body.balanceTypes === null ? BALANCE_TYPES : body.balanceTypes;
  if (!Array.isArray(balanceTypes) || !balanceTypes.length || balanceTypes.some((t) => !BALANCE_TYPES.includes(t))) {
    throw err(`INVALID_BALANCE_TYPES: use ${BALANCE_TYPES.join(', ')}`);
  }
  const glTypes = body.glTypes === undefined || body.glTypes === null ? null : body.glTypes;
  if (glTypes !== null && (!Array.isArray(glTypes) || glTypes.some((t) => !GL_TYPES.includes(t)))) {
    throw err(`INVALID_GL_TYPES: use ${GL_TYPES.join(', ')}`);
  }
  const branch = await acct.branchScope(c, body.branchId);
  let currencyCode = null;
  if (body.currencyCode) {
    currencyCode = String(body.currencyCode).toUpperCase();
    const { rows: [t] } = await c.query('SELECT currency_code FROM platform.tenants WHERE schema_name = current_schema()');
    const { rows: [cur] } = await c.query('SELECT 1 FROM currencies WHERE code = $1', [currencyCode]);
    if (currencyCode !== t.currency_code && !cur) throw err(`CURRENCY_NOT_FOUND: ${currencyCode}`, 404);
  }
  return { startDate, endDate, balanceTypes, glTypes, branchId: branch ? branch.id : null, branchCode: branch ? branch.code : null, currencyCode };
}

/** Record a request QUEUED. */
async function create(c, body, { createdBy } = {}) {
  const params = await check(c, body);
  const { rows: [r] } = await c.query(
    'INSERT INTO accounting_report_jobs (params, created_by) VALUES ($1, $2) RETURNING report_key, status',
    [JSON.stringify(params), createdBy || null]);
  return { reportKey: r.report_key, status: r.status };
}

/** The lines for a request, as the reference platform returns them. */
async function items(c, params) {
  // Every GL account is in the base currency: another currency has none.
  if (params.currencyCode) {
    const { rows: [t] } = await c.query('SELECT currency_code FROM platform.tenants WHERE schema_name = current_schema()');
    if (params.currencyCode !== t.currency_code) return [];
  }
  const tb = await acct.trialBalance(c, {
    from: params.startDate, to: params.endDate, branchId: params.branchId, glTypes: params.glTypes, zeroBalances: false,
  });
  const want = new Set(params.balanceTypes);
  return tb.rows.map((r) => ({
    glAccount: { id: r.code, name: r.name, type: r.type },
    amounts: {
      ...(want.has('OPENING_BALANCE') ? { openingBalance: r.openingBalance } : {}),
      debits: r.debit,
      credits: r.credit,
      ...(want.has('NET_CHANGE') ? { netChange: r.netChange } : {}),
      ...(want.has('CLOSING_BALANCE') ? { closingBalance: r.closingBalance } : {}),
    },
  }));
}

/** Claim a QUEUED report for the runner; null when someone else has it. */
async function claim(c, key) {
  const { rows: [r] } = await c.query(
    `UPDATE accounting_report_jobs SET status = 'IN_PROGRESS' WHERE report_key = $1 AND status = 'QUEUED' RETURNING *`, [key]);
  return r || null;
}

async function complete(c, key, lines) {
  await c.query(
    `UPDATE accounting_report_jobs SET status = 'COMPLETE', items = $2, completed_at = now() WHERE report_key = $1`,
    [key, JSON.stringify(lines)]);
}

async function fail(c, key, message) {
  await c.query(
    `UPDATE accounting_report_jobs SET status = 'ERROR', error = $2, completed_at = now() WHERE report_key = $1`,
    [key, String(message).slice(0, 1000)]);
}

/** A report by key, in the reference platform's shape; 404 once it has expired. */
async function get(c, key) {
  if (!/^[0-9a-f-]{36}$/i.test(String(key))) throw err('REPORT_NOT_FOUND', 404);
  const { rows: [r] } = await c.query('SELECT * FROM accounting_report_jobs WHERE report_key = $1 AND expires_at > now()', [key]);
  if (!r) throw err('REPORT_NOT_FOUND', 404);
  return {
    reportKey: r.report_key,
    status: r.status,
    ...(r.status === 'COMPLETE' ? { items: r.items || [] } : {}),
    ...(r.status === 'ERROR' ? { errorReason: r.error } : {}),
    request: r.params,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    expiresAt: r.expires_at,
  };
}

/** Remove expired reports. */
async function prune(c) {
  const { rowCount } = await c.query('DELETE FROM accounting_report_jobs WHERE expires_at <= now()');
  return rowCount;
}

module.exports = { BALANCE_TYPES, GL_TYPES, check, create, items, claim, complete, fail, get, prune };
