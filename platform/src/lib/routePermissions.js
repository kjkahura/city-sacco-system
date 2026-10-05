'use strict';

/**
 * The permission every tenant API route needs (Users and Access Control).
 * One table, so what a role can do is readable in one place, and a route
 * that is not listed here is refused to everyone but an administrator.
 *
 * A rule is:
 *   'CODE'              the permission
 *   ['A', 'B']          any one of them
 *   { all: ['A', 'B'] } every one of them
 *   ADMIN               an administrator only (the reference platform keeps these settings to
 *                       the administrator type; no permission grants them)
 *   OPEN                any signed-in staff user; the route or its domain
 *                       decides the rest (views, menu items, own profile)
 *   NONE                not a staff route (sign-in, the member portal)
 *
 * Paths are as mounted under /api, with :params. The most specific path
 * wins, so '/loans/controls' is found before '/loans/:id'.
 */

const ADMIN = Symbol('ADMIN');
const OPEN = Symbol('OPEN');
const NONE = Symbol('NONE');

const V_MEMBER = 'VIEW_CLIENT_DETAILS';
const V_LOAN = 'VIEW_LOAN_ACCOUNT_DETAILS';
const V_DEP = 'VIEW_SAVINGS_ACCOUNT_DETAILS';
const V_ACC = 'VIEW_ACCOUNTING_REPORTS';
// Webhooks are seen by those who make or edit them, and by setup administrators (the reference platform's View Administration Details).
const TEMPLATES_VIEW = ['CREATE_COMMUNICATION_TEMPLATES', 'EDIT_COMMUNICATION_TEMPLATES', 'MANAGE_GENERAL_SETUP'];
const EOD = 'MANAGE_EOD_PROCESSING';
// Changing a member or group: the details, its ID, its type, its association,
// or (blacklisted) its custom fields. ../domain/clients checks the one a change needs.
const EDIT_HOLDER = ['EDIT_CLIENT', 'EDIT_GROUP', 'EDIT_CLIENT_ID', 'EDIT_GROUP_ID', 'CHANGE_CLIENT_TYPE', 'CHANGE_GROUP_TYPE',
  'MANAGE_CLIENT_ASSOCIATION', 'MANAGE_GROUP_ASSOCIATION', 'EDIT_BLACKLISTED_CLIENT_CFV'];
const ASSOC = ['MANAGE_CLIENT_ASSOCIATION', 'MANAGE_GROUP_ASSOCIATION'];
// Changing a deposit account's state, or its rate (../domain/savings ACTIONS).
const DEP_STATE = ['EDIT_SAVINGS_ACCOUNT', 'APPROVE_SAVINGS', 'LOCK_SAVINGS_ACCOUNT', 'UNLOCK_SAVINGS_ACCOUNT', 'CLOSE_SAVINGS_ACCOUNTS',
  'REOPEN_SAVINGS_ACCOUNT', 'REVERSE_SAVINGS_ACCOUNT_WRITE_OFF'];
const STATE_ACTIONS = ['APPROVE_CLIENT', 'REJECT_CLIENT', 'EXIT_CLIENT', 'BLACKLIST_CLIENT', 'UNDO_CLIENT_STATE_CHANGED'];

const RULES = [
  // --- not staff routes, or open to any staff ---------------------------------
  ['*', '/auth/login', NONE], ['*', '/auth/refresh', NONE], ['*', '/auth/logout', NONE],
  ['*', '/auth/password', NONE], ['*', '/auth/mfa/verify', NONE], ['*', '/auth/mfa/enrol', NONE],
  ['*', '/auth/mfa/confirm', NONE], ['*', '/auth/reauth', NONE],
  ['*', '/auth/*', OPEN],
  ['*', '/portal/*', NONE],
  ['GET', '/organization/branding/:kind', NONE],
  ['GET', '/', OPEN],
  ['*', '/profile', OPEN], ['*', '/profile/*', OPEN],
  ['*', '/views', OPEN], ['*', '/views/*', OPEN],
  ['*', '/menu', OPEN], ['*', '/menu-items', OPEN], ['*', '/menu-items/*', OPEN],
  ['GET', '/users/:id/views', OPEN],

  // --- custom-view list endpoints (?viewfilter=) --------------------------------
  ['GET', '/clients', V_MEMBER],
  ['GET', '/activities', 'AUDIT_TRANSACTIONS'], ['GET', '/activities/feed', OPEN], ['GET', '/activities/types', OPEN],
  ['GET', '/accounting/journal', V_ACC],

  // --- roles, users, access ------------------------------------------------------
  ['GET', '/roles', 'VIEW_ROLE'], ['GET', '/roles/*', 'VIEW_ROLE'],
  ['POST', '/roles', 'CREATE_ROLE'], ['PATCH', '/roles/:code', 'EDIT_ROLE'], ['PUT', '/roles/:code', 'EDIT_ROLE'],
  ['DELETE', '/roles/:code', 'DELETE_ROLE'],
  ['GET', '/users', 'VIEW_USER_DETAILS'], ['GET', '/users/roles', 'VIEW_USER_DETAILS'], ['GET', '/users/audit', 'VIEW_USER_DETAILS'],
  ['GET', '/users/:id', 'VIEW_USER_DETAILS'], ['GET', '/users/:id/logins', 'VIEW_USER_DETAILS'],
  ['POST', '/users', 'CREATE_USER'], ['PATCH', '/users/:id', 'EDIT_USER'], ['POST', '/users/:id/unlock', 'EDIT_USER'],
  ['POST', '/users/:id/reset-password', ADMIN],
  ['POST', '/users/:id/reset-mfa', 'MANAGE_TWO_FACTOR_AUTHENTICATION'],
  ['GET', '/access-preferences', 'MANAGE_ACCESS_PREFERENCES'], ['PUT', '/access-preferences', 'MANAGE_ACCESS_PREFERENCES'],
  ['PATCH', '/access-preferences', 'MANAGE_ACCESS_PREFERENCES'],
  ['*', '/access-preferences/*', 'MANAGE_ACCESS_PREFERENCES'],
  ['GET', '/consumers', 'VIEW_API_CONSUMERS_AND_KEYS'], ['GET', '/consumers/*', 'VIEW_API_CONSUMERS_AND_KEYS'],
  ['POST', '/consumers', 'CREATE_API_CONSUMERS_AND_KEYS'], ['POST', '/consumers/:id/keys', 'CREATE_API_CONSUMERS_AND_KEYS'],
  ['POST', '/consumers/:id/secret-key', 'CREATE_API_CONSUMERS_AND_KEYS'],
  ['PATCH', '/consumers/:id', 'EDIT_API_CONSUMERS_AND_KEYS'],
  ['DELETE', '/consumers/:id', 'DELETE_API_CONSUMERS_AND_KEYS'], ['DELETE', '/consumers/:id/keys/:keyId', 'DELETE_API_CONSUMERS_AND_KEYS'],
  ['POST', '/consumers/keys/rotation', NONE],
  ['GET', '/audit-trail/events', 'MANAGE_AUDIT_TRAIL'], ['GET', '/v1/events', 'MANAGE_AUDIT_TRAIL'],

  // --- members and groups (the domain checks which of a list a change needs) --------
  ['GET', '/members', V_MEMBER], ['POST', '/members:search', V_MEMBER], ['GET', '/members/*', V_MEMBER],
  ['POST', '/members:duplicates', V_MEMBER], ['POST', '/members:reassign', ASSOC],
  ['POST', '/members', ['CREATE_CLIENT', 'CREATE_GROUP']], ['PATCH', '/members/:id', EDIT_HOLDER],
  ['DELETE', '/members/:id', ['DELETE_CLIENTS', 'DELETE_GROUP']],
  ['POST', '/members/:id/state', STATE_ACTIONS], ['POST', '/members/:id/association', ASSOC],
  ['POST', '/members/:id/anonymize', 'ANONYMIZE_CLIENT'],
  ['POST', '/members/:id/identifications', 'CREATE_DOCUMENTS'],
  ['PUT', '/members/:id/picture', 'EDIT_CLIENT'], ['DELETE', '/members/:id/picture', 'EDIT_CLIENT'],
  ['PUT', '/members/:id/signature', 'EDIT_CLIENT'], ['DELETE', '/members/:id/signature', 'EDIT_CLIENT'],
  ['POST', '/members/:id/identifications/:docId/files', 'CREATE_DOCUMENTS'],
  ['GET', '/members/:id/identifications/:docId/files/:fileId', 'VIEW_DOCUMENTS'],
  ['DELETE', '/members/:id/identifications/:docId/files/:fileId', 'DELETE_DOCUMENTS'],
  ['DELETE', '/members/:id/identifications/:docId', 'DELETE_DOCUMENTS'],
  // The reference platform's API v2 shapes.
  ['GET', '/clients/*', V_MEMBER], ['POST', '/clients:search', V_MEMBER], ['POST', '/clients', 'CREATE_CLIENT'],
  ['PUT', '/clients/:id', EDIT_HOLDER], ['PATCH', '/clients/:id', [...EDIT_HOLDER, ...STATE_ACTIONS]],
  ['DELETE', '/clients/:id', 'DELETE_CLIENTS'],
  ['GET', '/groups', 'VIEW_GROUP_DETAILS'], ['GET', '/groups/*', 'VIEW_GROUP_DETAILS'], ['POST', '/groups:search', 'VIEW_GROUP_DETAILS'],
  ['POST', '/groups', 'CREATE_GROUP'], ['PUT', '/groups/:id', EDIT_HOLDER], ['PATCH', '/groups/:id', EDIT_HOLDER],
  ['DELETE', '/groups/:id', 'DELETE_GROUP'], ['POST', '/groups/:id/members', 'EDIT_GROUP'],
  ['DELETE', '/groups/:id/members/:memberId', 'EDIT_GROUP'],
  ['GET', '/groups/:id/solidarity-loans', { all: ['VIEW_GROUP_DETAILS', V_LOAN] }],
  ['POST', '/groups/:id/solidarity-loans', 'CREATE_LOAN_ACCOUNT'],
  ['GET', '/clients/:id/creditarrangements', 'VIEW_LINE_OF_CREDIT_DETAILS'], ['GET', '/groups/:id/creditarrangements', 'VIEW_LINE_OF_CREDIT_DETAILS'],

  // --- credit arrangements (the reference platform's lines of credit) -----------------------------
  // POST /creditarrangements/:id is the shape of :changeState, :addAccount and
  // :removeAccount; each checks the permission its action needs.
  ['GET', '/creditarrangements', 'VIEW_LINE_OF_CREDIT_DETAILS'], ['GET', '/creditarrangements/*', 'VIEW_LINE_OF_CREDIT_DETAILS'],
  ['POST', '/creditarrangements', 'CREATE_LINES_OF_CREDIT'], ['POST', '/creditarrangements:search', 'VIEW_LINE_OF_CREDIT_DETAILS'],
  ['POST', '/creditarrangements/:id', ['APPROVE_LINE_OF_CREDIT', 'UNDO_APPROVE_LINE_OF_CREDIT', 'REJECT_LINE_OF_CREDIT',
    'UNDO_REJECT_LINE_OF_CREDIT', 'WITHDRAW_LINE_OF_CREDIT', 'UNDO_WITHDRAW_LINE_OF_CREDIT', 'CLOSE_LINES_OF_CREDIT',
    'ADD_ACCOUNTS_TO_LINE_OF_CREDIT', 'REMOTE_ACCOUNTS_FROM_LINE_OF_CREDIT']],
  ['PUT', '/creditarrangements/:id', 'EDIT_LINES_OF_CREDIT'], ['PATCH', '/creditarrangements/:id', 'EDIT_LINES_OF_CREDIT'],
  ['DELETE', '/creditarrangements/:id', 'DELETE_LINES_OF_CREDIT'],
  ['GET', '/client-types', OPEN], ['GET', '/client-types/*', OPEN],
  ['*', '/client-types', 'MANAGE_GENERAL_SETUP'], ['*', '/client-types/*', 'MANAGE_GENERAL_SETUP'],
  ['GET', '/group-role-names', OPEN], ['*', '/group-role-names', 'MANAGE_GENERAL_SETUP'], ['*', '/group-role-names/*', 'MANAGE_GENERAL_SETUP'],
  ['GET', '/client-controls', OPEN], ['PATCH', '/client-controls', ADMIN],

  // --- deposits ------------------------------------------------------------------
  ['GET', '/savings', V_DEP], ['GET', '/savings/*', V_DEP],
  ['POST', '/savings', 'CREATE_SAVINGS_ACCOUNT'],
  ['POST', '/savings/:id/deposits', 'MAKE_DEPOSIT'], ['POST', '/savings/:id/withdrawals', 'MAKE_WITHDRAWAL'],
  ['POST', '/savings/:id/transfers', 'MAKE_TRANSFER'], ['POST', '/savings/:id/fees', 'APPLY_SAVINGS_FEES'],
  ['PUT', '/savings/:id/overdraft', 'EDIT_SAVINGS_ACCOUNT'], ['PATCH', '/savings/:id', 'EDIT_SAVINGS_ACCOUNT'],
  ['POST', '/savings/:id/maturity', 'ACTIVATE_MATURITY'], ['DELETE', '/savings/:id/maturity', 'UNDO_MATURITY'],
  ['POST', '/savings/:id/interest-rate', 'EDIT_SAVINGS_ACCOUNT'],
  // POST /savings/:id is the shape of the reference platform's :changeInterestRate and
  // :changeState; each checks the permission its action needs.
  ['POST', '/savings/:id', DEP_STATE], ['POST', '/savings/:id/state', DEP_STATE],
  ['DELETE', '/savings/:id', 'DELETE_SAVINGS_ACCOUNT'],
  ['POST', '/savings/:id/blocks', 'BLOCK_AND_SEIZE_FUNDS'], ['DELETE', '/savings/:id/blocks/:reference', 'BLOCK_AND_SEIZE_FUNDS'],
  ['POST', '/savings/:id/seizure-transactions', 'BLOCK_AND_SEIZE_FUNDS'],
  ['GET', '/savings/:id/authorizationholds', 'VIEW_HOLDS'], ['POST', '/savings/:id/authorizationholds', 'CREATE_HOLDS'],
  ['DELETE', '/savings/:id/authorizationholds/:reference', 'DELETE_HOLDS'],
  ['POST', '/savings/deposit-transactions:bulk', 'MAKE_DEPOSIT'], ['POST', '/savings/transactions/reversals', 'BULK_DEPOSIT_CORRECTIONS'],
  ['GET', '/bulks/:key', V_DEP],
  // The reference platform's /deposits, the same accounts and rules as /savings. POST /deposits/:id is the
  // shape of every colon action; each checks the permission it needs.
  ['GET', '/deposits', V_DEP], ['GET', '/deposits/*', V_DEP], ['POST', '/deposits:search', V_DEP],
  ['POST', '/deposits/transactions:search', V_DEP], ['POST', '/loans/transactions:search', V_LOAN],
  // Webhooks (the reference platform's templates, communication log and notification settings).
  ['GET', '/templates', TEMPLATES_VIEW], ['GET', '/templates/:id', TEMPLATES_VIEW],
  ['POST', '/templates', 'CREATE_COMMUNICATION_TEMPLATES'], ['POST', '/templates/:id', 'EDIT_COMMUNICATION_TEMPLATES'],
  ['PATCH', '/templates/:id', 'EDIT_COMMUNICATION_TEMPLATES'], ['DELETE', '/templates/:id', 'EDIT_COMMUNICATION_TEMPLATES'],
  ['GET', '/communications/messages/:key', 'VIEW_COMMUNICATION_HISTORY'], ['POST', '/communications/messages:search', 'VIEW_COMMUNICATION_HISTORY'],
  ['POST', '/communications/messages:searchSorted', 'VIEW_COMMUNICATION_HISTORY'], ['POST', '/communications/messages:resend', 'RESEND_FAILED_MESSAGES'],
  ['POST', '/communications/messages:resendAsyncByKeys', 'RESEND_FAILED_MESSAGES'], ['POST', '/communications/messages:resendAsyncByDate', 'RESEND_FAILED_MESSAGES'],
  ['POST', '/notifications/messages/search', 'VIEW_COMMUNICATION_HISTORY'], ['POST', '/notifications/messages', 'RESEND_FAILED_MESSAGES'],
  ['GET', '/notificationsettings/webhook', ADMIN], ['PUT', '/notificationsettings/webhook', ADMIN],
  // Events streaming: API consumers (and administrators) that read streams. The list is also
  // shown under Administration > Events Streaming to those who see the templates.
  ['POST', '/v1/subscriptions', 'CONSUME_EVENT_STREAMS'], ['GET', '/v1/subscriptions', ['CONSUME_EVENT_STREAMS', ...TEMPLATES_VIEW]],
  ['GET', '/v1/subscriptions/:id/events', 'CONSUME_EVENT_STREAMS'], ['GET', '/v1/subscriptions/:id/stats', 'CONSUME_EVENT_STREAMS'],
  ['POST', '/v1/subscriptions/:id/cursors', 'CONSUME_EVENT_STREAMS'], ['DELETE', '/v1/subscriptions/:id', 'CONSUME_EVENT_STREAMS'],
  ['POST', '/deposits', 'CREATE_SAVINGS_ACCOUNT'], ['PUT', '/deposits/:id', 'EDIT_SAVINGS_ACCOUNT'], ['PATCH', '/deposits/:id', 'EDIT_SAVINGS_ACCOUNT'],
  ['DELETE', '/deposits/:id', 'DELETE_SAVINGS_ACCOUNT'],
  ['POST', '/deposits/:id', [...DEP_STATE, 'ACTIVATE_MATURITY', 'UNDO_MATURITY', 'APPLY_ACCRUED_SAVINGS_INTEREST']],
  ['POST', '/deposits/:id/deposit-transactions', 'MAKE_DEPOSIT'], ['POST', '/deposits/:id/withdrawal-transactions', 'MAKE_WITHDRAWAL'],
  ['POST', '/deposits/:id/transfer-transactions', 'MAKE_TRANSFER'], ['POST', '/deposits/:id/fee-transactions', 'APPLY_SAVINGS_FEES'],
  ['POST', '/deposits/:id/seizure-transactions', 'BLOCK_AND_SEIZE_FUNDS'],
  ['POST', '/deposits/:id/blocks', 'BLOCK_AND_SEIZE_FUNDS'], ['DELETE', '/deposits/:id/blocks/:reference', 'BLOCK_AND_SEIZE_FUNDS'],
  ['GET', '/deposits/:id/authorizationholds', 'VIEW_HOLDS'], ['POST', '/deposits/:id/authorizationholds', 'CREATE_HOLDS'],
  ['DELETE', '/deposits/:id/authorizationholds/:reference', 'DELETE_HOLDS'],
  ['POST', '/deposits/deposit-transactions:bulk', 'MAKE_DEPOSIT'],
  ['POST', '/savings/:id/overdraft/write-off', 'CLOSE_SAVINGS_ACCOUNTS'], ['POST', '/savings/:id/close', 'CLOSE_SAVINGS_ACCOUNTS'],
  ['POST', '/savings/:id/interest', 'APPLY_ACCRUED_SAVINGS_INTEREST'],
  ['POST', '/savings/:id/branch', 'MANAGE_DEPOSIT_ASSOCIATION'],
  ['POST', '/savings/:id/loan-repayments', { all: ['MAKE_TRANSFER', 'ENTER_REPAYMENT'] }],
  ['POST', '/savings/transactions/:reference/reversal', 'APPLY_SAVINGS_ADJUSTMENTS'],

  // --- loans -----------------------------------------------------------------------
  ['GET', '/loans', V_LOAN], ['GET', '/loans/*', V_LOAN],
  ['GET', '/loans/collections/sheet', 'ENTER_REPAYMENT'], ['GET', '/loans/collections/batches', 'ENTER_REPAYMENT'],
  ['POST', '/loans/collections/batches', 'ENTER_REPAYMENT'],
  ['GET', '/loans/controls/users', 'VIEW_USER_DETAILS'],
  ['PATCH', '/loans/controls', ADMIN], ['PATCH', '/loans/controls/users/:userId', 'EDIT_USER'],
  ['POST', '/loans/controls/run', EOD], ['POST', '/loans/rates/review', EOD], ['POST', '/loans/:id/rates/review', EOD],
  ['POST', '/loans/revolving/bill', EOD], ['POST', '/loans/planned-fees/run', EOD], ['POST', '/loans/fee-amortization/run', EOD],
  ['POST', '/loans/postdated-payments/run', EOD], ['POST', '/loans/settlement/run', EOD], ['POST', '/loans/penalties/run', EOD],
  ['POST', '/loans/arrears/run', EOD], ['POST', '/loans/fees/run', EOD], ['POST', '/loans/:id/eod-include', EOD],
  ['POST', '/loans/migrate', ADMIN],
  ['POST', '/loans/eligibility', 'CREATE_LOAN_ACCOUNT'], ['POST', '/loans', 'CREATE_LOAN_ACCOUNT'],
  ['PATCH', '/loans/:id', 'EDIT_LOAN_ACCOUNT'], ['PUT', '/loans/:id/disbursement-details', 'EDIT_LOAN_ACCOUNT'],
  ['DELETE', '/loans/:id', 'DELETE_LOAN_ACCOUNT'],
  ['POST', '/loans/:id/guarantors', 'CREATE_SECURITIES'], ['POST', '/loans/:id/collateral', 'CREATE_SECURITIES'],
  ['DELETE', '/loans/:id/guarantors/:guarantorId', 'DELETE_SECURITIES'],
  ['POST', '/loans/collateral/:collateralId/release', 'EDIT_SECURITIES'],
  ['POST', '/loans/:id/guarantors/:guarantorId/release-call', 'EDIT_SECURITIES'],
  ['POST', '/loans/:id/guarantors/:guarantorId/recover', 'COLLECT_GUARANTIES'],
  ['POST', '/loans/:id/request-approval', 'REQUEST_LOAN_APPROVAL'], ['POST', '/loans/:id/submit', 'REQUEST_LOAN_APPROVAL'],
  ['POST', '/loans/:id/set-incomplete', 'SET_LOAN_INCOMPLETE'],
  ['POST', '/loans/:id/approve', 'APPROVE_LOANS'], ['POST', '/loans/:id/undo-approve', 'APPROVE_LOANS'],
  ['POST', '/loans/:id/reject', 'REJECT_LOANS'], ['POST', '/loans/:id/undo-reject', 'UNDO_REJECT_LOANS'],
  ['POST', '/loans/:id/withdraw', 'WITHDRAW_LOAN_ACCOUNTS'], ['POST', '/loans/:id/undo-withdraw', 'UNDO_WITHDRAW_LOAN_ACCOUNTS'],
  ['POST', '/loans/:id/lock', 'LOCK_LOAN_ACCOUNTS'], ['POST', '/loans/:id/unlock', 'LOCK_LOAN_ACCOUNTS'],
  ['POST', '/loans/:id/lock-settings', 'LOCK_LOAN_ACCOUNTS'],
  ['POST', '/loans/:id/close', 'CLOSE_LOAN_ACCOUNTS'], ['POST', '/loans/:id/undo-close', 'UNDO_LOAN_ACCOUNT_CLOSURE'],
  ['GET', '/loans/:id/pay-off', 'PAY_OFF_LOAN'], ['POST', '/loans/:id/pay-off', 'PAY_OFF_LOAN'],
  ['POST', '/loans/:id/terminate', 'TERMINATE_LOAN_ACCOUNTS'], ['POST', '/loans/:id/undo-terminate', 'TERMINATE_LOAN_ACCOUNTS'],
  ['POST', '/loans/:id/interest-rate', 'EDIT_INTEREST_RATE'],
  ['POST', '/loans/:id/penalty-rate', 'EDIT_PENALTY_RATE'],
  ['POST', '/loans/:id/reschedule', 'RESCHEDULE_LOAN_ACCOUNT'], ['POST', '/loans/:id/undo-restructure', 'RESCHEDULE_LOAN_ACCOUNT'],
  ['POST', '/loans/:id/refinance', 'REFINANCE_LOAN_ACCOUNT'],
  ['POST', '/loans/:id/revolving-installments', 'EDIT_REPAYMENT_SCHEDULE'],
  ['DELETE', '/loans/:id/revolving-installments/:billingDateId', 'EDIT_REPAYMENT_SCHEDULE'],
  ['PUT', '/loans/:id/schedule', 'EDIT_REPAYMENT_SCHEDULE'], ['POST', '/loans/:id/payment-holiday', 'EDIT_REPAYMENT_SCHEDULE'],
  ['POST', '/loans/:id/holiday-interest', 'EDIT_REPAYMENT_SCHEDULE'], ['POST', '/loans/:id/due-day', 'EDIT_REPAYMENT_SCHEDULE'],
  ['DELETE', '/loans/:id/application-schedule', 'EDIT_REPAYMENT_SCHEDULE'],
  ['GET', '/loans/:id/attachments', 'VIEW_DOCUMENTS'], ['GET', '/loans/:id/attachments/*', 'VIEW_DOCUMENTS'],
  ['POST', '/loans/:id/attachments', 'CREATE_DOCUMENTS'], ['PATCH', '/loans/:id/attachments/:attachmentId', 'EDIT_DOCUMENTS'],
  ['DELETE', '/loans/:id/attachments/:attachmentId', 'DELETE_DOCUMENTS'],
  ['PUT', '/loans/:id/tranches', 'EDIT_LOAN_TRANCHES'],
  ['POST', '/loans/:id/funding', 'EDIT_INVESTOR_FUNDS'], ['DELETE', '/loans/funding/:fundingId', 'EDIT_INVESTOR_FUNDS'],
  ['POST', '/loans/:id/credit-balance-deposits', 'MAKE_TRANSFER'],
  ['POST', '/loans/:id/fees', 'APPLY_LOAN_FEES'], ['POST', '/loans/:id/planned-fees', 'APPLY_LOAN_FEES'],
  ['POST', '/loans/:id/planned-fees/apply', 'APPLY_LOAN_FEES'], ['PATCH', '/loans/planned-fees/:plannedId', 'APPLY_LOAN_FEES'],
  ['DELETE', '/loans/planned-fees/:plannedId', 'APPLY_LOAN_FEES'],
  ['POST', '/loans/fees/:feeId/waive', 'APPLY_LOAN_ADJUSTMENTS'], ['POST', '/loans/fees/:feeId/adjust', 'APPLY_LOAN_ADJUSTMENTS'],
  ['POST', '/loans/:id/reduce-balance', 'APPLY_LOAN_ADJUSTMENTS'],
  ['POST', '/loans/:id/penalties/accrue', 'APPLY_LOAN_ADJUSTMENTS'],
  ['POST', '/loans/penalties/:chargeId/waive', 'APPLY_LOAN_ADJUSTMENTS'], ['POST', '/loans/penalties/:chargeId/adjust', 'APPLY_LOAN_ADJUSTMENTS'],
  ['POST', '/loans/transactions/:reference/reversal', 'APPLY_LOAN_ADJUSTMENTS'],
  ['POST', '/loans/:id/disbursements', 'DIBURSE_LOANS'],
  ['POST', '/loans/:id/repayments', 'ENTER_REPAYMENT'], ['POST', '/loans/:id/recoveries', 'ENTER_REPAYMENT'],
  ['POST', '/loans/:id/postdated-payments', 'ENTER_REPAYMENT'], ['POST', '/loans/postdated-payments/:paymentId/cancel', 'ENTER_REPAYMENT'],
  ['POST', '/loans/:id/accrue-interest', 'APPLY_ACCRUED_LOAN_INTEREST'],
  ['POST', '/loans/:id/write-off', 'WRITE_OFF_LOAN_ACCOUNTS'],
  ['POST', '/loans/:id/write-off/approve', 'APPROVE_WRITE_OFFS'], ['POST', '/loans/:id/write-off/reject', 'APPROVE_WRITE_OFFS'],
  ['POST', '/loans/:id/branch', 'MANAGE_LOAN_ASSOCIATION'],
  ['PUT', '/loans/:id/settlement-account', 'LINK_ACCOUNTS'], ['DELETE', '/loans/:id/settlement-account', 'LINK_ACCOUNTS'],

  // --- products and rates ------------------------------------------------------------
  ['GET', '/loan-products', 'VIEW_LOAN_PRODUCT_DETAILS'], ['GET', '/loan-products/*', 'VIEW_LOAN_PRODUCT_DETAILS'],
  ['POST', '/loan-products/:id/schedule-preview', 'VIEW_LOAN_PRODUCT_DETAILS'],
  ['POST', '/loan-products', 'CREATE_LOAN_PRODUCT'], ['PATCH', '/loan-products/:id', 'EDIT_LOAN_PRODUCT'],
  ['POST', '/loan-products/:id/accounting-method', 'EDIT_LOAN_PRODUCT'], ['POST', '/loan-products/:id/fees', 'EDIT_LOAN_PRODUCT'],
  ['PATCH', '/loan-products/:id/fees/:feeId', 'EDIT_LOAN_PRODUCT'], ['DELETE', '/loan-products/:id/fees/:feeId', 'EDIT_LOAN_PRODUCT'],
  ['GET', '/deposit-products', 'VIEW_SAVINGS_PRODUCT_DETAILS'], ['GET', '/deposit-products/*', 'VIEW_SAVINGS_PRODUCT_DETAILS'],
  ['POST', '/deposit-products/accounting-rules', 'VIEW_SAVINGS_PRODUCT_DETAILS'],
  ['POST', '/deposit-products', 'CREATE_SAVINGS_PRODUCT'], ['PATCH', '/deposit-products/:id', 'EDIT_SAVINGS_PRODUCT'],
  ['POST', '/deposit-products/:id/accounting-method', 'EDIT_SAVINGS_PRODUCT'], ['POST', '/deposit-products/:id/fees', 'EDIT_SAVINGS_PRODUCT'],
  ['PATCH', '/deposit-products/:id/fees/:feeId', 'EDIT_SAVINGS_PRODUCT'], ['DELETE', '/deposit-products/:id/fees/:feeId', 'EDIT_SAVINGS_PRODUCT'],
  ['DELETE', '/deposit-products/:id', 'DELETE_SAVINGS_PRODUCT'],
  ['GET', '/index-rates', OPEN], ['GET', '/index-rates/*', OPEN],
  ['*', '/index-rates', 'MANAGE_INDEX_RATES'], ['*', '/index-rates/*', 'MANAGE_INDEX_RATES'],

  // --- accounting and branches ----------------------------------------------------------
  ['GET', '/accounting/*', V_ACC],
  ['PUT', '/accounting/inter-branch-rules', 'MANAGE_INTERBRANCH_GLACCOUNT_RULES'],
  ['POST', '/accounting/closures', 'MAKE_ACCOUNTING_CLOSURE'], ['DELETE', '/accounting/closures/:id', 'APPLY_ACCOUNTING_ADJUSTMENTS'],
  ['PUT', '/accounting/settings', 'MANAGE_ACCOUNTS'], ['POST', '/accounting/accruals/post', 'LOG_JOURNAL_ENTRIES'],
  ['POST', '/accounting/reports', V_ACC], ['GET', '/accounting/reports/:reportKey', V_ACC],
  ['PATCH', '/accounting/closures/:id', 'MAKE_ACCOUNTING_CLOSURE'],
  ['POST', '/accounting/interestaccrual:search', V_ACC],
  // The reference platform's GL accounts and journal entries. POST /gljournalentries/:ref is the shape of
  // :reverse; reversing a manual entry takes the permission that logs one.
  ['GET', '/glaccounts', V_ACC], ['GET', '/glaccounts/*', V_ACC],
  ['POST', '/glaccounts', 'MANAGE_ACCOUNTS'], ['PUT', '/glaccounts/:code', 'MANAGE_ACCOUNTS'],
  ['PATCH', '/glaccounts/:code', 'MANAGE_ACCOUNTS'], ['DELETE', '/glaccounts/:code', 'MANAGE_ACCOUNTS'],
  ['GET', '/gljournalentries', V_ACC], ['GET', '/gljournalentries/*', V_ACC], ['POST', '/gljournalentries:search', V_ACC],
  ['POST', '/gljournalentries', 'LOG_JOURNAL_ENTRIES'], ['POST', '/gljournalentries/:ref', 'LOG_JOURNAL_ENTRIES'],
  ['POST', '/gljournalentries/:ref/attachments', 'LOG_JOURNAL_ENTRIES'],
  ['GET', '/branches', 'VIEW_BRANCH_DETAILS'], ['GET', '/branches/:id', 'VIEW_BRANCH_DETAILS'],
  ['POST', '/branches', 'CREATE_BRANCH'], ['PATCH', '/branches/:id', 'EDIT_BRANCH'],
  ['GET', '/centres', 'VIEW_CENTRE_DETAILS'], ['GET', '/centres/:id', 'VIEW_CENTRE_DETAILS'],
  ['POST', '/centres', 'CREATE_CENTRE'], ['PATCH', '/centres/:id', 'EDIT_CENTRE'],

  // --- organization and general setup ----------------------------------------------------
  ['GET', '/organization', OPEN], ['PUT', '/organization', ADMIN],
  ['PUT', '/organization/branding/:kind', ADMIN], ['DELETE', '/organization/branding/:kind', ADMIN],
  ['GET', '/organization/eod', EOD], ['POST', '/organization/eod/retry-excluded', EOD],
  ['PUT', '/organization/eod', ADMIN], ['POST', '/organization/eod/run', ADMIN],
  ['GET', '/holidays', OPEN], ['*', '/holidays', 'MANAGE_HOLIDAYS'], ['*', '/holidays/*', 'MANAGE_HOLIDAYS'],
  ['GET', '/transaction-channels', 'VIEW_TRANSACTION_CHANNELS'],
  ['POST', '/transaction-channels', 'CREATE_TRANSACTION_CHANNELS'], ['PUT', '/transaction-channels/order', 'EDIT_TRANSACTION_CHANNELS'],
  ['PATCH', '/transaction-channels/:id', 'EDIT_TRANSACTION_CHANNELS'], ['DELETE', '/transaction-channels/:id', 'DELETE_TRANSACTION_CHANNELS'],
  ['GET', '/id-templates', OPEN], ['*', '/id-templates', 'MANAGE_GENERAL_SETUP'], ['*', '/id-templates/*', 'MANAGE_GENERAL_SETUP'],
  ['GET', '/currencies', OPEN], ['GET', '/currencies/*', OPEN],
  ['POST', '/currencies', 'MANAGE_CURRENCIES'], ['PATCH', '/currencies/:code', 'MANAGE_CURRENCIES'], ['DELETE', '/currencies/:code', 'MANAGE_CURRENCIES'],
  ['POST', '/currencies/:code/exchange-rates', 'CREATE_EXCHANGE_RATE'], ['POST', '/currencies/:code/accounting-rates', 'CREATE_ACCOUNTING_RATES'],
  ['POST', '/currencies/:code/accountingRates', 'CREATE_ACCOUNTING_RATES'],
  ['GET', '/custom-fields/*', 'VIEW_CUSTOM_FIELD'],
  ['POST', '/custom-fields/sets', 'CREATE_CUSTOM_FIELD'], ['POST', '/custom-fields/definitions', 'CREATE_CUSTOM_FIELD'],
  ['PUT', '/custom-fields/sets/order', 'EDIT_CUSTOM_FIELD'], ['PUT', '/custom-fields/definitions/order', 'EDIT_CUSTOM_FIELD'],
  ['PATCH', '/custom-fields/sets/:id', 'EDIT_CUSTOM_FIELD'], ['PATCH', '/custom-fields/definitions/:id', 'EDIT_CUSTOM_FIELD'],
  ['DELETE', '/custom-fields/sets/:id', 'DELETE_CUSTOM_FIELD'], ['DELETE', '/custom-fields/definitions/:id', 'DELETE_CUSTOM_FIELD'],
  // The entity's permission, branch and member rules are checked in the handler (customFields.assertAccess); the definition's roles decide which fields.
  // The reference platform's API v2 metadata and configuration as code (a PUT creates, edits and deactivates).
  ['GET', '/customfields/:id', 'VIEW_CUSTOM_FIELD'], ['GET', '/customfieldsets', 'VIEW_CUSTOM_FIELD'],
  ['GET', '/customfieldsets/:id/customfields', 'VIEW_CUSTOM_FIELD'],
  ['GET', '/configuration/customfields.yaml', 'VIEW_CUSTOM_FIELD'], ['GET', '/configuration/customfields/template.yaml', 'VIEW_CUSTOM_FIELD'],
  ['PUT', '/configuration/customfields.yaml', { all: ['CREATE_CUSTOM_FIELD', 'EDIT_CUSTOM_FIELD', 'DELETE_CUSTOM_FIELD'] }],
  ['GET', '/custom-fields/values/:entity/:id', OPEN],
  ['PUT', '/custom-fields/values/:entity/:id', OPEN],
  ['GET', '/documents/*', 'VIEW_DOCUMENTS'],
  ['POST', '/documents/templates/:kind/:productId', 'CREATE_PRODUCT_DOCUMENT_TEMPLATES'],
  ['PATCH', '/documents/templates/:id', 'EDIT_PRODUCT_DOCUMENT_TEMPLATES'],
  ['DELETE', '/documents/templates/:id', 'DELETE_PRODUCT_DOCUMENT_TEMPLATES'],

  // --- data -----------------------------------------------------------------------------
  ['GET', '/data-dictionary', OPEN], ['GET', '/data-dictionary/:table', OPEN], ['POST', '/data-dictionary/apply-comments', ADMIN],
  ['GET', '/extract', 'EXTRACT_DATA'], ['GET', '/extract/:stream', 'EXTRACT_DATA'],
  ['*', '/database/*', 'DOWNLOAD_BACKUPS'],
  ['GET', '/data-imports/template', 'IMPORT_DATA'], ['POST', '/data-imports', 'IMPORT_DATA'],
  ['GET', '/data-imports', 'VIEW_DATA_IMPORTS'], ['GET', '/data-imports/*', 'VIEW_DATA_IMPORTS'],
  ['POST', '/data-imports/:id/approve', ADMIN], ['POST', '/data-imports/:id/reject', ADMIN],
  ['POST', '/data/import', 'IMPORT_DATA'], ['GET', '/data/import/:importKey', 'VIEW_DATA_IMPORTS'],
  ['POST', '/data/import/events/*', ADMIN],

  // --- shares and dividends (SACCO; not in the reference platform) ----------------------------------------
  ['GET', '/shares', OPEN], ['GET', '/shares/*', OPEN],
  ['POST', '/shares', 'BUY_SHARES'], ['POST', '/shares/:id/purchases', 'BUY_SHARES'],
  ['POST', '/shares/:id/transfers', 'TRANSFER_SHARES'], ['POST', '/shares/transactions/:reference/reversal', 'TRANSFER_SHARES'],
  ['GET', '/dividends', OPEN], ['GET', '/dividends/*', OPEN], ['POST', '/dividends', 'MANAGE_DIVIDENDS'], ['POST', '/dividends/*', 'MANAGE_DIVIDENDS'],

  // --- reports, workspace ---------------------------------------------------------------------
  ['GET', '/reports/balance-sheet', V_ACC], ['GET', '/reports/income-statement', V_ACC], ['GET', '/reports/prudential', V_ACC],
  ['GET', '/reports/limits', V_ACC],
  ['GET', '/reports/indicators', 'VIEW_INTELLIGENCE'], ['GET', '/reports/indicators/*', 'VIEW_INTELLIGENCE'],
  ['GET', '/reports/indicator-reports', 'VIEW_INTELLIGENCE'], ['GET', '/reports/indicator-reports/:id', 'VIEW_INTELLIGENCE'],
  ['POST', '/reports/indicator-reports', 'CREATE_REPORTS'], ['PUT', '/reports/indicator-reports/:id', 'EDIT_REPORTS'],
  ['PATCH', '/reports/indicator-reports/:id', 'EDIT_REPORTS'], ['DELETE', '/reports/indicator-reports/:id', 'DELETE_REPORTS'],
  ['POST', '/reports/positions', EOD],
  ['GET', '/reports/audit-log', ['AUDIT_TRANSACTIONS', 'VIEW_REPORTS']],
  ['GET', '/reports/*', 'VIEW_REPORTS'],
  ['GET', '/report-templates', 'VIEW_REPORTS'], ['GET', '/report-templates/*', 'VIEW_REPORTS'],
  ['POST', '/report-templates/:id/run', 'VIEW_REPORTS'],
  ['POST', '/report-templates', 'CREATE_REPORTS'], ['PUT', '/report-templates/order', 'EDIT_REPORTS'],
  ['PATCH', '/report-templates/:id', 'EDIT_REPORTS'], ['DELETE', '/report-templates/:id', 'DELETE_REPORTS'],
  ['GET', '/tasks', 'VIEW_TASK'], ['GET', '/tasks/*', 'VIEW_TASK'],
  ['POST', '/tasks/templates', 'CREATE_COMMUNICATION_TEMPLATES'], ['PATCH', '/tasks/templates/:id', 'EDIT_COMMUNICATION_TEMPLATES'],
  ['DELETE', '/tasks/templates/:id', 'EDIT_COMMUNICATION_TEMPLATES'],
  ['POST', '/tasks', 'CREATE_TASK'], ['PATCH', '/tasks/:id', 'EDIT_TASK'], ['PUT', '/tasks/:id', 'EDIT_TASK'],
  ['POST', '/tasks/:id/complete', 'EDIT_TASK'], ['POST', '/tasks/:id/reopen', 'EDIT_TASK'], ['DELETE', '/tasks/:id', 'DELETE_TASK'],
  ['GET', '/tills/mine', [V_DEP, V_LOAN]],
  ['GET', '/tills', ['OPEN_TILL', 'CLOSE_TILL']], ['GET', '/tills/next-id', 'OPEN_TILL'],
  ['GET', '/tills/:id', ['OPEN_TILL', 'CLOSE_TILL', V_DEP]],
  ['POST', '/tills', 'OPEN_TILL'], ['DELETE', '/tills/:id', 'OPEN_TILL'], ['POST', '/tills/:id/reopen', 'OPEN_TILL'],
  // A supervisor moves cash in and out of a till; ADD_CASH and REMOVE_CASH are the teller's
  // permissions to post through the till (the reference platform's meaning), checked where a transaction is linked.
  ['POST', '/tills/:id/add-cash', 'OPEN_TILL'], ['POST', '/tills/:id/remove-cash', 'OPEN_TILL'],
  ['POST', '/tills/:id/close', 'CLOSE_TILL'], ['POST', '/tills/:id/undo-close', 'CLOSE_TILL'],

  // --- provisioning, periods, returns (SACCO finance; not in the reference platform) ------------------------
  ['GET', '/provisioning/*', V_ACC],
  ['PATCH', '/provisioning/bands/:code', 'MANAGE_PROVISIONING'], ['POST', '/provisioning/runs/:id/reverse', 'MANAGE_PROVISIONING'],
  ['POST', '/provisioning/run', 'RUN_PROVISIONING'],
  ['GET', '/periods', V_ACC], ['GET', '/periods/*', V_ACC],
  ['*', '/periods', 'CLOSE_FINANCIAL_YEAR'], ['*', '/periods/*', 'CLOSE_FINANCIAL_YEAR'],
  ['GET', '/returns', V_ACC], ['GET', '/returns/*', V_ACC], ['PUT', '/returns/:code', 'MANAGE_RETURNS'],
];

// --- matching -------------------------------------------------------------------------------

/** Specificity: literal segments beat parameters, which beat a trailing wildcard. */
function compile([method, path, rule], i) {
  const segs = path.split('/').filter(Boolean);
  const wild = segs[segs.length - 1] === '*';
  const body = wild ? segs.slice(0, -1) : segs;
  const re = new RegExp(`^/${body.map((s) => (s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}${wild ? '(?:/.*)?' : ''}/?$`);
  const score = body.reduce((n, s) => n * 3 + (s.startsWith(':') ? 1 : 2), 1) * 2 + (wild ? 0 : 1);
  return { method, path, rule, re, score, len: body.length + (wild ? 0.5 : 1), i };
}
const TABLE = RULES.map(compile).sort((a, b) => b.len - a.len || b.score - a.score || (a.method === '*') - (b.method === '*') || a.i - b.i);

// What works on the whole organization: not for a user limited to some branches.
const ORG_WIDE = new Set(['MANAGE_EOD_PROCESSING', 'RUN_PROVISIONING', 'MANAGE_PROVISIONING', 'CLOSE_FINANCIAL_YEAR', 'MANAGE_DIVIDENDS',
  'IMPORT_DATA', 'DOWNLOAD_BACKUPS', 'EXTRACT_DATA', 'MAKE_ACCOUNTING_CLOSURE', 'APPLY_ACCOUNTING_ADJUSTMENTS']);

/**
 * The reference platform's critical actions: with re-authentication on in the access
 * preferences, a signed-in user gives their password again for these.
 */
const CRITICAL = [
  ['POST', '/users'], ['PATCH', '/users/:id'], ['POST', '/users/:id/reset-password'], ['POST', '/users/:id/reset-mfa'],
  ['POST', '/users/:id/unlock'], ['POST', '/roles'], ['PATCH', '/roles/:code'], ['PUT', '/roles/:code'], ['DELETE', '/roles/:code'],
  ['PUT', '/access-preferences'], ['PATCH', '/access-preferences'], ['POST', '/access-preferences/blocked-ips/reset'],
  ['POST', '/consumers'], ['PATCH', '/consumers/:id'], ['DELETE', '/consumers/:id'], ['DELETE', '/consumers/:id/keys/:keyId'],
  ['POST', '/loan-products'], ['PATCH', '/loan-products/:id'], ['POST', '/loan-products/:id/accounting-method'],
  ['POST', '/deposit-products'], ['PATCH', '/deposit-products/:id'], ['POST', '/deposit-products/:id/accounting-method'],
  ['PUT', '/accounting/settings'], ['PUT', '/organization'], ['PATCH', '/branches/:id'],
  ['POST', '/database/backup'], ['GET', '/database/backup/:id/file'],
  ['POST', '/documents/templates/:kind/:productId'], ['PATCH', '/documents/templates/:id'], ['DELETE', '/documents/templates/:id'],
  ['PATCH', '/loans/controls'], ['PATCH', '/loans/controls/users/:userId'],
  ['DELETE', '/members/:id'], ['DELETE', '/clients/:id'], ['DELETE', '/groups/:id'], ['POST', '/members/:id/anonymize'],
  ['PATCH', '/client-controls'],
].map(([m, pth], i) => compile([m, pth, null], i));

function isCritical(method, path) {
  const p = path.replace(/\/+$/, '') || '/';
  return CRITICAL.some((t) => t.method === method && t.re.test(p));
}

/** The rule for a request, or undefined when no rule matches. */
function ruleFor(method, path) {
  const p = path.replace(/\/+$/, '') || '/';
  for (const t of TABLE) {
    if (t.method !== '*' && t.method !== method && !(t.method === 'GET' && method === 'HEAD')) continue;
    if (t.re.test(p)) return t;
  }
  return undefined;
}

/** Every permission code the table uses. */
function codes() {
  const out = new Set();
  for (const [, , r] of RULES) {
    if (typeof r === 'string') out.add(r);
    else if (Array.isArray(r)) r.forEach((c) => out.add(c));
    else if (r && r.all) r.all.forEach((c) => out.add(c));
  }
  return [...out];
}

module.exports = { RULES, ADMIN, OPEN, NONE, ORG_WIDE, ruleFor, isCritical, codes };
