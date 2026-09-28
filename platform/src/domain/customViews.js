'use strict';

const { pageParams } = require('../lib/page');
const PERMS = require('../lib/permissions');
const ROLES = require('./roles');
const CF = require('./customFields');

/**
 * Custom views (the reference platform's Custom Views, and custom views with API v1): a
 * filter, a set of columns and a sort over one kind of record. A temporary
 * view is run once and not kept; a saved view has a name and usage rights.
 *
 * Every field a view can show or filter on is declared below with the SQL
 * that produces it, so a view can only ever read what is listed here: the
 * definition a user sends names fields, never SQL. Custom field values are
 * offered for records that carry them (standard sets), under each field's
 * view rights.
 *
 * Who sees a saved view: its creator, a tenant administrator, and, when the
 * administrator has said so, every user or the users holding one of its
 * roles (the reference platform's usage rights, which only administrators set). The view's
 * kind of record still needs the user's role to be allowed it: journal
 * entries go to the ledger roles, activities to administrators, managers and
 * auditors.
 */

function err(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

const ADMIN = 'TENANT_ADMIN';
const EXPORT_MAX = 100000;

// Field types and the operators each takes (the reference platform's search operators).
const OPS = {
  TEXT: ['EQUALS', 'EQUALS_CASE_SENSITIVE', 'DIFFERENT_THAN', 'STARTS_WITH', 'STARTS_WITH_CASE_SENSITIVE', 'IN', 'EMPTY', 'NOT_EMPTY'],
  SELECTION: ['EQUALS', 'DIFFERENT_THAN', 'IN', 'EMPTY', 'NOT_EMPTY'],
  NUMBER: ['EQUALS', 'DIFFERENT_THAN', 'MORE_THAN', 'LESS_THAN', 'BETWEEN', 'EMPTY', 'NOT_EMPTY'],
  MONEY: ['EQUALS', 'DIFFERENT_THAN', 'MORE_THAN', 'LESS_THAN', 'BETWEEN', 'EMPTY', 'NOT_EMPTY'],
  DATE: ['ON', 'AFTER', 'AFTER_INCLUSIVE', 'BEFORE', 'BEFORE_INCLUSIVE', 'BETWEEN', 'TODAY', 'THIS_WEEK', 'THIS_MONTH', 'THIS_YEAR', 'LAST_DAYS', 'EMPTY', 'NOT_EMPTY'],
  TIMESTAMP: ['ON', 'AFTER', 'AFTER_INCLUSIVE', 'BEFORE', 'BEFORE_INCLUSIVE', 'BETWEEN', 'TODAY', 'THIS_WEEK', 'THIS_MONTH', 'THIS_YEAR', 'LAST_DAYS', 'EMPTY', 'NOT_EMPTY'],
  BOOLEAN: ['EQUALS', 'EMPTY', 'NOT_EMPTY'],
};

const f = (label, sql, type = 'TEXT', extra = {}) => ({ label, sql, type, ...extra });
const LOAN_STATES = ['PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'IN_ARREARS', 'LOCKED', 'CLOSED_REPAID',
  'CLOSED_WRITTEN_OFF', 'CLOSED_REJECTED', 'CLOSED_WITHDRAWN', 'CLOSED_RESCHEDULED', 'CLOSED_REFINANCED'];

/**
 * The kinds of record. `from` is the FROM clause, `id` the row identity,
 * `cf` the alias whose custom_fields holds custom values and the custom
 * field entity it answers to, `reference` the name API v1 uses.
 */
const ENTITIES = {
  MEMBERS: {
    label: 'Members', reference: 'CLIENTS', table: 'members', idSql: 'm.id', permission: 'VIEW_CLIENT_DETAILS',
    from: 'members m LEFT JOIN branches b ON b.id = m.branch_id LEFT JOIN centres ce ON ce.id = m.centre_id',
    cf: { alias: 'm', entity: 'MEMBER' },
    defaults: ['memberNo', 'fullName', 'status', 'branch', 'phone'],
    fields: {
      memberNo: f('Member number', 'm.member_no'),
      firstName: f('First name', 'm.first_name'),
      middleName: f('Middle name', 'm.middle_name'),
      lastName: f('Last name', 'm.last_name'),
      fullName: f('Name', "concat_ws(' ', m.first_name, m.middle_name, m.last_name)"),
      nationalId: f('National ID', 'm.national_id'),
      kraPin: f('KRA PIN', 'm.kra_pin'),
      phone: f('Phone', 'm.phone'),
      email: f('Email', 'm.email'),
      gender: f('Gender', 'm.gender', 'SELECTION', { values: ['MALE', 'FEMALE', 'OTHER'] }),
      dateOfBirth: f('Date of birth', 'm.date_of_birth', 'DATE'),
      status: f('State', 'm.status', 'SELECTION', { values: ['PENDING', 'ACTIVE', 'DORMANT', 'EXITED', 'DECEASED'] }),
      joinedOn: f('Joined on', 'm.joined_on', 'DATE'),
      exitedOn: f('Exited on', 'm.exited_on', 'DATE'),
      branch: f('Branch', 'b.code'),
      branchName: f('Branch name', 'b.name'),
      centre: f('Centre', 'ce.code'),
      creditOfficer: f('Credit officer', 'm.credit_officer'),
      employer: f('Employer', 'm.employer'),
      city: f('City', 'm.city'),
      region: f('Region', 'm.region'),
      country: f('Country', 'm.country'),
      runningLoans: f('Running loans', "(SELECT count(*) FROM loan_accounts l WHERE l.member_id = m.id AND l.status IN ('ACTIVE','IN_ARREARS','LOCKED'))::int", 'NUMBER'),
      loanBalance: f('Loan principal outstanding', "(SELECT COALESCE(SUM(GREATEST(l.principal_disbursed - l.principal_paid, 0)), 0) FROM loan_accounts l WHERE l.member_id = m.id AND l.status IN ('ACTIVE','IN_ARREARS','LOCKED'))", 'MONEY'),
      depositBalance: f('Deposit balance', "(SELECT COALESCE(SUM(a.balance), 0) FROM savings_accounts a WHERE a.member_id = m.id AND a.status = 'ACTIVE')", 'MONEY'),
      createdAt: f('Created', 'm.created_at', 'TIMESTAMP'),
      updatedAt: f('Last modified', 'm.updated_at', 'TIMESTAMP'),
    },
  },
  LOANS: {
    label: 'Loans', reference: 'LOANS', table: 'loan_accounts', idSql: 'l.id', permission: 'VIEW_LOAN_ACCOUNT_DETAILS',
    from: `loan_accounts l JOIN members m ON m.id = l.member_id LEFT JOIN branches b ON b.id = l.branch_id
      LEFT JOIN loan_products p ON p.id = l.product_id
      LEFT JOIN LATERAL (SELECT GREATEST(0, MAX(current_date - i.due_date))::int AS days_late FROM loan_installments i
        WHERE i.loan_id = l.id AND i.status <> 'PAID' AND i.due_date < current_date) lt ON true`,
    cf: { alias: 'l', entity: 'LOAN_ACCOUNT' },
    defaults: ['accountNo', 'memberName', 'productName', 'status', 'principalOutstanding', 'daysLate'],
    fields: {
      accountNo: f('Account number', 'l.account_no'),
      name: f('Loan name', 'l.name'),
      memberNo: f('Member number', 'm.member_no'),
      memberName: f('Member', "concat_ws(' ', m.first_name, m.last_name)"),
      productId: f('Product', 'l.product_id'),
      productName: f('Product name', 'p.name'),
      status: f('State', 'l.status', 'SELECTION', { values: LOAN_STATES }),
      principal: f('Loan amount', 'l.principal', 'MONEY'),
      termMonths: f('Installments', 'l.term_months', 'NUMBER'),
      interestRate: f('Interest rate', 'l.monthly_rate', 'NUMBER'),
      principalDisbursed: f('Principal disbursed', 'l.principal_disbursed', 'MONEY'),
      principalPaid: f('Principal paid', 'l.principal_paid', 'MONEY'),
      principalOutstanding: f('Principal outstanding', 'GREATEST(l.principal_disbursed - l.principal_paid, 0)', 'MONEY'),
      interestOutstanding: f('Interest outstanding', 'GREATEST(l.interest_accrued - l.interest_paid, 0)', 'MONEY'),
      feesOutstanding: f('Fees outstanding', 'GREATEST(l.fees_due - l.fees_paid, 0) + GREATEST(COALESCE(l.ns_fees_due, 0) - COALESCE(l.ns_fees_paid, 0), 0)', 'MONEY'),
      penaltyOutstanding: f('Penalty outstanding', 'GREATEST(l.penalty_accrued - l.penalty_paid, 0)', 'MONEY'),
      totalOutstanding: f('Total outstanding', 'GREATEST(l.principal_disbursed - l.principal_paid, 0) + GREATEST(l.interest_accrued - l.interest_paid, 0) + GREATEST(l.fees_due - l.fees_paid, 0) + GREATEST(l.penalty_accrued - l.penalty_paid, 0)', 'MONEY'),
      daysLate: f('Days late', "CASE WHEN l.status IN ('ACTIVE','IN_ARREARS','LOCKED') THEN COALESCE(lt.days_late, 0) ELSE 0 END", 'NUMBER'),
      nextDueDate: f('Next due date', "(SELECT min(i.due_date) FROM loan_installments i WHERE i.loan_id = l.id AND i.status <> 'PAID')", 'DATE'),
      nextDueAmount: f('Next due amount', `(SELECT round(i.principal_due - i.principal_paid + i.interest_due - i.interest_paid + i.fee_due - i.fee_paid, 2)
        FROM loan_installments i WHERE i.loan_id = l.id AND i.status <> 'PAID' ORDER BY i.due_date LIMIT 1)`, 'MONEY'),
      arrearsSince: f('In arrears since', 'l.arrears_since', 'DATE'),
      appliedOn: f('Applied on', 'l.applied_on', 'DATE'),
      approvedOn: f('Approved on', 'l.approved_on', 'DATE'),
      disbursedOn: f('Disbursed on', 'l.disbursed_on', 'DATE'),
      closedOn: f('Closed on', 'l.closed_on', 'DATE'),
      writtenOffAmount: f('Written off', 'l.written_off_amount', 'MONEY'),
      writtenOffOn: f('Written off on', 'l.written_off_on', 'DATE'),
      branch: f('Branch', 'b.code'),
      creditOfficer: f('Credit officer', 'COALESCE(l.credit_officer, m.credit_officer)'),
      purpose: f('Purpose', 'l.purpose'),
      createdAt: f('Created', 'l.created_at', 'TIMESTAMP'),
      updatedAt: f('Last modified', 'l.updated_at', 'TIMESTAMP'),
    },
  },
  LOAN_TRANSACTIONS: {
    label: 'Loan transactions', reference: 'LOAN_TRANSACTIONS', table: 'transactions', idSql: 't.id', permission: 'VIEW_LOAN_ACCOUNT_DETAILS',
    from: 'transactions t JOIN loan_accounts l ON l.id = t.loan_account_id JOIN members m ON m.id = l.member_id LEFT JOIN branches b ON b.id = t.branch_id',
    cf: { alias: 't', entity: 'TRANSACTION_CHANNEL' },
    defaults: ['reference', 'valueDate', 'kind', 'accountNo', 'amount'],
    fields: {
      reference: f('Reference', 't.reference'),
      kind: f('Type', 't.kind', 'SELECTION', { values: ['LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'LOAN_FEE', 'LOAN_FEE_WAIVED', 'LOAN_INTEREST_ACCRUAL', 'LOAN_INTEREST_CAPITALIZED', 'LOAN_WRITE_OFF', 'LOAN_RECOVERY', 'LOAN_RESCHEDULE', 'LOAN_REFINANCE', 'LOAN_BALANCE_WRITE_OFF', 'LOAN_FEE_ADJUSTED', 'LOAN_PENALTY_ADJUSTED', 'LOAN_RATE_CHANGED', 'LOAN_TERMINATED', 'REVERSAL'] }),
      accountNo: f('Loan account', 'l.account_no'),
      memberNo: f('Member number', 'm.member_no'),
      memberName: f('Member', "concat_ws(' ', m.first_name, m.last_name)"),
      productId: f('Product', 'l.product_id'),
      amount: f('Amount', 't.amount', 'MONEY'),
      principal: f('Principal', "COALESCE((t.allocation->>'principal')::numeric, 0)", 'MONEY'),
      interest: f('Interest', "COALESCE((t.allocation->>'interest')::numeric, 0)", 'MONEY'),
      fees: f('Fees', "COALESCE((t.allocation->>'fees')::numeric, 0)", 'MONEY'),
      penalty: f('Penalty', "COALESCE((t.allocation->>'penalty')::numeric, 0)", 'MONEY'),
      valueDate: f('Value date', 't.value_date', 'DATE'),
      channel: f('Channel', 't.channel_id'),
      reversed: f('Reversed', 't.reversed_by IS NOT NULL', 'BOOLEAN'),
      narration: f('Narration', 't.narration'),
      branch: f('Branch', 'b.code'),
      createdBy: f('Entered by', 't.created_by'),
      createdAt: f('Entered', 't.created_at', 'TIMESTAMP'),
    },
  },
  DEPOSITS: {
    label: 'Deposit accounts', reference: 'DEPOSITS', table: 'savings_accounts', idSql: 'a.id', permission: 'VIEW_SAVINGS_ACCOUNT_DETAILS',
    from: 'savings_accounts a JOIN members m ON m.id = a.member_id LEFT JOIN branches b ON b.id = a.branch_id LEFT JOIN savings_products sp ON sp.id = a.product_id',
    cf: { alias: 'a', entity: 'SAVINGS_ACCOUNT' },
    defaults: ['accountNo', 'memberName', 'productName', 'status', 'balance'],
    fields: {
      accountNo: f('Account number', 'a.account_no'),
      memberNo: f('Member number', 'm.member_no'),
      memberName: f('Member', "concat_ws(' ', m.first_name, m.last_name)"),
      productId: f('Product', 'a.product_id'),
      productName: f('Product name', 'sp.name'),
      status: f('State', 'a.status', 'SELECTION', { values: ['PENDING', 'ACTIVE', 'DORMANT', 'LOCKED', 'CLOSED'] }),
      balance: f('Balance', 'a.balance', 'MONEY'),
      interestAccrued: f('Interest accrued', 'a.interest_accrued', 'MONEY'),
      overdraftLimit: f('Overdraft limit', 'a.overdraft_limit', 'MONEY'),
      openedOn: f('Opened on', 'a.opened_on', 'DATE'),
      closedOn: f('Closed on', 'a.closed_on', 'DATE'),
      branch: f('Branch', 'b.code'),
      createdAt: f('Created', 'a.created_at', 'TIMESTAMP'),
      updatedAt: f('Last modified', 'a.updated_at', 'TIMESTAMP'),
    },
  },
  DEPOSIT_TRANSACTIONS: {
    label: 'Deposit transactions', reference: 'DEPOSIT_TRANSACTIONS', table: 'transactions', idSql: 't.id', permission: 'VIEW_SAVINGS_ACCOUNT_DETAILS',
    from: 'transactions t JOIN savings_accounts a ON a.id = t.savings_account_id JOIN members m ON m.id = a.member_id LEFT JOIN branches b ON b.id = t.branch_id',
    cf: { alias: 't', entity: 'TRANSACTION_CHANNEL' },
    defaults: ['reference', 'valueDate', 'kind', 'accountNo', 'amount'],
    fields: {
      reference: f('Reference', 't.reference'),
      kind: f('Type', 't.kind', 'SELECTION', { values: ['SAVINGS_DEPOSIT', 'SAVINGS_WITHDRAWAL', 'SAVINGS_TRANSFER', 'SAVINGS_FEE', 'SAVINGS_INTEREST_ACCRUAL', 'SAVINGS_INTEREST_APPLIED', 'SAVINGS_WITHHOLDING_TAX', 'SAVINGS_NEGATIVE_INTEREST', 'OVERDRAFT_INTEREST_APPLIED', 'OVERDRAFT_WRITE_OFF', 'REVERSAL'] }),
      accountNo: f('Deposit account', 'a.account_no'),
      memberNo: f('Member number', 'm.member_no'),
      memberName: f('Member', "concat_ws(' ', m.first_name, m.last_name)"),
      productId: f('Product', 'a.product_id'),
      amount: f('Amount', 't.amount', 'MONEY'),
      valueDate: f('Value date', 't.value_date', 'DATE'),
      channel: f('Channel', 't.channel_id'),
      reversed: f('Reversed', 't.reversed_by IS NOT NULL', 'BOOLEAN'),
      narration: f('Narration', 't.narration'),
      branch: f('Branch', 'b.code'),
      createdBy: f('Entered by', 't.created_by'),
      createdAt: f('Entered', 't.created_at', 'TIMESTAMP'),
    },
  },
  JOURNAL_ENTRIES: {
    label: 'Journal entries', reference: 'JOURNAL_ENTRIES', table: 'journal_lines', idSql: 'jl.id', permission: 'VIEW_ACCOUNTING_REPORTS',
    from: 'journal_lines jl JOIN journal_entries e ON e.id = jl.entry_id JOIN gl_accounts g ON g.code = jl.gl_code LEFT JOIN branches b ON b.id = jl.branch_id',
    defaults: ['bookingDate', 'glCode', 'glName', 'debit', 'credit', 'narration'],
    fields: {
      entryId: f('Entry', 'e.id::text'),
      bookingDate: f('Booking date', 'e.booking_date', 'DATE'),
      glCode: f('GL account', 'jl.gl_code'),
      glName: f('GL account name', 'g.name'),
      glType: f('GL type', 'g.type', 'SELECTION', { values: ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] }),
      direction: f('Direction', 'jl.direction', 'SELECTION', { values: ['DEBIT', 'CREDIT'] }),
      debit: f('Debit', "CASE WHEN jl.direction = 'DEBIT' THEN jl.amount ELSE 0 END", 'MONEY'),
      credit: f('Credit', "CASE WHEN jl.direction = 'CREDIT' THEN jl.amount ELSE 0 END", 'MONEY'),
      amount: f('Amount', 'jl.amount', 'MONEY'),
      narration: f('Narration', 'e.narration'),
      sourceType: f('Source', 'e.source_type'),
      branch: f('Branch', 'b.code'),
      createdBy: f('Entered by', 'e.created_by'),
      createdAt: f('Entered', 'e.created_at', 'TIMESTAMP'),
    },
  },
  ACTIVITIES: {
    label: 'System activities', reference: 'ACTIVITIES', table: 'audit_log', idSql: 'x.id', permission: 'AUDIT_TRANSACTIONS',
    from: 'audit_log x',
    defaults: ['createdAt', 'actor', 'action', 'entity', 'entityId'],
    fields: {
      actor: f('User', 'x.actor'),
      action: f('Action', 'x.action'),
      entity: f('Record', 'x.entity'),
      entityId: f('Record id', 'x.entity_id'),
      ip: f('IP address', 'host(x.ip)'),
      createdAt: f('When', 'x.created_at', 'TIMESTAMP'),
    },
  },
  TASKS: {
    label: 'Tasks', reference: 'TASKS', table: 'tasks', idSql: 'k.id', permission: 'VIEW_TASK',
    from: 'tasks k LEFT JOIN members m ON m.id = k.member_id LEFT JOIN branches b ON b.id = k.branch_id',
    // A user's task views list the tasks they may see (./tasks).
    scope: (user, p) => (user.role === 'TENANT_ADMIN' ? null
      : `(lower(k.assigned_email) = lower(${p(user.email)}) OR lower(k.created_by) = lower(${p(user.email)})${user.branchId && PERMS.can(user, 'EDIT_TASK') ? ` OR k.branch_id = ${p(user.branchId)}::uuid` : ''})`),
    defaults: ['title', 'assignedTo', 'dueDate', 'state', 'memberNo'],
    fields: {
      title: f('Title', 'k.title'),
      description: f('Notes', 'k.description'),
      assignedTo: f('Assigned to', 'k.assigned_email'),
      dueDate: f('Due date', 'k.due_date', 'DATE'),
      status: f('Status', 'k.status', 'SELECTION', { values: ['OPEN', 'COMPLETED'] }),
      state: f('State', "CASE WHEN k.status = 'OPEN' AND k.due_date < current_date THEN 'OVERDUE' ELSE k.status END", 'SELECTION', { values: ['OPEN', 'OVERDUE', 'COMPLETED'] }),
      memberNo: f('Member number', 'm.member_no'),
      memberName: f('Member', "concat_ws(' ', m.first_name, m.last_name)"),
      branch: f('Branch', 'b.code'),
      completedAt: f('Completed', 'k.completed_at', 'TIMESTAMP'),
      completedBy: f('Completed by', 'k.completed_by'),
      createdBy: f('Created by', 'k.created_by'),
      createdAt: f('Created', 'k.created_at', 'TIMESTAMP'),
    },
  },
};

const API_NAME_FOR = Object.fromEntries(Object.entries(ENTITIES).map(([k, e]) => [e.reference, k]));

function entityOf(name) {
  const key = String(name || '').toUpperCase();
  const e = ENTITIES[key] || ENTITIES[API_NAME_FOR[key]];
  if (!e) throw err(`UNKNOWN_VIEW_ENTITY: ${name} (use ${Object.keys(ENTITIES).join(', ')})`);
  return { key: ENTITIES[key] ? key : API_NAME_FOR[key], ...e };
}

/** Whether a user may see an entity's records (the reference platform: the menu item type's permission). */
const allowed = (e, user) => PERMS.can(user, e.permission);
function assertEntityAllowed(e, user) {
  if (!allowed(e, user)) throw err(`PERMISSION_REQUIRED: ${e.permission} for ${e.key}`, 403);
}

// --------------------------------------------------------------------------
// Fields, including custom fields
// --------------------------------------------------------------------------

const IDENT = /^[A-Za-z0-9_]+$/;
const CF_TYPES = { FREE_TEXT: 'TEXT', SELECTION: 'SELECTION', NUMBER: 'NUMBER', CHECKBOX: 'BOOLEAN', DATE: 'DATE', DATE_TIME: 'TIMESTAMP', MEMBER_LINK: 'TEXT', USER_LINK: 'TEXT' };

/** A custom field's text as its type. */
function typed(type, raw) {
  return type === 'NUMBER' ? `(CASE WHEN ${raw} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${raw}::numeric END)`
    : type === 'BOOLEAN' ? `(CASE WHEN lower(${raw}) IN ('true', 'false') THEN ${raw}::boolean END)`
      : type === 'DATE' ? `(CASE WHEN ${raw} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(${raw}, 10)::date END)`
        : type === 'TIMESTAMP' ? `(CASE WHEN ${raw} ~ '^[0-9]{4}-' THEN (${raw})::timestamptz END)`
          : raw;
}

/** Every field of an entity the user may use: { key: {label, sql, type, values?} }. */
async function fieldsFor(c, e, user) {
  const out = { ...e.fields };
  if (!e.cf) return out;
  const { rows } = await c.query(
    `SELECT d.id, d.set_id, d.name, d.field_type, d.options, d.view_roles, s.name AS set_name, s.set_type
     FROM custom_field_definitions d JOIN custom_field_sets s ON s.id = d.set_id
     WHERE d.entity = $1 AND s.set_type IN ('STANDARD', 'GROUPED') AND d.is_active ORDER BY s.sort_order, d.sort_order, d.id`, [e.cf.entity]);
  for (const d of rows) {
    if (!IDENT.test(d.id) || !IDENT.test(d.set_id)) continue;
    if (user && d.view_roles && !d.view_roles.includes(user.role)) continue;
    const type = CF_TYPES[d.field_type] || 'TEXT';
    const values = type === 'SELECTION' && Array.isArray(d.options) ? d.options.map((o) => (typeof o === 'object' ? o.value ?? o.id ?? o.name : o)) : undefined;
    const key = `cf:${d.set_id}.${d.id}`;
    const label = `${d.set_name}: ${d.name}`;
    if (d.set_type === 'GROUPED') {
      // A grouped set holds a list of entries, each with the set's fields. The
      // column shows every entry's value; a filter matches when any entry does.
      const arr = `(CASE WHEN jsonb_typeof(${e.cf.alias}.custom_fields -> '${d.set_id}') = 'array' THEN ${e.cf.alias}.custom_fields -> '${d.set_id}' ELSE '[]'::jsonb END)`;
      out[key] = {
        label, type, outputType: 'TEXT', custom: true, grouped: true, arraySql: arr, elemSql: typed(type, `(ge.value ->> '${d.id}')`),
        sql: `(SELECT string_agg(ge.value ->> '${d.id}', ', ' ORDER BY ge.ordinality) FROM jsonb_array_elements(${arr}) WITH ORDINALITY ge WHERE COALESCE(ge.value ->> '${d.id}', '') <> '')`,
        ...(values ? { values } : {}),
      };
      continue;
    }
    const raw = `(${e.cf.alias}.custom_fields -> '${d.set_id}' ->> '${d.id}')`;
    out[key] = { label, sql: typed(type, raw), type, custom: true, ...(values ? { values } : {}) };
  }
  return out;
}

/** The fields of an entity for a client to build a view with. */
async function describe(c, entity, user) {
  const e = entityOf(entity);
  assertEntityAllowed(e, user);
  const fields = await fieldsFor(c, e, user);
  return {
    entity: e.key, label: e.label, apiType: e.reference, defaultColumns: e.defaults,
    fields: Object.entries(fields).map(([key, x]) => ({
      key, label: x.label, type: x.type, operators: OPS[x.type], ...(x.values ? { values: x.values } : {}),
      custom: Boolean(x.custom), grouped: Boolean(x.grouped),
    })),
  };
}

function entities(user) {
  return Object.entries(ENTITIES).filter(([, e]) => allowed(e, user))
    .map(([key, e]) => ({ entity: key, label: e.label, apiType: e.reference }));
}

// --------------------------------------------------------------------------
// The query
// --------------------------------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One filter condition to SQL, pushing its values onto params. A grouped
 * custom field matches when any of its entries does (EMPTY: none has a value).
 */
function condition(field, flt, params) {
  if (field.grouped) {
    const op = String(flt.operator || 'EQUALS').toUpperCase();
    const inner = { ...field, grouped: false, sql: field.elemSql };
    const each = `FROM jsonb_array_elements(${field.arraySql}) ge`;
    if (op === 'EMPTY') return `NOT EXISTS (SELECT 1 ${each} WHERE ${condition(inner, { ...flt, operator: 'NOT_EMPTY' }, params)})`;
    if (op === 'DIFFERENT_THAN') return `NOT EXISTS (SELECT 1 ${each} WHERE ${condition(inner, { ...flt, operator: 'EQUALS' }, params)})`;
    return `EXISTS (SELECT 1 ${each} WHERE ${condition(inner, flt, params)})`;
  }
  return conditionOf(field, flt, params);
}

function conditionOf(field, flt, params) {
  const op = String(flt.operator || 'EQUALS').toUpperCase();
  if (!OPS[field.type].includes(op)) throw err(`OPERATOR_NOT_ALLOWED: ${op} on ${flt.field} (${field.type}; use ${OPS[field.type].join(', ')})`);
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const isDate = field.type === 'DATE' || field.type === 'TIMESTAMP';
  // A timestamp is compared by the organization's day (the session zone).
  const col = field.type === 'TIMESTAMP' ? `(${field.sql})::date` : `(${field.sql})`;
  const cast = isDate ? '::date' : ['NUMBER', 'MONEY'].includes(field.type) ? '::numeric' : field.type === 'BOOLEAN' ? '::boolean' : '::text';
  const need = (v, what = 'value') => {
    if (v === undefined || v === null || v === '') throw err(`FILTER_VALUE_REQUIRED: ${flt.field} ${op} needs a ${what}`);
    if (isDate && !ISO.test(String(v))) throw err(`INVALID_DATE: ${v} (use yyyy-MM-dd)`);
    if (['NUMBER', 'MONEY'].includes(field.type) && !Number.isFinite(Number(v))) throw err(`INVALID_NUMBER: ${v}`);
    return v;
  };
  switch (op) {
    case 'EQUALS':
      if (field.type === 'TEXT') return `lower(${col}) = lower(${p(String(need(flt.value)))})`;
      if (field.type === 'BOOLEAN') return `${col} = ${p(String(need(flt.value)) === 'true')}${cast}`;
      return `${col} = ${p(String(need(flt.value)))}${cast}`;
    case 'EQUALS_CASE_SENSITIVE': return `${col} = ${p(String(need(flt.value)))}::text`;
    case 'DIFFERENT_THAN':
      if (field.type === 'TEXT') return `lower(${col}) IS DISTINCT FROM lower(${p(String(need(flt.value)))})`;
      return `${col} IS DISTINCT FROM ${p(String(need(flt.value)))}${cast}`;
    case 'STARTS_WITH': return `lower(${col}) LIKE lower(${p(String(need(flt.value)).replace(/[\\%_]/g, '\\$&'))}) || '%'`;
    case 'STARTS_WITH_CASE_SENSITIVE': return `${col} LIKE ${p(String(need(flt.value)).replace(/[\\%_]/g, '\\$&'))} || '%'`;
    case 'IN': {
      const vs = Array.isArray(flt.values) ? flt.values : Array.isArray(flt.value) ? flt.value : null;
      if (!vs || !vs.length) throw err(`FILTER_VALUES_REQUIRED: ${flt.field} IN needs a list of values`);
      return `${col} = ANY(${p(vs.map(String))}::text[])`;
    }
    case 'MORE_THAN': return `${col} > ${p(need(flt.value))}::numeric`;
    case 'LESS_THAN': return `${col} < ${p(need(flt.value))}::numeric`;
    case 'BETWEEN': return `${col} BETWEEN ${p(String(need(flt.value)))}${cast} AND ${p(String(need(flt.secondValue, 'secondValue')))}${cast}`;
    case 'ON': return `${col} = ${p(need(flt.value))}::date`;
    case 'AFTER': return `${col} > ${p(need(flt.value))}::date`;
    case 'AFTER_INCLUSIVE': return `${col} >= ${p(need(flt.value))}::date`;
    case 'BEFORE': return `${col} < ${p(need(flt.value))}::date`;
    case 'BEFORE_INCLUSIVE': return `${col} <= ${p(need(flt.value))}::date`;
    case 'TODAY': return `${col} = current_date`;
    case 'THIS_WEEK': return `date_trunc('week', ${col}) = date_trunc('week', current_date)`;
    case 'THIS_MONTH': return `date_trunc('month', ${col}) = date_trunc('month', current_date)`;
    case 'THIS_YEAR': return `date_trunc('year', ${col}) = date_trunc('year', current_date)`;
    case 'LAST_DAYS': {
      const n = Number(flt.value);
      if (!Number.isInteger(n) || n < 1) throw err(`LAST_DAYS_NEEDS_A_WHOLE_NUMBER: ${flt.value}`);
      return `${col} BETWEEN current_date - ${p(n)}::int + 1 AND current_date`;
    }
    case 'EMPTY': return field.type === 'TEXT' || field.type === 'SELECTION' ? `COALESCE(${col}, '') = ''` : `${col} IS NULL`;
    case 'NOT_EMPTY': return field.type === 'TEXT' || field.type === 'SELECTION' ? `COALESCE(${col}, '') <> ''` : `${col} IS NOT NULL`;
    default: throw err(`UNKNOWN_OPERATOR: ${op}`);
  }
}

/** A definition checked against the fields: returns the normalised definition. */
function normalise(def, e, fields) {
  const match = String(def.match || 'ALL').toUpperCase();
  if (!['ALL', 'ANY'].includes(match)) throw err('MATCH_MUST_BE_ALL_OR_ANY');
  const filters = def.filters || def.filterCriteria || [];
  if (!Array.isArray(filters)) throw err('FILTERS_MUST_BE_A_LIST');
  if (filters.length > 50) throw err('TOO_MANY_FILTERS: at most 50');
  for (const x of filters) {
    if (!x || !fields[x.field]) throw err(`UNKNOWN_FIELD: ${x && x.field} for ${e.key}`);
    if (!OPS[fields[x.field].type].includes(String(x.operator || 'EQUALS').toUpperCase())) {
      throw err(`OPERATOR_NOT_ALLOWED: ${x.operator} on ${x.field} (use ${OPS[fields[x.field].type].join(', ')})`);
    }
  }
  let columns = def.columns === undefined || def.columns === null ? e.defaults : def.columns;
  if (!Array.isArray(columns)) throw err('COLUMNS_MUST_BE_A_LIST');
  columns = [...new Set(columns.map(String))];
  if (columns.length > 60) throw err('TOO_MANY_COLUMNS: at most 60');
  const bad = columns.filter((k) => !fields[k]);
  if (bad.length) throw err(`UNKNOWN_FIELD: ${bad.join(', ')} for ${e.key}`);
  const sortBy = def.sortBy || null;
  if (sortBy && !fields[sortBy]) throw err(`UNKNOWN_FIELD: ${sortBy} for ${e.key}`);
  const sortDir = String(def.sortDir || def.sortDirection || 'ASC').toUpperCase();
  if (!['ASC', 'DESC'].includes(sortDir)) throw err('SORT_DIRECTION_MUST_BE_ASC_OR_DESC');
  const display = String(def.display || 'LIST').toUpperCase();
  if (!['LIST', 'DETAIL'].includes(display)) throw err('DISPLAY_MUST_BE_LIST_OR_DETAIL');
  return {
    entity: e.key, match,
    filters: filters.map((x) => ({
      field: x.field, operator: String(x.operator || 'EQUALS').toUpperCase(),
      ...(x.value !== undefined ? { value: x.value } : {}), ...(x.secondValue !== undefined ? { secondValue: x.secondValue } : {}),
      ...(x.values !== undefined ? { values: x.values } : {}),
    })),
    columns, sortBy, sortDir,
    includeTotals: Boolean(def.includeTotals), includeTimestamp: Boolean(def.includeTimestamp), display,
  };
}

/** SELECT list, FROM, WHERE and ORDER BY for a normalised definition. */
function build(d, e, fields, user = null) {
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const conds = d.filters.map((x) => condition(fields[x.field], x, params));
  let where = conds.length ? `(${conds.map((s) => `(${s})`).join(d.match === 'ANY' ? ' OR ' : ' AND ')})` : '';
  // Some records are seen in part: a user's tasks, for one.
  const scoped = e.scope && user ? e.scope(user, p) : null;
  if (scoped) where = where ? `${scoped} AND ${where}` : scoped;
  where = where ? `WHERE ${where}` : '';
  const out = (k) => {
    const x = fields[k];
    if (x.outputType === 'TEXT') return `(${x.sql})`;
    if (x.type === 'TIMESTAMP') {
      return d.includeTimestamp ? `to_char((${x.sql}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` : `((${x.sql})::date)::text`;
    }
    if (x.type === 'DATE') return `(${x.sql})::text`;
    if (x.type === 'MONEY') return `round((${x.sql})::numeric, 2)`;
    return `(${x.sql})`;
  };
  const select = d.columns.map((k, i) => `${out(k)} AS "c${i}"`).join(', ');
  const order = d.sortBy ? `ORDER BY (${fields[d.sortBy].sql}) ${d.sortDir} NULLS LAST, ${e.idSql}` : `ORDER BY ${e.idSql}`;
  return { select, from: e.from, where, order, params };
}

const numericType = (t) => t === 'NUMBER' || t === 'MONEY';
const shownAs = (f) => f.outputType || f.type;

/**
 * Run a definition. Returns the columns, one page of rows keyed by field,
 * the total count, and the totals of the numeric columns over every
 * matching row (not just the page) when asked for.
 */
async function execute(c, def, user, { offset = 0, limit = 50, all = false } = {}) {
  const e = entityOf(def.entity);
  assertEntityAllowed(e, user);
  const fields = await fieldsFor(c, e, user);
  const d = normalise(def, e, fields);
  const q = build(d, e, fields, user);
  const page = all ? { offset: 0, limit: EXPORT_MAX } : pageParams({ offset, limit });
  const n = q.params.length;
  const { rows } = await c.query(
    `SELECT ${e.idSql}::text AS "_id", ${q.select} FROM ${q.from} ${q.where} ${q.order} LIMIT $${n + 1} OFFSET $${n + 2}`,
    [...q.params, all ? EXPORT_MAX + 1 : page.limit, page.offset]);
  const numCols = d.columns.map((k, i) => [k, i]).filter(([k]) => numericType(shownAs(fields[k])));
  const aggs = [`count(*)::bigint AS n`, ...(d.includeTotals ? numCols.map(([k, i]) => `SUM((${fields[k].sql})::numeric) AS "t${i}"`) : [])];
  const { rows: [t] } = await c.query(`SELECT ${aggs.join(', ')} FROM ${q.from} ${q.where}`, q.params);
  const truncated = all && rows.length > EXPORT_MAX;
  const items = (truncated ? rows.slice(0, EXPORT_MAX) : rows).map((r) => {
    const o = { id: r._id };
    d.columns.forEach((k, i) => { o[k] = numericType(shownAs(fields[k])) && r[`c${i}`] !== null ? Number(r[`c${i}`]) : r[`c${i}`]; });
    return o;
  });
  const totals = d.includeTotals
    ? Object.fromEntries(numCols.map(([k, i]) => [k, t[`t${i}`] === null ? 0 : Math.round(Number(t[`t${i}`]) * 100) / 100]))
    : null;
  return {
    definition: d,
    columns: d.columns.map((k) => ({ key: k, label: fields[k].label, type: shownAs(fields[k]) })),
    items, totals, total: Number(t.n), offset: page.offset, limit: all ? EXPORT_MAX : page.limit, truncated,
  };
}

/** The records a view matches, whole (the reference platform's resultType FULL_DETAILS), one page. */
async function fullDetails(c, def, user, { offset = 0, limit = 50 } = {}) {
  const e = entityOf(def.entity);
  assertEntityAllowed(e, user);
  const fields = await fieldsFor(c, e, user);
  const d = normalise(def, e, fields);
  const q = build(d, e, fields, user);
  const page = pageParams({ offset, limit });
  const n = q.params.length;
  const { rows: ids } = await c.query(
    `SELECT ${e.idSql} AS id FROM ${q.from} ${q.where} ${q.order} LIMIT $${n + 1} OFFSET $${n + 2}`,
    [...q.params, page.limit, page.offset]);
  const { rows: [t] } = await c.query(`SELECT count(*)::bigint AS n FROM ${q.from} ${q.where}`, q.params);
  const { rows } = ids.length
    ? await c.query(`SELECT * FROM ${e.table} WHERE id = ANY($1)`, [ids.map((r) => r.id)])
    : { rows: [] };
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const items = [];
  for (const r of ids.map((x) => byId.get(String(x.id))).filter(Boolean)) {
    const o = { ...r };
    // Binary columns never leave through a view.
    for (const k of Object.keys(o)) if (Buffer.isBuffer(o[k])) delete o[k];
    // Custom field values under each field's view rights.
    if (e.cf && o.custom_fields) o.custom_fields = (await CF.getValues(c, e.cf.entity, o.id, { user, record: r })).values;
    items.push(o);
  }
  return { items, total: Number(t.n), offset: page.offset, limit: page.limit };
}

// --------------------------------------------------------------------------
// Saved views
// --------------------------------------------------------------------------

function shape(v, user, favourites = new Set()) {
  return {
    id: v.id, encodedKey: v.id, entity: v.entity, type: ENTITIES[v.entity].reference, name: v.name, description: v.description,
    owner: v.owner_email, match: v.match, filters: v.filters, columns: v.columns,
    sortBy: v.sort_by, sortDir: v.sort_dir, includeTotals: v.include_totals, includeTimestamp: v.include_timestamp,
    display: v.display, usageRights: { allUsers: v.all_users, roles: v.roles },
    menuItemId: v.menu_item_id || null,
    position: v.position, favourite: favourites.has(v.id),
    canEdit: Boolean(user) && (user.role === ADMIN || v.owner_email.toLowerCase() === String(user.email).toLowerCase()),
    createdAt: v.created_at, updatedAt: v.updated_at,
  };
}

// A user sees their own views, all of them if an administrator, and those
// shared with every user or with their role ($2: the tenant role code).
const VISIBLE = `(v.owner_email = lower($1) OR $3::boolean OR v.all_users OR $2 = ANY(v.roles))`;
const who = (user) => [user.email, user.roleCode || user.role, user.role === ADMIN];

async function favouritesOf(c, email) {
  const { rows } = await c.query('SELECT view_id FROM custom_view_favourites WHERE user_email = lower($1)', [email]);
  return new Set(rows.map((r) => r.view_id));
}

/** The saved views a user can see, optionally of one kind; favourites first when asked. */
async function list(c, user, { entity = null, favouritesOnly = false, menuItemId = null } = {}) {
  const e = entity ? entityOf(entity) : null;
  const { rows } = await c.query(
    `SELECT v.* FROM custom_views v
     WHERE ${VISIBLE} AND ($4::text IS NULL OR v.entity = $4::text) AND ($5::uuid IS NULL OR v.menu_item_id = $5::uuid)
     ORDER BY v.entity, v.position, lower(v.name)`, [...who(user), e ? e.key : null, menuItemId]);
  const fav = await favouritesOf(c, user.email);
  return rows.filter((v) => allowed(ENTITIES[v.entity], user))
    .filter((v) => !favouritesOnly || fav.has(v.id))
    .map((v) => shape(v, user, fav));
}

async function find(c, id, user) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw err('VIEW_NOT_FOUND', 404);
  const { rows: [v] } = await c.query(`SELECT v.* FROM custom_views v WHERE v.id = $4::uuid AND ${VISIBLE}`, [...who(user), id]);
  if (!v || !allowed(ENTITIES[v.entity], user)) throw err('VIEW_NOT_FOUND', 404);
  return v;
}

async function get(c, id, user) {
  const v = await find(c, id, user);
  return shape(v, user, await favouritesOf(c, user.email));
}

/**
 * Usage rights from a body: every user, or the roles listed (built-in roles
 * and the tenant's own). Only an administrator may give any.
 */
async function rightsOf(c, body, user, before = null) {
  const r = body.usageRights || {};
  const allUsers = r.allUsers !== undefined ? Boolean(r.allUsers) : body.allUsers !== undefined ? Boolean(body.allUsers) : before ? before.all_users : false;
  const roles = r.roles !== undefined ? r.roles : body.roles !== undefined ? body.roles : before ? before.roles : [];
  const known = await ROLES.codes(c);
  if (!Array.isArray(roles) || roles.some((x) => !known.includes(x))) throw err(`INVALID_ROLES: use ${known.join(', ')}`);
  const changed = before ? (allUsers !== before.all_users || JSON.stringify([...roles].sort()) !== JSON.stringify([...before.roles].sort())) : (allUsers || roles.length);
  if (changed && user.role !== ADMIN) throw err('ONLY_AN_ADMINISTRATOR_SETS_USAGE_RIGHTS', 403);
  return { allUsers, roles: [...new Set(roles)] };
}

/** The menu item a view goes under: of the view's kind, and one the user can see. */
async function menuItemOf(c, id, entity, user) {
  if (id === undefined || id === null || id === '') return null;
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw err('MENU_ITEM_NOT_FOUND', 404);
  const { rows: [m] } = await c.query(
    `SELECT * FROM menu_items v WHERE v.id = $4::uuid AND ${VISIBLE}`, [...who(user), id]);
  if (!m) throw err('MENU_ITEM_NOT_FOUND', 404);
  if (m.type !== entity) throw err(`MENU_ITEM_IS_FOR_${m.type}_NOT_${entity}`, 400);
  return m.id;
}

function nameOf(body, before) {
  const name = body.name !== undefined ? String(body.name || '').trim() : before?.name;
  if (!name) throw err('VIEW_NAME_REQUIRED');
  if (name.length > 255) throw err('VIEW_NAME_TOO_LONG: at most 255 characters');
  return name;
}

async function create(c, body, user) {
  const b = body || {};
  const e = entityOf(b.entity);
  assertEntityAllowed(e, user);
  const fields = await fieldsFor(c, e, user);
  const d = normalise({ ...b, entity: e.key }, e, fields);
  const name = nameOf(b);
  const rights = await rightsOf(c, b, user);
  const menuItemId = await menuItemOf(c, b.menuItemId, e.key, user);
  const { rows: [pos] } = await c.query('SELECT COALESCE(max(position), 0) + 1 AS n FROM custom_views WHERE entity = $1', [e.key]);
  const { rows: [v] } = await c.query(
    `INSERT INTO custom_views (entity, name, description, owner_id, owner_email, match, filters, columns, sort_by, sort_dir,
       include_totals, include_timestamp, display, all_users, roles, position, menu_item_id)
     VALUES ($1,$2,$3,$4,lower($5),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (entity, lower(name), owner_email) DO NOTHING RETURNING *`,
    [e.key, name, b.description || null, user.sub || null, user.email, d.match, JSON.stringify(d.filters), JSON.stringify(d.columns),
      d.sortBy, d.sortDir, d.includeTotals, d.includeTimestamp, d.display, rights.allUsers, rights.roles, pos.n, menuItemId]);
  if (!v) throw err(`VIEW_NAME_TAKEN: you already have a ${e.label.toLowerCase()} view called ${name}`, 409);
  return shape(v, user);
}

async function editable(c, id, user) {
  const v = await find(c, id, user);
  if (user.role !== ADMIN && v.owner_email.toLowerCase() !== String(user.email).toLowerCase()) throw err('ONLY_THE_OWNER_OR_AN_ADMINISTRATOR_CHANGES_A_VIEW', 403);
  return v;
}

async function update(c, id, body, user) {
  const before = await editable(c, id, user);
  const b = body || {};
  const e = entityOf(before.entity);
  const fields = await fieldsFor(c, e, user);
  const merged = {
    entity: e.key,
    match: b.match ?? before.match, filters: b.filters ?? before.filters, columns: b.columns ?? before.columns,
    sortBy: b.sortBy !== undefined ? b.sortBy : before.sort_by, sortDir: b.sortDir ?? before.sort_dir,
    includeTotals: b.includeTotals ?? before.include_totals, includeTimestamp: b.includeTimestamp ?? before.include_timestamp,
    display: b.display ?? before.display,
  };
  const d = normalise(merged, e, fields);
  const name = nameOf(b, before);
  const rights = await rightsOf(c, b, user, before);
  const menuItemId = b.menuItemId !== undefined ? await menuItemOf(c, b.menuItemId, e.key, user) : before.menu_item_id;
  const position = b.position !== undefined ? Number(b.position) : before.position;
  if (!Number.isInteger(position) || position < 0) throw err('POSITION_MUST_BE_A_WHOLE_NUMBER');
  const { rows: [clash] } = await c.query(
    'SELECT 1 FROM custom_views WHERE entity = $1 AND lower(name) = lower($2) AND owner_email = $3 AND id <> $4',
    [e.key, name, before.owner_email, before.id]);
  if (clash) throw err(`VIEW_NAME_TAKEN: ${name}`, 409);
  const { rows: [v] } = await c.query(
    `UPDATE custom_views SET name = $2, description = $3, match = $4, filters = $5, columns = $6, sort_by = $7, sort_dir = $8,
       include_totals = $9, include_timestamp = $10, display = $11, all_users = $12, roles = $13, position = $14, menu_item_id = $15
     WHERE id = $1 RETURNING *`,
    [before.id, name, b.description !== undefined ? (b.description || null) : before.description, d.match, JSON.stringify(d.filters),
      JSON.stringify(d.columns), d.sortBy, d.sortDir, d.includeTotals, d.includeTimestamp, d.display, rights.allUsers, rights.roles, position, menuItemId]);
  return shape(v, user, await favouritesOf(c, user.email));
}

async function remove(c, id, user) {
  const v = await editable(c, id, user);
  await c.query('DELETE FROM custom_views WHERE id = $1', [v.id]);
  return { deleted: v.id };
}

/** Copy a view the user can see into a view of their own (the reference platform's Copy View / Save View As). */
async function copy(c, id, body, user) {
  const v = await find(c, id, user);
  const b = body || {};
  return create(c, {
    entity: v.entity, name: b.name || `${v.name} (copy)`, description: v.description, match: v.match, filters: v.filters,
    columns: v.columns, sortBy: v.sort_by, sortDir: v.sort_dir, includeTotals: v.include_totals,
    includeTimestamp: v.include_timestamp, display: v.display,
  }, user);
}

async function favourite(c, id, user, on = true) {
  const v = await find(c, id, user);
  if (on) {
    await c.query('INSERT INTO custom_view_favourites (view_id, user_email) VALUES ($1, lower($2)) ON CONFLICT DO NOTHING', [v.id, user.email]);
  } else {
    await c.query('DELETE FROM custom_view_favourites WHERE view_id = $1 AND user_email = lower($2)', [v.id, user.email]);
  }
  return { id: v.id, favourite: on };
}

/** The definition of a saved view, for execute(). */
function definitionOf(v) {
  return {
    entity: v.entity, match: v.match, filters: v.filters, columns: v.columns, sortBy: v.sort_by, sortDir: v.sort_dir,
    includeTotals: v.include_totals, includeTimestamp: v.include_timestamp, display: v.display,
  };
}

async function run(c, id, user, opts = {}) {
  const v = await find(c, id, user);
  const out = await execute(c, definitionOf(v), user, opts);
  return { view: shape(v, user, await favouritesOf(c, user.email)), ...out };
}

/**
 * A list endpoint filtered by a view (the reference platform API v1: ?viewfilter=), for the
 * entity that endpoint lists. resultType BASIC (the view's columns),
 * FULL_DETAILS (the whole records) or SUMMARY (count and column totals).
 */
async function forApi(c, id, entity, user, { resultType = 'BASIC', offset = 0, limit = 50 } = {}) {
  const v = await find(c, id, user);
  if (v.entity !== entity) throw err(`VIEW_IS_FOR_${v.entity}_NOT_${entity}`, 400);
  const def = definitionOf(v);
  const rt = String(resultType || 'BASIC').toUpperCase();
  if (rt === 'SUMMARY') {
    const out = await execute(c, { ...def, includeTotals: true }, user, { offset: 0, limit: 1 });
    return { kind: 'SUMMARY', body: { count: out.total, totals: out.totals || {} } };
  }
  if (rt === 'FULL_DETAILS') return { kind: 'PAGE', ...(await fullDetails(c, def, user, { offset, limit })) };
  if (rt !== 'BASIC') throw err('RESULT_TYPE_MUST_BE_BASIC_FULL_DETAILS_OR_SUMMARY');
  const out = await execute(c, def, user, { offset, limit });
  return { kind: 'PAGE', items: out.items, total: out.total, offset: out.offset, limit: out.limit };
}

/** A user's views for API v1 (GET /users/{user}/views?for=). */
async function forUser(c, target, { for: forType = null } = {}) {
  const e = forType ? entityOf(forType) : null;
  const views = await list(c, target, { entity: e ? e.key : null });
  return views.map((v) => ({ ...v, viewRights: { allUsers: v.usageRights.allUsers, roles: v.usageRights.roles } }));
}

/** Rows and columns for an export. */
function exportOf(out, title) {
  return {
    title,
    header: [['View', title], ['Rows', out.truncated ? `${out.items.length} of ${out.total} (the export holds at most ${EXPORT_MAX})` : String(out.total)], ['Generated', new Date().toISOString()]],
    columns: out.columns.map((col) => ({ key: col.key, label: col.label, num: numericType(col.type) })),
    rows: out.items,
    totals: out.totals,
  };
}

module.exports = {
  ENTITIES, OPS, EXPORT_MAX, entityOf, entities, describe, fieldsFor, normalise, build, execute, fullDetails,
  list, get, create, update, remove, copy, favourite, run, forApi, forUser, exportOf, definitionOf,
};
