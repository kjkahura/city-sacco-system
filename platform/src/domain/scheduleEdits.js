'use strict';

const acct = require('./accounting');
const S = require('./schedule');
const ledger = require('./ledger');
const types = require('./productTypes');
const { buildSchedule } = require('./installments');
const { err } = acct;
const { ymd, isoDate, toUTC } = S;

/**
 * Editing a running loan's schedule, after Mambu's "Repayments Schedule
 * Editing": what may change is the product's list (schedule_editing), and
 * only installments that nothing has been paid on and whose interest has
 * not started to be earned may change.
 *
 *   editSchedule    replace those installments with new dates, principal,
 *                   interest (fixed term) and fees; principal and fees are
 *                   reallocated, never added or removed
 *   paymentHoliday  give installments nothing due; the loan runs longer by
 *                   as many periods and the interest of the holiday is
 *                   spread over the installments after it
 *   changeDueDay    move the next installment and every later one to a new
 *                   day of the month (dynamic term): the next installment's
 *                   interest follows its longer or shorter period, later
 *                   installments keep their amounts
 *
 * On a dynamic-term loan the installments' interest is an expectation (the
 * loan earns interest on its balance), so an edit redraws it from the new
 * principal and dates. On a fixed-term loan the schedule is the contract:
 * interest stays as drawn unless INTEREST editing is allowed and it is
 * changed, and only installments whose period has not begun may change, so
 * the interest already earned stays exactly what the schedule said.
 *
 * An application has no installments yet, but editSchedule works on it too
 * (editApplication): what it changes is kept on the application
 * (custom_schedule) and the loan is drawn with it at disbursement
 * (installments.buildSchedule). The same product rights apply, except that
 * the number of installments may change within the product's term band,
 * as the term of an application may.
 *
 * Every edit is kept with the schedule before and after (loan_schedule_edits).
 */

const EDITS = ['PAYMENT_DATES', 'PRINCIPAL', 'INTEREST', 'FEES', 'PAYMENT_HOLIDAYS', 'NUMBER_OF_INSTALLMENTS'];
const today = () => isoDate(new Date());
const r2 = (n, d) => S.roundTo(n, d);

async function load(c, loanId, kind, asOf, { forUpdate = true } = {}) {
  const l = await ledger.lock(c, loanId, { forUpdate });
  if (!['ACTIVE', 'IN_ARREARS'].includes(l.status)) throw err(`SCHEDULE_NOT_EDITABLE_IN_STATE_${l.status}`, 409);
  const type = types.forLoan(l);
  if (!type.schedulesUpfront) throw err('THIS_LOAN_HAS_NO_SCHEDULE_TO_EDIT', 409);
  const allowed = new Set(l.schedule_editing || []);
  if (kind && !allowed.has(kind)) throw err(`PRODUCT_DOES_NOT_ALLOW_${kind}_EDITING`, 409);
  const { rows } = await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [l.id]);
  const date = asOf ? ymd(asOf) : today();
  // Where interest has been earned to: a fixed-term installment may change
  // only if its period starts on or after that day.
  const earned = l.accrued_through ? ymd(l.accrued_through) : ymd(l.disbursed_on);
  const fresh = (i) => Number(i.principal_paid) === 0 && Number(i.interest_paid) === 0 && Number(i.fee_paid) === 0 && i.status !== 'PAID';
  let firstEditable = -1;
  for (let k = 0; k < rows.length; k += 1) {
    const start = k === 0 ? ymd(l.disbursed_on) : ymd(rows[k - 1].nominal_due);
    const ok = fresh(rows[k]) && ymd(rows[k].due_date) > date && (type.basis !== 'SCHEDULE' || start >= earned);
    if (ok && firstEditable < 0) firstEditable = k;
    if (!ok && firstEditable >= 0) { firstEditable = -1; }  // the editable part is the tail after the last one that cannot change
  }
  const tail = firstEditable >= 0 ? rows.slice(firstEditable) : [];
  const head = firstEditable >= 0 ? rows.slice(0, firstEditable) : rows;
  const decimals = await ledger.currencyDecimals(c);
  const inputs = await ledger.scheduleInputsFor(c, l);
  return { l, type, allowed, rows, head, tail, date, decimals, inputs };
}

const view = (rows) => rows.map((i) => ({
  number: i.number, dueDate: ymd(i.due_date), principal: Number(i.principal_due), interest: Number(i.interest_due),
  fee: Number(i.fee_due), holiday: Boolean(i.payment_holiday),
}));

async function replaceTail(c, l, tail, lines) {
  await c.query('DELETE FROM loan_installments WHERE loan_id = $1 AND id = ANY($2)', [l.id, tail.map((t) => t.id)]);
  const start = tail[0].number;
  for (let k = 0; k < lines.length; k += 1) {
    const x = lines[k];
    const nothingDue = !(x.principal > 0) && !(x.interest > 0) && !(x.fee > 0);
    await c.query(
      `INSERT INTO loan_installments (loan_id, number, due_date, nominal_due, principal_due, interest_due, fee_due, status, payment_holiday)
       VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9)`,
      [l.id, start + k, x.dueDate, x.nominalDue || x.dueDate, x.principal, x.interest, x.fee || 0,
        nothingDue ? 'GRACE' : 'PENDING', Boolean(x.holiday)]);
  }
  const count = start - 1 + lines.length;
  await c.query('UPDATE loan_accounts SET term_months = $2, updated_at = now() WHERE id = $1', [l.id, count]);
}

async function record(c, l, kind, before, after, note, createdBy) {
  const { rows: [e] } = await c.query(
    `INSERT INTO loan_schedule_edits (loan_id, kind, before, after, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [l.id, kind, JSON.stringify(before), JSON.stringify(after), note, createdBy || 'SYSTEM']);
  return e;
}

/** Interest a dynamic loan's installments are expected to carry, from their principal and dates. */
function expectedInterest(lines, { outstanding, start, terms, decimals }) {
  let bal = outstanding;
  let from = start;
  for (const x of lines) {
    x.interest = r2(S.interestBetween(bal, terms, from, x.nominalDue || x.dueDate, { exact: true }), decimals);
    bal = r2(bal - x.principal, decimals);
    from = x.nominalDue || x.dueDate;
  }
  return lines;
}

// --------------------------------------------------------------------------

/**
 * Replace the editable installments with `installments`, each
 * { dueDate, principal, interest, fee }. A field left out keeps its value
 * (by position); a field changed needs the product to allow that edit.
 */
async function editSchedule(c, loanId, { installments, note = null, asOf = null, createdBy } = {}) {
  const current = await ledger.lock(c, loanId);
  if (APPLICATION.includes(current.status)) return editApplication(c, current, { installments, note, asOf, createdBy });
  const ctx = await load(c, loanId, null, asOf);
  const { l, type, allowed, head, tail, decimals, inputs } = ctx;
  if (!Array.isArray(installments) || !installments.length) throw err('GIVE_THE_NEW_INSTALLMENTS', 400);
  if (!tail.length) throw err('NO_INSTALLMENT_CAN_CHANGE: each has been paid on, has fallen due or has started to earn interest', 409);
  const need = (kind) => { if (!allowed.has(kind)) throw err(`PRODUCT_DOES_NOT_ALLOW_${kind}_EDITING`, 409); };
  if (installments.length !== tail.length) need('NUMBER_OF_INSTALLMENTS');

  const prevDate = head.length ? ymd(head[head.length - 1].due_date) : ymd(l.disbursed_on);
  const lines = installments.map((x, k) => {
    const old = tail[k];
    const dueDate = x.dueDate ? String(x.dueDate).slice(0, 10) : (old ? ymd(old.due_date) : null);
    if (!dueDate) throw err(`INSTALLMENT_${k + 1}_NEEDS_A_DUE_DATE`, 400);
    return {
      dueDate,
      nominalDue: old && dueDate === ymd(old.due_date) ? ymd(old.nominal_due) : dueDate,
      principal: x.principal !== undefined ? r2(x.principal, decimals) : (old ? Number(old.principal_due) : 0),
      interest: x.interest !== undefined ? r2(x.interest, decimals) : (old ? Number(old.interest_due) : 0),
      fee: x.fee !== undefined ? r2(x.fee, decimals) : (old ? Number(old.fee_due) : 0),
      changed: {
        date: !old || dueDate !== ymd(old.due_date),
        principal: !old || (x.principal !== undefined && r2(x.principal, decimals) !== Number(old.principal_due)),
        interest: old ? x.interest !== undefined && r2(x.interest, decimals) !== Number(old.interest_due) : x.interest !== undefined,
        fee: !old ? Boolean(x.fee) : x.fee !== undefined && r2(x.fee, decimals) !== Number(old.fee_due),
      },
    };
  });
  if (lines.some((x) => x.changed.date)) need('PAYMENT_DATES');
  if (lines.some((x) => x.changed.principal)) need('PRINCIPAL');
  if (lines.some((x) => x.changed.fee)) need('FEES');
  if (lines.some((x) => x.changed.interest)) {
    if (type.basis !== 'SCHEDULE') throw err('A_DYNAMIC_LOANS_INTEREST_FOLLOWS_ITS_BALANCE_AND_IS_NOT_EDITED', 409);
    need('INTEREST');
  }
  let last = prevDate;
  for (const x of lines) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.dueDate)) throw err(`INVALID_DUE_DATE: ${x.dueDate}`, 400);
    if (x.dueDate <= last) throw err(`DUE_DATES_MUST_RISE: ${x.dueDate} is not after ${last}`, 400);
    if (x.dueDate <= ctx.date) throw err(`DUE_DATE_NOT_IN_THE_FUTURE: ${x.dueDate}`, 400);
    if (x.principal < 0 || x.interest < 0 || x.fee < 0) throw err('AMOUNTS_CANNOT_BE_NEGATIVE', 400);
    last = x.dueDate;
  }
  const sum = (xs, f) => r2(xs.reduce((a, x) => a + Number(f(x)), 0), decimals);
  if (sum(lines, (x) => x.principal) !== sum(tail, (x) => x.principal_due)) {
    throw err(`PRINCIPAL_MUST_STILL_ADD_UP: the installments that can change carry ${sum(tail, (x) => x.principal_due)}`, 400);
  }
  if (sum(lines, (x) => x.fee) !== sum(tail, (x) => x.fee_due)) {
    throw err(`FEES_MUST_STILL_ADD_UP: the installments that can change carry ${sum(tail, (x) => x.fee_due)}; apply or waive a fee instead`, 400);
  }
  if (type.basis !== 'SCHEDULE') {
    const start = head.length ? ymd(head[head.length - 1].nominal_due) : ymd(l.disbursed_on);
    expectedInterest(lines, { outstanding: sum(tail, (x) => x.principal_due), start, terms: inputs.terms, decimals });
  }
  const before = view(tail);
  await replaceTail(c, l, tail, lines);
  const after = view((await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 AND number >= $2 ORDER BY number', [l.id, tail[0].number])).rows);
  await record(c, l, 'EDIT', before, after, note, createdBy);
  return { loanId: l.id, before, after };
}

/**
 * A payment holiday on `count` installments from installment `from`: they
 * fall due with nothing to pay, the schedule gains `count` installments at
 * the end, and the principal and the holiday's interest are spread over
 * the installments after it (Mambu's payment holiday; the arithmetic is the
 * schedule engine's PURE grace).
 */
async function paymentHoliday(c, loanId, { from, count = 1, note = null, asOf = null, createdBy } = {}) {
  const ctx = await load(c, loanId, 'PAYMENT_HOLIDAYS', asOf);
  const { l, type, head, decimals, inputs } = ctx;
  const n = Number(count);
  if (!(Number.isInteger(n) && n > 0)) throw err('A_PAYMENT_HOLIDAY_NEEDS_A_COUNT', 400);
  const at = ctx.tail.findIndex((i) => i.number === Number(from));
  if (at < 0) throw err(`INSTALLMENT_${from}_CANNOT_TAKE_A_HOLIDAY: it has been paid on, has fallen due or has started to earn interest`, 409);
  const tail = ctx.tail.slice(at);
  const kept = [...head, ...ctx.tail.slice(0, at)];

  // The tail's dates, then as many more as the holiday adds, on the interval.
  const nominal = tail.map((i) => ymd(i.nominal_due));
  const extra = S.nominalDueDates({ start: nominal[nominal.length - 1], count: n, interval: inputs.interval,
    fixedDays: inputs.fixedDays, shortMonth: inputs.shortMonth });
  nominal.push(...extra.map(isoDate));
  const periods = nominal.map((to, k) => ({
    from: toUTC(k === 0 ? (kept.length ? ymd(kept[kept.length - 1].nominal_due) : ymd(l.disbursed_on)) : nominal[k - 1]), to: toUTC(to),
  }));
  const principal = r2(tail.reduce((a, x) => a + Number(x.principal_due), 0), decimals);
  const fees = tail.map((x) => Number(x.fee_due));
  const planned = S.planInstallments({
    principal, terms: inputs.terms, method: l.method, periods, flatBase: l.method === 'FLAT' ? Number(l.principal) : null,
    grace: { type: 'PURE', periods: n }, rounding: inputs.rounding, decimals,
  });
  const lines = [];
  for (let k = 0; k < nominal.length; k += 1) {
    const due = await ledger.shiftOffClosedDays(c, nominal[k], inputs.nonWorkingDays, { notBefore: k ? lines[k - 1].dueDate : null });
    const p = planned[k] || { principal: 0, interest: 0 };
    lines.push({
      dueDate: due, nominalDue: nominal[k], principal: k < n ? 0 : p.principal, interest: k < n ? 0 : p.interest,
      // A holiday installment's fee moves to the first installment after it.
      fee: k < n ? 0 : (k === n ? r2(fees.slice(0, n + 1).reduce((a, f) => a + f, 0), decimals) : (fees[k] || 0)),
      holiday: k < n,
    });
  }
  if (type.basis !== 'SCHEDULE') {
    // A dynamic loan earns interest through the holiday on its balance; the
    // installments after it expect that interest and their own.
    const start = kept.length ? ymd(kept[kept.length - 1].nominal_due) : ymd(l.disbursed_on);
    const reg = lines.filter((x) => !x.holiday);
    const holidayInterest = r2(S.interestBetween(principal, inputs.terms, start, lines[n - 1].nominalDue, { exact: true }), decimals);
    expectedInterest(reg, { outstanding: principal, start: lines[n - 1].nominalDue, terms: inputs.terms, decimals });
    reg[0].interest = r2(reg[0].interest + holidayInterest, decimals);
  }
  const before = view(tail);
  await replaceTail(c, l, tail, lines);
  const after = view((await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 AND number >= $2 ORDER BY number', [l.id, tail[0].number])).rows);
  await record(c, l, 'PAYMENT_HOLIDAY', before, after, note, createdBy);
  return { loanId: l.id, holiday: after.filter((x) => x.holiday).map((x) => x.number), before, after };
}

/**
 * Move the next installment and every later one to `day` of their months
 * (dynamic term, as in Mambu). The next installment's interest follows the
 * new length of its period; later installments keep their amounts.
 */
async function changeDueDay(c, loanId, { day, note = null, asOf = null, createdBy } = {}) {
  const ctx = await load(c, loanId, 'PAYMENT_DATES', asOf);
  const { l, type, head, tail, decimals, inputs } = ctx;
  if (type.basis === 'SCHEDULE') throw err('THE_DUE_DAY_CHANGES_ON_DYNAMIC_TERM_LOANS', 409);
  const d = Number(day);
  if (!(Number.isInteger(d) && d >= 1 && d <= 31)) throw err('DAY_MUST_BE_1_TO_31', 400);
  if (!tail.length) throw err('NO_INSTALLMENT_CAN_CHANGE', 409);
  const onDay = (iso) => {
    const x = toUTC(iso);
    const last = S.daysInMonth(x.getUTCFullYear(), x.getUTCMonth());
    return isoDate(new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), Math.min(d, last))));
  };
  const prev = head.length ? ymd(head[head.length - 1].due_date) : ymd(l.disbursed_on);
  const lines = [];
  for (let k = 0; k < tail.length; k += 1) {
    const nominal = onDay(ymd(tail[k].nominal_due));
    const due = await ledger.shiftOffClosedDays(c, nominal, inputs.nonWorkingDays, { notBefore: k ? lines[k - 1].dueDate : prev });
    lines.push({ dueDate: due, nominalDue: nominal, principal: Number(tail[k].principal_due), interest: Number(tail[k].interest_due), fee: Number(tail[k].fee_due) });
  }
  if (lines[0].dueDate <= ctx.date || lines[0].dueDate <= prev) throw err(`THE_NEXT_DUE_DATE_WOULD_BE_${lines[0].dueDate}: not after ${ctx.date > prev ? ctx.date : prev}`, 409);
  // Only the next installment's period changes length.
  const outstanding = r2(tail.reduce((a, x) => a + Number(x.principal_due), 0), decimals);
  const start = head.length ? ymd(head[head.length - 1].nominal_due) : ymd(l.disbursed_on);
  lines[0].interest = r2(S.interestBetween(outstanding, inputs.terms, start, lines[0].nominalDue, { exact: true }), decimals);
  const before = view(tail);
  await replaceTail(c, l, tail, lines);
  const after = view((await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 AND number >= $2 ORDER BY number', [l.id, tail[0].number])).rows);
  await record(c, l, 'DUE_DAY', before, after, note, createdBy);
  return { loanId: l.id, day: d, before, after };
}

/**
 * What an editor may show: the installments that can change now and the
 * edits the product allows. For an application, the whole schedule it
 * would be drawn with.
 */
async function editable(c, loanId, { asOf = null } = {}) {
  const l = await ledger.read(c, loanId);
  const allowed = [...(l.schedule_editing || [])];
  const fixed = types.forLoan(l).basis === 'SCHEDULE';
  if (APPLICATION.includes(l.status)) {
    const a = await applicationSchedule(c, l.id);
    return { loanId: l.id, application: true, allowed, fixedTerm: fixed, countMayChange: true,
      head: [], installments: a.installments, custom: a.custom };
  }
  const { head, tail } = await load(c, l.id, null, asOf, { forUpdate: false });
  return { loanId: l.id, application: false, allowed, fixedTerm: fixed, countMayChange: allowed.includes('NUMBER_OF_INSTALLMENTS'),
    head: view(head), installments: view(tail) };
}

// --------------------------------------------------------------------------
// Applications
// --------------------------------------------------------------------------

const APPLICATION = ['PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED'];

function assertApplication(l) {
  if (!APPLICATION.includes(l.status)) throw err(`NOT_AN_APPLICATION: ${l.status}`, 409);
  const type = types.forLoan(l);
  if (!type.schedulesUpfront || type.plansTranches || type.disbursesAgain) throw err('THIS_PRODUCT_DRAWS_NO_SCHEDULE_AT_DISBURSEMENT', 409);
  return type;
}

/** The schedule an application would be drawn with today. */
async function draft(c, l, opts = {}) {
  return (await buildSchedule(c, { ...l, ...opts.patch }, { persist: false, custom: opts.custom !== false })).installments;
}
const draftView = (rows) => rows.map((i) => ({
  number: i.number, dueDate: i.dueDate, principal: i.principal, interest: i.interest, fee: i.fee || 0,
}));

/**
 * The schedule an application will be drawn with, as it would be if it
 * were disbursed today, and whether it has been edited.
 */
async function applicationSchedule(c, loanId) {
  const l = await ledger.read(c, loanId);
  assertApplication(l);
  return { loanId: l.id, custom: Array.isArray(l.custom_schedule) && l.custom_schedule.length > 0, edited: l.custom_schedule || null,
    installments: draftView(await draft(c, l)) };
}

async function editApplication(c, l, { installments, note, asOf, createdBy }) {
  const type = assertApplication(l);
  if (!Array.isArray(installments) || !installments.length) throw err('GIVE_THE_NEW_INSTALLMENTS', 400);
  const allowed = new Set(l.schedule_editing || []);
  const need = (kind) => { if (!allowed.has(kind)) throw err(`PRODUCT_DOES_NOT_ALLOW_${kind}_EDITING`, 409); };
  const decimals = await ledger.currencyDecimals(c);
  const date = asOf ? ymd(asOf) : today();
  const { rows: [p] } = await c.query('SELECT min_term, max_term FROM loan_products WHERE id = $1', [l.product_id]);
  const n = installments.length;
  if (n > p.max_term) throw err(`TERM_EXCEEDS_PRODUCT_MAX: ${p.max_term}`, 400);
  if (p.min_term && n < p.min_term) throw err(`TERM_BELOW_PRODUCT_MIN: ${p.min_term}`, 400);

  const before = draftView(await draft(c, l));
  // Positions keep what they had: the edited value, or the product's.
  const previous = Array.isArray(l.custom_schedule) && l.custom_schedule.length === n ? l.custom_schedule : null;
  const product = await draft(c, l, { patch: { term_months: n }, custom: false });
  const given = (v) => v !== null && v !== undefined;
  const edited = installments.map((x, k) => {
    const old = previous ? previous[k] : {};
    if (x.fee !== undefined && Number(x.fee) !== Number(product[k].fee || 0)) {
      throw err('FEES_ARE_PLACED_ON_THE_SCHEDULE_AT_DISBURSEMENT: edit them once the loan is running', 400);
    }
    const dueDate = x.dueDate ? String(x.dueDate).slice(0, 10) : (old.dueDate || null);
    const principal = given(x.principal) ? r2(x.principal, decimals) : (given(old.principal) ? Number(old.principal) : null);
    const interest = given(x.interest) ? r2(x.interest, decimals) : (given(old.interest) ? Number(old.interest) : null);
    return {
      dueDate: dueDate && dueDate !== product[k].dueDate ? dueDate : null,
      principal: given(principal) && principal !== product[k].principal ? principal : null,
      interest: given(interest) && interest !== product[k].interest ? interest : null,
    };
  });
  if (edited.some((x) => x.dueDate)) need('PAYMENT_DATES');
  if (edited.some((x) => given(x.principal))) need('PRINCIPAL');
  if (edited.some((x) => given(x.interest))) {
    if (type.basis !== 'SCHEDULE') throw err('A_DYNAMIC_LOANS_INTEREST_FOLLOWS_ITS_BALANCE_AND_IS_NOT_EDITED', 409);
    need('INTEREST');
  }
  const resolved = edited.map((x, k) => ({
    dueDate: x.dueDate || product[k].dueDate, principal: given(x.principal) ? x.principal : product[k].principal,
    interest: given(x.interest) ? x.interest : 0,
  }));
  let last = date;
  for (const x of resolved) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.dueDate)) throw err(`INVALID_DUE_DATE: ${x.dueDate}`, 400);
    if (x.dueDate <= last) throw err(`DUE_DATES_MUST_RISE: ${x.dueDate} is not after ${last}`, 400);
    if (x.principal < 0 || x.interest < 0) throw err('AMOUNTS_CANNOT_BE_NEGATIVE', 400);
    last = x.dueDate;
  }
  const total = r2(resolved.reduce((a, x) => a + x.principal, 0), decimals);
  if (total !== r2(Number(l.principal), decimals)) throw err(`PRINCIPAL_MUST_ADD_UP_TO_THE_LOAN: ${Number(l.principal)}, not ${total}`, 400);

  const custom = edited.every((x) => !x.dueDate && !given(x.principal) && !given(x.interest)) ? null : edited;
  await c.query('UPDATE loan_accounts SET custom_schedule = $2, term_months = $3, updated_at = now() WHERE id = $1',
    [l.id, custom ? JSON.stringify(custom) : null, n]);
  const after = draftView(await draft(c, await ledger.lock(c, l.id)));
  await record(c, l, 'APPLICATION', before, after, note, createdBy);
  return { loanId: l.id, application: true, custom: Boolean(custom), before, after };
}

/** Back to the product's schedule. */
async function clearApplicationSchedule(c, loanId, { note = null, createdBy } = {}) {
  const l = await ledger.lock(c, loanId);
  assertApplication(l);
  if (!l.custom_schedule) throw err('THE_APPLICATION_HAS_THE_PRODUCTS_SCHEDULE', 409);
  const before = draftView(await draft(c, l));
  await c.query('UPDATE loan_accounts SET custom_schedule = NULL, updated_at = now() WHERE id = $1', [l.id]);
  const after = draftView(await draft(c, await ledger.lock(c, l.id)));
  await record(c, l, 'APPLICATION', before, after, note || 'back to the product schedule', createdBy);
  return { loanId: l.id, application: true, custom: false, before, after };
}

async function editsOf(c, loanId) {
  const l = await ledger.read(c, loanId);
  const { rows } = await c.query('SELECT * FROM loan_schedule_edits WHERE loan_id = $1 ORDER BY created_at, id', [l.id]);
  return rows;
}

module.exports = { EDITS, editSchedule, paymentHoliday, changeDueDay, editsOf, editable, applicationSchedule, clearApplicationSchedule };
