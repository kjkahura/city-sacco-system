'use strict';

const acct = require('./accounting');
const { err } = acct;

/**
 * Currencies, after the reference platform's page of that name: the fiat currencies the
 * organization works with, one of them the base currency (set with the
 * organization and fixed once anything is posted), and for each other
 * currency its exchange rates (buy and sell, against the base currency,
 * each valid from a moment) and accounting rates.
 *
 * A fiat currency is added from the ISO 4217 list (the code and decimal
 * digits come from it and cannot be edited; the name, symbol and symbol
 * position can). The reference platform's cryptocurrencies and non-traditional currencies
 * are not offered. Products and accounts stay in the base currency: the
 * register and its rates are what multi-currency products would build on.
 *
 * An exchange rate set now is valid from now; one set with a date may be
 * backdated, but never to before the latest rate already set (the reference platform).
 */

const displayNames = new Intl.DisplayNames(['en'], { type: 'currency' });

function isoInfo(code) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(c) || !Intl.supportedValuesOf('currency').includes(c)) return null;
  const fmt = new Intl.NumberFormat('en', { style: 'currency', currency: c, currencyDisplay: 'narrowSymbol' });
  return {
    code: c, name: displayNames.of(c) || c,
    symbol: fmt.formatToParts(1).find((p) => p.type === 'currency')?.value || c,
    decimals: fmt.resolvedOptions().maximumFractionDigits,
  };
}

/** The ISO 4217 list, for the reference platform's Preset dropdown. */
function presets() {
  return Intl.supportedValuesOf('currency').map(isoInfo).filter(Boolean);
}

async function audit(c, actor, action, id, before, after) {
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,$2,'currency',$3,$4,$5)`,
    [actor || 'SYSTEM', action, id, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
}

async function list(c) {
  // The base currency seeded by the migration carries its code as its name
  // until it is looked up.
  const { rows: seeded } = await c.query('SELECT code FROM currencies WHERE name = code');
  for (const r of seeded) {
    const i = isoInfo(r.code);
    if (i) await c.query('UPDATE currencies SET name = $2, symbol = $3 WHERE code = $1 AND name = code', [r.code, i.name, i.symbol]);
  }
  const { rows } = await c.query(
    `SELECT cu.*,
       (SELECT row_to_json(x) FROM (SELECT buy_rate, sell_rate, valid_from FROM exchange_rates e WHERE e.currency_code = cu.code AND e.valid_from <= now()
          ORDER BY valid_from DESC LIMIT 1) x) AS exchange_rate,
       (SELECT row_to_json(x) FROM (SELECT rate, valid_from FROM accounting_rates a WHERE a.currency_code = cu.code AND a.valid_from <= now()
          ORDER BY valid_from DESC LIMIT 1) x) AS accounting_rate
     FROM currencies cu ORDER BY cu.is_base DESC, cu.code`);
  return rows;
}

async function find(c, code) {
  const { rows: [cu] } = await c.query('SELECT * FROM currencies WHERE code = $1', [String(code || '').toUpperCase()]);
  if (!cu) throw err(`UNKNOWN_CURRENCY: ${code}`, 404);
  return cu;
}

function editable(body) {
  const out = {};
  if (body.name !== undefined) {
    const n = String(body.name || '').trim();
    if (!n || n.length > 256) throw err('CURRENCY_NAME_IS_1_TO_256_CHARACTERS', 400);
    out.name = n;
  }
  if (body.symbol !== undefined) {
    const s = String(body.symbol || '').trim();
    if (!s || s.length > 10) throw err('CURRENCY_SYMBOL_IS_1_TO_10_CHARACTERS', 400);
    out.symbol = s;
  }
  if (body.symbolPosition !== undefined) {
    if (!['BEFORE', 'AFTER'].includes(body.symbolPosition)) throw err('SYMBOL_POSITION_IS_BEFORE_OR_AFTER', 400);
    out.symbol_position = body.symbolPosition;
  }
  return out;
}

async function add(c, body = {}, { createdBy } = {}) {
  const i = isoInfo(body.code);
  if (!i) throw err(`NOT_AN_ISO_4217_CURRENCY: ${body.code}`, 400);
  const cols = { code: i.code, name: i.name, symbol: i.symbol, decimals: Math.min(4, i.decimals), ...editable(body), created_by: createdBy || 'SYSTEM' };
  const keys = Object.keys(cols);
  const { rows: [cu] } = await c.query(
    `INSERT INTO currencies (${keys.join(', ')}) VALUES (${keys.map((_, k) => `$${k + 1}`).join(', ')}) ON CONFLICT (code) DO NOTHING RETURNING *`,
    keys.map((k) => cols[k]));
  if (!cu) throw err(`CURRENCY_EXISTS: ${i.code}`, 409);
  await audit(c, createdBy, 'CURRENCY_ADDED', cu.code, null, cu);
  return cu;
}

async function update(c, code, body = {}, { createdBy } = {}) {
  const before = await find(c, code);
  if (body.code !== undefined && String(body.code).toUpperCase() !== before.code) throw err('A_CURRENCY_CODE_CANNOT_CHANGE', 409);
  if (body.decimals !== undefined && Number(body.decimals) !== Number(before.decimals)) throw err('DECIMAL_DIGITS_CANNOT_CHANGE', 409);
  const cols = editable(body);
  const keys = Object.keys(cols);
  if (!keys.length) throw err('NO_UPDATABLE_FIELDS', 400);
  const { rows: [after] } = await c.query(`UPDATE currencies SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE code = $1 RETURNING *`,
    [before.code, ...keys.map((k) => cols[k])]);
  await audit(c, createdBy, 'CURRENCY_CHANGED', before.code, before, after);
  return after;
}

/** Only a currency no product, account, holiday or transaction uses; never the base. */
async function remove(c, code, { createdBy } = {}) {
  const cu = await find(c, code);
  if (cu.is_base) throw err('THE_BASE_CURRENCY_CANNOT_BE_DELETED', 409);
  const { rows: [u] } = await c.query(
    `SELECT (SELECT count(*) FROM journal_entries WHERE currency_code = $1) + (SELECT count(*) FROM holidays WHERE currency_code = $1) AS n`, [cu.code]);
  if (Number(u.n) > 0) throw err(`CURRENCY_IN_USE: ${cu.code}`, 409);
  await c.query('DELETE FROM currencies WHERE code = $1', [cu.code]);
  await audit(c, createdBy, 'CURRENCY_DELETED', cu.code, cu, null);
  return { deleted: cu.code };
}

async function assertNotBase(cu) {
  if (cu.is_base) throw err('THE_BASE_CURRENCY_HAS_NO_EXCHANGE_RATE', 409);
}

/**
 * A new exchange rate for a currency against the base: buy and sell rates,
 * valid from `startDate` (now when not given), which may not be before the
 * latest rate already set.
 */
async function setExchangeRate(c, code, { buyRate, sellRate, startDate = null } = {}, { createdBy } = {}) {
  const cu = await find(c, code);
  await assertNotBase(cu);
  const buy = Number(buyRate); const sell = Number(sellRate);
  if (!(buy > 0) || !(sell > 0)) throw err('BUY_AND_SELL_RATES_MUST_BE_ABOVE_ZERO', 400);
  const from = startDate ? new Date(startDate) : new Date();
  if (Number.isNaN(from.getTime())) throw err('INVALID_START_DATE', 400);
  const { rows: [last] } = await c.query('SELECT max(valid_from) AS d FROM exchange_rates WHERE currency_code = $1', [cu.code]);
  if (last?.d && from < new Date(last.d)) throw err(`EXCHANGE_RATE_CANNOT_START_BEFORE_THE_LATEST: ${new Date(last.d).toISOString()}`, 409);
  const { rows: [r] } = await c.query(
    'INSERT INTO exchange_rates (currency_code, buy_rate, sell_rate, valid_from, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [cu.code, buy, sell, from.toISOString(), createdBy || 'SYSTEM']);
  await audit(c, createdBy, 'EXCHANGE_RATE_SET', cu.code, null, r);
  return r;
}

async function setAccountingRate(c, code, { rate, startDate = null } = {}, { createdBy } = {}) {
  const cu = await find(c, code);
  await assertNotBase(cu);
  const v = Number(rate);
  if (!(v > 0)) throw err('ACCOUNTING_RATE_MUST_BE_ABOVE_ZERO', 400);
  const from = startDate ? new Date(startDate) : new Date();
  if (Number.isNaN(from.getTime())) throw err('INVALID_START_DATE', 400);
  const { rows: [last] } = await c.query('SELECT max(valid_from) AS d FROM accounting_rates WHERE currency_code = $1', [cu.code]);
  if (last?.d && from < new Date(last.d)) throw err(`ACCOUNTING_RATE_CANNOT_START_BEFORE_THE_LATEST: ${new Date(last.d).toISOString()}`, 409);
  const { rows: [r] } = await c.query(
    'INSERT INTO accounting_rates (currency_code, rate, valid_from, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
    [cu.code, v, from.toISOString(), createdBy || 'SYSTEM']);
  await audit(c, createdBy, 'ACCOUNTING_RATE_SET', cu.code, null, r);
  return r;
}

async function rates(c, code) {
  const cu = await find(c, code);
  const { rows: exchange } = await c.query('SELECT * FROM exchange_rates WHERE currency_code = $1 ORDER BY valid_from DESC', [cu.code]);
  const { rows: accounting } = await c.query('SELECT * FROM accounting_rates WHERE currency_code = $1 ORDER BY valid_from DESC', [cu.code]);
  return { currency: cu, exchange, accounting };
}

/** The exchange rate in force at a moment (buy and sell), or null. */
async function exchangeRateAt(c, code, at = new Date()) {
  const { rows: [r] } = await c.query(
    'SELECT * FROM exchange_rates WHERE currency_code = $1 AND valid_from <= $2 ORDER BY valid_from DESC LIMIT 1', [String(code).toUpperCase(), new Date(at).toISOString()]);
  return r || null;
}

module.exports = { presets, isoInfo, list, add, update, remove, setExchangeRate, setAccountingRate, rates, exchangeRateAt };
