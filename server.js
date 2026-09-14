const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

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

function getOverview() {
  const totalMembers = MEMBERS.length;
  const totalLoans = LOANS.reduce((sum, loan) => sum + loan.principal, 0);
  const totalSavings = SAVINGS.reduce((sum, account) => sum + account.balance, 0);
  const loanRecoveryRate = 95;
  return { totalMembers, totalLoans, totalSavings, loanRecoveryRate };
}

function mapClientToMambu(client) {
  const [firstName, ...rest] = (client.name || '').split(' ');
  const lastName = rest.join(' ');
  return {
    clientId: client.id,
    firstName: client.firstName || firstName || '',
    lastName: client.lastName || lastName || '',
    displayName: client.displayName || client.name || `${firstName} ${lastName}`.trim(),
    accountHolderType: 'INDIVIDUAL',
    accountHolderKey: client.id,
    branchId: client.branchId || 'HQ',
    centreId: client.centreId || 'C1',
    entity: client.entity,
    status: client.status,
    phone: client.phone,
    email: client.email,
    kwaraId: client.kwaraId,
    nationalId: client.nationalId,
    kraPin: client.kraPin,
    dateOfBirth: client.dob,
    gender: client.gender,
    department: client.department,
    employmentType: client.empType,
    joinedDate: client.joinDate,
    customFields: client.customFields || []
  };
}

function mapLoanToMambu(loan) {
  const P = loan.principal || 0;
  const n = loan.duration || 0;
  const r = 0.01;
  const installment = n && P ? Math.round(P * r * Math.pow(1+r,n) / (Math.pow(1+r,n)-1)) : 0;
  const clientId = loan.clientId || loan.member || null;
  const member = MEMBERS.find(m => m.id === clientId || m.kwaraId === clientId);
  return {
    loanId: loan.id,
    clientId,
    clientName: member ? (member.displayName || member.name) : loan.member,
    principal: loan.principal,
    termInMonths: loan.duration,
    productTypeKey: loan.productTypeKey || 'NL01',
    processingFee: loan.processingFee !== undefined ? loan.processingFee : true,
    disbursementDate: loan.disbDate,
    status: loan.status,
    interestRatePerMonth: 1,
    currency: 'KES',
    monthlyInstallment: installment,
    outstandingBalance: loan.principal,
    nextPaymentDueDate: loan.nextDueDate || null
  };
}

function mapAccountToMambu(acc) {
  const isShare = acc.type === 'SHARE';
  const accountId = `${acc.id}-${isShare ? 'SHR' : 'SAV'}`;
  const balance = isShare ? acc.amount : acc.balance;
  return {
    accountId,
    accountHolderType: 'INDIVIDUAL',
    accountHolderKey: acc.id,
    productTypeKey: isShare ? 'SC01' : 'MD01',
    accountType: isShare ? 'SHARE' : 'SAVINGS',
    accountState: 'ACTIVE',
    availableBalance: balance,
    accountBalance: balance,
    currency: 'KES',
    lastActivityDate: acc.last || new Date().toISOString().split('T')[0],
    units: acc.units || null
  };
}

function findDepositAccount(accountId) {
  const allAccounts = [...SAVINGS.map(s => ({ ...s, type: 'SAVINGS' })), ...SHARES.map(s => ({ ...s, type: 'SHARE' }))];
  return allAccounts.find(acc => `${acc.id}-${acc.type === 'SHARE' ? 'SHR' : 'SAV'}` === accountId || acc.id === accountId);
}

app.get('/api/overview', (req, res) => res.json(getOverview()));

app.get('/api/clients', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 100;
  const search = req.query.search || '';

  let filtered = MEMBERS;
  if (search) {
    const lowerSearch = search.toLowerCase();
    filtered = MEMBERS.filter(m =>
      m.id.toLowerCase().includes(lowerSearch) ||
      m.name.toLowerCase().includes(lowerSearch) ||
      m.phone.toLowerCase().includes(lowerSearch) ||
      (m.nationalId && m.nationalId.toLowerCase().includes(lowerSearch)) ||
      (m.kwaraId && m.kwaraId.toLowerCase().includes(lowerSearch)) ||
      (m.emp && m.emp.toLowerCase().includes(lowerSearch)) ||
      m.name.toLowerCase().split(' ').some(word => word.charAt(0).toLowerCase() === lowerSearch.charAt(0))
    );
  }

  const total = filtered.length;
  const startIndex = (page - 1) * limit;
  const paginated = filtered.slice(startIndex, startIndex + limit);

  res.json({
    data: paginated.map(mapClientToMambu),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  });
});

app.get('/api/clients/:id', (req, res) => {
  const client = MEMBERS.find(m => m.id === req.params.id || m.kwaraId === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(mapClientToMambu(client));
});

app.post('/api/clients', (req, res) => {
  const { clientId, firstName, lastName, displayName, name, emp, entity, phone, status, kwaraId, nationalId, kraPin, email, dateOfBirth, dob, gender, department, employmentType, empType, joinedDate, joinDate } = req.body;
  const id = clientId || kwaraId || req.body.id || `${Math.floor(100000000 + Math.random() * 900000000)}`;
  const normalizedName = displayName || name || `${firstName || ''} ${lastName || ''}`.trim();
  if (!normalizedName || !id || !phone || !entity) return res.status(400).json({ error: 'Missing required fields: name/displayName, clientId/kwaraId, phone, entity' });
  const newClient = {
    id,
    name: normalizedName,
    firstName,
    lastName,
    displayName: normalizedName,
    emp: emp || '',
    entity,
    phone,
    status: status || 'Active',
    kwaraId: kwaraId || id,
    nationalId,
    kraPin,
    email,
    dob: dob || dateOfBirth,
    gender,
    department,
    empType: empType || employmentType,
    joinDate: joinDate || joinedDate,
    branchId: req.body.branchId || 'HQ',
    centreId: req.body.centreId || 'C1',
    customFields: req.body.customFields || []
  };
  MEMBERS.unshift(newClient);
  res.status(201).json(mapClientToMambu(newClient));
});

app.put('/api/clients/:id', (req, res) => {
  const client = MEMBERS.find(m => m.id === req.params.id || m.kwaraId === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { firstName, lastName, displayName, name, emp, entity, phone, status, kwaraId, nationalId, kraPin, email, dateOfBirth, dob, gender, department, employmentType, empType, joinedDate, joinDate, branchId, centreId, customFields } = req.body;
  if (displayName || name) {
    client.name = displayName || name;
    client.displayName = client.name;
  }
  if (firstName !== undefined) client.firstName = firstName;
  if (lastName !== undefined) client.lastName = lastName;
  if (emp !== undefined) client.emp = emp;
  if (entity !== undefined) client.entity = entity;
  if (phone !== undefined) client.phone = phone;
  if (status !== undefined) client.status = status;
  if (kwaraId !== undefined) client.kwaraId = kwaraId;
  if (nationalId !== undefined) client.nationalId = nationalId;
  if (kraPin !== undefined) client.kraPin = kraPin;
  if (email !== undefined) client.email = email;
  if (dateOfBirth !== undefined) client.dob = dateOfBirth;
  if (dob !== undefined) client.dob = dob;
  if (gender !== undefined) client.gender = gender;
  if (department !== undefined) client.department = department;
  if (employmentType !== undefined) client.empType = employmentType;
  if (empType !== undefined) client.empType = empType;
  if (joinedDate !== undefined) client.joinDate = joinedDate;
  if (joinDate !== undefined) client.joinDate = joinDate;
  if (branchId !== undefined) client.branchId = branchId;
  if (centreId !== undefined) client.centreId = centreId;
  if (customFields !== undefined) client.customFields = customFields;
  res.json(mapClientToMambu(client));
});

app.delete('/api/clients/:id', (req, res) => {
  const idx = MEMBERS.findIndex(m => m.id === req.params.id || m.kwaraId === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  const [deleted] = MEMBERS.splice(idx, 1);
  res.json({ deleted: mapClientToMambu(deleted) });
});

app.get('/api/loans', (req, res) => res.json(LOANS.map(mapLoanToMambu)));
app.get('/api/loans/:id', (req, res) => {
  const loan = LOANS.find(l => l.id === req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  res.json(mapLoanToMambu(loan));
});
app.post('/api/loans', (req, res) => {
  const { clientId, loanId, member, principal, termInMonths, duration, disbDate, disbursementDate, productTypeKey, processingFee, status } = req.body;
  const loanClient = member || req.body.clientName || clientId;
  const amount = principal || req.body.amount;
  const months = duration || termInMonths;
  if (!loanClient || !amount || !months) return res.status(400).json({ error: 'Missing required fields: clientId/member, principal/amount, duration/termInMonths' });
  const id = loanId || `LN${Math.floor(100000 + Math.random() * 900000)}`;
  const newLoan = {
    member: loanClient,
    id,
    principal: Number(amount),
    duration: Number(months),
    disbDate: disbDate || disbursementDate || new Date().toISOString().split('T')[0],
    productTypeKey: productTypeKey || 'NL01',
    processingFee: processingFee !== undefined ? Boolean(processingFee) : true,
    status: status || 'Active'
  };
  LOANS.unshift(newLoan);
  res.status(201).json(mapLoanToMambu(newLoan));
});

app.put('/api/loans/:id', (req, res) => {
  const loan = LOANS.find(l => l.id === req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  const { clientId, member, principal, termInMonths, duration, disbDate, disbursementDate, productTypeKey, processingFee, status } = req.body;
  if (clientId !== undefined) loan.member = clientId;
  if (member !== undefined) loan.member = member;
  if (principal !== undefined) loan.principal = Number(principal);
  if (termInMonths !== undefined) loan.duration = Number(termInMonths);
  if (duration !== undefined) loan.duration = Number(duration);
  if (disbDate !== undefined) loan.disbDate = disbDate;
  if (disbursementDate !== undefined) loan.disbDate = disbursementDate;
  if (productTypeKey !== undefined) loan.productTypeKey = productTypeKey;
  if (processingFee !== undefined) loan.processingFee = Boolean(processingFee);
  if (status !== undefined) loan.status = status;
  res.json(mapLoanToMambu(loan));
});

app.delete('/api/loans/:id', (req, res) => {
  const idx = LOANS.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Loan not found' });
  const [deleted] = LOANS.splice(idx, 1);
  res.json({ deleted: mapLoanToMambu(deleted) });
});

app.get('/api/deposit-accounts', (req, res) => {
  const allAccounts = [
    ...SAVINGS.map(s => mapAccountToMambu({ ...s, type: 'SAVINGS' })),
    ...SHARES.map(s => mapAccountToMambu({ ...s, type: 'SHARE' }))
  ];
  res.json(allAccounts);
});
app.get('/api/deposit-accounts/:id', (req, res) => {
  const account = [...SAVINGS.map(s => ({ ...s, type: 'SAVINGS' })), ...SHARES.map(s => ({ ...s, type: 'SHARE' }))]
    .find(acc => `${acc.id}-${acc.type === 'SHARE' ? 'SHR' : 'SAV'}` === req.params.id || acc.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'Deposit account not found' });
  res.json(mapAccountToMambu(account));
});
app.post('/api/deposit-accounts', (req, res) => {
  const { accountHolderKey, clientId, productTypeKey, depositAccountType, type, initialDepositAmount, amount, balance, lastActivityDate } = req.body;
  const owner = accountHolderKey || clientId || req.body.member;
  const acctType = type || depositAccountType || (productTypeKey === 'SC01' ? 'SHARE' : 'SAVINGS');
  const amt = initialDepositAmount || amount || balance;
  if (!owner || amt == null) return res.status(400).json({ error: 'Missing required fields: accountHolderKey/clientId, amount' });
  const id = owner;
  if (acctType === 'SHARE') {
    const newShare = { member: owner, id, amount: Number(amt), units: Number(amt) / 200 };
    SHARES.unshift(newShare);
    res.status(201).json(mapAccountToMambu({ ...newShare, type: 'SHARE' }));
  } else {
    const newSaving = { member: owner, id, balance: Number(amt), last: lastActivityDate || new Date().toISOString().split('T')[0] };
    SAVINGS.unshift(newSaving);
    res.status(201).json(mapAccountToMambu({ ...newSaving, type: 'SAVINGS' }));
  }
});

app.put('/api/deposit-accounts/:id', (req, res) => {
  const account = findDepositAccount(req.params.id);
  if (!account) return res.status(404).json({ error: 'Deposit account not found' });
  const accountId = `${account.id}-${account.type === 'SHARE' ? 'SHR' : 'SAV'}`;
  if (account.type === 'SHARE') {
    const existing = SHARES.find(s => s.id === account.id);
    if (!existing) return res.status(404).json({ error: 'Share account not found' });
    if (req.body.amount !== undefined) existing.amount = Number(req.body.amount);
    if (req.body.units !== undefined) existing.units = Number(req.body.units);
    if (req.body.balance !== undefined) existing.amount = Number(req.body.balance);
    res.json(mapAccountToMambu({ ...existing, type: 'SHARE' }));
  } else {
    const existing = SAVINGS.find(s => s.id === account.id);
    if (!existing) return res.status(404).json({ error: 'Savings account not found' });
    if (req.body.balance !== undefined) existing.balance = Number(req.body.balance);
    if (req.body.last !== undefined) existing.last = req.body.last;
    res.json(mapAccountToMambu({ ...existing, type: 'SAVINGS' }));
  }
});

app.delete('/api/deposit-accounts/:id', (req, res) => {
  const account = findDepositAccount(req.params.id);
  if (!account) return res.status(404).json({ error: 'Deposit account not found' });
  if (account.type === 'SHARE') {
    const idx = SHARES.findIndex(s => s.id === account.id);
    const [deleted] = SHARES.splice(idx, 1);
    res.json({ deleted: mapAccountToMambu({ ...deleted, type: 'SHARE' }) });
  } else {
    const idx = SAVINGS.findIndex(s => s.id === account.id);
    const [deleted] = SAVINGS.splice(idx, 1);
    res.json({ deleted: mapAccountToMambu({ ...deleted, type: 'SAVINGS' }) });
  }
});

app.get('/api/kyc-fields', (req, res) => res.json(KYC_FIELDS));
app.get('/api/custom-fields', (req, res) => res.json(CUSTOM_FIELDS));
app.post('/api/custom-fields', (req, res) => {
  const { module, fieldSet, label, type, section, usage, required, hint, options } = req.body;
  if (!module || !label || !type) return res.status(400).json({ error: 'Missing required fields' });
  const newField = {
    id: Date.now().toString(),
    module,
    fieldSet: fieldSet || 'General',
    label,
    type,
    section: section || 'Personal',
    usage: usage || 'Available',
    required: required || (usage === 'Required' ? 'Required' : 'Optional'),
    hint: hint || '',
    options: Array.isArray(options) ? options : []
  };
  CUSTOM_FIELDS.push(newField);
  res.status(201).json(newField);
});
app.put('/api/custom-fields/:id', (req, res) => {
  const field = CUSTOM_FIELDS.find(f => f.id === req.params.id);
  if (!field) return res.status(404).json({ error: 'Custom field not found' });
  const { module, fieldSet, label, type, section, usage, required, hint, options } = req.body;
  if (module !== undefined) field.module = module;
  if (fieldSet !== undefined) field.fieldSet = fieldSet;
  if (label !== undefined) field.label = label;
  if (type !== undefined) field.type = type;
  if (section !== undefined) field.section = section;
  if (usage !== undefined) field.usage = usage;
  if (required !== undefined) field.required = required;
  if (hint !== undefined) field.hint = hint;
  if (type !== undefined && type !== 'Dropdown') {
    field.options = [];
  }
  if (options !== undefined) field.options = Array.isArray(options) ? options : [];
  res.json(field);
});
app.delete('/api/custom-fields/:id', (req, res) => {
  const index = CUSTOM_FIELDS.findIndex(f => f.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Custom field not found' });
  CUSTOM_FIELDS.splice(index, 1);
  res.json({ deleted: true });
});

app.get('/api/custom-field-sets', (req, res) => res.json(CUSTOM_FIELD_SETS));
app.post('/api/custom-field-sets', (req, res) => {
  const { module, name, type, notes } = req.body;
  if (!module || !name) return res.status(400).json({ error: 'Missing required fields' });
  const newSet = {
    id: Date.now().toString(),
    module,
    name,
    type: type || 'Standard',
    notes: notes || ''
  };
  CUSTOM_FIELD_SETS.push(newSet);
  res.status(201).json(newSet);
});
app.put('/api/custom-field-sets/:id', (req, res) => {
  const set = CUSTOM_FIELD_SETS.find(s => s.id === req.params.id);
  if (!set) return res.status(404).json({ error: 'Custom field set not found' });
  const { module, name, type, notes } = req.body;
  if (module !== undefined) set.module = module;
  if (name !== undefined) set.name = name;
  if (type !== undefined) set.type = type;
  if (notes !== undefined) set.notes = notes;
  res.json(set);
});
app.delete('/api/custom-field-sets/:id', (req, res) => {
  const index = CUSTOM_FIELD_SETS.findIndex(s => s.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Custom field set not found' });
  CUSTOM_FIELD_SETS.splice(index, 1);
  res.json({ deleted: true });
});
app.get('/api/gl-accounts', (req, res) => res.json(GL_ACCOUNTS));
app.post('/api/gl-accounts', (req, res) => {
  const { code, name, type, statement, description } = req.body;
  if (!code || !name || !type) return res.status(400).json({ error: 'Missing required fields' });
  const newGL = { code, name, type, statement: statement || 'Balance Sheet', description: description || '' };
  GL_ACCOUNTS.unshift(newGL);
  res.status(201).json(newGL);
});
app.put('/api/gl-accounts/:code', (req, res) => {
  const gl = GL_ACCOUNTS.find(g => g.code === req.params.code);
  if (!gl) return res.status(404).json({ error: 'GL Account not found' });
  const { name, type, statement, description } = req.body;
  if (name !== undefined) gl.name = name;
  if (type !== undefined) gl.type = type;
  if (statement !== undefined) gl.statement = statement;
  if (description !== undefined) gl.description = description;
  res.json(gl);
});
app.delete('/api/gl-accounts/:code', (req, res) => {
  const idx = GL_ACCOUNTS.findIndex(g => g.code === req.params.code);
  if (idx === -1) return res.status(404).json({ error: 'GL Account not found' });
  const [deleted] = GL_ACCOUNTS.splice(idx, 1);
  res.json({ deleted });
});

app.get('/api/users', (req, res) => res.json(USERS));
app.post('/api/users', (req, res) => {
  const { name, email, role, status } = req.body;
  if (!name || !email || !role) return res.status(400).json({ error: 'Missing required fields' });
  const newUser = { name, email, role, status: status || 'Active' };
  USERS.unshift(newUser);
  res.status(201).json(newUser);
});
app.put('/api/users/:email', (req, res) => {
  const user = USERS.find(u => u.email === decodeURIComponent(req.params.email));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { name, role, status } = req.body;
  if (name !== undefined) user.name = name;
  if (role !== undefined) user.role = role;
  if (status !== undefined) user.status = status;
  res.json(user);
});
app.delete('/api/users/:email', (req, res) => {
  const idx = USERS.findIndex(u => u.email === decodeURIComponent(req.params.email));
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const [deleted] = USERS.splice(idx, 1);
  res.json({ deleted });
});

app.get('/api/loan-products', (req, res) => res.json(LOAN_PRODUCTS));
app.post('/api/loan-products', (req, res) => {
  const { id, name, rate, maxTerm, fee, feeDefault, glAsset, glIncome } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'Missing required fields' });
  const newProduct = { id, name, rate: rate || 1, maxTerm: maxTerm || 36, fee: fee || 0, feeDefault: feeDefault !== undefined ? Boolean(feeDefault) : true, glAsset: glAsset || '', glIncome: glIncome || '' };
  LOAN_PRODUCTS.unshift(newProduct);
  res.status(201).json(newProduct);
});
app.put('/api/loan-products/:id', (req, res) => {
  const product = LOAN_PRODUCTS.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Loan Product not found' });
  const { name, rate, maxTerm, fee, feeDefault, glAsset, glIncome } = req.body;
  if (name !== undefined) product.name = name;
  if (rate !== undefined) product.rate = rate;
  if (maxTerm !== undefined) product.maxTerm = maxTerm;
  if (fee !== undefined) product.fee = fee;
  if (feeDefault !== undefined) product.feeDefault = Boolean(feeDefault);
  if (glAsset !== undefined) product.glAsset = glAsset;
  if (glIncome !== undefined) product.glIncome = glIncome;
  res.json(product);
});
app.delete('/api/loan-products/:id', (req, res) => {
  const idx = LOAN_PRODUCTS.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Loan Product not found' });
  const [deleted] = LOAN_PRODUCTS.splice(idx, 1);
  res.json({ deleted });
});

app.get('/api/savings-products', (req, res) => res.json(SAVINGS_PRODUCTS));
app.get('/api/share-products', (req, res) => res.json(SHARE_PRODUCTS));
app.get('/api/charges', (req, res) => res.json(CHARGES));

app.get('/api/reports/trial-balance', (req, res) => res.json(TB_DATA));
app.get('/api/reports/balance-sheet', (req, res) => res.json(BS_GROUPS));
app.get('/api/reports/income-statement', (req, res) => res.json(IS_GROUPS));

app.get('/api/search/clients', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const results = q
    ? MEMBERS.filter(m =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.phone && m.phone.toLowerCase().includes(q)) ||
        (m.nationalId && m.nationalId.toLowerCase().includes(q)) ||
        (m.kwaraId && m.kwaraId.toLowerCase().includes(q))
      ).map(mapClientToMambu)
    : MEMBERS.map(mapClientToMambu);
  res.json(results);
});
app.get('/api/search/members', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const results = q
    ? MEMBERS.filter(m => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || (m.phone && m.phone.toLowerCase().includes(q)))
    : MEMBERS;
  res.json(results.map(mapClientToMambu));
});

app.get('/api/branches', (req, res) => res.json(BRANCHES));
app.get('/api/centres', (req, res) => res.json(CENTRES));
app.get('/api/groups', (req, res) => res.json(GROUPS));
app.get('/api/transactions', (req, res) => res.json(TRANSACTIONS));
app.get('/api/cards', (req, res) => res.json(CARDS));

// Branches CRUD
app.post('/api/branches', (req, res) => {
  const { id, name, address } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'Missing required fields' });
  const newBranch = { id, name, address };
  BRANCHES.unshift(newBranch);
  res.status(201).json(newBranch);
});
app.put('/api/branches/:id', (req, res) => {
  const branch = BRANCHES.find(b => b.id === req.params.id);
  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  const { name, address } = req.body;
  if (name !== undefined) branch.name = name;
  if (address !== undefined) branch.address = address;
  res.json(branch);
});
app.delete('/api/branches/:id', (req, res) => {
  const idx = BRANCHES.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Branch not found' });
  const [deleted] = BRANCHES.splice(idx, 1);
  res.json({ deleted });
});

// Centres CRUD
app.post('/api/centres', (req, res) => {
  const { id, name, branchId } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'Missing required fields' });
  const newCentre = { id, name, branchId };
  CENTRES.unshift(newCentre);
  res.status(201).json(newCentre);
});
app.put('/api/centres/:id', (req, res) => {
  const centre = CENTRES.find(c => c.id === req.params.id);
  if (!centre) return res.status(404).json({ error: 'Centre not found' });
  const { name, branchId } = req.body;
  if (name !== undefined) centre.name = name;
  if (branchId !== undefined) centre.branchId = branchId;
  res.json(centre);
});
app.delete('/api/centres/:id', (req, res) => {
  const idx = CENTRES.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Centre not found' });
  const [deleted] = CENTRES.splice(idx, 1);
  res.json({ deleted });
});

// Groups CRUD
app.post('/api/groups', (req, res) => {
  const { id, name, centreId } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'Missing required fields' });
  const newGroup = { id, name, centreId };
  GROUPS.unshift(newGroup);
  res.status(201).json(newGroup);
});
app.put('/api/groups/:id', (req, res) => {
  const group = GROUPS.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const { name, centreId } = req.body;
  if (name !== undefined) group.name = name;
  if (centreId !== undefined) group.centreId = centreId;
  res.json(group);
});
app.delete('/api/groups/:id', (req, res) => {
  const idx = GROUPS.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Group not found' });
  const [deleted] = GROUPS.splice(idx, 1);
  res.json({ deleted });
});

// Transactions CRUD
app.post('/api/transactions', (req, res) => {
  const { id, accountId, amount, type, date } = req.body;
  if (!id || !accountId || !amount || !type) return res.status(400).json({ error: 'Missing required fields' });
  const newTransaction = { id, accountId, amount, type, date };
  TRANSACTIONS.unshift(newTransaction);
  res.status(201).json(newTransaction);
});
app.put('/api/transactions/:id', (req, res) => {
  const transaction = TRANSACTIONS.find(t => t.id === req.params.id);
  if (!transaction) return res.status(404).json({ error: 'Transaction not found' });
  const { accountId, amount, type, date } = req.body;
  if (accountId !== undefined) transaction.accountId = accountId;
  if (amount !== undefined) transaction.amount = amount;
  if (type !== undefined) transaction.type = type;
  if (date !== undefined) transaction.date = date;
  res.json(transaction);
});
app.delete('/api/transactions/:id', (req, res) => {
  const idx = TRANSACTIONS.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Transaction not found' });
  const [deleted] = TRANSACTIONS.splice(idx, 1);
  res.json({ deleted });
});

// Cards CRUD
app.post('/api/cards', (req, res) => {
  const { id, accountId, cardNumber, status } = req.body;
  if (!id || !accountId || !cardNumber) return res.status(400).json({ error: 'Missing required fields' });
  const newCard = { id, accountId, cardNumber, status: status || 'ACTIVE' };
  CARDS.unshift(newCard);
  res.status(201).json(newCard);
});
app.put('/api/cards/:id', (req, res) => {
  const card = CARDS.find(c => c.id === req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const { accountId, cardNumber, status } = req.body;
  if (accountId !== undefined) card.accountId = accountId;
  if (cardNumber !== undefined) card.cardNumber = cardNumber;
  if (status !== undefined) card.status = status;
  res.json(card);
});
app.delete('/api/cards/:id', (req, res) => {
  const idx = CARDS.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Card not found' });
  const [deleted] = CARDS.splice(idx, 1);
  res.json({ deleted });
});

// Currencies CRUD
app.get('/api/currencies', (req, res) => res.json(CURRENCIES));
app.post('/api/currencies', (req, res) => {
  const { code, name, symbol } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'Missing required fields' });
  const newCurrency = { code, name, symbol };
  CURRENCIES.unshift(newCurrency);
  res.status(201).json(newCurrency);
});
app.put('/api/currencies/:code', (req, res) => {
  const currency = CURRENCIES.find(c => c.code === req.params.code);
  if (!currency) return res.status(404).json({ error: 'Currency not found' });
  const { name, symbol } = req.body;
  if (name !== undefined) currency.name = name;
  if (symbol !== undefined) currency.symbol = symbol;
  res.json(currency);
});
app.delete('/api/currencies/:code', (req, res) => {
  const idx = CURRENCIES.findIndex(c => c.code === req.params.code);
  if (idx === -1) return res.status(404).json({ error: 'Currency not found' });
  const [deleted] = CURRENCIES.splice(idx, 1);
  res.json({ deleted });
});

// ═══════════════════════════════════════ ADVANCED FEATURES ═══════════════════════════════════════

// Notifications
app.get('/api/notifications', (req, res) => res.json(NOTIFICATIONS));
app.post('/api/notifications', (req, res) => {
  const { type, title, message, recipient } = req.body;
  const newNotification = {
    id: `N${Date.now()}`,
    type,
    title,
    message,
    recipient,
    status: 'UNREAD',
    createdAt: new Date().toISOString()
  };
  NOTIFICATIONS.unshift(newNotification);
  res.status(201).json(newNotification);
});
app.put('/api/notifications/:id/read', (req, res) => {
  const notification = NOTIFICATIONS.find(n => n.id === req.params.id);
  if (!notification) return res.status(404).json({ error: 'Notification not found' });
  notification.status = 'READ';
  res.json(notification);
});

// Background Processes
app.get('/api/background-processes', (req, res) => res.json(BACKGROUND_PROCESSES));
app.post('/api/background-processes/:id/run', (req, res) => {
  const process = BACKGROUND_PROCESSES.find(p => p.id === req.params.id);
  if (!process) return res.status(404).json({ error: 'Process not found' });
  
  process.status = 'RUNNING';
  process.lastRun = new Date().toISOString();
  
  // Simulate process completion after 2 seconds
  setTimeout(() => {
    process.status = 'COMPLETED';
    process.nextRun = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // Next day
  }, 2000);
  
  res.json({ message: 'Process started', process });
});

// Documents
app.get('/api/documents', (req, res) => res.json(DOCUMENTS));
app.post('/api/documents', (req, res) => {
  const { name, type, entityId, entityType, size } = req.body;
  const newDocument = {
    id: `DOC${Date.now()}`,
    name,
    type,
    entityId,
    entityType,
    uploadedAt: new Date().toISOString(),
    size: size || 0,
    status: 'ACTIVE'
  };
  DOCUMENTS.unshift(newDocument);
  res.status(201).json(newDocument);
});

// Workflows
app.get('/api/workflows', (req, res) => res.json(WORKFLOWS));
app.post('/api/workflows/:id/advance', (req, res) => {
  const workflow = WORKFLOWS.find(w => w.id === req.params.id);
  if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
  
  if (workflow.currentStep < workflow.steps.length - 1) {
    workflow.currentStep++;
  }
  res.json(workflow);
});

// Audit Logs
app.get('/api/audit-logs', (req, res) => res.json(AUDIT_LOGS));

// Advanced Reporting
app.get('/api/reports/loan-portfolio', (req, res) => {
  const portfolio = {
    totalLoans: LOANS.reduce((sum, loan) => sum + loan.principal, 0),
    activeLoans: LOANS.filter(l => l.status === 'Active').length,
    arrearsCount: LOANS.filter(l => l.status === 'Arrears').length,
    averageLoanSize: LOANS.reduce((sum, loan) => sum + loan.principal, 0) / LOANS.length,
    byProduct: LOANS.reduce((acc, loan) => {
      acc[loan.productTypeKey || 'UNKNOWN'] = (acc[loan.productTypeKey || 'UNKNOWN'] || 0) + loan.principal;
      return acc;
    }, {})
  };
  res.json(portfolio);
});

app.get('/api/reports/member-engagement', (req, res) => {
  const engagement = {
    totalMembers: MEMBERS.length,
    activeMembers: MEMBERS.filter(m => m.status === 'Active').length,
    loanParticipation: LOANS.length / MEMBERS.length,
    savingsParticipation: SAVINGS.length / MEMBERS.length,
    shareParticipation: SHARES.length / MEMBERS.length,
    averageSavings: SAVINGS.reduce((sum, s) => sum + s.balance, 0) / SAVINGS.length,
    averageShares: SHARES.reduce((sum, s) => sum + s.amount, 0) / SHARES.length
  };
  res.json(engagement);
});

// Bulk Operations
app.post('/api/bulk/members', (req, res) => {
  const { members } = req.body;
  if (!Array.isArray(members)) return res.status(400).json({ error: 'Members array required' });
  
  const results = { success: 0, failed: 0, errors: [] };
  
  members.forEach(member => {
    try {
      // Basic validation
      if (!member.firstName || !member.lastName || !member.id) {
        results.failed++;
        results.errors.push(`Missing required fields for member: ${JSON.stringify(member)}`);
        return;
      }
      
      MEMBERS.push({
        id: member.id,
        name: `${member.firstName} ${member.lastName}`,
        emp: member.employeeNumber || '',
        entity: member.entity || 'KPMG Kenya',
        phone: member.phone || '',
        status: 'Active'
      });
      results.success++;
    } catch (error) {
      results.failed++;
      results.errors.push(`Error processing member: ${error.message}`);
    }
  });
  
  res.json(results);
});

// Interest Accrual Simulation
app.post('/api/processes/accrue-interest', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  let totalInterest = 0;
  
  LOANS.forEach(loan => {
    if (loan.status === 'Active') {
      // Simple interest calculation (1% per month)
      const monthlyInterest = loan.principal * 0.01;
      totalInterest += monthlyInterest;
      
      // Add transaction record
      TRANSACTIONS.push({
        id: `INT${Date.now()}${Math.random().toString(36).substr(2, 5)}`,
        type: 'INTEREST_ACCRUAL',
        accountId: `${loan.id}-LOAN`,
        amount: monthlyInterest,
        currency: 'KES',
        date: today,
        description: `Monthly interest accrual for loan ${loan.id}`,
        status: 'COMPLETED'
      });
    }
  });
  
  res.json({ 
    message: 'Interest accrual completed',
    totalInterestAccrued: totalInterest,
    loansProcessed: LOANS.filter(l => l.status === 'Active').length,
    transactionsCreated: LOANS.filter(l => l.status === 'Active').length
  });
});

app.listen(PORT, () => {
  console.log(`City SACCO app listening on http://localhost:${PORT}`);
});
