#!/usr/bin/env node
'use strict';

/**
 * Transaction channels after the reference platform
 * (docs/audits/audit-transaction-channels.md): its API v2 at
 * /organization/transactionChannels, configuration as code
 * (/configuration/transactionchannels.yaml), the constraint operators, the
 * product check, and the constraints as postings meet them.
 */

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant } = require('../src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const S = require('../src/domain/savings');
const YAML = require('../src/lib/yaml');
const CHC = require('../src/domain/channelConfig');
const { orgDay } = require('./_org');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'chtest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4137;
const PASSWORD = 'a sufficiently long passphrase';
const PW = 'Staff password 2026';
const T = (fn) => withTenant(SCHEMA, fn);

const tokens = {};
async function call(method, p, body, { who = 'admin', type = null, headers: extra = {} } = {}) {
  const headers = { 'x-tenant': SLUG, ...extra };
  if (tokens[who]) headers.authorization = `Bearer ${tokens[who]}`;
  let payload;
  if (type) { headers['content-type'] = type; payload = body; }
  else if (body !== undefined && body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: payload });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, raw: text, text: text.slice(0, 400), reason: `${d?.errors?.[0]?.errorReason || ''}`, type: r.headers.get('content-type') };
}
const store = require('../src/lib/ratestore');
async function login(email, password = PW) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  return (await call('POST', '/api/auth/login', { email, password }, { who: 'nobody' })).body?.accessToken;
}

const OPEN = { usage: 'UNCONSTRAINED', constraints: [] };
const v2 = (id, extra = {}) => ({ id, name: id, glAccount: '100-210', availableForAll: true, usageRights: [], loanConstraints: OPEN, depositConstraints: OPEN, ...extra });
const yamlPut = (doc, who = 'admin') => call('PUT', '/api/configuration/transactionchannels.yaml', typeof doc === 'string' ? doc : YAML.stringify(doc), { type: 'application/yaml', who });
const stored = async (id) => (await T((c) => c.query('SELECT * FROM transaction_channels WHERE id = $1', [id]))).rows[0];

(async () => {
  const server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Channels SACCO', mfaRequiredRoles: [], adminEmail: 'admin@ch.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    tokens.admin = await login('admin@ch.local', PASSWORD);
    await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' });
    const role = await call('POST', '/api/roles', { name: 'Channel viewer', code: 'CHANNEL_VIEWER', baseRole: 'TELLER',
      permissions: ['VIEW_TRANSACTION_CHANNELS', 'EDIT_TRANSACTION_CHANNELS'] });
    check('a role that views and edits channels only', role.status === 201, role.text);
    const u = await call('POST', '/api/users', { email: 'viewer@ch.local', fullName: 'The viewer', password: PW, role: 'CHANNEL_VIEWER', branchId: 'HQ' });
    await pool.query('UPDATE platform.users SET must_change_password = false WHERE id = $1', [u.body?.id]);
    tokens.viewer = await login('viewer@ch.local');
    check('staff signed in', tokens.admin && tokens.viewer);
    const m = (await call('POST', '/api/members', { firstName: 'Wanjiru', lastName: 'Channel', branchId: 'HQ' })).body;
    const acct = await T((c) => S.open(c, { memberId: m.id, productId: 'SAV01', openedOn: orgDay(-5) }));
    check('a member with a deposit account', m?.id && acct?.id, JSON.stringify(acct).slice(0, 200));
    const deposit = (amount, channelId) => call('POST', `/api/savings/${acct.id}/deposits`, { amount, channelId });

    // ------------------------------------------------------------------------
    section('the operators, stored and read back');
    {
      const round = (side, criteria, operator, values) => CHC.filterOut(CHC.filterIn(side, { criteria, operator, values }, 'x'));
      let o = round('LOAN', 'AMOUNT', 'MORE_THAN', ['100']);
      check('MORE_THAN 100 reads back as MORE_THAN 100', o.operator === 'MORE_THAN' && o.values[0] === '100.00', JSON.stringify(o));
      check('and is stored as a minimum of 100.01', CHC.filterIn('LOAN', { criteria: 'AMOUNT', operator: 'MORE_THAN', values: ['100'] }, 'x').min === 100.01);
      o = round('LOAN', 'AMOUNT', 'LESS_THAN', [9999.99]);
      check('LESS_THAN reads back', o.operator === 'LESS_THAN' && o.values[0] === '9999.99', JSON.stringify(o));
      o = round('SAVINGS', 'AMOUNT', 'BETWEEN', ['10', '20']);
      check('BETWEEN reads back with both amounts', o.operator === 'BETWEEN' && o.values.join() === '10.00,20.00', JSON.stringify(o));
      o = round('SAVINGS', 'AMOUNT', 'EQUALS', ['50']);
      check('EQUALS reads back', o.operator === 'EQUALS' && o.values.join() === '50.00', JSON.stringify(o));
      o = CHC.filterOut({ type: 'AMOUNT', min: 100, max: null });
      check('an inclusive minimum from before reads as MORE_THAN a cent below', o.operator === 'MORE_THAN' && o.values[0] === '99.99', JSON.stringify(o));
      o = round('LOAN', 'TYPE', 'IN', ['repayment']);
      check('TYPE IN takes the type in any case', o.operator === 'IN' && o.values.join() === 'REPAYMENT', JSON.stringify(o));
      const bad = (side, k) => { try { CHC.filterIn(side, k, 'x'); return null; } catch (e) { return e.message; } };
      check('TYPE does not take MORE_THAN', /takes IN, EMPTY, NOT_EMPTY/.test(bad('LOAN', { criteria: 'TYPE', operator: 'MORE_THAN', values: ['1'] })));
      check('AMOUNT does not take IN', /AMOUNT criterion takes/.test(bad('LOAN', { criteria: 'AMOUNT', operator: 'IN', values: ['1'] })));
      check('a deposit type is not a loan type', /loan types are/.test(bad('LOAN', { criteria: 'TYPE', operator: 'IN', values: ['DEPOSIT'] })));
      check('BETWEEN needs two amounts, lower first', /two values/.test(bad('LOAN', { criteria: 'AMOUNT', operator: 'BETWEEN', values: ['1'] }))
        && /lower amount first/.test(bad('LOAN', { criteria: 'AMOUNT', operator: 'BETWEEN', values: ['9', '1'] })));
      check('an amount has at most two decimals', /two decimals/.test(bad('LOAN', { criteria: 'AMOUNT', operator: 'EQUALS', values: ['1.005'] })));
      check('a negative or written amount is refused', /not below zero/.test(bad('LOAN', { criteria: 'AMOUNT', operator: 'EQUALS', values: ['-1'] }))
        && /not below zero/.test(bad('LOAN', { criteria: 'AMOUNT', operator: 'EQUALS', values: ['ten'] })));
      check('EMPTY takes no values', /takes no values/.test(bad('LOAN', { criteria: 'PRODUCT', operator: 'EMPTY', values: ['NL01'] })));
    }

    // ------------------------------------------------------------------------
    section('API v2: /organization/transactionChannels');
    let r = await call('GET', '/api/organization/transactionChannels');
    const cash = (r.body || []).find((x) => x.id === 'cash');
    check('the channels in the reference shape', r.status === 200 && cash && cash.state === 'ACTIVE' && cash.isDefault === true && cash.glAccount === '100-200'
      && cash.availableForAll === true && cash.loanConstraints.usage === 'UNCONSTRAINED' && cash.depositConstraints.usage === 'UNCONSTRAINED', r.text);
    const seeded = (await T((c) => c.query('SELECT id FROM transaction_channels ORDER BY sort_order, id'))).rows.map((x) => x.id);
    check('in their order', r.body.map((x) => x.id).join() === seeded.join(), r.body.map((x) => x.id).join());
    const chapsBody = v2('chaps', {
      name: 'CHAPS', channelType: 'TRANSFER',
      loanConstraints: { usage: 'LIMITED', matchFiltersOption: 'ALL', constraints: [{ criteria: 'AMOUNT', operator: 'MORE_THAN', value: '10000' }] },
      depositConstraints: { usage: 'LIMITED', matchFiltersOption: 'ANY', constraints: [
        { criteria: 'AMOUNT', operator: 'BETWEEN', value: '500', secondValue: '1000' }, { criteria: 'TYPE', operator: 'IN', values: ['WITHDRAWAL'] }] },
    });
    const KEY = { headers: { 'idempotency-key': '2f1d0c7e-5c55-4d3b-9b71-3a0f3f4c2b10' } };
    r = await call('POST', '/api/organization/transactionChannels', chapsBody, KEY);
    check('a channel is created with reference constraints', r.status === 201 && r.body.loanConstraints.constraints[0].operator === 'MORE_THAN'
      && r.body.loanConstraints.constraints[0].value === '10000.00' && r.body.depositConstraints.matchFiltersOption === 'ANY' && r.body.channelType === 'TRANSFER', r.text);
    const again = await call('POST', '/api/organization/transactionChannels', chapsBody, KEY);
    check('the same request with the same Idempotency-Key gets the first answer back', again.status === 201 && again.body.name === 'CHAPS', again.text);
    check('the stored filter is the inclusive range', (await stored('chaps')).loan_constraints.filters[0].min === 10000.01);
    check('a second channel with the same ID is refused', (await call('POST', '/api/organization/transactionChannels', v2('chaps'))).status === 409);
    r = await call('GET', '/api/organization/transactionChannels/chaps');
    check('a channel by ID', r.status === 200 && r.body.id === 'chaps', r.text);
    check('an unknown ID is 404', (await call('GET', '/api/organization/transactionChannels/nope')).status === 404);

    section('the constraints on postings');
    r = await deposit(700, 'chaps');
    check('a deposit inside BETWEEN 500 and 1000 goes through (ANY)', r.status === 201, `${r.status} ${r.reason}`);
    r = await deposit(1000, 'chaps');
    check('BETWEEN includes its upper amount', r.status === 201, `${r.status} ${r.reason}`);
    r = await deposit(1500, 'chaps');
    check('one outside it is refused', r.status === 409 && /CHANNEL_CONSTRAINTS_REFUSE/.test(r.reason), `${r.status} ${r.reason}`);

    section('validation');
    r = await call('POST', '/api/organization/transactionChannels', v2('badprod', {
      loanConstraints: { usage: 'LIMITED', matchFiltersOption: 'ALL', constraints: [{ criteria: 'PRODUCT', operator: 'IN', values: ['NOPE'] }] } }));
    check('a product filter names existing products', r.status === 400 && /UNKNOWN_LOAN_PRODUCTS: NOPE/.test(r.reason), r.text);
    r = await call('POST', '/api/organization/transactionChannels', v2('badprod', {
      depositConstraints: { usage: 'LIMITED', matchFiltersOption: 'ALL', constraints: [{ criteria: 'PRODUCT', operator: 'IN', values: ['NL01'] }] } }));
    check('of the right kind (a loan product is not a deposit product)', r.status === 400 && /UNKNOWN_DEPOSIT_PRODUCTS: NL01/.test(r.reason), r.text);
    r = await call('POST', '/api/organization/transactionChannels', v2('badprod', { loanConstraints: { usage: 'UNCONSTRAINED', constraints: [{ criteria: 'AMOUNT', operator: 'EQUALS', value: '1' }] } }));
    check('UNCONSTRAINED usage takes no constraints', r.status === 400 && /takes no constraints/.test(r.reason), r.text);
    r = await call('POST', '/api/organization/transactionChannels', { ...v2('badprod'), loanConstraints: undefined });
    check('loanConstraints is required', r.status === 400 && /loanConstraints is required/.test(r.reason), r.text);
    r = await call('POST', '/api/organization/transactionChannels', v2('badprod', { availableForAll: false, usageRights: [] }));
    check('a channel not for all users names its roles', r.status === 400 && /name the roles/.test(r.reason), r.text);
    r = await call('POST', '/api/organization/transactionChannels', v2('badprod', { availableForAll: false, usageRights: ['NO_SUCH_ROLE'] }));
    check('which must exist', r.status === 400 && /UNKNOWN_ROLES/.test(r.reason), r.text);
    r = await call('POST', '/api/organization/transactionChannels', v2('badprod', { glAccount: null }));
    check('a new channel needs a GL account', r.status === 400 && /NEEDS_A_GL_ACCOUNT/.test(r.reason), r.text);
    check('nothing was created by the refusals', !(await stored('badprod')));

    section('update and delete');
    r = await call('PUT', '/api/organization/transactionChannels/chaps', v2('chaps', { name: 'CHAPS payments', state: 'INACTIVE', availableForAll: false, usageRights: ['MANAGER'] }));
    check('a PUT replaces the channel', r.status === 200 && r.body.name === 'CHAPS payments' && r.body.state === 'INACTIVE' && r.body.usageRights.join() === 'MANAGER'
      && r.body.loanConstraints.usage === 'UNCONSTRAINED', r.text);
    r = await call('GET', '/api/organization/transactionChannels?transactionChannelState=INACTIVE');
    check('the list filters by state', r.status === 200 && r.body.length === 1 && r.body[0].id === 'chaps', r.text);
    check('an unknown state is refused', (await call('GET', '/api/organization/transactionChannels?transactionChannelState=GONE')).status === 400);
    r = await call('PUT', '/api/organization/transactionChannels/chaps', v2('other'));
    check('the ID cannot change', r.status === 400 && /ID_CANNOT_CHANGE/.test(r.reason), r.text);
    r = await call('PUT', '/api/organization/transactionChannels/cash', v2('cash', { glAccount: '100-200', state: 'INACTIVE' }));
    check('the default channel cannot be deactivated', r.status === 409, r.text);
    r = await call('PUT', '/api/organization/transactionChannels/internal', v2('internal', { glAccount: null, name: 'Internal moves' }));
    check('a channel seeded without a GL account may stay without one', r.status === 200 && r.body.glAccount === null && r.body.name === 'Internal moves', r.text);
    r = await call('PUT', '/api/organization/transactionChannels/cash', v2('cash', { glAccount: null }));
    check('one with a GL account cannot drop it', r.status === 400 && /NEEDS_A_GL_ACCOUNT/.test(r.reason), r.text);
    check('a used channel cannot be deleted', (await call('DELETE', '/api/organization/transactionChannels/chaps')).status === 409);
    r = await call('DELETE', '/api/organization/transactionChannels/settlement');
    check('the channels the platform posts through cannot be deleted', r.status === 409 && /SYSTEM_CHANNEL/.test(r.reason), r.text);
    r = await call('PUT', '/api/organization/transactionChannels/transfer', v2('transfer', { glAccount: '290-210', state: 'INACTIVE' }));
    check('nor deactivated', r.status === 409 && /SYSTEM_CHANNEL/.test(r.reason), r.text);
    await call('POST', '/api/organization/transactionChannels', v2('spare'));
    r = await call('DELETE', '/api/organization/transactionChannels/spare');
    check('an unused one is deleted with 204', r.status === 204 && !(await stored('spare')), `${r.status} ${r.text}`);

    section('permissions');
    check('a role with view rights reads the list', (await call('GET', '/api/organization/transactionChannels', null, { who: 'viewer' })).status === 200);
    check('but cannot create', (await call('POST', '/api/organization/transactionChannels', v2('vw'), { who: 'viewer' })).status === 403);
    check('nor delete', (await call('DELETE', '/api/organization/transactionChannels/mpesa', null, { who: 'viewer' })).status === 403);
    check('nor PUT the configuration (that needs create, edit and delete)', (await yamlPut({ defaultTransactionChannel: {} }, 'viewer')).status === 403);

    // ------------------------------------------------------------------------
    section('configuration as code');
    // Data the file must carry back unchanged: a closed side, a legacy minimum of
    // zero, a system channel deactivated before the rule, a channel another table names.
    await T(async (c) => {
      await c.query(`INSERT INTO transaction_channels (id, name, channel_type, gl_account_code, sort_order, loan_constraints, savings_constraints)
        VALUES ('closed', 'Closed to loans', 'CASH', '100-210', 90, '{"match":"ALL","filters":[]}', '{"match":"ALL","filters":[{"type":"AMOUNT","min":0,"max":null}]}'),
               ('named', 'Named elsewhere', 'CASH', '100-210', 91, NULL, NULL)`);
      await c.query("UPDATE transaction_channels SET is_active = false WHERE id = 'settlement'");
      await c.query('CREATE TABLE channel_refs (channel_id text REFERENCES transaction_channels(id))');
      await c.query("INSERT INTO channel_refs VALUES ('named')");
    });
    r = await call('PUT', '/api/organization/transactionChannels/settlement', v2('settlement', { glAccount: '290-200', state: 'INACTIVE', name: 'Settlement' }));
    check('a system channel already inactive can still be edited', r.status === 200, r.text);
    r = await call('GET', '/api/configuration/transactionchannels.yaml');
    check('GET returns YAML', r.status === 200 && /yaml/.test(r.type) && /^defaultTransactionChannel:/m.test(r.raw), r.text);
    const doc = YAML.parse(r.raw);
    check('the default channel apart, the rest in order', doc.defaultTransactionChannel.id === 'cash'
      && doc.transactionChannels.map((x) => x.id).join() === seeded.filter((id) => id !== 'cash').concat('chaps', 'closed', 'named').join(), JSON.stringify(doc).slice(0, 300));
    const closed = doc.transactionChannels.find((x) => x.id === 'closed');
    check('a closed side is written as PRODUCT EMPTY', closed.loansConstraints.constraints[0].filterElement === 'EMPTY', JSON.stringify(closed));
    check('a minimum of zero as NOT_EMPTY', closed.savingsConstraints.constraints[0].filterElement === 'NOT_EMPTY', JSON.stringify(closed));
    const ch = doc.transactionChannels.find((x) => x.id === 'chaps');
    check('a channel in the file shape', ch.state === 'INACTIVE' && ch.loansConstraints.usage === 'UNCONSTRAINED_USAGE' && ch.usageRights.allUsers === false
      && ch.usageRights.roles.join() === 'MANAGER' && ch.glAccountCode === '100-210', JSON.stringify(ch));
    const internal = doc.transactionChannels.find((x) => x.id === 'internal');
    check('a channel without a GL account has no glAccountCode', internal && internal.glAccountCode === undefined, JSON.stringify(internal));

    const original = r.raw;
    r = await yamlPut(original);
    check('the file read back is taken unchanged', r.status === 200 && r.body.created.length === 0 && r.body.deleted.length === 0 && r.body.deactivated.length === 0, r.text);
    check('and the configuration is the same after', original === (await call('GET', '/api/configuration/transactionchannels.yaml')).raw);

    // The reference's example, with this SACCO's GL accounts and roles.
    const ref = `---
defaultTransactionChannel:
  id: "cash"
  name: "Cash"
  state: "ACTIVE"
  loansConstraints:
    usage: "UNCONSTRAINED_USAGE"
    constraints: []
  savingsConstraints:
    usage: "UNCONSTRAINED_USAGE"
    constraints: []
  glAccountCode: "100-200"
  usageRights:
    roles: []
    allUsers: true
transactionChannels:
  - id: "visa"
    name: "Visa Card"
    state: "ACTIVE"
    loansConstraints:
      usage: "LIMITED_USAGE"
      constraints:
        - criteria: "PRODUCT"
          filterElement: "EMPTY"
          values: []
      matchFilter: "ALL"
    savingsConstraints:
      usage: "UNCONSTRAINED_USAGE"
      constraints: []
    glAccountCode: "100-210"
    usageRights:
      roles:
        - "MANAGER"
      allUsers: false
  - id: "bacs"
    name: "BACS"
    state: "ACTIVE"
    loanConstraints:
      usage: "LIMITED_USAGE"
      constraints:
        - criteria: "AMOUNT"
          filterElement: "LESS_THAN"
          values:
            - "9999.99"
      matchFilter: "ALL"
    savingsConstraints:
      usage: "LIMITED_USAGE"
      constraints:
        - criteria: "AMOUNT"
          filterElement: "LESS_THAN"
          values:
            - "9999.99"
      matchFilter: "ALL"
    glAccountCode: "100-210"
    usageRights:
      roles: []
      allUsers: true
  - id: "mpesa"
    name: "M-Pesa"
    state: "ACTIVE"
    loansConstraints:
      usage: "UNCONSTRAINED_USAGE"
      constraints: []
    savingsConstraints:
      usage: "UNCONSTRAINED_USAGE"
      constraints: []
    glAccountCode: "100-220"
    usageRights:
      roles: []
      allUsers: true
`;
    r = await yamlPut(ref);
    check('a file in the reference\'s own example shape is taken', r.status === 200 && r.body.created.join() === 'visa,bacs', r.text);
    check('channels left out are deleted when unused', r.body.deleted.includes('bank') && r.body.deleted.includes('cheque') && !(await stored('bank')), JSON.stringify(r.body));
    check('and deactivated with the reference\'s warning when used', r.body.deactivated.includes('chaps')
      && r.body.warnings.some((w) => /TransactionChannel \[chaps\] could not be deleted/.test(w)) && (await stored('chaps')).is_active === false, JSON.stringify(r.body));
    check('the channels the platform posts through are kept, with a warning', ['internal', 'settlement', 'transfer'].every((id) => !r.body.deleted.includes(id))
      && (await stored('settlement')) && r.body.warnings.some((w) => /\[settlement\] was kept/.test(w)), JSON.stringify(r.body));
    check('a channel another record names is deactivated, not deleted', r.body.deactivated.includes('named') && (await stored('named'))?.is_active === false, JSON.stringify(r.body));
    check('one closed to loans, unused, is deleted', r.body.deleted.includes('closed'));
    const order = (await call('GET', '/api/organization/transactionChannels')).body.map((x) => x.id);
    check('the listed channels take the file\'s order, the default keeps its place', order.slice(0, 4).join() === 'cash,visa,bacs,mpesa', order.join());
    check('PRODUCT EMPTY closes a channel to loans', (await stored('visa')).loan_constraints.filters[0].operator === 'EMPTY');
    r = await deposit(9999.99, 'bacs');
    check('LESS_THAN is strict: 9999.99 is refused', r.status === 409, `${r.status} ${r.reason}`);
    r = await deposit(9999.98, 'bacs');
    check('and 9999.98 goes through', r.status === 201, `${r.status} ${r.reason}`);
    r = await deposit(100, 'visa');
    check('a channel for MANAGER only refuses the administrator\'s role', r.status === 403 && /YOUR_ROLE/.test(r.reason), `${r.status} ${r.reason}`);

    section('a PUT with an error changes nothing');
    const now = (await call('GET', '/api/configuration/transactionchannels.yaml')).raw;
    const tries = [
      [{ ...YAML.parse(now), defaultTransactionChannel: { ...YAML.parse(now).defaultTransactionChannel, id: 'newcash' } }, /DEFAULT_CHANNEL_ID_CANNOT_CHANGE/, 'the default channel\'s ID cannot change'],
      [{ ...YAML.parse(now), defaultTransactionChannel: { ...YAML.parse(now).defaultTransactionChannel, state: 'INACTIVE' } }, /CANNOT_BE_DEACTIVATED/, 'nor can it be deactivated'],
      [{ ...YAML.parse(now), transactionChannels: [...YAML.parse(now).transactionChannels, YAML.parse(now).transactionChannels[0]] }, /APPEARS_TWICE/, 'an ID cannot appear twice'],
      [{ ...YAML.parse(now), transactionChannels: [{ ...YAML.parse(now).transactionChannels[0], id: 'brand new', glAccountCode: '100-210' }] }, /without spaces/, 'an ID has no spaces'],
      [{ ...YAML.parse(now), transactionChannels: [{ ...YAML.parse(now).transactionChannels[0], id: 'newone', glAccountCode: '999-999' }] }, /UNKNOWN_GL_ACCOUNT/, 'a GL account must exist'],
      [{ ...YAML.parse(now), transactionChannels: [{ ...YAML.parse(now).transactionChannels[0], loansConstraints: { usage: 'LIMITED_USAGE', constraints: [] } }] }, /needs constraints/, 'LIMITED_USAGE needs constraints'],
      [{ ...YAML.parse(now), transactionChannels: [{ ...YAML.parse(now).transactionChannels[0], loansConstraints: { usage: 'LIMITED_USAGE', constraints: [{ criteria: 'TYPE', filterElement: 'IN', values: ['DISBURSEMENT'] }] } }] }, /matchFilter/, 'and a matchFilter'],
      [{ ...YAML.parse(now), transactionChannels: [{ ...YAML.parse(now).transactionChannels[0], usageRights: { allUsers: false, roles: [] } }] }, /roles is required/, 'roles are required when not for all users'],
      [{ ...YAML.parse(now), transactionChannels: [{ ...YAML.parse(now).transactionChannels[0], state: 'GONE' }] }, /ACTIVE or INACTIVE/, 'state is ACTIVE or INACTIVE'],
      [{ transactionChannels: [] }, /defaultTransactionChannel/, 'the default channel is required'],
    ];
    for (const [d, re, label] of tries) {
      r = await yamlPut(d);
      check(label, r.status === 400 && re.test(r.reason), `${r.status} ${r.reason}`);
    }
    check('and nothing changed', (await call('GET', '/api/configuration/transactionchannels.yaml')).raw === now);
    r = await yamlPut('defaultTransactionChannel:\n  id: cash\n\tname: tab');
    check('YAML errors name the line', r.status === 400 && /line 3/.test(r.reason), r.text);
    r = await call('GET', '/api/configuration/transactionchannels/template.yaml');
    const tpl = YAML.parse(r.raw);
    check('the template is a file in the shape the PUT takes', r.status === 200 && tpl.defaultTransactionChannel.id === 'cash' && tpl.transactionChannels.length === 2);
    await T((c) => c.query("UPDATE transaction_channels SET is_default = false WHERE id = 'cash'"));
    r = await yamlPut(now);
    check('a SACCO with no default channel is refused, not given a new one', r.status === 409 && /NO_DEFAULT_CHANNEL/.test(r.reason), r.text);
    await T((c) => c.query("UPDATE transaction_channels SET is_default = true WHERE id = 'cash'"));
    check('the change is in the change log', (await T((c) => c.query("SELECT 1 FROM audit_log WHERE action = 'TRANSACTION_CHANNEL_CONFIGURATION_APPLIED'"))).rowCount >= 2);
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`); console.log('FAILED:', e.stack);
  } finally {
    server.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
  }
})();
