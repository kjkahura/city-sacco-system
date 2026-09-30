'use strict';

/**
 * The Excel data import: the prerequisites, and running an import.
 */

const acct = require('../accounting');
const L = require('../loans');
const LM = require('../loanMigration');
const SV = require('../savings');
const SH = require('../shares');
const B = require('../branches');
const CL = require('../clients');
const CF = require('../customFields');
const IDT = require('../idTemplates');
const { err } = require('../../lib/errors');
const { recordAudit } = require('../../lib/auditLog');
const definitions = require('./definitions');

const COLUMN_OF = {
  disbursedOn: 'Disbursed on', principalOutstanding: 'Principal outstanding', state: 'Account state', closedOn: 'Closed on',
  principalInterval: 'Principal interval', appliedOn: 'Date applied', approvedOn: 'Date approved', firstRepaymentDate: 'Repayment start date',
  transactions: 'Account number', principalInArrears: 'Principal in arrears',
};
const columnFor = (f) => COLUMN_OF[f] || 'Account number';

/** The loan as ../loanMigration takes it, from its sheet rows. */
function specOf(r, schedule, txs) {
  return {
    accountNo: r.accountNo, productId: r.productId, principal: r.principal, installments: r.installments, rate: r.rate,
    gracePeriods: r.gracePeriods, repaymentEvery: r.repaymentEvery, repaymentUnit: r.repaymentUnit, principalInterval: r.principalInterval,
    state: r.state || 'ACTIVE', appliedOn: r.appliedOn, approvedOn: r.approvedOn, disbursedOn: r.disbursedOn, closedOn: r.closedOn,
    firstRepaymentDate: r.firstRepaymentDate, principalOutstanding: r.principalOutstanding, principalInArrears: r.principalInArrears,
    interestOutstanding: r.interestOutstanding, feesOutstanding: r.feesOutstanding, penaltyOutstanding: r.penaltyOutstanding,
    purpose: r.purpose, notes: r.notes, customFields: r.customFields || {},
    // A schedule without paid columns: what the account says was paid is
    // applied to it oldest first, as to a schedule the product draws.
    schedule: schedule ? schedule.map((x) => ({ ...x, ...(r._hasSchedulePaid ? {} : { principalPaid: null, interestPaid: null, feesPaid: null, penaltyPaid: null }) })) : null,
    schedulePaid: !!r._hasSchedulePaid,
    transactions: (txs || []).map((x) => ({ type: x.type, date: x.date, amount: x.amount, notes: x.notes })),
  };
}

/** The opening balances as journal lines, from either sheet. */
function openingLines(data) {
  if (data.glBalances.length) {
    return data.glBalances.filter((r) => (r.debit || 0) > 0 || (r.credit || 0) > 0)
      .map((r) => ({ glCode: r.glCode, amount: r.debit || r.credit, side: r.debit > 0 ? 'D' : 'C', branch: r.branch, row: r }));
  }
  return data.chart.filter((r) => r.balance && r.type).map((r) => {
    const debitNature = ['ASSET', 'EXPENSE'].includes(r.type);
    const debit = debitNature ? r.balance > 0 : r.balance < 0;
    return { glCode: r.code, amount: Math.abs(r.balance), side: debit ? 'D' : 'C', branch: null, row: r };
  });
}

// --- prerequisites ----------------------------------------------------------

/**
 * The reference platform's import prerequisites: users (credit officers), branches, custom
 * fields and products set up before the import. What is missing becomes a
 * warning on the upload, and is listed on the template.
 */
async function prerequisites(c) {
  const n = async (sql) => (await c.query(sql)).rows[0].n;
  const users = await n(`SELECT count(*)::int AS n FROM platform.users u JOIN platform.tenants t ON t.id = u.tenant_id
                          WHERE t.schema_name = current_schema() AND u.status = 'ACTIVE'`);
  const out = [
    { item: 'Users (credit officers)', count: users, ok: users > 1, detail: 'Staff users besides the first administrator, to assign members to' },
    { item: 'Branches', count: await n('SELECT count(*)::int AS n FROM branches'), detail: 'Branches members and accounts belong to (or on the Branches sheet)' },
    { item: 'Loan products', count: await n('SELECT count(*)::int AS n FROM loan_products WHERE is_active'), detail: 'Every product a loan is imported under' },
    { item: 'Deposit products', count: await n('SELECT count(*)::int AS n FROM savings_products WHERE is_active'), detail: 'Every product a deposit account is imported under' },
    { item: 'Custom field definitions', count: await n('SELECT count(*)::int AS n FROM custom_field_definitions WHERE is_active'), detail: 'Only if you import custom field values', optional: true },
  ];
  for (const x of out) if (x.ok === undefined) x.ok = x.optional ? true : x.count > 0;
  return out;
}

// --- running it ---------------------------------------------------------------

/**
 * Run the import against the database. Every row runs in its own savepoint
 * so one bad row is reported and the rest still tried; a row that depends
 * on one that failed (a loan for a member who did not import) says so. The
 * caller decides what happens to the whole: rolled back (validation) or
 * committed (approval, only when there are no errors). `onProgress(done,
 * total)` is called as rows are done; `preview` collects each record as
 * created, for the reviewer.
 */
async function execute(c, { asOf, data, layout = {} }, { importId, createdBy, user, onProgress = null, preview = null }) {
  const errors = [];
  const warnings = [];
  const created = { glAccounts: 0, branches: 0, centres: 0, members: 0, groups: 0, groupMembers: 0, deposits: 0, shares: 0, loans: 0, installments: 0, transactions: 0, openingEntryLines: 0 };
  const failed = { member: new Map(), branch: new Map(), centre: new Map(), group: new Map() };
  const members = new Map();
  const total = ['glAccounts', 'chart', 'branches', 'centres', 'members', 'deposits', 'shares', 'loans'].reduce((t, k) => t + data[k].length, 0) + 1;
  let done = 0;
  const tick = () => { done += 1; if (onProgress) onProgress(done, total); };
  const push = (k, x) => { if (preview) (preview[k] = preview[k] || []).push(x); };
  let sp = 0;
  const indexOf = (key, column) => layout[key]?.columns?.[column] ?? null;
  const row = async (key, r, column, fn) => {
    sp += 1;
    const name = `import_row_${sp}`;
    await c.query(`SAVEPOINT ${name}`);
    try {
      const out = await fn();
      await c.query(`RELEASE SAVEPOINT ${name}`);
      return out;
    } catch (e) {
      await c.query(`ROLLBACK TO SAVEPOINT ${name}`);
      const sheet = layout[key]?.sheet || definitions.SHEETS.find((s) => s.key === key)?.name || key;
      const index = indexOf(key, column);
      errors.push({ sheet, row: r._row ?? null, column, message: explain(e), ...(index !== null ? { index } : {}) });
      return undefined;
    }
  };
  const dependsOn = (map, key, what) => {
    if (map.has(key)) throw err(`${what} ${key} did not import (row ${map.get(key)})`);
  };
  const branchId = async (code) => {
    if (!code) return undefined;
    dependsOn(failed.branch, String(code).toUpperCase(), 'Branch');
    return (await B.resolve(c, String(code).toUpperCase())).id;
  };

  // Custom field values as the sheet wrote them, as the field wants them:
  // True and False for a checkbox, a date in either form.
  const defs = new Map();
  const coerce = async (entity, values) => {
    if (!values || !Object.keys(values).length) return {};
    if (!defs.has(entity)) defs.set(entity, await CF.definitions(c, { entity, includeInactive: false }));
    const list = defs.get(entity);
    const out = {};
    for (const [setId, fields] of Object.entries(values)) {
      out[setId] = {};
      for (const [fieldId, v] of Object.entries(fields)) {
        const d = list.find((x) => x.id === fieldId && x.set_id === setId);
        let x = v;
        if (d && d.field_type === 'CHECKBOX') {
          const s = String(v).trim().toLowerCase();
          x = ['true', 'yes', 'y', '1'].includes(s) || v === true ? true : ['false', 'no', 'n', '0'].includes(s) || v === false ? false : v;
        } else if (d && d.field_type === 'DATE') x = definitions.isoDate(v) || v;
        out[setId][fieldId] = x;
      }
    }
    return out;
  };

  // Credit officers are the tenant's own users.
  const officers = new Map();
  const officer = async (who) => {
    if (!who) return null;
    const k = String(who).trim().toLowerCase();
    if (!officers.has(k)) {
      const { rows: [u] } = await c.query(
        `SELECT u.email FROM platform.users u JOIN platform.tenants t ON t.id = u.tenant_id
         WHERE t.schema_name = current_schema() AND u.status = 'ACTIVE' AND lower(u.email) = $1`, [k]);
      officers.set(k, u ? u.email : null);
    }
    const found = officers.get(k);
    if (!found) throw err(`Credit officer ${who} is not an active user of this SACCO (Credit Officers sheet)`);
    return found;
  };

  // The chart of accounts: parents before children, then the reference platform's chart sheet.
  const pending = [...data.glAccounts];
  const inFile = new Set(pending.map((r) => r.code));
  const placed = new Set();
  let guard = pending.length + 1;
  while (pending.length && guard > 0) {
    guard -= 1;
    for (let i = 0; i < pending.length; i += 1) {
      const r = pending[i];
      if (r.parentCode && inFile.has(r.parentCode) && !placed.has(r.parentCode)) continue;
      pending.splice(i, 1); i -= 1;
      placed.add(r.code);
      const ok = await row('glAccounts', r, 'Code', async () => {
        if (r.parentCode) {
          const { rows: [p] } = await c.query('SELECT type FROM gl_accounts WHERE code = $1', [r.parentCode]);
          if (!p) throw err(`Parent code ${r.parentCode} is not in the chart of accounts`);
        }
        const { rowCount } = await c.query(
          `INSERT INTO gl_accounts (code, name, type, parent_code, usage, notes, import_id)
           VALUES ($1,$2,$3,$4,COALESCE($5,'DETAIL'),$6,$7) ON CONFLICT (code) DO NOTHING`,
          [r.code, r.name, r.type, r.parentCode, r.usage, r.notes, importId]);
        if (!rowCount) throw err(`GL account ${r.code} is already in the chart of accounts`);
        push('glAccounts', { code: r.code, name: r.name, type: r.type, usage: r.usage || 'DETAIL', parent: r.parentCode });
        return true;
      });
      tick();
      if (ok) created.glAccounts += 1;
    }
  }
  for (const r of pending) errors.push({ sheet: 'GL Accounts', row: r._row, column: 'Parent code', message: 'The parent codes form a loop' });
  for (const r of data.chart) {
    const ok = await row('chart', r, 'GL Code', async () => {
      const { rows: [g] } = await c.query('SELECT code, type FROM gl_accounts WHERE code = $1', [r.code]);
      if (g) {
        if (g.type !== r.type) throw err(`GL account ${r.code} is ${g.type} in the chart of accounts, not ${r.type}`);
        return false;
      }
      await c.query(
        `INSERT INTO gl_accounts (code, name, type, usage, notes, import_id) VALUES ($1,$2,$3,COALESCE($4,'DETAIL'),$5,$6)`,
        [r.code, r.name, r.type, r.usage, r.notes, importId]);
      push('glAccounts', { code: r.code, name: r.name, type: r.type, usage: r.usage || 'DETAIL', parent: null });
      return true;
    });
    tick();
    if (ok) created.glAccounts += 1;
  }

  for (const r of data.branches) {
    const ok = await row('branches', r, 'Branch ID', async () => {
      const b = await B.create(c, { ...definitions.given({ name: r.name, town: r.town, phone: r.phone, email: r.email, address: r.address, notes: r.notes }),
        code: r.code, customFields: await coerce('BRANCH', r.customFields), createdBy, user });
      await c.query('UPDATE branches SET import_id = $2 WHERE id = $1', [b.id, importId]);
      push('branches', { code: b.code, name: b.name, town: b.town });
      return b;
    });
    tick();
    if (ok) created.branches += 1; else failed.branch.set(r.code, r._row);
  }
  for (const r of data.centres) {
    const ok = await row('centres', r, 'Centre ID', async () => {
      await branchId(r.branch);
      const ce = await B.createCentre(c, { ...definitions.given({ name: r.name, address: r.address, notes: r.notes }),
        code: r.code, branchId: r.branch, meetingDay: r.meetingDay ?? null, customFields: await coerce('CENTRE', r.customFields), createdBy, user });
      await c.query('UPDATE centres SET import_id = $2 WHERE id = $1', [ce.id, importId]);
      push('centres', { code: ce.code, name: ce.name, branch: r.branch, meetingDay: ce.meeting_day });
      return ce;
    });
    tick();
    if (ok) created.centres += 1; else failed.centre.set(r.code, r._row);
  }

  for (const r of data.members) {
    const m = await row('members', r, 'Member number', async () => {
      const bId = await branchId(r.branch);
      if (r.branch) {
        const { rows: [b] } = await c.query('SELECT status FROM branches WHERE id = $1', [bId]);
        if (b.status !== 'ACTIVE') throw err(`Branch ${r.branch} is deactivated`);
      }
      if (r.centre) dependsOn(failed.centre, String(r.centre).toUpperCase(), 'Centre');
      const centre = r.centre ? await B.centreFor(c, String(r.centre).toUpperCase(), bId || null) : null;
      const credit = await officer(r.creditOfficer);
      const values = await CF.prepare(c, 'MEMBER', { item: 'client', patch: await coerce('MEMBER', r.customFields), user, creating: true });
      // The ID document, against the ID templates (the reference platform: ID type, number,
      // authority, valid until); mandatory templates apply as on the form.
      let docs = [];
      if (r.idNumber) {
        const { rows: [t] } = await c.query('SELECT id FROM id_templates WHERE lower(id_type) = lower($1) OR id::text = $1 LIMIT 1', [r.idType]);
        docs = [{ templateId: t ? t.id : 'OTHER', idType: r.idType, documentId: r.idNumber, issuingAuthority: r.idAuthority, validUntil: r.idValidUntil }];
      }
      const shaped = await IDT.forNewMember(c, docs);
      const { rows: [x] } = await c.query(
        `INSERT INTO members (member_no, first_name, middle_name, last_name, national_id, kra_pin, phone, phone2, email,
            date_of_birth, gender, employer, status, joined_on, branch_id, centre_id, address_line1, address_line2, city,
            postcode, region, country, credit_officer, prior_loan_cycles, notes, custom_fields, import_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13,'INACTIVE'),COALESCE($14::date,$15::date),$16,$17,$18,$19,$20,
                 $21,$22,$23,$24,COALESCE($25,0),$26,$27,$28)
         RETURNING id, branch_id, member_no, holder_type`,
        [r.memberNo, r.firstName, r.middleName, r.lastName, r.nationalId ? String(r.nationalId).replace(/\s/g, '').toUpperCase() : null, r.kraPin, r.phone, r.phone2, r.email,
          r.dateOfBirth, r.gender, r.employer, r.status, r.joinedOn, asOf, bId || (centre ? centre.branch_id : null), centre ? centre.id : null,
          r.addressLine1, r.addressLine2, r.city, r.postcode, r.region, r.country, credit, r.priorLoanCycles, r.notes,
          JSON.stringify(values), importId]);
      await IDT.storeForMember(c, x.id, shaped, { createdBy });
      if (r.status === 'EXITED') await c.query('UPDATE members SET exited_on = COALESCE(exited_on, $2::date) WHERE id = $1', [x.id, asOf]);
      await c.query("INSERT INTO member_state_changes (member_id, to_state, action, actor) VALUES ($1, COALESCE($2, 'INACTIVE'), 'IMPORTED', $3)",
        [x.id, r.status, createdBy]);
      await recordAudit(c, { actor: createdBy, action: 'MEMBER_IMPORTED', entity: 'member', entityId: x.id, after: JSON.stringify({ memberNo: r.memberNo, importId }) });
      push('members', { memberNo: r.memberNo, name: [r.firstName, r.middleName, r.lastName].filter(Boolean).join(' '), branch: r.branch,
        centre: r.centre, joinedOn: r.joinedOn || asOf, creditOfficer: credit, priorLoanCycles: r.priorLoanCycles || 0,
        idDocuments: shaped.map((d) => `${d.id_type} ${d.document_id}`) });
      return x;
    });
    tick();
    if (m) { created.members += 1; members.set(r.memberNo, m); } else failed.member.set(r.memberNo, r._row);
  }

  // Groups (the reference platform's Groups sheet), through the same rules as the console:
  // type, association, contact details, custom fields. Their members come
  // from the Members sheet's Group ID and Group role columns.
  for (const r of data.groups) {
    const g = await row('groups', r, 'Group ID', async () => {
      if (r.branch) await branchId(r.branch);
      if (r.centre) dependsOn(failed.centre, r.centre, 'Centre');
      const out = await CL.create(c, {
        memberNo: r.groupNo, groupName: r.name, clientTypeId: r.type || undefined, branchId: r.branch || undefined, centreId: r.centre || undefined,
        creditOfficer: r.creditOfficer ? await officer(r.creditOfficer) : undefined, phone: r.phone, phone2: r.phone2, email: r.email,
        addressLine1: r.addressLine1, addressLine2: r.addressLine2, city: r.city, postcode: r.postcode, region: r.region, country: r.country,
        notes: r.notes, joinedOn: asOf, customFields: await coerce('GROUP', r.customFields),
      }, { user, holderType: 'GROUP', imported: true });
      await c.query('UPDATE members SET import_id = $2 WHERE id = $1', [out.member.id, importId]);
      push('groups', { groupNo: out.member.member_no, name: out.member.first_name, type: out.member.client_type_id, branch: r.branch, centre: r.centre });
      return { id: out.member.id, branch_id: out.member.branch_id, member_no: out.member.member_no, holder_type: 'GROUP' };
    });
    tick();
    if (g) { created.groups += 1; members.set(r.groupNo, g); } else failed.group.set(r.groupNo, r._row);
  }
  {
    // Each group's members, gathered from the member rows, set once per group.
    const byGroup = new Map();
    for (const r of data.members) {
      if (!r.groupIds.length || !members.has(r.memberNo)) continue;
      for (const gno of r.groupIds) {
        if (!byGroup.has(gno)) byGroup.set(gno, []);
        byGroup.get(gno).push({ r, memberId: members.get(r.memberNo).id, roles: r.groupRoles });
      }
    }
    for (const [gno, list] of byGroup) {
      const ok = await row('members', list[0].r, 'Group ID', async () => {
        dependsOn(failed.group, gno, 'Group');
        const g = members.get(gno) || (await c.query("SELECT id FROM members WHERE member_no = $1 AND holder_type = 'GROUP'", [gno])).rows[0];
        if (!g) throw err(`No group ${gno}, here or on the Groups sheet`);
        const current = (await CL.groupMembers(c, g.id)).map((x) => ({ memberId: x.member_id, roles: x.roles }));
        const out = await CL.setGroupMembers(c, g.id, [...current, ...list.map((x) => ({ memberId: x.memberId, roles: x.roles }))], { user, checkPermission: false });
        for (const w of out.warnings) warnings.push({ sheet: layout.members?.sheet || 'Members', row: list[0].r._row, column: 'Group ID', message: `${gno}: ${w}` });
        return list.length;
      });
      if (ok) created.groupMembers += ok;
    }
  }
  const member = async (no) => {
    if (members.has(no)) return members.get(no);
    dependsOn(failed.member, no, 'Member');
    const { rows: [m] } = await c.query('SELECT id, branch_id, holder_type FROM members WHERE member_no = $1', [no]);
    if (!m) throw err(`No member ${no}, here or on the Members sheet`);
    members.set(no, m);
    return m;
  };

  const subledger = { deposits: new Map(), overdrafts: new Map(), shares: new Map(), loans: new Map() };
  const addTo = (map, gl, amount) => { if (gl && amount) map.set(gl, definitions.round2((map.get(gl) || 0) + amount)); };

  for (const r of data.deposits) {
    const ok = await row('deposits', r, 'Account number', async () => {
      const m = await member(r.memberNo);
      const bId = await branchId(r.branch);
      const a = await SV.open(c, { memberId: m.id, productId: r.productId, accountNo: r.accountNo, branchId: bId,
        overdraftLimit: r.overdraftLimit || 0, openedOn: r.openedOn || asOf, customFields: await coerce('SAVINGS_ACCOUNT', r.customFields), user });
      const { rows: [p] } = await c.query('SELECT * FROM savings_products WHERE id = $1', [r.productId]);
      const odPrincipal = definitions.round2(r.overdraftDue || 0);
      const odInterest = definitions.round2(r.overdraftInterestDue || 0);
      const odFees = definitions.round2(r.overdraftFeesDue || 0);
      const overdrawn = definitions.round2(odPrincipal + odInterest + odFees);
      if (overdrawn > 0 && !p.allow_overdraft) throw err(`Product ${p.id} does not allow overdrafts`);
      if (overdrawn > definitions.round2(r.overdraftLimit || 0) + 0.001 && !p.allow_technical_overdraft) {
        throw err(`The account is overdrawn by ${overdrawn}, more than its limit of ${r.overdraftLimit || 0}`);
      }
      if (r.overdraftRate !== null && !p.allow_overdraft) throw err(`Product ${p.id} does not allow overdrafts, so it takes no overdraft rate`);
      const balance = overdrawn > 0 ? -overdrawn : r.balance;
      // Under cash accounting overdraft interest and fees applied but unpaid
      // are income when paid; under accrual they are in the receivables the
      // opening balances carry.
      const cash = p.accounting_method !== 'ACCRUAL';
      await c.query(
        `UPDATE savings_accounts SET balance = $2, accrued_through = $3::date, last_interest_applied_on = $3::date,
           period_started_on = $3::date + 1, import_id = $4, applied_on = $5::date, notes = $6, overdraft_rate = $7,
           od_interest_due = $8, od_fees_due = $9
         WHERE id = $1`,
        [a.id, balance, asOf, importId, r.appliedOn || r.openedOn || asOf, r.notes, r.overdraftRate, cash ? odInterest : 0, cash ? odFees : 0]);
      if (balance !== 0) {
        await SV.record(c, { reference: SV.ref('MG'), kind: 'MIGRATION_OPENING_BALANCE', memberId: m.id, savingsAccountId: a.id,
          amount: Math.abs(balance), valueDate: r.openedOn || asOf, narration: 'Balance brought forward (data import)', createdBy,
          allocation: { importId, ...(balance < 0 ? { overdrawn: true, odPrincipal, odInterest, odFees } : {}) } });
      }
      addTo(subledger.deposits, p.gl_liability, Math.max(0, balance));
      addTo(subledger.overdrafts, p.gl_od_portfolio, odPrincipal);
      push('deposits', { accountNo: r.accountNo, memberNo: r.memberNo, product: r.productId, balance, overdraftLimit: r.overdraftLimit || 0,
        overdraftRate: r.overdraftRate, openedOn: r.openedOn || asOf });
      return a;
    });
    tick();
    if (ok) created.deposits += 1;
  }

  for (const r of data.shares) {
    const ok = await row('shares', r, 'Account number', async () => {
      const m = await member(r.memberNo);
      const { rows: [p] } = await c.query('SELECT * FROM share_products WHERE id = $1', [r.productId]);
      if (!p) throw err(`No share product ${r.productId}`);
      if (!(r.units > 0)) throw err('Units must be more than zero');
      const a = await SH.open(c, { memberId: m.id, productId: r.productId, accountNo: r.accountNo });
      await c.query('UPDATE share_accounts SET units = $2, import_id = $3 WHERE id = $1', [a.id, r.units, importId]);
      const amount = definitions.round2(r.units * Number(p.unit_price));
      await c.query(
        `INSERT INTO share_movements (account_id, member_id, units, unit_price, amount, kind, value_date)
         VALUES ($1,$2,$3,$4,$5,'MIGRATION',$6)`, [a.id, m.id, r.units, p.unit_price, amount, asOf]);
      addTo(subledger.shares, p.gl_equity, amount);
      push('shares', { accountNo: r.accountNo, memberNo: r.memberNo, product: r.productId, units: r.units, value: amount });
      return a;
    });
    tick();
    if (ok) created.shares += 1;
  }

  // Loans: the closed ones first, so a member's old loans are history
  // before the running one is opened (a product may allow one at a time).
  const schedules = definitions.groupBy(data.schedule, (x) => x.accountNo);
  const transactions = definitions.groupBy(data.transactions, (x) => x.accountNo);
  const rank = { CLOSED: 0, WITHDRAWN: 0, REJECTED: 0, WRITTEN_OFF: 1, ACTIVE: 2, APPROVED: 3, PENDING_APPROVAL: 3 };
  const loans = [...data.loans].sort((a, b) => (rank[a.state || 'ACTIVE'] ?? 2) - (rank[b.state || 'ACTIVE'] ?? 2));
  for (const r of loans) {
    const ok = await row('loans', r, 'Account number', async () => {
      const m = await member(r.memberNo);
      // Client type G: the loan is the group's (the reference platform's group loan).
      if ((r.clientType || 'C') === 'G' && m.holder_type !== 'GROUP') throw err(`Client type G, but ${r.memberNo} is a member, not a group`);
      if ((r.clientType || 'C') === 'C' && m.holder_type === 'GROUP') throw err(`${r.memberNo} is a group; give the client type G`);
      const bId = await branchId(r.branch);
      const spec = specOf(r, schedules.get(r.accountNo), transactions.get(r.accountNo));
      spec.memberId = m.id;
      if (bId !== undefined) spec.branchId = bId;
      spec.customFields = await coerce('LOAN_ACCOUNT', r.customFields);
      const out = await LM.migrate(c, spec, { asOf, importId, createdBy, user });
      for (const w of out.warnings) warnings.push({ sheet: layout.loans?.sheet || 'Loan Accounts', row: r._row, column: 'Account number', message: w });
      addTo(subledger.loans, out.loan.gl_portfolio, out.principalOutstanding);
      created.installments += out.installments;
      created.transactions += spec.transactions.length;
      if (preview) {
        const b = L.balances(out.loan);
        const item = { accountNo: r.accountNo, memberNo: r.memberNo, product: r.productId, status: out.loan.status, principal: Number(out.loan.principal),
          principalOutstanding: b.principal, interestOutstanding: b.interest, feesOutstanding: b.fees, penaltyOutstanding: b.penalty,
          arrearsSince: out.loan.arrears_since, disbursedOn: out.loan.disbursed_on, installments: out.installments };
        if ((preview.loans || []).length < definitions.PREVIEW_SCHEDULES) {
          item.schedule = (await c.query(
            `SELECT number, due_date, principal_due, principal_paid, interest_due, interest_paid, fee_due, fee_paid, status, late_fee_exempt
             FROM loan_installments WHERE loan_id = $1 ORDER BY number`, [out.loan.id])).rows;
        }
        push('loans', item);
      }
      return out.loan;
    });
    tick();
    if (ok) created.loans += 1;
  }

  // The opening balances, one entry on the migration date.
  let entryId = null;
  const sheetGl = new Map();
  const lines = openingLines(data);
  if (lines.length) {
    const posted = [];
    let good = true;
    const key = data.glBalances.length ? 'glBalances' : 'chart';
    for (const l of lines) {
      const ok = await row(key, l.row, key === 'glBalances' ? 'GL code' : 'GL Code', async () => {
        const { rows: [g] } = await c.query('SELECT code, type, usage FROM gl_accounts WHERE code = $1', [l.glCode]);
        if (!g) throw err(`No GL account ${l.glCode}, in the chart or on the GL Accounts sheet`);
        if (g.usage === 'HEADER') throw err(`GL account ${l.glCode} is a header account and takes no postings`);
        const bId = await branchId(l.branch);
        posted.push({ glCode: l.glCode, amount: l.amount, side: l.side, branchId: bId || null });
        sheetGl.set(l.glCode, definitions.round2((sheetGl.get(l.glCode) || 0) + (l.side === 'D' ? l.amount : -l.amount)));
        return true;
      });
      if (!ok) good = false;
    }
    if (good && posted.length) {
      const ok = await row(key, { _row: null }, null, async () => acct.post(c, {
        debits: posted.filter((x) => x.side === 'D'),
        credits: posted.filter((x) => x.side === 'C'),
        bookingDate: asOf,
        narration: 'Opening balances (data import)',
        sourceType: 'DATA_IMPORT', sourceId: importId, createdBy,
      }));
      if (ok) {
        entryId = ok.entryId; created.openingEntryLines = ok.lineCount;
        if (preview) preview.openingEntry = posted.map((x) => ({ glCode: x.glCode, debit: x.side === 'D' ? x.amount : 0, credit: x.side === 'C' ? x.amount : 0 }));
      }
    }
    // Subledgers against the opening balances: loan and overdraft
    // portfolios are debit balances, deposits and share capital credits.
    const compare = (map, sign, what) => {
      for (const [gl, t] of map) {
        const inSheet = definitions.round2((sheetGl.get(gl) || 0) * sign);
        if (definitions.round2(t) !== inSheet) {
          warnings.push({ sheet: layout[key]?.sheet || 'GL Balances', row: null, column: 'GL code',
            message: `${what} add up to ${definitions.round2(t)} on GL account ${gl}; the opening balances have ${inSheet}` });
        }
      }
    };
    compare(subledger.loans, 1, 'Loan principal outstanding');
    compare(subledger.overdrafts, 1, 'Overdrawn deposit accounts');
    compare(subledger.deposits, -1, 'Deposit balances');
    compare(subledger.shares, -1, 'Share capital');
  } else if (data.loans.length || data.deposits.length || data.shares.length) {
    warnings.push({ sheet: 'GL Balances', row: null, column: null,
      message: 'Accounts are imported with balances but there are no opening balances (GL Balances or Chart of Accounts): the general ledger will not show them until an opening entry is posted.' });
  }
  tick();
  return { errors, warnings, created, entryId };
}

/** Why a row failed, in the words of the sheet rather than the database. */
function explain(e) {
  if (e.code === '23505') {
    const k = String(e.detail || e.constraint || '');
    if (/member_no/.test(k)) return 'The member number is already in use';
    if (/account_no/.test(k)) return 'The account number is already in use';
    return `Already exists (${e.constraint || 'unique'})`;
  }
  if (e.code === '23503') return `Refers to something that does not exist (${e.constraint || 'foreign key'})`;
  if (e.code === '23514') return String(e.message).replace(/^new row .* violates check constraint/, 'A value is out of range:');
  return String(e.message || e).replace(/_/g, ' ').replace(/^([A-Z ]+):/, (m) => m.charAt(0) + m.slice(1).toLowerCase());
}

Object.assign(module.exports, {
  COLUMN_OF, columnFor, specOf, openingLines, prerequisites, execute, explain,
});
