// Seed data extracted verbatim from the original server.js.
// In-memory only. Replaced by a real datastore before production.

const BRANCHES = [
  { id: 'HQ', name: 'Headquarters', address: 'Nairobi, Kenya' },
  { id: 'BR1', name: 'Westlands Branch', address: 'Westlands, Nairobi' },
];

const CENTRES = [
  { id: 'C1', name: 'Centre 1', branchId: 'HQ' },
  { id: 'C2', name: 'Centre 2', branchId: 'BR1' },
];

const GROUPS = [
  { id: 'G1', name: 'KPMG Staff Group', centreId: 'C1' },
];

const CURRENCIES = [
  { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh' },
];

const TRANSACTIONS = [
  { id: 'T1', accountId: '61110K134-SAV', amount: 10000, type: 'DEPOSIT', date: '2026-04-01' },
];

const CARDS = [
  { id: 'CARD1', accountId: '61110K134-SAV', cardNumber: '**** **** **** 1234', status: 'ACTIVE' },
];

const LOANS = [
  { member: 'Joseph Kariuki', id: '61110K134', principal: 710000, duration: 36, disbDate: '2026-02-27', status: 'Active' },
  { member: 'Stephen Kamau Waweru', id: '61110K351', principal: 3499000, duration: 60, disbDate: '2025-11-26', status: 'Active' },
  { member: 'Maxwell Munyi Munene', id: '61110K1174', principal: 2000000, duration: 60, disbDate: '2026-02-06', status: 'Active' },
  { member: 'Sarah Wanjiku Rukunga', id: '61110K2565', principal: 79000, duration: 36, disbDate: '2026-02-04', status: 'Active' },
  { member: 'Christine Gatakaa Njeri', id: '61110K2526', principal: 99000, duration: 36, disbDate: '2026-02-11', status: 'Arrears' },
  { member: 'Erastus Kamau Maina', id: '61110K235', principal: 2999000, duration: 60, disbDate: '2026-02-12', status: 'Active' },
];

const SAVINGS = [
  { member: 'Joseph Kariuki', id: '61110K134', balance: 10000, last: '2026-02-28' },
  { member: 'Maxwell Munyi', id: '61110K1174', balance: 10000, last: '2026-02-28' },
  { member: 'Sarah Rukunga', id: '61110K2565', balance: 5000, last: '2026-02-04' },
  { member: 'Christine Gatakaa', id: '61110K2526', balance: 25000, last: '2026-02-11' },
  { member: 'Erastus Kamau', id: '61110K235', balance: 10000, last: '2026-02-28' },
];

const SHARES = [
  { member: 'Joseph Kariuki', id: '61110K134', amount: 1000000, units: 5000 },
  { member: 'Maxwell Munyi', id: '61110K1174', amount: 100000, units: 500 },
  { member: 'Sarah Rukunga', id: '61110K2565', amount: 15000, units: 75 },
  { member: 'Clive Akora', id: '61110K242', amount: 100000, units: 500 },
];

const KYC_FIELDS = [
  { name: 'First Name', type: 'Text', required: true, section: 'Personal' },
  { name: 'Last Name', type: 'Text', required: true, section: 'Personal' },
  { name: 'Kwara ID', type: 'Text', required: true, section: 'Personal' },
  { name: 'Employee #', type: 'Text', required: false, section: 'Personal' },
  { name: 'National ID No.', type: 'Text', required: true, section: 'Personal' },
  { name: 'KRA PIN', type: 'Text', required: false, section: 'Personal' },
  { name: 'Date of Birth', type: 'Date', required: false, section: 'Personal' },
  { name: 'Gender', type: 'Dropdown', required: false, section: 'Personal' },
  { name: 'Phone Number', type: 'Text', required: true, section: 'Personal' },
  { name: 'Email Address', type: 'Text', required: false, section: 'Personal' },
  { name: 'Entity/Employer', type: 'Dropdown', required: true, section: 'Employment' },
  { name: 'Date Joined SACCO', type: 'Date', required: false, section: 'Employment' },
];

const CUSTOM_FIELDS = [
  { id: 'CF1', module: 'Clients', fieldSet: 'General', label: 'Guarantor 1 Name', type: 'Text', section: 'Financial', usage: 'Available', required: 'Optional', hint: '' },
  { id: 'CF2', module: 'Clients', fieldSet: 'General', label: 'Guarantor 2 Name', type: 'Text', section: 'Financial', usage: 'Available', required: 'Optional', hint: '' },
  { id: 'CF3', module: 'Clients', fieldSet: 'General', label: 'MPESA Number', type: 'Text', section: 'Personal', usage: 'Available', required: 'Optional', hint: '' },
];

const CUSTOM_FIELD_SETS = [
  { id: 'CFS1', module: 'Clients', name: 'General', type: 'Standard', notes: 'Default client field set' },
  { id: 'CFS2', module: 'Groups', name: 'General', type: 'Standard', notes: 'Default group field set' },
];

const GL_ACCOUNTS = [
  { code: '100-100-001', name: 'Loan Portfolio — Normal Loans', type: 'Asset', statement: 'Balance Sheet' },
  { code: '100-100-002', name: 'Loan Portfolio — Car Insurance Loans', type: 'Asset', statement: 'Balance Sheet' },
  { code: '100-000-201', name: 'Bank Account', type: 'Asset', statement: 'Balance Sheet' },
  { code: '100-000-401', name: 'KPMG Payroll Control Receivable', type: 'Asset', statement: 'Balance Sheet' },
  { code: '200-000-101', name: 'Member Deposits', type: 'Liability', statement: 'Balance Sheet' },
  { code: '200-000-309', name: 'Overflow Account', type: 'Liability', statement: 'Balance Sheet' },
  { code: '300-000-101', name: 'Share Capital', type: 'Equity', statement: 'Balance Sheet' },
  { code: '400-000-101', name: 'Interest Income — Normal Loans', type: 'Income', statement: 'Income Statement' },
  { code: '400-000-102', name: 'Interest Income — Car Insurance Loans', type: 'Income', statement: 'Income Statement' },
  { code: '410-000-101', name: 'Loan Processing Fees', type: 'Income', statement: 'Income Statement' },
  { code: '500-000-101', name: 'Operating Expenses', type: 'Expense', statement: 'Income Statement' },
  { code: '500-000-301', name: 'Bank Charges', type: 'Expense', statement: 'Income Statement' },
];

const USERS = [
  { name: 'John Karanja', email: 'admin@example.com', role: 'Super Admin', status: 'Active' },
  { name: 'Abraham Rono', email: 'accountant@example.com', role: 'Accountant', status: 'Active' },
  { name: 'System Admin', email: 'sysadmin@example.com', role: 'Super Admin', status: 'Active' },
];

// ═══════════════════════════════════════ ADVANCED FEATURES ═══════════════════════════════════════
const NOTIFICATIONS = [
  { id: 'N1', type: 'LOAN_DUE', title: 'Loan Payment Due', message: 'Your loan payment of KSh 25,000 is due tomorrow', recipient: '61110K134', status: 'UNREAD', createdAt: '2026-04-01T10:00:00Z' },
  { id: 'N2', type: 'ACCOUNT_LOW', title: 'Low Balance Alert', message: 'Your savings account balance is below KSh 5,000', recipient: '61110K2565', status: 'READ', createdAt: '2026-03-28T14:30:00Z' },
];

const BACKGROUND_PROCESSES = [
  { id: 'BP1', name: 'Daily Interest Accrual', type: 'INTEREST_ACCRUAL', status: 'COMPLETED', lastRun: '2026-04-01T02:00:00Z', nextRun: '2026-04-02T02:00:00Z', schedule: 'DAILY' },
  { id: 'BP2', name: 'Monthly Statement Generation', type: 'STATEMENT_GENERATION', status: 'PENDING', lastRun: '2026-03-31T02:00:00Z', nextRun: '2026-04-30T02:00:00Z', schedule: 'MONTHLY' },
  { id: 'BP3', name: 'Loan Maturity Check', type: 'LOAN_MATURITY', status: 'RUNNING', lastRun: null, nextRun: '2026-04-01T06:00:00Z', schedule: 'DAILY' },
];

const DOCUMENTS = [
  { id: 'DOC1', name: 'Loan Agreement - Joseph Kariuki', type: 'LOAN_AGREEMENT', entityId: '61110K134', entityType: 'MEMBER', uploadedAt: '2026-02-27T10:00:00Z', size: 245760, status: 'ACTIVE' },
  { id: 'DOC2', name: 'KYC Documents - Sarah Rukunga', type: 'KYC_DOCUMENTS', entityId: '61110K2565', entityType: 'MEMBER', uploadedAt: '2026-02-04T09:15:00Z', size: 512000, status: 'ACTIVE' },
];

const WORKFLOWS = [
  { id: 'WF1', name: 'Loan Approval Process', type: 'LOAN_APPROVAL', status: 'ACTIVE', steps: ['Application', 'Credit Check', 'Approval', 'Disbursement'], currentStep: 0 },
  { id: 'WF2', name: 'Member Onboarding', type: 'MEMBER_ONBOARDING', status: 'ACTIVE', steps: ['Registration', 'KYC Verification', 'Account Creation', 'Welcome'], currentStep: 0 },
];

const AUDIT_LOGS = [
  { id: 'AL1', action: 'LOGIN', user: 'admin@example.com', entity: 'USER', entityId: 'admin@example.com', timestamp: '2026-04-01T08:30:00Z', details: 'Successful login from 192.168.1.100' },
  { id: 'AL2', action: 'CREATE_LOAN', user: 'admin@example.com', entity: 'LOAN', entityId: '61110K134', timestamp: '2026-02-27T10:15:00Z', details: 'Created loan for Joseph Kariuki - KSh 710,000' },
  { id: 'AL3', action: 'UPDATE_MEMBER', user: 'accountant@example.com', entity: 'MEMBER', entityId: '61110K2565', timestamp: '2026-03-15T14:20:00Z', details: 'Updated contact information' },
];

const LOAN_PRODUCTS = [
  { id: 'NL01', name: 'Normal Loan', rate: 1, maxTerm: 60, fee: 1000, feeDefault: true, glAsset: '100-100-001', glIncome: '400-000-101' },
  { id: 'CL01', name: 'Car Insurance Loan', rate: 1, maxTerm: 24, fee: 1000, feeDefault: true, glAsset: '100-100-002', glIncome: '400-000-102' },
];

const SAVINGS_PRODUCTS = [
  { id: 'MD01', name: 'Member Deposits', interest: 0, glLiability: '200-000-101', glPayroll: '100-000-401', glBank: '100-000-201' },
  { id: 'OD01', name: 'Overflow Account', interest: 0, glLiability: '200-000-309', glPayroll: '200-000-309', glBank: '200-000-309' },
];

const SHARE_PRODUCTS = [
  { id: 'SC01', name: 'Share Capital', parValue: 200, glEquity: '300-000-101' },
];

const CHARGES = [
  { name: 'Loan Processing Fee', amount: 1000, appliesTo: 'All Loans', timing: 'At Disbursement', defaultOn: true, gl: '410-000-101' },
  { name: 'Loan Penalty', amount: 500, appliesTo: 'Overdue Loans', timing: 'Per missed installment', defaultOn: false, gl: '410-000-102' },
];

const TB_DATA = [
  { type: 'ASSET', code: '100-000-101', name: 'Loans to members', open: 286362033.84, debit: 1027618116.46, credit: 970528286.53, net: 57089829.93, close: 343451863.77 },
  { type: 'ASSET', code: '100-000-102', name: 'Car Insurance Loan', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'ASSET', code: '100-000-201', name: 'Bank', open: 6700093.15, debit: 1292707183.91, credit: 1296370877.65, net: -3663693.74, close: 3036399.41 },
  { type: 'ASSET', code: '100-000-202', name: 'Fixed Deposit - NCBA', open: 25000000, debit: 18401437.06, credit: 25401437.06, net: -7000000, close: 18000000 },
  { type: 'ASSET', code: '100-000-301', name: 'KPMG Staff', open: 0, debit: 177510.60, credit: 177510.60, net: 0, close: 0 },
  { type: 'ASSET', code: '100-000-302', name: 'Ex KPMG Staff', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'ASSET', code: '100-000-303', name: 'Receivable from Ex-KPMG', open: 2271010.09, debit: 2112377.17, credit: 4383387.26, net: -2271010.09, close: 0 },
  { type: 'ASSET', code: '100-000-305', name: 'Property & Equipment', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'ASSET', code: '100-000-307', name: 'Deferred tax', open: 2800, debit: 0, credit: 0, net: 0, close: 2800 },
  { type: 'ASSET', code: '100-000-308', name: 'Receivable from Kwara', open: 120, debit: 0, credit: 0, net: 0, close: 120 },
  { type: 'ASSET', code: '100-000-401', name: 'KPMG Payroll Deduction', open: 5580899.59, debit: 76258062.03, credit: 75710264.62, net: 547797.41, close: 6128697 },
  { type: 'ASSET', code: '100-000-402', name: 'Gras Savoye Kenya Insurance', open: 0, debit: 8228158.92, credit: 8228158.92, net: 0, close: 0 },
  { type: 'ASSET', code: '100-000-403', name: 'Insurance Payroll', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'ASSET', code: '100-000-404', name: 'Bank Receipts', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'ASSET', code: '100-000-405', name: 'Savings Payroll', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'ASSET', code: '100-000-406', name: 'Investments', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'ASSET', code: '100-000-407', name: 'Kwara', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'ASSET', code: '100-000-408', name: 'Kaputei (James Munene)', open: 102500, debit: 0, credit: 0, net: 0, close: 102500 },
  { type: 'ASSET', code: '100-000-501', name: 'Co-operative Bank of Kenya', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'ASSET', code: '100-000-502', name: 'Coop Insurance Company', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'ASSET', code: '100-000-503', name: 'KUSCCO Ltd Shares', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'ASSET', code: '100-000-504', name: 'CIC Insurance group', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'ASSET', code: '100-000-601', name: 'Sacco ERP', open: 1067200, debit: 0, credit: 0, net: 0, close: 1067200 },
  { type: 'ASSET', code: '100-000-602', name: 'Acc. SACCO ERP Depreciation', open: -725886.48, debit: 0, credit: 113771.74, net: -113771.74, close: -839658.22 },
  { type: 'ASSET', code: '100-000-701', name: 'Land', open: 8665000, debit: 0, credit: 0, net: 0, close: 8665000 },
  { type: 'ASSET', code: '100-000-702', name: 'Computer and Accessories', open: 391366, debit: 0, credit: 0, net: 0, close: 391366 },
  { type: 'ASSET', code: '100-000-703', name: 'Acc. Depreciation', open: -391366, debit: 0, credit: 0, net: 0, close: -391366 },
  { type: 'ASSET', code: '100-000-704', name: 'Trade & Other receivables', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'ASSET', code: '100-000-801', name: 'Co-operative Bank of Kenya', open: 1574, debit: 0, credit: 0, net: 0, close: 1574 },
  { type: 'ASSET', code: '100-000-802', name: 'Coop Insurance Company of Kenya', open: 593, debit: 0, credit: 0, net: 0, close: 593 },
  { type: 'ASSET', code: '100-000-803', name: 'KUSCCO Ltd Shares', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'ASSET', code: '100-000-804', name: 'CIC Insurance group', open: 298299, debit: 0, credit: 0, net: 0, close: 298299 },
  { type: 'LIABILITY', code: '200-000-101', name: 'Members deposits', open: 285125786.99, debit: 17040275.62, credit: 51004213.07, net: 33963937.45, close: 319089724.44 },
  { type: 'LIABILITY', code: '200-000-102', name: 'Top up Deposit', open: -0.03, debit: 0, credit: 0.03, net: 0.03, close: 0 },
  { type: 'LIABILITY', code: '200-000-201', name: 'Audit fees & VAT', open: 0, debit: 40000, credit: 250000, net: 210000, close: 210000 },
  { type: 'LIABILITY', code: '200-000-202', name: 'Supervision fees', open: 18304, debit: 0, credit: 0, net: 0, close: 18304 },
  { type: 'LIABILITY', code: '200-000-203', name: 'Accounting fees', open: 1162061, debit: 320000, credit: 290000, net: -30000, close: 1132061 },
  { type: 'LIABILITY', code: '200-000-204', name: 'Unidentified receipts', open: 528083, debit: 0, credit: 0, net: 0, close: 528083 },
  { type: 'LIABILITY', code: '200-000-205', name: 'Honoraria payable', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'LIABILITY', code: '200-000-206', name: 'Members deposit with CBA', open: 451668, debit: 0, credit: 0, net: 0, close: 451668 },
  { type: 'LIABILITY', code: '200-000-207', name: 'Registration fees', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'LIABILITY', code: '200-000-208', name: 'Donations', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'LIABILITY', code: '200-000-209', name: 'Accrued administrative exp', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'LIABILITY', code: '200-000-210', name: 'By-laws registration', open: 30000, debit: 0, credit: 0, net: 0, close: 30000 },
  { type: 'LIABILITY', code: '200-000-301', name: 'Interest on Member Deposits', open: 24446896.29, debit: 22332479.16, credit: 809384.07, net: -21523095.09, close: 2923801.20 },
  { type: 'LIABILITY', code: '200-000-302', name: 'Dividends on Share capital', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'LIABILITY', code: '200-000-303', name: 'Corporate Tax Liability', open: 54000.01, debit: 54000.01, credit: 0, net: -54000.01, close: 0 },
  { type: 'LIABILITY', code: '200-000-309', name: 'Overflow Account', open: 0, debit: 13688301.60, credit: 13688301.60, net: 0, close: 0 },
  { type: 'EQUITY', code: '300-000-101', name: 'Share Capital', open: 10086725.36, debit: 3218091.49, credit: 6330790.82, net: 3112699.33, close: 13199424.69 },
  { type: 'EQUITY', code: '300-000-102', name: 'Statutory Reserve', open: 6413933, debit: 0, credit: 0, net: 0, close: 6413933 },
  { type: 'EQUITY', code: '300-000-103', name: 'Retained Earnings', open: 6043778.57, debit: 0, credit: 0, net: 0, close: 6043778.57 },
  { type: 'EQUITY', code: '300-000-104', name: 'Share Capital for Left members', open: 965000, debit: 0, credit: 0, net: 0, close: 965000 },
  { type: 'INCOME', code: '400-000-101', name: 'Interest on Normal Loans', open: 0, debit: 4216534.37, credit: 33825613.49, net: 29609079.12, close: 29609079.12 },
  { type: 'INCOME', code: '400-000-102', name: 'Interest from Car Insurance', open: 0, debit: 7939.58, credit: 40453.50, net: 32513.92, close: 32513.92 },
  { type: 'INCOME', code: '400-000-103', name: 'Interest from Fixed Deposits', open: 0, debit: 0, credit: 1368922.36, net: 1368922.36, close: 1368922.36 },
  { type: 'INCOME', code: '400-000-201', name: 'Processing Fees', open: 0, debit: 42000, credit: 190000, net: 148000, close: 148000 },
  { type: 'INCOME', code: '400-000-202', name: 'Penalties and Fines', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'INCOME', code: '400-000-205', name: 'Exit Fees', open: 0, debit: 0, credit: 10000, net: 10000, close: 10000 },
  { type: 'EXPENSE', code: '500-000-101', name: 'Write Offs', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'EXPENSE', code: '500-000-201', name: 'Interest on Deposits', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'EXPENSE', code: '500-000-202', name: 'Provision for dividends', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'EXPENSE', code: '500-000-301', name: 'Bank Charges', open: 0, debit: 3405882.03, credit: 3243796.42, net: 162085.61, close: 162085.61 },
  { type: 'EXPENSE', code: '500-000-302', name: 'Sitting Allowance', open: 0, debit: 311000, credit: 0, net: 311000, close: 311000 },
  { type: 'EXPENSE', code: '500-000-303', name: 'AGM Expenses', open: 0, debit: 48354, credit: 0, net: 48354, close: 48354 },
  { type: 'EXPENSE', code: '500-000-304', name: 'Honoraria', open: 0, debit: 700000, credit: 700000, net: 0, close: 0 },
  { type: 'EXPENSE', code: '500-000-305', name: 'Accountancy and Audit', open: 0, debit: 1670694, credit: 512694.01, net: 1157999.99, close: 1157999.99 },
  { type: 'EXPENSE', code: '500-000-306', name: 'Grasavoye Insurance Premium', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'EXPENSE', code: '500-000-307', name: 'Computer/Software Expense', open: 0, debit: 425694, credit: 0, net: 425694, close: 425694 },
  { type: 'EXPENSE', code: '500-000-308', name: 'CSI', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
  { type: 'EXPENSE', code: '500-000-309', name: 'Office Expense', open: 0, debit: 40000, credit: 0, net: 40000, close: 40000 },
  { type: 'EXPENSE', code: '500-000-310', name: 'Depreciation Software', open: 0, debit: 113771.74, credit: 0, net: 113771.74, close: 113771.74 },
  { type: 'EXPENSE', code: '500-000-311', name: 'Tax Expense', open: 0, debit: 0, credit: 0, net: 0, close: 0 },
];

const BS_GROUPS = {
  ASSETS: [
    { note: 3, label: '[1000] CASH AND RECONCILIATION', codes: ['100-000-201','100-000-301','100-000-302','100-000-401','100-000-402','100-000-403','100-000-404','100-000-405','100-000-407'] },
    { note: 4, label: '[1100] SHORT TERM INVESTMENTS', codes: ['100-000-202'] },
    { note: 5, label: '[1200] TOTAL LOANS', codes: ['100-000-101','100-000-102'] },
    { note: 6, label: '[1400] INVESTMENTS', codes: ['100-000-501','100-000-502','100-000-503','100-000-504','100-000-801','100-000-802','100-000-803','100-000-804'] },
    { note: 7, label: '[1500] CREDITORS-Assets', codes: ['100-000-303','100-000-308','100-000-408','100-000-704'] },
    { note: 8, label: '[1600] LONG - TERM INVESTMENTS', codes: ['100-000-406'] },
    { note: 9, label: '[1700] PROPERTIES & ACCESSORIES', codes: ['100-000-601','100-000-602','100-000-701','100-000-702','100-000-703'] },
  ],
  LIABILITIES: [
    { note: 10, label: '[2000] CREDITORS-Liabilities', codes: ['200-000-201','200-000-202','200-000-203','200-000-204','200-000-205','200-000-206','200-000-207','200-000-208','200-000-209','200-000-210','200-000-303'] },
    { note: 11, label: '[2100] INTEREST DEBTS', codes: ['200-000-301','200-000-302'] },
    { note: 12, label: '[2200] MEMBERS SAVINGS AND DEPOSITS', codes: ['200-000-101','200-000-102','200-000-309'] },
    { note: 13, label: '[2500] UNPAID EXPENSES', codes: [] },
    { note: 14, label: '[3000] MEMBERS SHARES', codes: ['300-000-101','300-000-104'] },
  ],
  EQUITY: [
    { label: 'Surplus/(Loss) Retained Earnings', codes: ['300-000-103'] },
    { label: 'Grants', codes: [] },
    { label: 'Revaluation Reserves', codes: [] },
    { label: 'Insurance Fund', codes: [] },
    { label: 'Statutory Reserve Fund', codes: ['300-000-102'] },
    { label: 'Share Transfer Fund', codes: [] },
    { label: 'Bad and Doubtful Debt Provision', codes: [] },
    { label: 'CORE CAPITAL', codes: [], note: 2 },
  ],
};

const IS_GROUPS = {
  INCOME: [
    { note: 15, label: '[4000] INTEREST INCOME', codes: ['400-000-101','400-000-102','400-000-103'] },
    { note: 16, label: '[4100] OTHER INCOME FROM LOANS', codes: ['400-000-201','400-000-202'] },
    { note: 17, label: '[4200] FEES REVENUE', codes: ['400-000-205'] },
    { note: 18, label: '[4500] OTHER REVENUES', codes: [] },
  ],
  EXPENSES: [
    { note: 19, label: '[5000] FINANCIAL COSTS', codes: ['500-000-201','500-000-202'] },
    { note: 20, label: '[5200] ADMINISTRATIVE COSTS', codes: ['500-000-301','500-000-302','500-000-303','500-000-304','500-000-309'] },
    { note: 21, label: '[5300] BUSINESS COSTS', codes: [] },
    { note: 22, label: '[5400] EQUIPMENT COSTS', codes: ['500-000-306','500-000-307','500-000-308','500-000-310'] },
    { note: 23, label: '[5500] OTHER COSTS', codes: ['500-000-305','500-000-311'] },
    { note: 24, label: '[5600] OFFICE COSTS', codes: [] },
  ],
};



// ---------------------------------------------------------------------------
// MEMBERS was referenced throughout the original server.js but never declared,
// which made /api/overview, /api/clients and /api/loans return 500 at runtime.
// Seeded here from the loan and savings rows so those routes work.
// ---------------------------------------------------------------------------
const MEMBERS = [
  { id: '61110K134',  kwaraId: 'KW-134',  firstName: 'Joseph',  lastName: 'Kariuki',  gender: 'MALE',   state: 'ACTIVE', branchId: 'BR001', joinDate: '2021-03-14', phone: '+254712000134', email: 'member134@example.com' },
  { id: '61110K2565', kwaraId: 'KW-2565', firstName: 'Grace',   lastName: 'Njeri',    gender: 'FEMALE', state: 'ACTIVE', branchId: 'BR001', joinDate: '2022-07-02', phone: '+254712002565', email: 'member2565@example.com' },
  { id: '61110K3011', kwaraId: 'KW-3011', firstName: 'Peter',   lastName: 'Otieno',   gender: 'MALE',   state: 'ACTIVE', branchId: 'BR002', joinDate: '2020-11-19', phone: '+254712003011', email: 'member3011@example.com' },
  { id: '61110K4420', kwaraId: 'KW-4420', firstName: 'Mercy',   lastName: 'Achieng',  gender: 'FEMALE', state: 'ACTIVE', branchId: 'BR002', joinDate: '2023-01-30', phone: '+254712004420', email: 'member4420@example.com' },
  { id: '61110K5108', kwaraId: 'KW-5108', firstName: 'Daniel',  lastName: 'Mwangi',   gender: 'MALE',   state: 'INACTIVE', branchId: 'BR001', joinDate: '2019-06-05', phone: '+254712005108', email: 'member5108@example.com' },
];

// ---------------------------------------------------------------------------
// Collections added for full Mambu API v2 group coverage.
// ---------------------------------------------------------------------------
// Control accounts for the settlement channels. Without these the channel
// GL codes point at nothing and every deposit is rejected as GL_ACCOUNT_NOT_FOUND.
GL_ACCOUNTS.push(
  { code: '100-000-101', name: 'Cash on Hand',            type: 'Asset',     statement: 'Balance Sheet' },
  { code: '100-000-102', name: 'M-Pesa Settlement',       type: 'Asset',     statement: 'Balance Sheet' },
  { code: '100-000-103', name: 'Cheques in Clearing',     type: 'Asset',     statement: 'Balance Sheet' },
  { code: '500-000-305', name: 'Interest Expense — Member Deposits', type: 'Expense', statement: 'Income Statement' },
);

const API_CONSUMERS = [];
const COMMENTS = [];
const COMMUNICATIONS = [];
const CONFIGURATIONS = [];
const CREDIT_ARRANGEMENTS = [];
const DATA_IMPORTS = [];
const DATABASE_BACKUPS = [];
const DEPOSIT_PRODUCTS = SAVINGS_PRODUCTS;
const EXCHANGE_RATES = [];
const FUNDING_SOURCES = [];
const HOLIDAYS = [];
const ID_TEMPLATES = [];
const INDEX_RATES = [];
const ISLAMIC_FINANCING = [];
const JOURNAL_ENTRIES = [];
const NOTIFICATION_SETTINGS = [];
const ORGANIZATION = [{ id: 'ORG1', name: 'City SACCO', currencyCode: 'KES', timezone: 'Africa/Nairobi' }];
const PROFIT_SHARING = [];
const STREAMING_PUBLISHERS = [];
const SUBSCRIPTIONS = [];
const TASKS = [];
const TEMPLATES = [];
const TRANSACTION_CHANNELS = [
  { id: 'cash',     name: 'Cash',          channelType: 'CASH',     glAccountCode: '100-000-101', active: true },
  { id: 'mpesa',    name: 'M-Pesa',        channelType: 'MOBILE',   glAccountCode: '100-000-102', active: true },
  { id: 'bank',     name: 'Bank Transfer', channelType: 'TRANSFER', glAccountCode: '100-000-201', active: true },
  { id: 'cheque',   name: 'Cheque',        channelType: 'CHEQUE',   glAccountCode: '100-000-103', active: true },
  { id: 'internal', name: 'Internal',      channelType: 'INTERNAL', glAccountCode: null,          active: true },
];
const LOAN_TRANSACTIONS = [];
const DEPOSIT_TRANSACTIONS = [];
const LOAN_SCHEDULES = {};
const BLOCKS = [];

module.exports = {
  MEMBERS, BRANCHES, CENTRES, GROUPS, CURRENCIES, TRANSACTIONS, CARDS, LOANS, SAVINGS, SHARES,
  KYC_FIELDS, CUSTOM_FIELDS, CUSTOM_FIELD_SETS, GL_ACCOUNTS, USERS, NOTIFICATIONS,
  BACKGROUND_PROCESSES, DOCUMENTS, WORKFLOWS, AUDIT_LOGS, LOAN_PRODUCTS,
  SAVINGS_PRODUCTS, SHARE_PRODUCTS, CHARGES, TB_DATA, BS_GROUPS, IS_GROUPS,
  API_CONSUMERS, COMMENTS, COMMUNICATIONS, CONFIGURATIONS, CREDIT_ARRANGEMENTS,
  DATA_IMPORTS, DATABASE_BACKUPS, DEPOSIT_PRODUCTS, EXCHANGE_RATES, FUNDING_SOURCES,
  HOLIDAYS, ID_TEMPLATES, INDEX_RATES, ISLAMIC_FINANCING, JOURNAL_ENTRIES,
  NOTIFICATION_SETTINGS, ORGANIZATION, PROFIT_SHARING, STREAMING_PUBLISHERS,
  SUBSCRIPTIONS, TASKS, TEMPLATES, TRANSACTION_CHANNELS,
  LOAN_TRANSACTIONS, DEPOSIT_TRANSACTIONS, LOAN_SCHEDULES, BLOCKS,
};
