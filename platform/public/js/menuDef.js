/**
 * The console's navigation as data: the top menus and their dropdowns, the
 * icons on the right, and the Administration tabs. topbar.js draws it,
 * nav.js opens what it names. Kept free of imports so it can be read on
 * its own (src/domain/menus.js reports the same 13 top menus).
 *
 * An entry: { key, label, view, filter?, perms?, divider?, icon? }. perms:
 * the user needs any one; none means every user. A filter is passed to the
 * page and kept in the address hash (#view/value).
 */

const CLIENT_STATES = [['active', 'Active', 'ACTIVE'], ['inactive', 'Inactive', 'INACTIVE'], ['pending', 'Pending Approval', 'PENDING_APPROVAL'],
  ['exited', 'Exited', 'EXITED'], ['blacklisted', 'Blacklisted', 'BLACKLISTED'], ['rejected', 'Rejected', 'REJECTED']];

/** The stored transaction kinds each Loan Transactions entry covers. */
export const LOAN_TX_TYPES = {
  disbursements: ['LOAN_DISBURSEMENT'],
  repayments: ['LOAN_REPAYMENT', 'LOAN_RECOVERY'],
  fees: ['LOAN_FEE', 'LOAN_FEE_WAIVED', 'LOAN_FEE_ADJUSTED', 'LOAN_PENALTY_ADJUSTED'],
  interest: ['LOAN_INTEREST_ACCRUAL', 'LOAN_INTEREST_CAPITALIZED'],
  writeoffs: ['LOAN_WRITE_OFF', 'LOAN_BALANCE_WRITE_OFF'],
  reversals: ['REVERSAL'],
};

/** The stored transaction kinds each Deposit Transactions entry covers. */
export const DEPOSIT_TX_TYPES = {
  deposits: ['SAVINGS_DEPOSIT'],
  withdrawals: ['SAVINGS_WITHDRAWAL', 'SAVINGS_SEIZURE'],
  transfers: ['SAVINGS_TRANSFER'],
  fees: ['SAVINGS_FEE'],
  interest: ['SAVINGS_INTEREST_APPLIED', 'SAVINGS_NEGATIVE_INTEREST', 'OVERDRAFT_INTEREST_APPLIED'],
  tax: ['SAVINGS_WITHHOLDING_TAX'],
  reversals: ['REVERSAL'],
};

const V_LOAN = ['VIEW_LOAN_ACCOUNT_DETAILS'];
const V_DEP = ['VIEW_SAVINGS_ACCOUNT_DETAILS'];
const V_ACC = ['VIEW_ACCOUNTING_REPORTS'];

const states = (view, list, allLabel, perms) => [
  ...list.map(([key, label, state]) => ({ key, label, view, filter: { state }, perms })),
  { key: 'all', label: allLabel, view, perms, divider: true },
];
const types = (view, labels, allLabel, perms) => [
  ...labels.map(([key, label]) => ({ key, label, view, filter: { type: key }, perms })),
  { key: 'all', label: allLabel, view, perms, divider: true },
];

export const TOP = [
  { key: 'dashboard', label: 'Dashboard', open: { key: 'dashboard', label: 'Dashboard', view: 'dashboard' } },
  { key: 'clients', label: 'Clients', entries: states('members', CLIENT_STATES, 'All Clients') },
  { key: 'groups', label: 'Groups', entries: states('groups', CLIENT_STATES, 'All Groups', ['VIEW_GROUP_DETAILS']) },
  { key: 'loans', label: 'Loans', entries: states('loans', [
    ['partial', 'Partial Application', 'PARTIAL_APPLICATION'], ['pending', 'Pending Approval', 'PENDING_APPROVAL'],
    ['approved', 'Approved', 'APPROVED'], ['active', 'Active', 'ACTIVE'], ['arrears', 'Active in Arrears', 'IN_ARREARS'],
    ['closed', 'Closed', 'CLOSED_REPAID,CLOSED_RESCHEDULED,CLOSED_REFINANCED'], ['writtenOff', 'Written Off', 'CLOSED_WRITTEN_OFF'],
  ], 'All Loans') },
  { key: 'deposits', label: 'Deposits', entries: states('deposits', [
    ['pending', 'Pending Approval', 'PENDING_APPROVAL'], ['approved', 'Approved', 'APPROVED'], ['active', 'Active', 'ACTIVE'],
    ['arrears', 'Active in Arrears', 'ACTIVE_IN_ARREARS'], ['matured', 'Matured', 'MATURED'], ['dormant', 'Dormant', 'DORMANT'],
    ['locked', 'Locked', 'LOCKED'], ['closed', 'Closed', 'CLOSED'],
  ], 'All Deposits', V_DEP) },
  { key: 'loanTransactions', label: 'Loan Transactions', entries: types('loanTransactions', [
    ['disbursements', 'Disbursements'], ['repayments', 'Repayments'], ['fees', 'Fees and Penalties'], ['interest', 'Interest'],
    ['writeoffs', 'Write-offs'], ['reversals', 'Reversals'],
  ], 'All', V_LOAN) },
  { key: 'depositTransactions', label: 'Deposit Transactions', entries: types('depositTransactions', [
    ['deposits', 'Deposits'], ['withdrawals', 'Withdrawals'], ['transfers', 'Transfers'], ['fees', 'Fees'],
    ['interest', 'Interest Applied'], ['tax', 'Withholding Tax'], ['reversals', 'Reversals'],
  ], 'All', V_DEP) },
  { key: 'activities', label: 'Activities', open: { key: 'activities', label: 'Activities', view: 'activities', perms: ['AUDIT_TRANSACTIONS'] } },
  { key: 'creditArrangements', label: 'Credit Arrangements', entries: states('creditArrangements', [
    ['pending', 'Pending Approval', 'PENDING_APPROVAL'], ['approved', 'Approved', 'APPROVED'], ['active', 'Active', 'ACTIVE'],
    ['closed', 'Closed', 'CLOSED'], ['withdrawn', 'Withdrawn', 'WITHDRAWN'], ['rejected', 'Rejected', 'REJECTED'],
  ], 'All', ['VIEW_LINE_OF_CREDIT_DETAILS']) },
  { key: 'products', label: 'Products', entries: [
    { key: 'loan', label: 'Loan Products', view: 'products', filter: { tab: 'loan' } },
    { key: 'deposit', label: 'Deposit Products', view: 'products', filter: { tab: 'deposit' } },
  ] },
  { key: 'reporting', label: 'Reporting', entries: [
    { key: 'reports', label: 'Reports', view: 'reports', filter: { which: 'trial-balance' }, perms: ['VIEW_REPORTS', 'VIEW_ACCOUNTING_REPORTS', 'VIEW_INTELLIGENCE'] },
    { key: 'views', label: 'Custom Views', view: 'views' },
    { key: 'templates', label: 'Report Templates', view: 'reports', filter: { which: 'templates' }, perms: ['VIEW_REPORTS'] },
    { key: 'returns', label: 'Regulatory Returns', view: 'returns' },
    { key: 'indicators', label: 'Indicators', view: 'reports', filter: { which: 'indicators' }, perms: ['VIEW_INTELLIGENCE'] },
  ] },
  { key: 'accounting', label: 'Accounting', entries: [
    { key: 'journal', label: 'Journal Entries', view: 'journal', perms: ['VIEW_ACCOUNTING_REPORTS', 'LOG_JOURNAL_ENTRIES'] },
    { key: 'chart', label: 'Chart of Accounts', view: 'chart', perms: ['VIEW_ACCOUNTING_REPORTS', 'MANAGE_ACCOUNTS'] },
    { key: 'trialBalance', label: 'Trial Balance', view: 'reports', filter: { which: 'trial-balance' }, perms: V_ACC },
    { key: 'balanceSheet', label: 'Balance Sheet', view: 'reports', filter: { which: 'balance-sheet' }, perms: V_ACC },
    { key: 'incomeStatement', label: 'Income Statement', view: 'reports', filter: { which: 'income-statement' }, perms: V_ACC },
    { key: 'accruals', label: 'Interest Accruals', view: 'accruals', perms: V_ACC },
    { key: 'periods', label: 'Periods and Year-end Close', view: 'finance', divider: true },
    { key: 'provisioning', label: 'Provisioning', view: 'finance', filter: { only: 'provisioning' } },
    { key: 'branches', label: 'Branch Accounting', view: 'accounting' },
  ] },
  { key: 'administration', label: 'Administration', open: { key: 'administration', label: 'Administration', view: 'admin' } },
];

const SOON = (what) => `${what} is being built. This tab will hold its settings once it is ready.`;

export const ADMIN_TABS = [
  { key: 'general', label: 'General Setup', perms: ['MANAGE_GENERAL_SETUP', 'MANAGE_HOLIDAYS', 'MANAGE_CURRENCIES', 'MANAGE_INDEX_RATES', 'MANAGE_EOD_PROCESSING'] },
  { key: 'clients', label: 'Client Setup', perms: ['MANAGE_GENERAL_SETUP'] },
  { key: 'accounting', label: 'Accounting Setup', perms: ['MANAGE_INTERBRANCH_GLACCOUNT_RULES', 'MAKE_ACCOUNTING_CLOSURE', 'CREATE_ACCOUNTING_RATES'] },
  { key: 'organization', label: 'Organization', perms: ['EDIT_BRANCH', 'MANAGE_GENERAL_SETUP'] },
  { key: 'access', label: 'Access', perms: ['VIEW_USER_DETAILS', 'VIEW_ROLE', 'MANAGE_ACCESS_PREFERENCES', 'VIEW_API_CONSUMERS_AND_KEYS', 'MANAGE_AUDIT_TRAIL'] },
  { key: 'products', label: 'Products', perms: ['CREATE_LOAN_PRODUCT', 'EDIT_LOAN_PRODUCT', 'CREATE_SAVINGS_PRODUCT', 'EDIT_SAVINGS_PRODUCT'] },
  { key: 'fields', label: 'Fields', perms: ['CREATE_CUSTOM_FIELD', 'EDIT_CUSTOM_FIELD'] },
  { key: 'views', label: 'Views', perms: ['MANAGE_GENERAL_SETUP'] },
  { key: 'sms', label: 'SMS', perms: ['CREATE_COMMUNICATION_TEMPLATES', 'EDIT_COMMUNICATION_TEMPLATES'],
    placeholder: SOON('SMS: messages to members through an SMS provider the SACCO plugs in, with templates and a delivery log,') },
  { key: 'email', label: 'Email', perms: ['CREATE_COMMUNICATION_TEMPLATES', 'EDIT_COMMUNICATION_TEMPLATES'],
    placeholder: SOON('Email: messages to members and staff through the SACCO\'s mail server, with templates and a delivery log,') },
  { key: 'webhooks', label: 'Webhooks', perms: ['MANAGE_GENERAL_SETUP'],
    placeholder: SOON('Webhooks: calls to another system\'s web address when an event happens, such as a deposit or a loan approval,') },
  { key: 'events', label: 'Events Streaming', perms: ['MANAGE_GENERAL_SETUP'],
    placeholder: SOON('Events streaming: a continuous feed of the SACCO\'s events for a data warehouse or another system,') },
  { key: 'templates', label: 'Templates', perms: ['CREATE_PRODUCT_DOCUMENT_TEMPLATES', 'EDIT_PRODUCT_DOCUMENT_TEMPLATES', 'CREATE_REPORTS', 'EDIT_REPORTS'] },
  { key: 'reports', label: 'Reports', perms: ['MANAGE_RETURNS'] },
  { key: 'apps', label: 'Apps', perms: ['MANAGE_GENERAL_SETUP'],
    placeholder: SOON('Apps: add-ons from other providers, connected with their own API consumer and permissions,') },
  { key: 'data', label: 'Data', perms: ['IMPORT_DATA', 'DOWNLOAD_BACKUPS', 'VIEW_DATA_IMPORTS', 'EXTRACT_DATA'] },
];

const ADMIN_PERMS = [...new Set(ADMIN_TABS.flatMap((t) => t.perms || []))];

export const RIGHT = [
  { key: 'tasks', label: 'Tasks', icon: 'tasks', view: 'tasks', perms: ['VIEW_TASK'] },
  { key: 'teller', label: 'Teller', icon: 'teller', view: 'teller', perms: ['VIEW_SAVINGS_ACCOUNT_DETAILS', 'VIEW_LOAN_ACCOUNT_DETAILS'] },
  { key: 'tills', label: 'Till', icon: 'till', view: 'tills', perms: ['OPEN_TILL', 'CLOSE_TILL', 'ADD_CASH', 'REMOVE_CASH'] },
  { key: 'admin', label: 'Administration', icon: 'cog', view: 'admin', perms: ADMIN_PERMS },
];
// The Administration menu shows when any tab does.
TOP[TOP.length - 1].open.perms = ADMIN_PERMS;

/** Pages that are no longer on the bar but still open from a hash or a link. */
export const OTHER_VIEWS = ['organization', 'controls', 'data', 'users', 'access'];

const allowed = (can, perms) => !perms || !perms.length || can(...perms);

/** The menus the user may open, each with only the entries they may open; empty menus dropped. */
export function visibleMenus(can) {
  const out = [];
  for (const m of TOP) {
    if (m.open) { if (allowed(can, m.open.perms)) out.push(m); continue; }
    const entries = m.entries.filter((e) => allowed(can, e.perms));
    if (entries.length) out.push({ ...m, entries });
  }
  return out;
}

export const visibleTabs = (can) => ADMIN_TABS.filter((t) => allowed(can, t.perms));
export const visibleRight = (can) => RIGHT.filter((e) => allowed(can, e.perms));

const HASH_KEYS = ['state', 'type', 'tab', 'which', 'only'];
const valueOf = (filter = {}) => {
  const k = HASH_KEYS.find((x) => filter[x] !== undefined && filter[x] !== null && filter[x] !== '');
  return k ? [k, String(filter[k])] : null;
};

export function hashOf(view, filter = {}) {
  const v = valueOf(filter);
  return v ? `#${view}/${encodeURIComponent(v[1])}` : `#${view}`;
}

const ENTRIES = [...TOP.flatMap((m) => (m.open ? [m.open] : m.entries)), ...RIGHT];
const KNOWN = new Set([...ENTRIES.map((e) => e.view), ...OTHER_VIEWS, 'admin']);
const HOME = { view: 'dashboard', filter: {} };

export function parseHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const slash = raw.indexOf('/');
  const view = slash < 0 ? raw : raw.slice(0, slash);
  let value = null;
  if (slash >= 0) {
    try { value = decodeURIComponent(raw.slice(slash + 1)); } catch { return HOME; }
  }
  if (!KNOWN.has(view)) return HOME;
  if (view === 'admin') {
    const tab = ADMIN_TABS.find((t) => t.key === value) || ADMIN_TABS[0];
    return { view, filter: { tab: tab.key } };
  }
  if (value === null || value === '') return { view, filter: {} };
  const hit = ENTRIES.find((e) => e.view === view && valueOf(e.filter)?.[1] === value);
  return hit ? { view, filter: { ...hit.filter } } : HOME;
}

/** The menu and entry that open a view with a filter, for marking the bar. */
export function entryFor(view, filter = {}) {
  const v = valueOf(filter)?.[1] ?? null;
  for (const m of TOP) {
    for (const e of m.open ? [m.open] : m.entries) {
      if (e.view === view && (valueOf(e.filter)?.[1] ?? null) === v) return { menu: m.key, entry: e.key };
    }
  }
  return null;
}
