const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ---------------------------------------------------------------------------
// Shared in-memory store. Both the legacy dashboard API (/api/*) and the
// Mambu-conformant API (/api/v2/*) read and write these same collections.
// ---------------------------------------------------------------------------
const store = require('./src/store');
const {
  MEMBERS, BRANCHES, CENTRES, GROUPS, CURRENCIES, TRANSACTIONS, CARDS, LOANS,
  SAVINGS, SHARES, KYC_FIELDS, CUSTOM_FIELDS, CUSTOM_FIELD_SETS, GL_ACCOUNTS,
  USERS, NOTIFICATIONS, BACKGROUND_PROCESSES, DOCUMENTS, WORKFLOWS, AUDIT_LOGS,
  LOAN_PRODUCTS, SAVINGS_PRODUCTS, SHARE_PRODUCTS, CHARGES, TB_DATA, BS_GROUPS,
  IS_GROUPS,
} = store;

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


// ---------------------------------------------------------------------------
// Mambu API v2 conformant surface.
// Mounted under /api/v2 so the existing dashboard API at /api stays untouched.
// ---------------------------------------------------------------------------
const { searchHandler } = require('./src/lib/resource');
const loanDomain = require('./src/domain/loans');
const depositDomain = require('./src/domain/deposits');
app.post('/api/v2/loans:search', searchHandler(store.LOANS, { map: loanDomain.normalise }));
app.post('/api/v2/deposits:search', searchHandler(store.SAVINGS, { map: depositDomain.normalise }));
app.post('/api/v2/loans/transactions:search', searchHandler(store.LOAN_TRANSACTIONS));
app.post('/api/v2/deposits/transactions:search', searchHandler(store.DEPOSIT_TRANSACTIONS));
app.post('/api/v2/accounting/journalentries:search', searchHandler(store.JOURNAL_ENTRIES));
app.use('/api/v2/loans', require('./src/routes/loans'));
app.use('/api/v2/deposits', require('./src/routes/deposits'));
app.use('/api/v2/accounting', require('./src/routes/accounting'));
app.use('/api/v2', require('./src/routes'));

// Only bind a port when run directly, so tooling can require the app.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`City SACCO app listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
