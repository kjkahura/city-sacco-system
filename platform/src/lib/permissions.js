'use strict';

/**
 * Permissions (the reference platform's permission codes). A user's permissions are those of
 * their role, plus any given to them directly; a tenant administrator holds
 * every permission. The codes are the reference platform's where the reference platform has one, so a role
 * set up here reads the same as one in the reference platform. The few marked `platform`
 * cover what this platform has and the reference platform does not (shares, dividends,
 * provisioning, the year-end close, returns, data extracts).
 *
 * Every permission here is checked: by the route table (./routePermissions)
 * or, for the ones that depend on what a request does, where it happens
 * (posting through a till, posting on a locked loan, a custom allocation).
 */

const P = (code, label, extra = {}) => ({ code, label, ...extra });
const PF = (code, label) => P(code, label, { platform: true });

const GROUPS = [
  ['General', [
    P('AUDIT_TRANSACTIONS', 'Audit transactions (all transactions and system activities)'),
    P('EXPORT_TO_EXCEL', 'Export to Excel and CSV'),
    P('IMPORT_DATA', 'Import data'),
    P('DOWNLOAD_BACKUPS', 'Download backups'),
    PF('VIEW_DATA_IMPORTS', 'View data imports'),
    PF('EXTRACT_DATA', 'Read the incremental data extract'),
  ]],
  ['Administration', [
    P('VIEW_CUSTOM_FIELD', 'View custom fields'),
    P('CREATE_CUSTOM_FIELD', 'Create custom fields'),
    P('EDIT_CUSTOM_FIELD', 'Edit custom fields'),
    P('DELETE_CUSTOM_FIELD', 'Delete custom fields'),
    P('VIEW_BRANCH_DETAILS', 'View branch details'),
    P('CREATE_BRANCH', 'Create branches'),
    P('EDIT_BRANCH', 'Edit branches'),
    P('VIEW_CENTRE_DETAILS', 'View centre details'),
    P('CREATE_CENTRE', 'Create centres'),
    P('EDIT_CENTRE', 'Edit centres'),
    P('VIEW_LOAN_PRODUCT_DETAILS', 'View loan products'),
    P('CREATE_LOAN_PRODUCT', 'Create loan products'),
    P('EDIT_LOAN_PRODUCT', 'Edit loan products'),
    P('VIEW_SAVINGS_PRODUCT_DETAILS', 'View deposit products'),
    P('CREATE_SAVINGS_PRODUCT', 'Create deposit products'),
    P('EDIT_SAVINGS_PRODUCT', 'Edit deposit products'),
    P('DELETE_SAVINGS_PRODUCT', 'Delete deposit products that never had accounts'),
    P('CREATE_PRODUCT_DOCUMENT_TEMPLATES', 'Create product documents'),
    P('EDIT_PRODUCT_DOCUMENT_TEMPLATES', 'Edit product documents'),
    P('DELETE_PRODUCT_DOCUMENT_TEMPLATES', 'Delete product documents'),
    P('VIEW_TRANSACTION_CHANNELS', 'View transaction channels'),
    P('CREATE_TRANSACTION_CHANNELS', 'Create transaction channels'),
    P('EDIT_TRANSACTION_CHANNELS', 'Edit transaction channels'),
    P('DELETE_TRANSACTION_CHANNELS', 'Delete transaction channels'),
    P('CREATE_EXCHANGE_RATE', 'Create exchange rates'),
    P('MANAGE_HOLIDAYS', 'Manage holidays'),
    P('MANAGE_EOD_PROCESSING', 'Manage end of day processing and batch jobs'),
    P('MANAGE_INDEX_RATES', 'Manage index rates'),
    P('MANAGE_CURRENCIES', 'Manage currencies'),
    PF('MANAGE_GENERAL_SETUP', 'Manage ID templates, client and group types, and group role names'),
  ]],
  ['Access', [
    P('CREATE_USER', 'Create users'),
    P('EDIT_USER', 'Edit users (also unlock, and set limits)'),
    P('VIEW_USER_DETAILS', 'View user details'),
    P('CREATE_ROLE', 'Create roles'),
    P('EDIT_ROLE', 'Edit roles'),
    P('VIEW_ROLE', 'View roles'),
    P('DELETE_ROLE', 'Delete roles'),
    P('VIEW_API_CONSUMERS_AND_KEYS', 'View API consumers and keys'),
    P('CREATE_API_CONSUMERS_AND_KEYS', 'Create API consumers and keys'),
    P('EDIT_API_CONSUMERS_AND_KEYS', 'Edit API consumers and keys'),
    P('DELETE_API_CONSUMERS_AND_KEYS', 'Delete API consumers and keys'),
    P('MANAGE_ACCESS_PREFERENCES', 'Manage access preferences'),
    P('MANAGE_TWO_FACTOR_AUTHENTICATION', 'Manage two-factor authentication'),
    P('MANAGE_AUDIT_TRAIL', 'Read the audit trail'),
  ]],
  ['Communication', [
    P('CREATE_COMMUNICATION_TEMPLATES', 'Create templates'),
    P('EDIT_COMMUNICATION_TEMPLATES', 'Edit templates'),
    P('VIEW_COMMUNICATION_HISTORY', 'View the communication log'),
    P('RESEND_FAILED_MESSAGES', 'Resend failed messages'),
    P('CONSUME_EVENT_STREAMS', 'Subscribe to and read event streams'),
  ]],
  ['Clients', [
    P('VIEW_CLIENT_DETAILS', 'View members'),
    P('CREATE_CLIENT', 'Create members'),
    P('EDIT_CLIENT', 'Edit members\' details'),
    P('DELETE_CLIENTS', 'Delete members who never had an account'),
    P('APPROVE_CLIENT', 'Approve members pending approval'),
    P('REJECT_CLIENT', 'Reject members pending approval'),
    P('EXIT_CLIENT', 'Exit members'),
    P('ANONYMIZE_CLIENT', 'Anonymize exited members'),
    P('BLACKLIST_CLIENT', 'Blacklist members'),
    P('UNDO_CLIENT_STATE_CHANGED', 'Undo approving, rejecting, exiting or blacklisting a member'),
    P('CHANGE_CLIENT_TYPE', 'Change a member\'s client type'),
    P('MANAGE_CLIENT_ASSOCIATION', 'Change a member\'s branch, centre and credit officer'),
    P('EDIT_CLIENT_ID', 'Set or change a member or group ID by hand'),
    P('EDIT_BLACKLISTED_CLIENT_CFV', 'Edit custom field values of blacklisted members'),
  ]],
  ['Groups', [
    P('VIEW_GROUP_DETAILS', 'View groups'),
    P('CREATE_GROUP', 'Create groups'),
    P('EDIT_GROUP', 'Edit groups and their members'),
    P('DELETE_GROUP', 'Delete groups that never had an account'),
    P('CHANGE_GROUP_TYPE', 'Change a group\'s type'),
    P('MANAGE_GROUP_ASSOCIATION', 'Change a group\'s branch, centre and credit officer'),
    P('EDIT_GROUP_ID', 'Set or change a group ID by hand'),
  ]],
  ['Loan accounts', [
    P('VIEW_LOAN_ACCOUNT_DETAILS', 'View loan accounts'),
    P('CREATE_LOAN_ACCOUNT', 'Create loan accounts'),
    P('EDIT_LOAN_ACCOUNT', 'Edit loan accounts'),
    P('DELETE_LOAN_ACCOUNT', 'Delete loan accounts'),
    P('ENTER_REPAYMENT', 'Enter repayments'),
    P('EDIT_REPAYMENT_SCHEDULE', 'Edit repayment schedules'),
    P('APPROVE_LOANS', 'Approve loans'),
    P('REQUEST_LOAN_APPROVAL', 'Request loan approval'),
    P('DIBURSE_LOANS', 'Disburse loans'),
    P('WITHDRAW_LOAN_ACCOUNTS', 'Withdraw loan accounts'),
    P('UNDO_WITHDRAW_LOAN_ACCOUNTS', 'Undo withdraw loan accounts'),
    P('SET_LOAN_INCOMPLETE', 'Set loans incomplete'),
    P('REJECT_LOANS', 'Reject loan accounts'),
    P('UNDO_REJECT_LOANS', 'Undo reject loan accounts'),
    P('CLOSE_LOAN_ACCOUNTS', 'Close repaid loan accounts'),
    P('UNDO_LOAN_ACCOUNT_CLOSURE', 'Undo close'),
    P('WRITE_OFF_LOAN_ACCOUNTS', 'Write off loan accounts'),
    P('TERMINATE_LOAN_ACCOUNTS', 'Terminate loan accounts'),
    P('PAY_OFF_LOAN', 'Pay off loan accounts'),
    P('REFINANCE_LOAN_ACCOUNT', 'Refinance loan accounts'),
    P('RESCHEDULE_LOAN_ACCOUNT', 'Reschedule loan accounts'),
    P('APPLY_ACCRUED_LOAN_INTEREST', 'Apply accrued interest'),
    P('APPLY_LOAN_FEES', 'Apply loan account fees'),
    P('APPLY_LOAN_ADJUSTMENTS', 'Apply loan adjustments (reversals, waivers, balance reductions)'),
    P('LINK_ACCOUNTS', 'Set settlement accounts'),
    P('COLLECT_GUARANTIES', 'Collect securities'),
    P('CREATE_SECURITIES', 'Create securities (guarantors, collateral)'),
    P('EDIT_SECURITIES', 'Edit securities'),
    P('DELETE_SECURITIES', 'Delete securities'),
    P('LOCK_LOAN_ACCOUNTS', 'Lock loan accounts'),
    P('POST_TRANSACTIONS_ON_LOCKED_LOAN_ACCOUNTS', 'Post transactions on locked accounts'),
    P('EDIT_LOAN_TRANCHES', 'Edit loan tranches'),
    P('EDIT_PENALTY_RATE', 'Edit penalty rate'),
    P('SET_DISBURSEMENT_CONDITIONS', 'Set disbursement conditions'),
    P('EDIT_INTEREST_RATE', 'Edit interest rate'),
    P('PERFORM_REPAYMENTS_WITH_CUSTOM_AMOUNTS_ALLOCATION', 'Repay with a custom allocation'),
    P('MANAGE_LOAN_ASSOCIATION', 'Manage loan association (branch)'),
    PF('APPROVE_WRITE_OFFS', 'Approve or reject write-off requests'),
  ]],
  ['Deposit accounts', [
    P('VIEW_SAVINGS_ACCOUNT_DETAILS', 'View deposit accounts'),
    P('CREATE_SAVINGS_ACCOUNT', 'Create deposit accounts'),
    P('EDIT_SAVINGS_ACCOUNT', 'Edit deposit accounts (overdraft)'),
    P('DELETE_SAVINGS_ACCOUNT', 'Delete deposit accounts that never had a transaction'),
    P('APPROVE_SAVINGS', 'Approve deposit accounts (and undo the approval or the activation)'),
    P('LOCK_SAVINGS_ACCOUNT', 'Lock deposit accounts'),
    P('UNLOCK_SAVINGS_ACCOUNT', 'Unlock deposit accounts'),
    P('REOPEN_SAVINGS_ACCOUNT', 'Reopen closed current and savings accounts'),
    P('REVERSE_SAVINGS_ACCOUNT_WRITE_OFF', 'Undo the write-off of a deposit account'),
    P('BACKDATE_SAVINGS_TRANSACTIONS', 'Post deposits, withdrawals and transfers with a past value date'),
    P('MAKE_INTER_CLIENTS_TRANSFERS', 'Transfer to another holder\'s account'),
    P('BULK_DEPOSIT_CORRECTIONS', 'Reverse several deposit transactions at once'),
    P('BLOCK_AND_SEIZE_FUNDS', 'Block funds in deposit accounts, unblock and seize them'),
    P('MAKE_DEPOSIT', 'Make deposits'),
    P('MAKE_WITHDRAWAL', 'Make withdrawals'),
    P('MAKE_EARLY_WITHDRAWALS', 'Make withdrawals during a fixed deposit or savings plan term'),
    P('ACTIVATE_MATURITY', 'Start the maturity period of a fixed deposit or savings plan'),
    P('UNDO_MATURITY', 'Undo a maturity before its date'),
    P('POST_TRANSACTIONS_ON_DORMANT_ACCOUNTS', 'Post deposits and withdrawals on dormant accounts'),
    P('CLOSE_SAVINGS_ACCOUNTS', 'Close deposit accounts (and write off overdrafts)'),
    P('APPLY_SAVINGS_FEES', 'Apply deposit account fees'),
    P('APPLY_SAVINGS_ADJUSTMENTS', 'Apply deposit account adjustments (reversals)'),
    P('MAKE_TRANSFER', 'Make transfers'),
    P('APPLY_ACCRUED_SAVINGS_INTEREST', 'Apply accrued interest'),
    P('MANAGE_DEPOSIT_ASSOCIATION', 'Manage deposit association (branch)'),
  ]],
  ['Holds', [
    P('VIEW_HOLDS', 'View transaction holds'),
    P('CREATE_HOLDS', 'Create transaction holds'),
    P('UPDATE_HOLDS', 'Settle transaction holds'),
    P('DELETE_HOLDS', 'Reverse transaction holds'),
  ]],
  ['Lines of credit', [
    P('VIEW_LINE_OF_CREDIT_DETAILS', 'View credit arrangements'),
    P('CREATE_LINES_OF_CREDIT', 'Create credit arrangements'),
    P('EDIT_LINES_OF_CREDIT', 'Edit credit arrangements'),
    P('APPROVE_LINE_OF_CREDIT', 'Approve credit arrangements'),
    P('UNDO_APPROVE_LINE_OF_CREDIT', 'Undo the approval of credit arrangements'),
    P('WITHDRAW_LINE_OF_CREDIT', 'Withdraw credit arrangements'),
    P('UNDO_WITHDRAW_LINE_OF_CREDIT', 'Undo withdraw credit arrangements'),
    P('REJECT_LINE_OF_CREDIT', 'Reject credit arrangements'),
    P('UNDO_REJECT_LINE_OF_CREDIT', 'Undo reject credit arrangements'),
    P('ADD_ACCOUNTS_TO_LINE_OF_CREDIT', 'Add accounts to credit arrangements'),
    // The reference platform's own spelling of the code.
    P('REMOTE_ACCOUNTS_FROM_LINE_OF_CREDIT', 'Remove accounts from credit arrangements'),
    P('CLOSE_LINES_OF_CREDIT', 'Close and reopen credit arrangements'),
    P('DELETE_LINES_OF_CREDIT', 'Delete credit arrangements that have no accounts'),
  ]],
  ['Documents', [
    P('VIEW_DOCUMENTS', 'View documents'),
    P('CREATE_DOCUMENTS', 'Create documents'),
    P('EDIT_DOCUMENTS', 'Edit documents'),
    P('DELETE_DOCUMENTS', 'Delete documents'),
  ]],
  ['Tasks', [
    P('VIEW_TASK', 'View tasks'),
    P('CREATE_TASK', 'Create tasks'),
    P('EDIT_TASK', 'Edit tasks'),
    P('DELETE_TASK', 'Delete tasks'),
  ]],
  ['Reporting', [
    P('VIEW_INTELLIGENCE', 'View historical data and indicators'),
    P('VIEW_REPORTS', 'View reports'),
    P('CREATE_REPORTS', 'Create reports'),
    P('EDIT_REPORTS', 'Edit reports'),
    P('DELETE_REPORTS', 'Delete reports'),
  ]],
  ['Accounting', [
    P('CREATE_ACCOUNTING_RATES', 'Create accounting rates'),
    P('MANAGE_ACCOUNTS', 'Manage chart of accounts and accounting settings'),
    P('LOG_JOURNAL_ENTRIES', 'Log journal entries'),
    P('VIEW_ACCOUNTING_REPORTS', 'View accounting reports and journal entries'),
    P('MAKE_ACCOUNTING_CLOSURE', 'Make accounting closures'),
    P('APPLY_ACCOUNTING_ADJUSTMENTS', 'Delete accounting closures'),
    P('MANAGE_INTERBRANCH_GLACCOUNT_RULES', 'Manage inter-branch GL account rules'),
    PF('MANAGE_PROVISIONING', 'Manage provisioning bands and reverse runs'),
    PF('RUN_PROVISIONING', 'Run provisioning'),
    PF('CLOSE_FINANCIAL_YEAR', 'Open, close and reopen financial years'),
    PF('MANAGE_RETURNS', 'Load regulatory return templates'),
  ]],
  ['Tellering', [
    P('OPEN_TILL', 'Open a till for a teller, and move cash in and out of it'),
    P('CLOSE_TILL', 'Close a till'),
    P('ADD_CASH', 'Post deposits and repayments through a till'),
    P('REMOVE_CASH', 'Post withdrawals and disbursements through a till'),
    P('POST_TRANSACTIONS_WITHOUT_OPENED_TILL', 'Post cash transactions without an open till'),
  ]],
  ['Funds', [
    P('EDIT_INVESTOR_FUNDS', 'Manage a loan\'s funding sources'),
  ]],
  ['Shares and dividends', [
    PF('BUY_SHARES', 'Open share accounts and buy shares'),
    PF('TRANSFER_SHARES', 'Transfer shares and reverse share transactions'),
    PF('MANAGE_DIVIDENDS', 'Declare, allocate and pay dividends'),
  ]],
];

const CATALOG = GROUPS.flatMap(([group, list]) => list.map((p) => ({ ...p, group, enforced: true })));
const CODES = new Set(CATALOG.map((p) => p.code));

// Every staff user can look.
const ALL_STAFF = ['VIEW_CLIENT_DETAILS', 'VIEW_GROUP_DETAILS', 'VIEW_LOAN_ACCOUNT_DETAILS', 'VIEW_SAVINGS_ACCOUNT_DETAILS', 'VIEW_TASK', 'CREATE_TASK',
  'EDIT_TASK', 'EXPORT_TO_EXCEL', 'VIEW_BRANCH_DETAILS', 'VIEW_CENTRE_DETAILS', 'VIEW_TRANSACTION_CHANNELS', 'VIEW_DOCUMENTS',
  'VIEW_LOAN_PRODUCT_DETAILS', 'VIEW_SAVINGS_PRODUCT_DETAILS', 'VIEW_CUSTOM_FIELD', 'VIEW_LINE_OF_CREDIT_DETAILS', 'VIEW_HOLDS'];
const READERS = ['VIEW_REPORTS', 'VIEW_INTELLIGENCE', 'VIEW_ACCOUNTING_REPORTS'];
// What the front office posts: members, accounts, cash, loan applications.
const FRONT_OFFICE = ['CREATE_CLIENT', 'CREATE_GROUP', 'CREATE_DOCUMENTS', 'EDIT_DOCUMENTS', 'CREATE_SAVINGS_ACCOUNT', 'MAKE_DEPOSIT', 'MAKE_WITHDRAWAL',
  'MAKE_TRANSFER', 'APPLY_SAVINGS_FEES', 'ENTER_REPAYMENT', 'CREATE_LOAN_ACCOUNT', 'EDIT_LOAN_ACCOUNT', 'CREATE_SECURITIES',
  'REQUEST_LOAN_APPROVAL', 'SET_LOAN_INCOMPLETE', 'WITHDRAW_LOAN_ACCOUNTS', 'PAY_OFF_LOAN', 'EDIT_LOAN_TRANCHES', 'EDIT_INVESTOR_FUNDS',
  'APPLY_LOAN_FEES', 'REFINANCE_LOAN_ACCOUNT', 'WRITE_OFF_LOAN_ACCOUNTS', 'LINK_ACCOUNTS', 'BUY_SHARES',
  'POST_TRANSACTIONS_ON_LOCKED_LOAN_ACCOUNTS', 'PERFORM_REPAYMENTS_WITH_CUSTOM_AMOUNTS_ALLOCATION', 'SET_DISBURSEMENT_CONDITIONS',
  'ACTIVATE_MATURITY', 'CREATE_LINES_OF_CREDIT', 'EDIT_LINES_OF_CREDIT', 'ADD_ACCOUNTS_TO_LINE_OF_CREDIT', 'REMOTE_ACCOUNTS_FROM_LINE_OF_CREDIT', 'WITHDRAW_LINE_OF_CREDIT',
  'BACKDATE_SAVINGS_TRANSACTIONS', 'MAKE_INTER_CLIENTS_TRANSFERS'];
// What a branch manager approves and runs on top of that.
const MANAGEMENT = ['EDIT_CLIENT', 'APPROVE_CLIENT', 'REJECT_CLIENT', 'EXIT_CLIENT', 'BLACKLIST_CLIENT',
  'UNDO_CLIENT_STATE_CHANGED', 'CHANGE_CLIENT_TYPE', 'MANAGE_CLIENT_ASSOCIATION', 'EDIT_CLIENT_ID', 'EDIT_BLACKLISTED_CLIENT_CFV', 'EDIT_GROUP',
  'CHANGE_GROUP_TYPE', 'MANAGE_GROUP_ASSOCIATION', 'EDIT_GROUP_ID', 'DELETE_DOCUMENTS', 'EDIT_SAVINGS_ACCOUNT', 'CLOSE_SAVINGS_ACCOUNTS', 'APPLY_ACCRUED_SAVINGS_INTEREST',
  'MANAGE_DEPOSIT_ASSOCIATION', 'APPLY_SAVINGS_ADJUSTMENTS', 'DELETE_SECURITIES', 'EDIT_SECURITIES', 'COLLECT_GUARANTIES',
  'APPROVE_LOANS', 'REJECT_LOANS', 'UNDO_REJECT_LOANS', 'UNDO_WITHDRAW_LOAN_ACCOUNTS', 'LOCK_LOAN_ACCOUNTS', 'CLOSE_LOAN_ACCOUNTS',
  'UNDO_LOAN_ACCOUNT_CLOSURE', 'TERMINATE_LOAN_ACCOUNTS', 'EDIT_INTEREST_RATE', 'RESCHEDULE_LOAN_ACCOUNT', 'EDIT_REPAYMENT_SCHEDULE',
  'APPLY_LOAN_ADJUSTMENTS', 'DIBURSE_LOANS', 'APPLY_ACCRUED_LOAN_INTEREST', 'EDIT_PENALTY_RATE', 'APPROVE_WRITE_OFFS',
  'MANAGE_LOAN_ASSOCIATION', 'CREATE_LOAN_PRODUCT', 'EDIT_LOAN_PRODUCT', 'CREATE_SAVINGS_PRODUCT', 'EDIT_SAVINGS_PRODUCT',
  'MANAGE_INDEX_RATES', 'CREATE_BRANCH', 'EDIT_BRANCH', 'CREATE_CENTRE', 'EDIT_CENTRE', 'MANAGE_INTERBRANCH_GLACCOUNT_RULES',
  'MAKE_ACCOUNTING_CLOSURE', 'APPLY_ACCOUNTING_ADJUSTMENTS', 'MANAGE_ACCOUNTS', 'LOG_JOURNAL_ENTRIES', 'MANAGE_HOLIDAYS',
  'CREATE_TRANSACTION_CHANNELS', 'EDIT_TRANSACTION_CHANNELS', 'DELETE_TRANSACTION_CHANNELS', 'MANAGE_GENERAL_SETUP',
  'CREATE_EXCHANGE_RATE', 'CREATE_ACCOUNTING_RATES', 'CREATE_CUSTOM_FIELD', 'EDIT_CUSTOM_FIELD', 'DELETE_CUSTOM_FIELD',
  'CREATE_PRODUCT_DOCUMENT_TEMPLATES', 'EDIT_PRODUCT_DOCUMENT_TEMPLATES', 'DELETE_PRODUCT_DOCUMENT_TEMPLATES', 'IMPORT_DATA',
  'VIEW_DATA_IMPORTS', 'TRANSFER_SHARES', 'MANAGE_DIVIDENDS', 'MANAGE_PROVISIONING', 'RUN_PROVISIONING', 'CLOSE_FINANCIAL_YEAR',
  'MANAGE_RETURNS', 'MANAGE_EOD_PROCESSING', 'APPROVE_LINE_OF_CREDIT', 'UNDO_APPROVE_LINE_OF_CREDIT', 'REJECT_LINE_OF_CREDIT',
  'UNDO_REJECT_LINE_OF_CREDIT', 'UNDO_WITHDRAW_LINE_OF_CREDIT', 'CLOSE_LINES_OF_CREDIT', 'UNDO_MATURITY', 'MAKE_EARLY_WITHDRAWALS',
  'POST_TRANSACTIONS_ON_DORMANT_ACCOUNTS', 'APPROVE_SAVINGS', 'LOCK_SAVINGS_ACCOUNT', 'UNLOCK_SAVINGS_ACCOUNT', 'REOPEN_SAVINGS_ACCOUNT',
  'REVERSE_SAVINGS_ACCOUNT_WRITE_OFF', 'BULK_DEPOSIT_CORRECTIONS', 'CREATE_HOLDS', 'UPDATE_HOLDS', 'DELETE_HOLDS'];

/**
 * What the built-in roles hold, set so that every route lets in who the old
 * built-in role checks let in (the exceptions are in the README). A tenant
 * edits these (they are rows in its roles table); these are the starting
 * point.
 *
 * TELLER keeps POST_TRANSACTIONS_WITHOUT_OPENED_TILL so that tellers are not
 * stopped the day tills arrive. Take it off the role when the branch works
 * through tills; from then a teller's cash transactions need an open till.
 */
const DEFAULTS = {
  TENANT_ADMIN: CATALOG.map((p) => p.code),
  MANAGER: [...ALL_STAFF, ...READERS, ...FRONT_OFFICE, ...MANAGEMENT, 'CREATE_REPORTS', 'EDIT_REPORTS', 'DELETE_REPORTS',
    'AUDIT_TRANSACTIONS', 'DELETE_TASK', 'OPEN_TILL', 'CLOSE_TILL', 'ADD_CASH', 'REMOVE_CASH', 'POST_TRANSACTIONS_WITHOUT_OPENED_TILL',
    'CREATE_COMMUNICATION_TEMPLATES', 'EDIT_COMMUNICATION_TEMPLATES', 'VIEW_COMMUNICATION_HISTORY', 'RESEND_FAILED_MESSAGES', 'VIEW_ROLE', 'VIEW_USER_DETAILS'],
  ACCOUNTANT: [...ALL_STAFF, ...READERS, 'POST_TRANSACTIONS_WITHOUT_OPENED_TILL', 'MAKE_ACCOUNTING_CLOSURE', 'EXTRACT_DATA', 'RUN_PROVISIONING'],
  AUDITOR: [...ALL_STAFF, ...READERS, 'AUDIT_TRANSACTIONS', 'VIEW_COMMUNICATION_HISTORY', 'POST_TRANSACTIONS_WITHOUT_OPENED_TILL', 'VIEW_ROLE', 'VIEW_USER_DETAILS',
    'EXTRACT_DATA', 'VIEW_DATA_IMPORTS'],
  TELLER: [...ALL_STAFF, ...FRONT_OFFICE, 'ADD_CASH', 'REMOVE_CASH', 'POST_TRANSACTIONS_WITHOUT_OPENED_TILL'],
};
for (const k of Object.keys(DEFAULTS)) DEFAULTS[k] = [...new Set(DEFAULTS[k])];
const BASE_ROLES = Object.keys(DEFAULTS);
const USER_TYPES = { TENANT_ADMIN: 'ADMINISTRATOR', TELLER: 'TELLER' };

/**
 * The codes each built-in role started enforcing in the Users and Access
 * Control build: tenant roles saved before it are given these (by base
 * role), since before it their base role decided those routes.
 */
const ENFORCED_BEFORE_UAC = new Set(['VIEW_REPORTS', 'CREATE_REPORTS', 'EDIT_REPORTS', 'DELETE_REPORTS', 'VIEW_INTELLIGENCE',
  'EXPORT_TO_EXCEL', 'VIEW_ACCOUNTING_REPORTS', 'OPEN_TILL', 'CLOSE_TILL', 'ADD_CASH', 'REMOVE_CASH', 'POST_TRANSACTIONS_WITHOUT_OPENED_TILL',
  'VIEW_TASK', 'CREATE_TASK', 'EDIT_TASK', 'DELETE_TASK', 'CREATE_COMMUNICATION_TEMPLATES', 'EDIT_COMMUNICATION_TEMPLATES',
  'VIEW_CLIENT_DETAILS', 'VIEW_LOAN_ACCOUNT_DETAILS', 'VIEW_SAVINGS_ACCOUNT_DETAILS', 'AUDIT_TRANSACTIONS', 'VIEW_ROLE', 'CREATE_ROLE',
  'EDIT_ROLE', 'DELETE_ROLE', 'MANAGE_EOD_PROCESSING']);

/**
 * Whether a user (req.auth, with `permissions` filled in by requireAuth)
 * holds a permission. An administrator holds all. A user object without
 * permissions (a caller that did not come through requireAuth) is judged by
 * its built-in role's defaults.
 */
function can(user, code) {
  if (!user) return false;
  if (user.role === 'TENANT_ADMIN') return true;
  const held = user.permissions;
  if (held instanceof Set) return held.has(code);
  if (Array.isArray(held)) return held.includes(code);
  return (DEFAULTS[user.role] || []).includes(code);
}

function unknown(list) {
  return (list || []).filter((c) => !CODES.has(c));
}

module.exports = { GROUPS, CATALOG, CODES, DEFAULTS, BASE_ROLES, USER_TYPES, ENFORCED_BEFORE_UAC, can, unknown };
