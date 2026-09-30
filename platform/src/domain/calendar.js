'use strict';

const { orgToday } = require('../lib/orgDate');
const acct = require('./accounting');
const S = require('./schedule');
const ledger = require('./ledger');
const { recordAudit } = require('../lib/auditLog');
const { err } = acct;
const { ymd, isoDate } = S;

/**
 * Holidays and non-working days, after the reference platform's page of that name.
 *
 * Non-working days are days of the week, for the whole organization.
 * Holidays fall on a date, once or every year (recurring), and are
 * organization-wide, for one branch (the reference platform's branch holidays, counted for
 * the loans of that branch) or for a currency (counted for accounts in it;
 * every account here is in the base currency). The SQL function
 * is_closed_day answers for every calendar check: schedules, arrears
 * tolerance and penalty days (./ledger closedDays, ./workflow, ./penalties).
 *
 * A change to either marks the calendar as changed from a date. The sync
 * (the end of day's first step, or on demand) then re-dates the unpaid
 * installments of open loans that fall due after today, from each
 * installment's nominal date by the product's non-working day rule, as
 * The reference platform updates every account that is not closed. Amounts stay as they
 * are; installments already due are left alone, so arrears do not move.
 */

const today = (c) => orgToday(c);
const RECALC_STATES = ['ACTIVE', 'IN_ARREARS', 'LOCKED'];

async function markChanged(c, from) {
  await c.query(
    `UPDATE organization_settings SET calendar_changed_from = LEAST(COALESCE(calendar_changed_from, $1::date), $1::date) WHERE id = 1`,
    [from]);
}

async function audit(c, actor, action, id, before, after) {
  await recordAudit(c, { actor: actor || 'SYSTEM', action: action, entity: 'holiday', entityId: id, before: before ? JSON.stringify(before) : null, after: after ? JSON.stringify(after) : null });
}

const shape = (h) => ({
  key: h.key, id: h.id, description: h.name, date: ymd(h.holiday_date), recurring: h.recurring,
  branchId: h.branch_id, branchCode: h.branch_code || null, currencyCode: h.currency_code,
  scope: h.branch_id ? 'BRANCH' : h.currency_code ? 'CURRENCY' : 'GENERAL', createdBy: h.created_by, createdAt: h.created_at,
});

/** The whole calendar: non-working days and every holiday, by scope. */
async function list(c, { branchId = null } = {}) {
  const { rows: [s] } = await c.query('SELECT non_working_days, calendar_changed_from FROM organization_settings WHERE id = 1');
  const { rows } = await c.query(
    `SELECT h.*, b.code AS branch_code FROM holidays h LEFT JOIN branches b ON b.id = h.branch_id
     WHERE ($1::uuid IS NULL OR h.branch_id = $1::uuid)
     ORDER BY h.branch_id NULLS FIRST, h.currency_code NULLS FIRST, h.holiday_date`, [branchId]);
  const all = rows.map(shape);
  return {
    nonWorkingDays: s.non_working_days.map(Number),
    pendingSyncFrom: s.calendar_changed_from ? ymd(s.calendar_changed_from) : null,
    general: all.filter((h) => h.scope === 'GENERAL'),
    branches: all.filter((h) => h.scope === 'BRANCH'),
    currencies: all.filter((h) => h.scope === 'CURRENCY'),
  };
}

async function resolveBranch(c, ref) {
  if (!ref) return null;
  const { rows: [b] } = await c.query('SELECT id FROM branches WHERE id::text = $1 OR code = $1', [String(ref)]);
  if (!b) throw err(`UNKNOWN_BRANCH: ${ref}`, 404);
  return b.id;
}

/**
 * Add a holiday: `date`, `description`, `recurring`, an optional `id`
 * (generated when blank; unique within its currency), and `branchId` or
 * `currencyCode` for a branch or currency holiday.
 */
async function add(c, { date, description, name, recurring = false, id = null, branchId = null, currencyCode = null } = {}, { createdBy } = {}) {
  const day = date ? ymd(date) : null;
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw err('A_HOLIDAY_NEEDS_A_DATE', 400);
  const label = String(description ?? name ?? '').trim();
  if (!label) throw err('A_HOLIDAY_NEEDS_A_DESCRIPTION', 400);
  const branch = await resolveBranch(c, branchId);
  let currency = null;
  if (currencyCode) {
    if (branch) throw err('A_HOLIDAY_IS_FOR_A_BRANCH_OR_A_CURRENCY_NOT_BOTH', 400);
    currency = String(currencyCode).toUpperCase();
    const { rowCount } = await c.query('SELECT 1 FROM currencies WHERE code = $1', [currency]);
    if (!rowCount) throw err(`CURRENCY_NOT_SET_UP: ${currency}`, 404);
  }
  if (id !== null && id !== '' && !/^[A-Za-z0-9_-]{1,32}$/.test(String(id))) throw err('HOLIDAY_ID_IS_1_TO_32_LETTERS_DIGITS_DASHES', 400);
  const { rows: [h] } = await c.query(
    `INSERT INTO holidays (holiday_date, name, recurring, branch_id, currency_code, created_by${id ? ', id' : ''})
     VALUES ($1::date, $2, $3, $4, $5, $6${id ? ', $7' : ''})
     ON CONFLICT DO NOTHING RETURNING *`,
    [day, label, recurring === true || recurring === 'true', branch, currency, createdBy || 'SYSTEM', ...(id ? [String(id)] : [])]);
  if (!h) throw err('HOLIDAY_EXISTS: that date or ID is already a holiday in this scope', 409);
  await markChanged(c, h.recurring ? (await today(c)) : day);
  await audit(c, createdBy, 'HOLIDAY_ADDED', h.id, null, shape(h));
  return shape(h);
}

async function find(c, ref) {
  const { rows: [h] } = await c.query(
    `SELECT * FROM holidays WHERE key::text = $1 OR (id = $1 AND currency_code IS NULL) ORDER BY branch_id NULLS FIRST LIMIT 1`, [String(ref)]);
  if (!h) throw err(`UNKNOWN_HOLIDAY: ${ref}`, 404);
  return h;
}

async function update(c, ref, { date, description, name, recurring } = {}, { createdBy } = {}) {
  const h = await find(c, ref);
  const day = date ? ymd(date) : ymd(h.holiday_date);
  const label = description ?? name ?? h.name;
  if (!String(label).trim()) throw err('A_HOLIDAY_NEEDS_A_DESCRIPTION', 400);
  const rec = recurring === undefined ? h.recurring : (recurring === true || recurring === 'true');
  const { rows: [after] } = await c.query(
    'UPDATE holidays SET holiday_date = $2::date, name = $3, recurring = $4 WHERE key = $1 RETURNING *', [h.key, day, String(label).trim(), rec]);
  await markChanged(c, (rec || h.recurring) ? (await today(c)) : (day < ymd(h.holiday_date) ? day : ymd(h.holiday_date)));
  await audit(c, createdBy, 'HOLIDAY_CHANGED', h.id, shape(h), shape(after));
  return shape(after);
}

async function remove(c, ref, { createdBy } = {}) {
  const h = await find(c, ref);
  await c.query('DELETE FROM holidays WHERE key = $1', [h.key]);
  await markChanged(c, h.recurring ? (await today(c)) : ymd(h.holiday_date));
  await audit(c, createdBy, 'HOLIDAY_DELETED', h.id, shape(h), null);
  return { deleted: h.id };
}

/** The organization's non-working days of the week, 0 Sunday to 6 Saturday. */
async function setNonWorkingDays(c, days, { createdBy } = {}) {
  if (!Array.isArray(days)) throw err('NON_WORKING_DAYS_IS_A_LIST_OF_0_TO_6', 400);
  const set = [...new Set(days.map(Number))].sort();
  if (set.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw err('NON_WORKING_DAYS_IS_A_LIST_OF_0_TO_6', 400);
  if (set.length >= 7) throw err('AT_LEAST_ONE_DAY_MUST_BE_A_WORKING_DAY', 400);
  const { rows: [s] } = await c.query('SELECT non_working_days FROM organization_settings WHERE id = 1');
  await c.query('UPDATE organization_settings SET non_working_days = $1::smallint[], updated_at = now(), updated_by = $2 WHERE id = 1', [set, createdBy || 'SYSTEM']);
  await markChanged(c, (await today(c)));
  await audit(c, createdBy, 'NON_WORKING_DAYS_CHANGED', null, { days: s.non_working_days }, { days: set });
  return { nonWorkingDays: set };
}

/**
 * Re-date open loans after a calendar change (the reference platform's holiday sync,
 * HOLIDAY_SYNC_COMPLETED). Unpaid installments due after today move to
 * where the product's rule puts their nominal date now; EXTEND_SCHEDULE
 * moves forward, as a date that lands on a closed day does.
 */
async function sync(c, { createdBy = 'EOD', force = false } = {}) {
  const { rows: [s] } = await c.query('SELECT calendar_changed_from FROM organization_settings WHERE id = 1');
  if (!s.calendar_changed_from && !force) return { synced: false, loans: 0, installments: 0 };
  const from = (await today(c));
  const { rows: loans } = await c.query(
    `SELECT DISTINCT i.loan_id FROM loan_installments i JOIN loan_accounts l ON l.id = i.loan_id
     WHERE l.status = ANY($1::text[]) AND i.status NOT IN ('PAID') AND i.due_date > $2::date`, [RECALC_STATES, from]);
  let moved = 0;
  let touched = 0;
  for (const { loan_id: id } of loans) {
    const l = await ledger.lock(c, id);
    const rule = l.non_working_days || 'MOVE_FORWARD';
    if (rule === 'DO_NOT_RESCHEDULE') continue;
    const { rows: inst } = await c.query('SELECT id, number, due_date, nominal_due, status FROM loan_installments WHERE loan_id = $1 ORDER BY number', [id]);
    let previous = l.disbursed_on ? ymd(l.disbursed_on) : null;
    let changed = false;
    for (const i of inst) {
      const due = ymd(i.due_date);
      if (i.status === 'PAID' || due <= from) { previous = due; continue; }
      const next = await ledger.shiftOffClosedDays(c, ymd(i.nominal_due), rule === 'EXTEND_SCHEDULE' ? 'MOVE_FORWARD' : rule,
        { notBefore: previous, branchId: l.branch_id || null });
      const target = next > from ? next : due;
      if (target !== due) {
        await c.query('UPDATE loan_installments SET due_date = $2::date WHERE id = $1', [i.id, target]);
        moved += 1;
        changed = true;
      }
      previous = target;
    }
    if (changed) touched += 1;
  }
  await c.query('UPDATE organization_settings SET calendar_changed_from = NULL WHERE id = 1');
  const out = { synced: true, changedFrom: s.calendar_changed_from ? ymd(s.calendar_changed_from) : null, loans: touched, installments: moved };
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'HOLIDAY_SYNC_COMPLETED', entity: 'calendar', after: JSON.stringify(out) });
  return out;
}

module.exports = { list, add, update, remove, setNonWorkingDays, sync };
