#!/usr/bin/env node
'use strict';

/**
 * Managing your organization, after the reference platform's pages of that name: the
 * organization's details and branding, branches and centres, product
 * availability per branch, holidays and non-working days with the calendar
 * sync, transaction channels, ID templates, tax rate sources, currencies,
 * end-of-day settings, custom fields and product documents.
 */

const { orgDay } = require('./_org');
const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const { signToken } = require('../src/tenancy/resolve');
const L = require('../src/domain/loans');
const SV = require('../src/domain/savings');
const acct = require('../src/domain/accounting');
const ORG = require('../src/domain/organization');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'orgsetup';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4104;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
const Rd = (fn) => withTenantRead(SCHEMA, fn);
const S = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

let server;
let token;
async function call(method, p, body, { auth = token, raw = false } = {}) {
  const headers = { 'x-tenant': SLUG };
  if (auth) headers.authorization = `Bearer ${auth}`;
  let payload;
  if (body) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  if (raw) return r;
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text, headers: r.headers, reason: d?.errors?.[0]?.errorReason || d?.error || '' };
}
const GL = { glPortfolio: '100-100', glInterestInc: '400-100', glFeeInc: '400-200', glInterestRec: '100-300', glPenaltyInc: '400-200' };
const BASE = { ...GL, accountingMethod: 'ACCRUAL', interestAccruedAccounting: 'DAILY', enforceDepositMultiplier: false, maxTerm: 36,
  monthlyRate: 1, productType: 'FIXED_TERM', method: 'REDUCING', nonWorkingDays: 'MOVE_FORWARD' };
const mk = (id, body = {}) => call('POST', '/api/loan-products', { id, name: id, ...BASE, ...body });
const sched = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY number', [id])).rows);
const loanRow = (id) => Rd(async (c) => (await c.query('SELECT * FROM loan_accounts WHERE id = $1', [id])).rows[0]);
let seq = 0;
const member = ({ branchId = null, centreId = null } = {}) => T(async (c) => {
  seq += 1;
  const { rows: [m] } = await c.query(
    `INSERT INTO members (member_no, first_name, last_name, branch_id, centre_id) VALUES ($1,'Ann',$1,$2,$3) RETURNING *`,
    [`O${String(seq).padStart(4, '0')}`, branchId, centreId]);
  return m;
});
const apply = (memberId, productId, principal, term, extra = {}) =>
  T((c) => L.apply(c, { memberId, productId, principal, termMonths: term, createdBy: 'officer', ...extra }));
const disbursed = async (memberId, productId, principal, term, on, extra = {}) => {
  const l = await apply(memberId, productId, principal, term, extra);
  await T((c) => L.changeState(c, l.id, 'APPROVE', { createdBy: 'manager' }));
  await T((c) => L.disburse(c, l.id, { amount: principal, channelId: 'bank', valueDate: on, createdBy: 'teller' }));
  return l;
};
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Org SACCO', mfaRequiredRoles: [], adminEmail: 'admin@orgsetup.local', adminPassword: PASSWORD });
    await migrateAllTenants({});
    const login = await call('POST', '/api/auth/login', { email: 'admin@orgsetup.local', password: PASSWORD }, { auth: null });
    token = login.body.accessToken;
    const { rows: [admin] } = await pool.query("SELECT id FROM platform.users WHERE email = 'admin@orgsetup.local'");
    // A real staff user of the role: the role a request carries is read from the database, not the token.
    const staff = async (email, role) => (await pool.query(
      `INSERT INTO platform.users (tenant_id, email, password_hash, full_name, role)
       SELECT id, $2, 'x', $3, $4 FROM platform.tenants WHERE slug = $1 RETURNING id`, [SLUG, email, role.toLowerCase(), role])).rows[0].id;
    const manager = signToken({ sub: await staff('manager@orgsetup.local', 'MANAGER'), email: 'manager@orgsetup.local', role: 'MANAGER', tid: SLUG, name: 'Manager' });
    const teller = signToken({ sub: await staff('teller@orgsetup.local', 'TELLER'), email: 'teller@orgsetup.local', role: 'TELLER', tid: SLUG, name: 'Teller' });
    void admin;
    const made = await Promise.all([mk('FX'), mk('FXN', { nonWorkingDays: 'DO_NOT_RESCHEDULE' }), mk('OTHER')]);
    check('products', made.every((r) => r.status === 201), made.map((r) => `${r.status} ${r.reason}`).join('|'));

    // ----------------------------------------------------------------------
    section('organization details');
    let r = await call('GET', '/api/organization');
    check('the organization has its name, base currency and time zone', r.status === 200 && r.body.institutionName === 'Org SACCO'
      && r.body.currency === 'KES' && r.body.timeZone === 'Africa/Nairobi' && r.body.localDateFormat === 'dd-MM-yyyy', JSON.stringify(r.body).slice(0, 200));
    r = await call('PUT', '/api/organization', {
      institutionName: 'Org SACCO Ltd', timeZone: 'Africa/Kampala', localDateFormat: 'dd/MM/yyyy', decimalMark: ',',
      contact: { streetAddress: 'Moi Avenue 1', city: 'Nairobi', country: 'Kenya', phone: '+254700000000', email: 'info@org.co.ke' },
    });
    check('a tenant admin changes the name, time zone, formats, decimal mark and contact details', r.status === 200
      && r.body.institutionName === 'Org SACCO Ltd' && r.body.timeZone === 'Africa/Kampala' && r.body.decimalMark === ','
      && r.body.contact.city === 'Nairobi', `${r.status} ${r.reason}`);
    check('the tenant record changes with it', (await pool.query('SELECT name, timezone FROM platform.tenants WHERE slug = $1', [SLUG])).rows[0].name === 'Org SACCO Ltd');
    check('an unknown time zone is refused', (await call('PUT', '/api/organization', { timeZone: 'Mars/Olympus' })).status === 400);
    check('so is a date format without a day or year', (await call('PUT', '/api/organization', { localDateFormat: 'MM' })).status === 400);
    check('only a tenant admin may change it', (await call('PUT', '/api/organization', { institutionName: 'X' }, { auth: manager })).status === 403);
    r = await call('GET', '/api/currencies');
    check('the base currency is in the register with its ISO name', r.status === 200 && r.body[0].code === 'KES' && r.body[0].is_base && r.body[0].name === 'Kenyan Shilling',
      JSON.stringify(r.body[0]));
    await call('POST', '/api/currencies', { code: 'UGX' });
    r = await call('PUT', '/api/organization', { currency: 'UGX' });
    check('the base currency can change while nothing is posted', r.status === 200 && r.body.currency === 'UGX'
      && Number((await Rd((c) => c.query('SELECT currency_decimals FROM accounting_settings'))).rows[0].currency_decimals) === 0, `${r.status} ${r.reason}`);
    await call('PUT', '/api/organization', { currency: 'KES' });

    section('branding');
    r = await call('PUT', '/api/organization/branding/logo', { data: PNG, type: 'image/png' });
    check('a logo is uploaded', r.status === 200 && r.body.bytes > 0, `${r.status} ${r.reason}`);
    const img = await call('GET', '/api/organization/branding/logo', null, { auth: null, raw: true });
    check('and shown on the login screen without signing in', img.status === 200 && img.headers.get('content-type') === 'image/png');
    check('an SVG is refused (it can carry script)', (await call('PUT', '/api/organization/branding/icon', { data: PNG, type: 'image/svg+xml' })).status === 415);
    check('a missing icon is a 404', (await call('GET', '/api/organization/branding/icon', null, { auth: null, raw: true })).status === 404);

    // ----------------------------------------------------------------------
    section('branches and centres');
    r = await call('POST', '/api/branches', { code: 'NBI', name: 'Nairobi', address: 'Moi Avenue', email: 'nbi@org.co.ke', notes: 'Head office' });
    const nbi = r.body;
    check('a branch takes address, email and notes', r.status === 201 && nbi.address === 'Moi Avenue' && nbi.email === 'nbi@org.co.ke', `${r.status} ${r.reason}`);
    const msa = (await call('POST', '/api/branches', { code: 'MSA', name: 'Mombasa' })).body;
    check('a bad email is refused', (await call('POST', '/api/branches', { code: 'KSM', name: 'Kisumu', email: 'nope' })).status === 400);
    r = await call('POST', '/api/centres', { code: 'NBI-C1', name: 'Kibera', branchId: 'NBI', meetingDay: 3 });
    const centre = r.body;
    check('a centre belongs to a branch and has a weekly meeting day', r.status === 201 && centre.branch_id === nbi.id && centre.meeting_day === 3, `${r.status} ${r.reason}`);
    r = await call('PATCH', '/api/branches/NBI', { status: 'CLOSED' });
    check('a branch with active centres cannot be deactivated', r.status === 409 && /ACTIVE_CENTRES/.test(r.reason), `${r.status} ${r.reason}`);
    await call('PATCH', '/api/centres/NBI-C1', { status: 'INACTIVE' });
    r = await call('PATCH', '/api/branches/NBI', { status: 'CLOSED' });
    check('once they are deactivated it can', r.status === 200 && r.body.status === 'CLOSED');
    check('a centre cannot be reactivated in a deactivated branch', (await call('PATCH', '/api/centres/NBI-C1', { status: 'ACTIVE' })).status === 409);
    await call('PATCH', '/api/branches/NBI', { status: 'ACTIVE' });
    await call('PATCH', '/api/centres/NBI-C1', { status: 'ACTIVE' });
    r = await call('GET', '/api/branches/NBI');
    check('the branch view shows its centres and its activity', r.status === 200 && r.body.centres.length === 1 && r.body.activity.length >= 3, `${r.status}`);
    r = await call('POST', '/api/members', { firstName: 'Zawadi', lastName: 'M', centreId: 'NBI-C1' });
    check('a member put in a centre is in the centre\'s branch', r.status === 201 && r.body.centre_id === centre.id && r.body.branch_id === nbi.id, `${r.status} ${r.reason}`);
    r = await call('POST', '/api/members', { firstName: 'Y', lastName: 'M', branchId: 'MSA', centreId: 'NBI-C1' });
    check('a centre in another branch is refused', r.status === 409 && /ANOTHER_BRANCH/.test(r.reason), `${r.status} ${r.reason}`);

    section('the weekly meeting day moves the first repayment');
    const mc = await member({ branchId: nbi.id, centreId: centre.id });
    // Disbursed Thursday 1 January: the schedule's first date, Sunday 1 February, moves to Wednesday 4 February.
    const ml = await disbursed(mc.id, 'FXN', 3000, 3, '2026-01-01');
    let s = await sched(ml.id);
    check('to the next meeting day', S(s[0].due_date) === '2026-02-04' && S((await loanRow(ml.id)).first_repayment_date) === '2026-02-04',
      s.map((i) => S(i.due_date)).join());

    section('product availability per branch');
    r = await call('PATCH', '/api/loan-products/OTHER', { availableBranches: ['MSA'] });
    check('a loan product is limited to branches', r.status === 200 && r.body.availableBranches.length === 1 && r.body.availableBranches[0] === msa.id, `${r.status} ${r.reason}`);
    const mn = await member({ branchId: nbi.id });
    const mm = await member({ branchId: msa.id });
    let threw = null;
    try { await apply(mn.id, 'OTHER', 1000, 3); } catch (e) { threw = e; }
    check('a member of another branch cannot take it', threw && /NOT_AVAILABLE_IN_THIS_BRANCH/.test(threw.message), threw?.message);
    check('a member of the branch can', Boolean(await apply(mm.id, 'OTHER', 1000, 3)));
    await call('PATCH', '/api/deposit-products/SAV01', { availableBranches: ['MSA'] });
    threw = null;
    try { await T((c) => SV.open(c, { memberId: mn.id, productId: 'SAV01' })); } catch (e) { threw = e; }
    check('the same for deposit products', threw && /NOT_AVAILABLE_IN_THIS_BRANCH/.test(threw.message), threw?.message);
    await call('PATCH', '/api/deposit-products/SAV01', { availableBranches: null });

    // ----------------------------------------------------------------------
    section('holidays and non-working days');
    r = await call('POST', '/api/holidays', { date: '2025-03-02', description: 'Recurring day off', recurring: true, id: 'REC1' });
    check('a recurring holiday', r.status === 201 && r.body.recurring && r.body.scope === 'GENERAL', `${r.status} ${r.reason}`);
    r = await call('POST', '/api/holidays', { date: '2026-04-02', description: 'Nairobi day', branchId: 'NBI' });
    check('a branch holiday', r.status === 201 && r.body.scope === 'BRANCH', `${r.status} ${r.reason}`);
    check('the same date twice in one scope is refused', (await call('POST', '/api/holidays', { date: '2026-04-02', description: 'x', branchId: 'NBI' })).status === 409);
    check('a holiday for a currency not set up is refused', (await call('POST', '/api/holidays', { date: '2026-04-03', description: 'x', currencyCode: 'USD' })).status === 404);
    const hn = await member({ branchId: nbi.id });
    const hm = await member({ branchId: msa.id });
    const la = await disbursed(hn.id, 'FX', 3000, 3, '2026-01-02');
    const lb = await disbursed(hm.id, 'FX', 3000, 3, '2026-01-02');
    const sa = await sched(la.id);
    const sb = await sched(lb.id);
    check('a recurring holiday moves a due date in any year', S(sa[1].due_date) === '2026-03-03' && S(sb[1].due_date) === '2026-03-03', `${S(sa[1].due_date)} ${S(sb[1].due_date)}`);
    check('a branch holiday moves only that branch\'s loans', S(sa[2].due_date) === '2026-04-03' && S(sb[2].due_date) === '2026-04-02', `${S(sa[2].due_date)} ${S(sb[2].due_date)}`);
    r = await call('PUT', '/api/holidays/non-working-days', { days: [0] });
    check('non-working days are set for the organization', r.status === 200 && r.body.nonWorkingDays.join() === '0');
    const sat = await disbursed(hm.id, 'FX', 3000, 3, '2026-01-31');   // due Saturday 28 February
    check('and a Saturday is then a working day', S((await sched(sat.id))[0].due_date) === '2026-02-28', S((await sched(sat.id))[0].due_date));
    check('every day off is refused', (await call('PUT', '/api/holidays/non-working-days', { days: [0, 1, 2, 3, 4, 5, 6] })).status === 400);
    await call('PUT', '/api/holidays/non-working-days', { days: [0, 6] });

    section('the calendar sync re-dates open loans');
    const fut = await disbursed(hm.id, 'FX', 3000, 6, '2026-09-01');
    const before = (await sched(fut.id)).map((i) => S(i.due_date));
    await call('POST', '/api/holidays/sync', {});
    r = await call('POST', '/api/holidays', { date: '2026-12-01', description: 'Jamhuri eve' });
    const pending = (await call('GET', '/api/holidays')).body.pendingSyncFrom;
    r = await call('POST', '/api/holidays/sync', {});
    let after = (await sched(fut.id)).map((i) => S(i.due_date));
    check('a new holiday marks the calendar changed until the sync', pending === '2026-12-01', pending);
    check('the sync moves the unpaid installment that falls on it', r.status === 200 && r.body.installments >= 1 && after[2] === '2026-12-02' && before[2] === '2026-12-01',
      `${before.join()} -> ${after.join()} ${JSON.stringify(r.body)}`);
    const h = (await call('GET', '/api/holidays')).body.general.find((x) => x.description === 'Jamhuri eve');
    await call('DELETE', `/api/holidays/${h.key}`);
    await call('POST', '/api/holidays/sync', {});
    after = (await sched(fut.id)).map((i) => S(i.due_date));
    check('and moves it back when the holiday goes', after[2] === '2026-12-01', after.join());
    check('the sync is recorded', (await Rd((c) => c.query("SELECT 1 FROM audit_log WHERE action = 'HOLIDAY_SYNC_COMPLETED'"))).rowCount >= 2);

    // ----------------------------------------------------------------------
    section('transaction channels');
    r = await call('POST', '/api/transaction-channels', { id: 'agent', name: 'Agent banking', channelType: 'MOBILE', glAccount: '100-220',
      loanConstraints: { match: 'ALL', filters: [{ type: 'AMOUNT', max: 1000 }, { type: 'TYPE', values: ['REPAYMENT'] }] } });
    check('a channel is created with loan constraints', r.status === 201 && r.body.loan_constraints.filters.length === 2, `${r.status} ${r.reason}`);
    const cm = await member({ branchId: msa.id });
    const cl = await disbursed(cm.id, 'FX', 3000, 3, '2026-01-02');
    r = await call('POST', `/api/loans/${cl.id}/repayments`, { amount: 1500, channelId: 'agent', valueDate: '2026-01-10' });
    check('a repayment the constraints do not allow is refused', r.status === 409 && /CHANNEL_CONSTRAINTS_REFUSE/.test(r.reason), `${r.status} ${r.reason}`);
    r = await call('POST', `/api/loans/${cl.id}/repayments`, { amount: 500, channelId: 'agent', valueDate: '2026-01-10' });
    check('one they allow goes through', r.status === 201, `${r.status} ${r.reason}`);
    await call('PATCH', '/api/transaction-channels/agent', { usageRoles: ['MANAGER'] });
    r = await call('POST', `/api/loans/${cl.id}/repayments`, { amount: 100, channelId: 'agent', valueDate: '2026-01-11' });
    check('usage rights limit the channel to roles', r.status === 403 && /YOUR_ROLE/.test(r.reason), `${r.status} ${r.reason}`);
    r = await call('POST', `/api/loans/${cl.id}/repayments`, { amount: 100, channelId: 'agent', valueDate: '2026-01-11' }, { auth: manager });
    check('a role with the right posts', r.status === 201, `${r.status} ${r.reason}`);
    r = await call('GET', '/api/transaction-channels?usable=true');
    check('the channels a user may use leave out the others', r.status === 200 && !r.body.some((x) => x.id === 'agent'));
    check('the default channel cannot be deactivated', (await call('PATCH', '/api/transaction-channels/cash', { isActive: false })).status === 409);
    check('nor deleted', (await call('DELETE', '/api/transaction-channels/cash')).status === 409);
    check('a channel that has been used cannot be deleted', (await call('DELETE', '/api/transaction-channels/agent')).status === 409);
    await call('POST', '/api/transaction-channels', { id: 'spare', name: 'Spare', glAccount: '100-210' });
    check('an unused one can', (await call('DELETE', '/api/transaction-channels/spare')).status === 200);
    r = await call('PUT', '/api/transaction-channels/order', { order: ['mpesa', 'cash'] });
    check('the order is set', r.status === 200 && r.body[0].id === 'mpesa' && r.body[1].id === 'cash', `${r.status} ${r.reason} ${JSON.stringify((r.body || []).map((x) => [x.id, x.sort_order]))}`);

    // ----------------------------------------------------------------------
    section('ID templates');
    r = await call('POST', '/api/id-templates', { id: 'NID', idType: 'National ID', issuingAuthority: 'Registrar of Persons', mask: '########', mandatory: true });
    check('a template with an input mask', r.status === 201 && r.body.mask === '########', `${r.status} ${r.reason}`);
    await call('POST', '/api/id-templates', { id: 'PP', idType: 'Passport', issuingAuthority: 'Immigration', mask: '@#######', allowAttachments: true });
    r = await call('POST', '/api/members', { firstName: 'A', lastName: 'B' });
    check('a member cannot be created without a mandatory document', r.status === 400 && /MANDATORY_ID_DOCUMENTS_MISSING/.test(r.reason), `${r.status} ${r.reason}`);
    r = await call('POST', '/api/members', { firstName: 'A', lastName: 'B', identificationDocuments: [{ templateId: 'NID', documentId: '1234' }] });
    check('a document number must fit the template', r.status === 400 && /DOES_NOT_MATCH/.test(r.reason), `${r.status} ${r.reason}`);
    r = await call('POST', '/api/members', { firstName: 'A', lastName: 'B', identificationDocuments: [{ templateId: 'NID', documentId: '12345678' }] });
    const idm = r.body;
    check('with it the member is created', r.status === 201, `${r.status} ${r.reason}`);
    r = await call('POST', `/api/members/${idm.id}/identifications`, { templateId: 'PP', documentId: 'A1234567',
      attachment: { name: 'scan.png', type: 'image/png', data: PNG } });
    check('a document with an attachment where the template allows it', r.status === 201 && r.body.hasAttachment, `${r.status} ${r.reason}`);
    const att = await call('GET', `/api/members/${idm.id}/identifications/${r.body.id}/attachment`, null, { raw: true });
    check('and the attachment can be downloaded', att.status === 200 && att.headers.get('content-type') === 'image/png');
    check('an attachment on a template that does not take one is refused',
      (await call('POST', `/api/members/${idm.id}/identifications`, { templateId: 'NID', documentId: '87654321', attachment: { name: 'x.png', type: 'image/png', data: PNG } })).status === 400);
    check('an Other document needs the organization to allow it',
      (await call('POST', `/api/members/${idm.id}/identifications`, { templateId: 'OTHER', idType: 'Alien card', documentId: 'X1' })).status === 400);
    await call('PUT', '/api/id-templates/other', { allow: true });
    check('then it is taken', (await call('POST', `/api/members/${idm.id}/identifications`, { templateId: 'OTHER', idType: 'Alien card', documentId: 'X1' })).status === 201);
    check('a template in use cannot be deleted', (await call('DELETE', '/api/id-templates/NID')).status === 409);
    const nidDoc = (await call('GET', `/api/members/${idm.id}/identifications`)).body.find((d) => d.template_id === 'NID');
    check('nor the last document of a mandatory template', (await call('DELETE', `/api/members/${idm.id}/identifications/${nidDoc.id}`)).status === 409);
    await call('PATCH', '/api/id-templates/NID', { mandatory: false });

    // ----------------------------------------------------------------------
    section('tax rate sources');
    r = await call('POST', '/api/index-rates', { id: 'VAT16', name: 'VAT', kind: 'VAT' });
    check('a VAT rate source', r.status === 201 && r.body.kind === 'VAT', `${r.status} ${r.reason}`);
    await call('POST', '/api/index-rates/VAT16/rates', { validFrom: '2026-01-01', rate: 16 });
    r = await call('POST', '/api/loan-products', { id: 'TAXED', name: 'Taxed', ...BASE, taxSourceId: 'VAT16', taxOnInterest: true, glTaxPayable: '200-300' });
    check('a loan product takes its rate from the source', r.status === 201 && r.body.taxSourceId === 'VAT16'
      && Number((await Rd((c) => c.query("SELECT tax_rate_percent FROM loan_products WHERE id = 'TAXED'"))).rows[0]?.tax_rate_percent) === 16, `${r.status} ${r.text.slice(0, 300)}`);
    check('an interest index is not a VAT source', (await call('PATCH', '/api/loan-products/FX', { taxSourceId: 'NOPE' })).status >= 400);
    const today = orgDay(0);
    await call('POST', '/api/index-rates/VAT16/rates', { validFrom: today, rate: 18 });
    check('a new value in force reaches the product at once', Number((await Rd((c) => c.query("SELECT tax_rate_percent FROM loan_products WHERE id = 'TAXED'"))).rows[0].tax_rate_percent) === 18);
    r = await call('PATCH', '/api/index-rates/VAT16/rates/2026-01-01', { rate: 10 });
    check('a past value a product uses cannot be edited', r.status === 409 && /RATE_VALUE_IN_USE/.test(r.reason), `${r.status} ${r.reason}`);
    check('nor the source deleted', (await call('DELETE', '/api/index-rates/VAT16')).status === 409);
    await call('POST', '/api/index-rates', { id: 'WHT15', name: 'Withholding', kind: 'WITHHOLDING' });
    await call('POST', '/api/index-rates/WHT15/rates', { validFrom: '2026-01-01', rate: 15 });
    r = await call('PATCH', '/api/deposit-products/SAV01', { withholdingSourceId: 'WHT15' });
    check('a deposit product takes withholding tax from a source', r.status === 200 && r.body.interest.withholdingTaxPercent === 15, `${r.status} ${r.reason}`);
    await call('POST', '/api/index-rates/WHT15/rates', { validFrom: '2099-01-01', rate: 20 });
    r = await call('POST', '/api/index-rates/tax-update', { date: '2099-01-02' });
    check('the end of day\'s tax rate update applies the value for its date', r.status === 200 && r.body.depositProducts.some((p) => Number(p.withholding_tax_percent) === 20));
    await call('POST', '/api/index-rates/tax-update', {});

    // ----------------------------------------------------------------------
    section('currencies');
    r = await call('GET', '/api/currencies/presets');
    check('the ISO 4217 list is offered', r.status === 200 && r.body.some((x) => x.code === 'USD' && x.decimals === 2));
    r = await call('POST', '/api/currencies', { code: 'USD', symbolPosition: 'BEFORE' });
    check('a fiat currency is added from it', r.status === 201 && r.body.name === 'US Dollar' && r.body.decimals === 2, `${r.status} ${r.reason}`);
    check('not a made-up one', (await call('POST', '/api/currencies', { code: 'ABC' })).status === 400);
    check('its decimal digits cannot change', (await call('PATCH', '/api/currencies/USD', { decimals: 3 })).status === 409);
    r = await call('POST', '/api/currencies/USD/exchange-rates', { buyRate: 128.5, sellRate: 130.1, startDate: '2026-06-01T00:00:00Z' });
    check('an exchange rate, buy and sell, from a date', r.status === 201 && Number(r.body.sell_rate) === 130.1, `${r.status} ${r.reason}`);
    r = await call('POST', '/api/currencies/USD/exchange-rates', { buyRate: 127, sellRate: 129, startDate: '2026-05-01T00:00:00Z' });
    check('not dated before the latest rate', r.status === 409, `${r.status} ${r.reason}`);
    r = await call('POST', '/api/currencies/USD/accounting-rates', { rate: 129.3 });
    check('an accounting rate', r.status === 201);
    check('the base currency has no exchange rate', (await call('POST', '/api/currencies/KES/exchange-rates', { buyRate: 1, sellRate: 1 })).status === 409);
    check('the base currency cannot be deleted', (await call('DELETE', '/api/currencies/KES')).status === 409);
    r = await call('PUT', '/api/organization', { currency: 'USD' });
    check('and cannot change once anything is posted', r.status === 409 && /ONCE_ANYTHING_IS_POSTED/.test(r.reason), `${r.status} ${r.reason}`);
    check('another currency can be deleted', (await call('DELETE', '/api/currencies/UGX')).status === 200);

    // ----------------------------------------------------------------------
    section('end-of-day settings');
    r = await call('GET', '/api/organization/eod');
    check('automatic by default, no cutoff, retrying loans left out', r.status === 200 && r.body.mode === 'AUTOMATIC' && r.body.accountingCutoff === null && r.body.retryExcluded);
    check('Run Now is for manual end of day', (await call('POST', '/api/organization/eod/run', {})).status === 409);
    r = await call('PUT', '/api/organization/eod', { mode: 'MANUAL', accountingCutoff: '00:00' });
    check('the mode and the accounting cutoff are set', r.status === 200 && r.body.mode === 'MANUAL' && r.body.accountingCutoff === '00:00', `${r.status} ${r.reason}`);
    const localToday = ORG.localClock('Africa/Kampala').date;
    const tomorrow = new Date(Date.parse(`${localToday}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const e1 = await T((c) => acct.post(c, { debits: [{ glCode: '100-200', amount: 1 }], credits: [{ glCode: '100-210', amount: 1 }], narration: 'cutoff test', sourceType: 'MANUAL', createdBy: 'test' }));
    const bd = (await Rd((c) => c.query('SELECT booking_date FROM journal_entries WHERE id = $1', [e1.entryId]))).rows[0].booking_date;
    check('a posting after the cutoff is booked on the next day', S(bd) === tomorrow, `${S(bd)} ${tomorrow}`);
    await call('PUT', '/api/organization/eod', { accountingCutoff: null });
    check('the cutoff is HH:MM', (await call('PUT', '/api/organization/eod', { accountingCutoff: '25:00' })).status === 400);
    r = await call('POST', '/api/organization/eod/run', { businessDate: '2026-01-15' });
    check('Run Now runs the end of day and records its completion', r.status === 201 && r.body.completion && ['COMPLETE', 'FAILED'].includes(r.body.completion.state)
      && r.body.jobs.some((j) => j.job === 'syncCalendar'), `${r.status} ${r.reason} ${JSON.stringify(r.body?.completion)}`);
    check('not for a date to come', (await call('POST', '/api/organization/eod/run', { businessDate: '2099-01-01' })).status === 400);
    check('the completions are listed', (await call('GET', '/api/organization/eod')).body.completions.length >= 1);
    const xl = await disbursed(cm.id, 'FX', 3000, 3, '2026-01-02');
    await T((c) => c.query("INSERT INTO loan_eod_exclusions (loan_id, job, business_date, error) VALUES ($1, 'accrueInterest', '2026-01-15', 'test')", [xl.id]));
    r = await call('POST', '/api/organization/eod/retry-excluded', {});
    check('loans left out are tried again, and one that now runs comes back', r.status === 200 && r.body.included.length === 1, `${r.status} ${JSON.stringify(r.body)}`);
    await call('PUT', '/api/organization/eod', { mode: 'AUTOMATIC' });

    // ----------------------------------------------------------------------
    section('custom fields');
    r = await call('POST', '/api/custom-fields/sets', { entity: 'MEMBER', name: 'Profile', id: 'profile' });
    check('a set for members, its ID starting with an underscore', r.status === 201 && r.body.id === '_profile', `${r.status} ${r.reason}`);
    await call('POST', '/api/custom-fields/sets', { entity: 'MEMBER', name: 'Bank accounts', id: '_banks', type: 'GROUPED' });
    const defs = await Promise.all([
      call('POST', '/api/custom-fields/definitions', { entity: 'MEMBER', setId: '_profile', id: 'occupation', name: 'Occupation', type: 'FREE_TEXT', usage: { required: true } }),
      call('POST', '/api/custom-fields/definitions', { entity: 'MEMBER', setId: '_profile', id: 'altPhone', name: 'Other phone', type: 'FREE_TEXT', format: '+254#########', uniqueValue: true }),
      call('POST', '/api/custom-fields/definitions', { entity: 'MEMBER', setId: '_banks', id: 'bankName', name: 'Bank', type: 'FREE_TEXT' }),
    ]);
    check('definitions of several kinds', defs.every((x) => x.status === 201), defs.map((x) => `${x.status} ${x.reason}`).join('|'));
    r = await call('POST', '/api/custom-fields/definitions', { entity: 'MEMBER', setId: '_profile', id: 'county', name: 'County', type: 'SELECTION',
      options: [{ id: 'NBI', label: 'Nairobi', score: 2 }, { id: 'MSA', label: 'Mombasa', score: 1 }] });
    check('a selection field with scored options', r.status === 201, `${r.status} ${r.reason}`);
    r = await call('POST', '/api/custom-fields/definitions', { entity: 'MEMBER', setId: '_profile', id: 'ward', name: 'Ward', type: 'SELECTION', dependentOn: 'county',
      options: [{ id: 'KIB', label: 'Kibera', parent: 'NBI', score: 3 }, { id: 'NYA', label: 'Nyali', parent: 'MSA' }] });
    check('and one that depends on it', r.status === 201 && r.body.dependent_on === 'county', `${r.status} ${r.reason}`);
    r = await call('POST', '/api/members', { firstName: 'C', lastName: 'F' });
    check('a required field must be given when a member is created', r.status === 400 && /CUSTOM_FIELD_REQUIRED/.test(r.reason), `${r.status} ${r.reason}`);
    r = await call('POST', '/api/members', { firstName: 'C', lastName: 'F', customFields: { _profile: { occupation: 'Teacher', county: 'NBI', ward: 'NYA' } } });
    check('a dependent option must belong to the parent\'s value', r.status === 400 && /INVALID_CUSTOM_FIELD_VALUE/.test(r.reason), `${r.status} ${r.reason}`);
    r = await call('POST', '/api/members', { firstName: 'C', lastName: 'F', customFields: {
      _profile: { occupation: 'Teacher', altPhone: '+254711000111', county: 'Nairobi', ward: 'KIB' }, _banks: [{ bankName: 'KCB' }, { bankName: 'Equity' }] } });
    const cfm = r.body;
    check('with valid values the member is created', r.status === 201, `${r.status} ${r.text}`);
    r = await call('GET', `/api/members/${cfm.id}`);
    check('the values come back in the reference platform\'s shape, labels stored as option IDs, with the set\'s score', r.body.customFields._profile.county === 'NBI'
      && r.body.customFields._banks.length === 2 && r.body.customFieldScores._profile === 5, JSON.stringify(r.body.customFields) + JSON.stringify(r.body.customFieldScores));
    r = await call('POST', '/api/members', { firstName: 'D', lastName: 'F', customFields: { _profile: { occupation: 'Nurse', altPhone: '+254711000111' } } });
    check('a unique value cannot be used twice', r.status === 409 && /DUPLICATE_UNIQUE_VALUE/.test(r.reason), `${r.status} ${r.reason}`);
    check('a value must fit the format', (await call('POST', '/api/members', { firstName: 'D', lastName: 'F', customFields: { _profile: { occupation: 'N', altPhone: '0711' } } })).status === 400);

    await call('POST', '/api/custom-fields/sets', { entity: 'LOAN_ACCOUNT', name: 'Appraisal', id: '_appraisal' });
    r = await call('POST', '/api/custom-fields/definitions', { entity: 'LOAN_ACCOUNT', setId: '_appraisal', id: 'visited', name: 'Business visited', type: 'CHECKBOX',
      availableForAll: false, usage: { items: { FX: { required: true } } } });
    check('a loan field required for one product only', r.status === 201 && r.body.usage.items.FX.required === true && !r.body.usage.items.OTHER, `${r.status} ${r.reason}`);
    const fm = await member({ branchId: msa.id });
    r = await call('POST', '/api/loans', { memberId: fm.id, productId: 'FX', principal: 1000, termMonths: 3 });
    check('an application for that product needs it', r.status === 400 && /CUSTOM_FIELD_REQUIRED/.test(r.reason), `${r.status} ${r.reason}`);
    r = await call('POST', '/api/loans', { memberId: fm.id, productId: 'OTHER', principal: 1000, termMonths: 3, customFields: { _appraisal: { visited: true } } });
    check('another product does not take it', r.status === 400 && /NOT_AVAILABLE/.test(r.reason), `${r.status} ${r.reason}`);
    r = await call('POST', '/api/loans', { memberId: fm.id, productId: 'FX', principal: 1000, termMonths: 3, customFields: { _appraisal: { visited: true } } });
    const cfl = r.body;
    check('with it the application is made', r.status === 201 && cfl.custom_fields._appraisal.visited === true, `${r.status} ${r.reason}`);
    await call('POST', `/api/loans/${cfl.id}/reject`, { note: 'no' });
    r = await call('PATCH', `/api/loans/${cfl.id}`, { customFields: { _appraisal: { visited: false } } });
    check('values can be changed on a closed loan', r.status === 200 && (await loanRow(cfl.id)).custom_fields._appraisal.visited === false, `${r.status} ${r.reason}`);

    await call('PATCH', '/api/custom-fields/definitions/occupation', { editRoles: ['MANAGER'] });
    r = await call('PUT', `/api/custom-fields/values/MEMBER/${cfm.id}`, { _profile: { occupation: 'Farmer' } });
    check('a role without edit rights cannot change a value', r.status === 403 && /NOT_EDITABLE_BY_YOUR_ROLE/.test(r.reason), `${r.status} ${r.reason}`);
    r = await call('PUT', `/api/custom-fields/values/MEMBER/${cfm.id}`, { _profile: { occupation: 'Farmer' } }, { auth: manager });
    check('a role with them can', r.status === 200 && r.body.values._profile.occupation === 'Farmer', `${r.status} ${r.reason}`);
    r = await call('POST', '/api/members', { firstName: 'E', lastName: 'F' });
    check('and a user who may not enter a required field can save without it (the reference platform)', r.status === 201, `${r.status} ${r.reason}`);
    await call('PATCH', '/api/custom-fields/definitions/altPhone', { viewRoles: ['MANAGER'], editRoles: ['MANAGER'] });
    r = await call('GET', `/api/members/${cfm.id}`, null, { auth: teller });
    check('a field a role may not view is left out for it', r.status === 200 && r.body.customFields._profile.altPhone === undefined && r.body.customFields._profile.county === 'NBI',
      JSON.stringify(r.body.customFields));
    await call('PATCH', '/api/custom-fields/definitions/county', { isActive: false });
    r = await call('PUT', `/api/custom-fields/values/MEMBER/${cfm.id}`, { _profile: { county: 'MSA', ward: 'NYA' } }, { auth: manager });
    check('a deactivated field takes no new value', r.status === 409 && /DEACTIVATED/.test(r.reason), `${r.status} ${r.reason}`);
    check('a field with values cannot be deleted', (await call('DELETE', '/api/custom-fields/definitions/bankName')).status === 409);
    await call('POST', '/api/custom-fields/definitions', { entity: 'MEMBER', setId: '_profile', id: 'unused', name: 'Unused', type: 'NUMBER' });
    check('an unused one can', (await call('DELETE', '/api/custom-fields/definitions/unused')).status === 200);
    await call('POST', '/api/custom-fields/definitions', { entity: 'USER', setId: (await call('POST', '/api/custom-fields/sets', { entity: 'USER', name: 'Staff', id: '_staff' })).body.id,
      id: 'staffNo', name: 'Staff number', type: 'FREE_TEXT' });
    r = await call('PUT', `/api/custom-fields/values/USER/${admin.id}`, { _staff: { staffNo: 'S-001' } });
    check('users have custom fields too', r.status === 200 && r.body.values._staff.staffNo === 'S-001', `${r.status} ${r.reason}`);
    check('which only a tenant admin sets', (await call('PUT', `/api/custom-fields/values/USER/${admin.id}`, { _staff: { staffNo: 'S-002' } }, { auth: manager })).status === 403);
    await call('POST', '/api/custom-fields/sets', { entity: 'TRANSACTION_CHANNEL', name: 'Receipt', id: '_receipt' });
    await call('POST', '/api/custom-fields/definitions', { entity: 'TRANSACTION_CHANNEL', setId: '_receipt', id: 'receiptNo', name: 'Receipt number', type: 'FREE_TEXT',
      availableForAll: false, usage: { items: { cash: { required: true } } } });
    r = await call('POST', `/api/loans/${cl.id}/repayments`, { amount: 50, channelId: 'cash', valueDate: '2026-01-12' });
    check('a transaction through a channel with a required field needs it', r.status === 400 && /CUSTOM_FIELD_REQUIRED/.test(r.reason), `${r.status} ${r.reason}`);
    r = await call('POST', `/api/loans/${cl.id}/repayments`, { amount: 50, channelId: 'cash', valueDate: '2026-01-12', customFields: { _receipt: { receiptNo: 'R-77' } } });
    check('and keeps it on the transaction', r.status === 201 && r.body.custom_fields._receipt.receiptNo === 'R-77', `${r.status} ${r.reason}`);
    r = await call('POST', `/api/loans/${cl.id}/repayments`, { amount: 50, channelId: 'mpesa', valueDate: '2026-01-12' });
    check('another channel does not ask for it', r.status === 201, `${r.status} ${r.reason}`);
    const receipt = (await Rd((c) => c.query("SELECT reference FROM transactions WHERE custom_fields @> '{\"_receipt\": {\"receiptNo\": \"R-77\"}}'"))).rows[0];

    // ----------------------------------------------------------------------
    section('product documents');
    r = await call('POST', '/api/documents/templates/loan/FX', { name: 'Statement', availability: 'ACCOUNT', content:
      '<h1>{{organization.name}}</h1><p>{{member.fullName}} {{account.accountNo}} owes {{account.totalBalance}}</p>'
      + '<div class="page-break"></div><table>{{#statement}}<tr><td>{{line.date}}</td><td>{{line.type}}</td><td>{{line.amount}}</td></tr>{{/statement}}</table>'
      + '<ol>{{#schedule}}<li>{{line.dueDate}} {{line.total}}</li>{{/schedule}}</ol>' });
    const stmt = r.body;
    check('an account template for a product', r.status === 201 && stmt.availability === 'ACCOUNT', `${r.status} ${r.reason}`);
    check('names are unique per product', (await call('POST', '/api/documents/templates/loan/FX', { name: 'Statement', availability: 'ACCOUNT' })).status === 409);
    r = await call('GET', `/api/documents/loan/${cl.id}/${stmt.id}`);
    check('a statement needs its dates', r.status === 400 && /STATEMENT/.test(r.reason), `${r.status} ${r.reason}`);
    const doc = await call('GET', `/api/documents/loan/${cl.id}/${stmt.id}?from=2026-01-01&to=2026-01-31`, null, { raw: true });
    const html = await doc.text();
    check('the document is filled from the account and member', doc.status === 200 && html.includes('Org SACCO Ltd') && html.includes(cl.account_no)
      && html.includes('Ann ') && /LOAN_DISBURSEMENT/.test(html) && (html.match(/<li>/g) || []).length === 3, html.slice(0, 300));
    check('amounts and dates in the organization\'s formats', html.includes('3.000,00') && html.includes('02/01/2026'), html.slice(0, 600));
    check('served with a policy that allows no script', /default-src 'none'/.test(doc.headers.get('content-security-policy') || ''));
    r = await call('POST', '/api/documents/templates/loan/FX', { name: 'Receipt', availability: 'TRANSACTION',
      content: '<p>Received {{transaction.amount}} via {{transaction.channel}} ref {{transaction.reference}} no {{transaction.custom._receipt.receiptNo}} <b>{{member.custom._profile.occupation}}</b></p>' });
    const rc = await call('GET', `/api/documents/loan/${cl.id}/${r.body.id}?reference=${receipt.reference}`, null, { raw: true });
    const rhtml = await rc.text();
    check('a transaction document for a transaction on the account', rc.status === 200 && rhtml.includes('50,00') && rhtml.includes('R-77') && rhtml.includes('Cash'), rhtml);
    check('the documents available on an account are listed', (await call('GET', `/api/documents/loan/${cl.id}`)).body.length === 2);
    check('a template on another product is refused', (await call('GET', `/api/documents/loan/${ml.id}/${stmt.id}?from=2026-01-01&to=2026-01-31`, null, { raw: true })).status === 409);
  } catch (e) {
    fail++; failures.push(e.stack); console.error(e);
  } finally {
    server.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
    process.exit(fail ? 1 : 0);
  }
})();
