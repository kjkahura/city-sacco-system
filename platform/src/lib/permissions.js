'use strict';

/**
 * Permissions (the reference platform's permission codes). A user's permissions are those of
 * their role, plus any given to them directly; a tenant administrator holds
 * every permission. The codes are the reference platform's where the reference platform has one, so a role
 * set up here reads the same as one in the reference platform.
 *
 * `enforced` marks the permissions the platform checks today. The others are
 * catalogued so roles can be set up in full, and are enforced as their areas
 * move over from the built-in role checks (Users and Access Control).
 */

const P = (code, label, enforced = false) => ({ code, label, enforced });

const GROUPS = [
  ['Reports', [
    P('VIEW_REPORTS', 'View reports', true),
    P('CREATE_REPORTS', 'Create reports', true),
    P('EDIT_REPORTS', 'Edit reports', true),
    P('DELETE_REPORTS', 'Delete reports', true),
    P('VIEW_INTELLIGENCE', 'View historical data and indicators', true),
    P('EXPORT_TO_EXCEL', 'Export to Excel and CSV', true),
  ]],
  ['Accounting', [
    P('VIEW_ACCOUNTING_REPORTS', 'View accounting reports and journal entries', true),
    P('LOG_JOURNAL_ENTRIES', 'Log journal entries'),
    P('MAKE_ACCOUNTING_CLOSURE', 'Make accounting closures'),
    P('MANAGE_ACCOUNTS', 'Manage GL accounts'),
  ]],
  ['Tellering', [
    P('OPEN_TILL', 'Open tills', true),
    P('CLOSE_TILL', 'Close tills', true),
    P('ADD_CASH', 'Add cash to a till', true),
    P('REMOVE_CASH', 'Remove cash from a till', true),
    P('POST_TRANSACTIONS_WITHOUT_OPENED_TILL', 'Post cash transactions without an open till', true),
  ]],
  ['Tasks', [
    P('VIEW_TASK', 'View tasks', true),
    P('CREATE_TASK', 'Create tasks', true),
    P('EDIT_TASK', 'Edit tasks', true),
    P('DELETE_TASK', 'Delete tasks', true),
    P('CREATE_COMMUNICATION_TEMPLATES', 'Create templates', true),
    P('EDIT_COMMUNICATION_TEMPLATES', 'Edit templates', true),
  ]],
  ['Views and menus', [
    P('VIEW_CLIENT_DETAILS', 'View members', true),
    P('VIEW_LOAN_ACCOUNT_DETAILS', 'View loan accounts', true),
    P('VIEW_SAVINGS_ACCOUNT_DETAILS', 'View deposit accounts', true),
    P('AUDIT_TRANSACTIONS', 'View system activities', true),
    P('VIEW_BRANCH_DETAILS', 'View branches'),
    P('VIEW_CENTRE_DETAILS', 'View centres'),
    P('VIEW_USER_DETAILS', 'View users'),
  ]],
  ['Access', [
    P('VIEW_ROLE', 'View roles', true),
    P('CREATE_ROLE', 'Create roles', true),
    P('EDIT_ROLE', 'Edit roles', true),
    P('DELETE_ROLE', 'Delete roles', true),
    P('CREATE_USER', 'Create users'),
    P('EDIT_USER', 'Edit users'),
  ]],
  ['Members', [
    P('CREATE_CLIENT', 'Create members'),
    P('EDIT_CLIENT', 'Edit members'),
    P('APPROVE_CLIENT', 'Approve members'),
    P('EXIT_CLIENT', 'Exit members'),
  ]],
  ['Loans', [
    P('CREATE_LOAN_ACCOUNT', 'Create loan accounts'),
    P('EDIT_LOAN_ACCOUNT', 'Edit loan accounts'),
    P('APPROVE_LOANS', 'Approve loans'),
    P('DIBURSE_LOANS', 'Disburse loans'),
    P('ENTER_REPAYMENT', 'Enter repayments'),
    P('WRITE_OFF_LOAN_ACCOUNTS', 'Write off loans'),
    P('RESCHEDULE_LOAN_ACCOUNT', 'Reschedule loans'),
    P('REFINANCE_LOAN_ACCOUNT', 'Refinance loans'),
    P('LOCK_LOAN_ACCOUNTS', 'Lock loans'),
    P('BACKDATE_LOAN_TRANSACTIONS', 'Backdate loan transactions'),
  ]],
  ['Deposits', [
    P('CREATE_SAVINGS_ACCOUNT', 'Create deposit accounts'),
    P('MAKE_DEPOSIT', 'Make deposits'),
    P('MAKE_WITHDRAWAL', 'Make withdrawals'),
    P('MAKE_TRANSFER', 'Make transfers'),
    P('CLOSE_SAVINGS_ACCOUNTS', 'Close deposit accounts'),
    P('BACKDATE_SAVINGS_TRANSACTIONS', 'Backdate deposit transactions'),
  ]],
  ['Administration', [
    P('IMPORT_DATA', 'Import data'),
    P('DOWNLOAD_BACKUPS', 'Download backups'),
    P('MANAGE_EOD_PROCESSING', 'Manage end of day processing', true),
    P('VIEW_CUSTOM_FIELD', 'View custom fields'),
    P('EDIT_CUSTOM_FIELD', 'Edit custom fields'),
    P('VIEW_TRANSACTION_CHANNELS', 'View transaction channels'),
  ]],
];

const CATALOG = GROUPS.flatMap(([group, list]) => list.map((p) => ({ ...p, group })));
const CODES = new Set(CATALOG.map((p) => p.code));

const ALL_STAFF = ['VIEW_CLIENT_DETAILS', 'VIEW_LOAN_ACCOUNT_DETAILS', 'VIEW_SAVINGS_ACCOUNT_DETAILS', 'VIEW_TASK', 'CREATE_TASK',
  'EDIT_TASK', 'EXPORT_TO_EXCEL', 'VIEW_BRANCH_DETAILS', 'VIEW_CENTRE_DETAILS', 'VIEW_TRANSACTION_CHANNELS'];
const READERS = ['VIEW_REPORTS', 'VIEW_INTELLIGENCE', 'VIEW_ACCOUNTING_REPORTS'];

/**
 * What the built-in roles hold, set so that every route moved to permissions
 * lets in exactly who the role check let in before. A tenant edits these
 * (they are rows in its roles table); these are the starting point.
 *
 * TELLER keeps POST_TRANSACTIONS_WITHOUT_OPENED_TILL so that tellers are not
 * stopped the day tills arrive. Take it off the role when the branch works
 * through tills; from then a teller's cash transactions need an open till.
 */
const DEFAULTS = {
  TENANT_ADMIN: CATALOG.map((p) => p.code),
  MANAGER: [...ALL_STAFF, ...READERS, 'CREATE_REPORTS', 'EDIT_REPORTS', 'DELETE_REPORTS', 'AUDIT_TRANSACTIONS', 'DELETE_TASK',
    'OPEN_TILL', 'CLOSE_TILL', 'ADD_CASH', 'REMOVE_CASH', 'POST_TRANSACTIONS_WITHOUT_OPENED_TILL',
    'CREATE_COMMUNICATION_TEMPLATES', 'EDIT_COMMUNICATION_TEMPLATES', 'VIEW_ROLE', 'VIEW_USER_DETAILS'],
  ACCOUNTANT: [...ALL_STAFF, ...READERS, 'POST_TRANSACTIONS_WITHOUT_OPENED_TILL'],
  AUDITOR: [...ALL_STAFF, ...READERS, 'AUDIT_TRANSACTIONS', 'POST_TRANSACTIONS_WITHOUT_OPENED_TILL', 'VIEW_ROLE', 'VIEW_USER_DETAILS'],
  TELLER: [...ALL_STAFF, 'CLOSE_TILL', 'POST_TRANSACTIONS_WITHOUT_OPENED_TILL'],
};
const BASE_ROLES = Object.keys(DEFAULTS);
const USER_TYPES = { TENANT_ADMIN: 'ADMINISTRATOR', TELLER: 'TELLER' };

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

module.exports = { GROUPS, CATALOG, CODES, DEFAULTS, BASE_ROLES, USER_TYPES, can, unknown };
