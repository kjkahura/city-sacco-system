const API_BASE = '/api';

let currentPage = 1;
let totalMembers = 0;
let searchQuery = '';

// Global data arrays
let MEMBERS = [];
let LOANS = [];
let SAVINGS = [];
let SHARES = [];
let KYC_FIELDS = [];
let CUSTOM_FIELDS = [];
let CUSTOM_FIELD_SETS = [];
let currentCustomFieldOptions = [];
let GL_ACCOUNTS = [];
let USERS = [];
let LOAN_PRODUCTS = [];
let SAVINGS_PRODUCTS = [];
let SHARE_PRODUCTS = [];
let CHARGES = [];
let BRANCHES = [];
let CENTRES = [];
let GROUPS = [];
let CURRENCIES = [];
let TRANSACTIONS = [];
let CARDS = [];
let NOTIFICATIONS = [];
let PROCESSES = [];
let AUDIT_LOGS = [];

async function fetchJson(path) {
  const response = await fetch(`${API_BASE}/${path}`);
  if (!response.ok) {
    throw new Error(`API request failed: ${path} ${response.status}`);
  }
  return response.json();
}

async function postJson(path, payload) {
  const response = await fetch(`${API_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`API POST failed: ${path} ${response.status}`);
  }
  return response.json();
}

let editingMemberId = null;
let editingLoanId = null;
let editingCustomFieldSetId = null;

async function putJson(path, payload) {
  const response = await fetch(`${API_BASE}/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`API PUT failed: ${path} ${response.status}`);
  }
  return response.json();
}

async function deleteJson(path) {
  const response = await fetch(`${API_BASE}/${path}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(`API DELETE failed: ${path} ${response.status}`);
  }
  return response.json();
}

function setMemberModalState(editing = false) {
  const title = document.querySelector('#modal-member .modal-title');
  const action = document.querySelector('#modal-member .modal-footer .btn-primary');
  if (title) title.textContent = editing ? 'Edit Member' : 'Add New Member';
  if (action) action.textContent = editing ? 'Save Changes' : 'Register Member';
}

function setLoanModalState(editing = false) {
  const title = document.querySelector('#modal-loan .modal-title');
  if (title) title.textContent = editing ? 'Edit Loan' : 'Create Loan';
}

function resetMemberForm() {
  editingMemberId = null;
  setMemberModalState(false);
  document.getElementById('member-firstName').value = '';
  document.getElementById('member-lastName').value = '';
  document.getElementById('member-kwaraId').value = '';
  document.getElementById('member-empNum').value = '';
  document.getElementById('member-nationalId').value = '';
  document.getElementById('member-kraPin').value = '';
  document.getElementById('member-phone').value = '';
  document.getElementById('member-email').value = '';
  document.getElementById('member-dob').value = '';
  document.getElementById('member-gender').value = 'Select…';
  document.getElementById('member-entity').value = 'KPMG Kenya';
  document.getElementById('member-department').value = '';
  document.getElementById('member-empType').value = 'Permanent';
  document.getElementById('member-joinDate').value = '';
  renderMemberCustomFieldInputs();
}

function prepareNewMember() {
  resetMemberForm();
  openModal('modal-member');
}

function openEditMember(id) {
  const member = MEMBERS.find(m => memberClientId(m) === id);
  if (!member) return;
  editingMemberId = id;
  setMemberModalState(true);
  const displayName = member.displayName || member.name || '';
  const [firstName, ...rest] = displayName.split(' ');
  document.getElementById('member-firstName').value = member.firstName || firstName || '';
  document.getElementById('member-lastName').value = member.lastName || rest.join(' ') || '';
  document.getElementById('member-kwaraId').value = member.kwaraId || member.clientId || member.id || '';
  document.getElementById('member-empNum').value = member.emp || '';
  document.getElementById('member-nationalId').value = member.nationalId || '';
  document.getElementById('member-kraPin').value = member.kraPin || '';
  document.getElementById('member-phone').value = member.phone || '';
  document.getElementById('member-email').value = member.email || '';
  document.getElementById('member-dob').value = member.dob || member.dateOfBirth || '';
  document.getElementById('member-gender').value = member.gender || 'Select…';
  document.getElementById('member-entity').value = member.entity || 'KPMG Kenya';
  document.getElementById('member-department').value = member.department || '';
  document.getElementById('member-empType').value = member.empType || member.employmentType || 'Permanent';
  document.getElementById('member-joinDate').value = member.joinDate || member.joinedDate || '';
  renderMemberCustomFieldInputs(member);
  openModal('modal-member');
}

async function deleteMember(id) {
  if (!confirm('Delete this member? This action cannot be undone.')) return;
  try {
    await deleteJson(`clients/${encodeURIComponent(id)}`);
    const idx = MEMBERS.findIndex(m => memberClientId(m) === id);
    if (idx !== -1) MEMBERS.splice(idx, 1);
    totalMembers = Math.max(0, totalMembers - 1);
    renderMembers(MEMBERS);
    renderPagination();
  } catch (error) {
    console.error('Failed to delete member:', error);
    alert('Failed to delete member. Please try again.');
  }
}

function resetLoanForm() {
  editingLoanId = null;
  setLoanModalState(false);
  document.getElementById('loan-member-search').value = '';
  searchLoanMember('');
  document.getElementById('loan-product').value = 'NL01';
  document.getElementById('loan-app-date').value = '';
  document.getElementById('loan-principal').value = '';
  document.getElementById('loan-duration').value = '';
  document.getElementById('loan-disb-date').value = '';
  document.getElementById('loan-first-rep').value = '';
  document.getElementById('charge-processing-fee').checked = true;
  loanStep = 1;
  document.querySelectorAll('.wizard-panel').forEach((panel, idx) => panel.classList.toggle('active', idx === 0));
  document.querySelectorAll('.wizard-step').forEach((step, idx) => {
    step.classList.toggle('active', idx === 0);
    step.classList.remove('done');
  });
  const backBtn = document.getElementById('loan-btn-back');
  if (backBtn) backBtn.style.display = 'none';
  const nextBtn = document.getElementById('loan-btn-next');
  if (nextBtn) nextBtn.textContent = 'Next →';
}

function prepareNewLoan() {
  resetLoanForm();
  setLoanModalState(false);
  openModal('modal-loan');
}

function openEditLoan(id) {
  const loan = LOANS.find(l => l.id === id || l.loanId === id);
  if (!loan) return;
  resetLoanForm();
  editingLoanId = id;
  setLoanModalState(true);
  document.getElementById('loan-member-search').value = '';
  searchLoanMember('');
  const memberSelect = document.getElementById('loan-member-select');
  if (memberSelect) {
    memberSelect.value = loan.clientId || loan.member || '';
    if (!memberSelect.value) {
      const match = Array.from(memberSelect.options).find(opt => opt.text.includes(loan.member || loan.clientName || ''));
      if (match) memberSelect.value = match.value;
    }
  }
  document.getElementById('loan-product').value = loan.productTypeKey || loan.loanProduct || 'NL01';
  document.getElementById('loan-app-date').value = loan.applicationDate || '';
  document.getElementById('loan-principal').value = loan.principal || 0;
  document.getElementById('loan-duration').value = loan.duration || loan.termInMonths || 0;
  document.getElementById('loan-disb-date').value = loan.disbDate || loan.disbursementDate || '';
  document.getElementById('loan-first-rep').value = loan.firstRepaymentDate || '';
  document.getElementById('charge-processing-fee').checked = loan.processingFee !== false;
  openModal('modal-loan');
}

async function deleteLoan(id) {
  if (!confirm('Delete this loan? This action cannot be undone.')) return;
  try {
    await deleteJson(`loans/${encodeURIComponent(id)}`);
    const idx = LOANS.findIndex(l => l.id === id || l.loanId === id);
    if (idx !== -1) LOANS.splice(idx, 1);
    renderLoans();
  } catch (error) {
    console.error('Failed to delete loan:', error);
    alert('Failed to delete loan. Please try again.');
  }
}

function renderLoans() {
  const tbody = document.getElementById('loan-tbody');
  if (!tbody) return;
  tbody.innerHTML = LOANS.map(l => {
    const memberName = l.member || l.clientName || '—';
    const loanId = l.id || l.loanId || '—';
    const principal = l.principal || 0;
    const duration = l.duration || l.termInMonths || 0;
    const disbDate = l.disbDate || l.disbursementDate || '—';
    const status = l.status || 'Active';
    const r = 0.01;
    const install = duration && principal ? Math.round(principal * r * Math.pow(1+r,duration) / (Math.pow(1+r,duration)-1)) : 0;
    return `
    <tr>
      <td><span class="td-primary">${memberName}</span><br><span class="td-mono">${loanId}</span></td>
      <td class="td-mono">${fmt(principal)}</td>
      <td class="td-mono">${fmt(principal)}</td>
      <td class="td-mono" style="color:var(--green)">${fmt(install)}</td>
      <td>${duration} mo</td>
      <td><span class="badge badge-blue">KES 1,000</span></td>
      <td>${disbDate}</td>
      <td>${statusBadge(status)}</td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="openEditLoan('${loanId}')">Edit</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteLoan('${loanId}')">✕</button>
      </td>
    </tr>`;
  }).join('');
}

function memberDisplayName(member) {
  return (member.displayName || member.name || '').trim();
}

function memberClientId(member) {
  return member.clientId || member.id || '';
}

function renderMemberCustomFieldInputs(member = null) {
  const container = document.getElementById('member-custom-fields');
  if (!container) return;
  const clientFields = CUSTOM_FIELDS.filter(f => f.module === 'Clients' && f.usage !== 'Unavailable');
  const values = (member?.customFields || []).reduce((acc, cf) => {
    acc[cf.fieldId || cf.id || cf.label] = cf.value ?? cf.text ?? '';
    return acc;
  }, {});

  if (!clientFields.length) {
    container.innerHTML = `
      <div class="form-group" style="grid-column:1/-1;color:var(--text3);font-size:13px">
        No custom fields configured yet. Add fields in Settings → Custom Fields.
      </div>
      <div class="form-group" style="grid-column:1/-1;">
        <button type="button" class="btn btn-secondary btn-sm" onclick="openCustomFieldModal()">+ Add Custom Field</button>
      </div>
    `;
    return;
  }

  container.innerHTML = clientFields.map(field => {
    const fieldKey = field.id || field.label;
    const value = values[fieldKey] || '';
    const required = field.usage === 'Required' ? ' required' : '';
    const hint = field.hint ? `<div class="form-help">${field.hint}</div>` : '';
    const inputId = `member-cf-${fieldKey}`;
    let input = '';

    if (field.type === 'Dropdown' && Array.isArray(field.options) && field.options.length) {
      input = `<select id="${inputId}" class="form-control"${required}>${field.options.map(opt => {
        const optionValue = opt.value ?? opt.id ?? opt.label ?? '';
        const optionLabel = opt.label || opt.id || opt.value || optionValue;
        return `<option value="${optionValue}"${optionValue === value ? ' selected' : ''}>${optionLabel}</option>`;
      }).join('')}</select>`;
    } else if (field.type === 'Date') {
      input = `<input id="${inputId}" class="form-control" type="date" value="${value}"${required}>`;
    } else if (field.type === 'Number') {
      input = `<input id="${inputId}" class="form-control" type="number" step="any" value="${value}"${required}>`;
    } else {
      input = `<input id="${inputId}" class="form-control" type="text" value="${value}"${required}>`;
    }

    return `
      <div class="form-group">
        <label class="form-label">${field.label}${field.usage === 'Required' ? ' *' : ''}</label>
        ${input}
        ${hint}
      </div>`;
  }).join('');
}

function collectMemberCustomFieldValues() {
  return CUSTOM_FIELDS.filter(f => f.module === 'Clients' && f.usage !== 'Unavailable').map(field => {
    const inputId = `member-cf-${field.id || field.label}`;
    const element = document.getElementById(inputId);
    if (!element) return null;
    return {
      fieldId: field.id,
      label: field.label,
      type: field.type,
      value: element.value ?? ''
    };
  }).filter(Boolean);
}

function renderMembers(members) {
  const tbody = document.getElementById('member-tbody');
  if (!tbody) return;
  tbody.innerHTML = members.map(m => {
    const clientId = memberClientId(m);
    const displayName = memberDisplayName(m);
    const loans = LOANS.filter(l => l.clientId === clientId || l.member === displayName).length;
    const savings = SAVINGS.filter(s => s.id === clientId).reduce((sum, s) => sum + s.balance, 0);
    const status = m.status || 'Active';
    return `
    <tr>
      <td><span class="td-primary">${displayName}</span><br><span class="td-mono">${clientId}</span></td>
      <td class="td-mono">${clientId}</td>
      <td>${m.entity || 'KPMG Kenya'}</td>
      <td>${m.phone || '—'}</td>
      <td>${loans}</td>
      <td class="td-mono">${fmt(savings)}</td>
      <td><span class="badge ${status === 'Active' ? 'badge-green' : 'badge-amber'}">${status}</span></td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="openMemberDetails('${clientId}')">View</button>
        <button class="btn btn-ghost btn-sm" onclick="openEditMember('${clientId}')">Edit</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteMember('${clientId}')">✕</button>
      </td>
    </tr>`;
  }).join('');
}

function openMemberDetails(id) {
  const member = MEMBERS.find(m => memberClientId(m) === id);
  if (!member) return;
  // Populate the details modal
  const displayName = memberDisplayName(member);
  document.getElementById('member-details-name').textContent = displayName;
  document.getElementById('member-details-name-display').textContent = displayName;
  document.getElementById('member-details-id').textContent = memberClientId(member);
  document.getElementById('member-details-entity').textContent = member.entity || 'KPMG Kenya';
  document.getElementById('member-details-phone').textContent = member.phone || '—';
  document.getElementById('member-details-email').textContent = member.email || '—';
  document.getElementById('member-details-dob').textContent = member.dob || member.dateOfBirth || '—';
  document.getElementById('member-details-gender').textContent = member.gender || '—';
  document.getElementById('member-details-department').textContent = member.department || '—';
  document.getElementById('member-details-emp-type').textContent = member.empType || member.employmentType || '—';
  document.getElementById('member-details-join-date').textContent = member.joinDate || member.joinedDate || '—';
  document.getElementById('member-details-status').textContent = member.status || 'Active';
  // Custom fields
  renderMemberDetailsCustomFields(member);
  openModal('modal-member-details');
}

function renderMemberDetailsCustomFields(member) {
  const container = document.getElementById('member-details-custom-fields');
  if (!container) return;
  const clientFields = CUSTOM_FIELDS.filter(f => f.module === 'Clients' && f.usage !== 'Unavailable');
  const values = (member.customFields || []).reduce((acc, cf) => {
    acc[cf.fieldId || cf.id || cf.label] = cf.value ?? cf.text ?? '';
    return acc;
  }, {});

  if (!clientFields.length) {
    container.innerHTML = '<div style="color:var(--text3);font-size:13px">No custom fields configured.</div>';
    return;
  }

  container.innerHTML = clientFields.map(field => {
    const fieldKey = field.id || field.label;
    const value = values[fieldKey] || '—';
    return `
      <div class="form-group">
        <label class="form-label">${field.label}</label>
        <div style="padding:8px 12px;background:var(--bg3);border-radius:4px;color:var(--text)">${value}</div>
      </div>`;
  }).join('');
}

function loanProductLabel(code) {
  if (!code) return '—';
  try {
    if (!LOAN_PRODUCTS || !Array.isArray(LOAN_PRODUCTS)) return code;
    const product = LOAN_PRODUCTS.find(p => p.id === code || p.id === (code || '').trim());
    return product ? `${product.id} · ${product.name}` : code;
  } catch (e) {
    console.error('Error getting loan product label:', e);
    return code;
  }
}

async function saveGLAccount(isEdit, code) {
  const name = document.getElementById('egl-name').value.trim();
  const type = document.getElementById('egl-type').value;
  const stmt = document.getElementById('egl-statement').value;
  if (!name) {
    alert('Please fill in required fields.');
    return;
  }
  const payload = { name, type, statement: stmt };
  try {
    if (isEdit) {
      await putJson(`gl-accounts/${encodeURIComponent(code)}`, payload);
    } else {
      const codeVal = document.getElementById('egl-code').value.trim();
      if (!codeVal) {
        alert('Please enter a GL Code.');
        return;
      }
      await postJson('gl-accounts', { code: codeVal, ...payload });
    }
    const idx = GL_ACCOUNTS.findIndex(g => g.code === code);
    if (idx !== -1) {
      const updated = await fetchJson('gl-accounts');
      GL_ACCOUNTS.length = 0;
      GL_ACCOUNTS.push(...updated);
    } else {
      const updated = await fetchJson('gl-accounts');
      GL_ACCOUNTS.length = 0;
      GL_ACCOUNTS.push(...updated);
    }
    renderGLAccounts();
    closeModal('modal-edit-gl');
  } catch (error) {
    console.error('Failed to save GL account:', error);
    alert('Failed to save GL account.');
  }
}

async function deleteGLAccount(code) {
  if (!confirm(`Delete GL account "${code}"?`)) return;
  try {
    await deleteJson(`gl-accounts/${encodeURIComponent(code)}`);
    const idx = GL_ACCOUNTS.findIndex(g => g.code === code);
    if (idx !== -1) GL_ACCOUNTS.splice(idx, 1);
    renderGLAccounts();
  } catch (error) {
    console.error('Failed to delete GL account:', error);
    alert('Failed to delete GL account.');
  }
}

async function saveLoanProduct(isEdit, productId) {
  const id = document.getElementById('product-id').value.trim();
  const name = document.getElementById('product-name').value.trim();
  const rate = parseFloat(document.getElementById('product-rate').value) || 1;
  const maxTerm = parseInt(document.getElementById('product-max-term').value) || 36;
  const fee = parseFloat(document.getElementById('product-fee').value) || 0;
  const feeDefault = document.getElementById('product-fee-default').checked;
  const glAsset = document.getElementById('product-gl-asset').value;
  const glIncome = document.getElementById('product-gl-income').value;
  if (!name || !id) {
    alert('Please fill in required fields.');
    return;
  }
  const payload = { name, rate, maxTerm, fee, feeDefault, glAsset, glIncome };
  try {
    if (isEdit) {
      await putJson(`loan-products/${encodeURIComponent(productId)}`, payload);
    } else {
      await postJson('loan-products', { id, ...payload });
    }
    const updated = await fetchJson('loan-products');
    LOAN_PRODUCTS.length = 0;
    LOAN_PRODUCTS.push(...updated);
    renderLoanProducts();
    closeModal('modal-edit-loan-product');
  } catch (error) {
    console.error('Failed to save loan product:', error);
    alert('Failed to save loan product.');
  }
}

async function deleteLoanProduct(id) {
  if (!confirm(`Delete this loan product?`)) return;
  try {
    await deleteJson(`loan-products/${encodeURIComponent(id)}`);
    const idx = LOAN_PRODUCTS.findIndex(p => p.id === id);
    if (idx !== -1) LOAN_PRODUCTS.splice(idx, 1);
    renderLoanProducts();
  } catch (error) {
    console.error('Failed to delete loan product:', error);
    alert('Failed to delete loan product.');
  }
}

async function saveUser(isEdit, userEmail) {
  const name = document.getElementById('user-name').value.trim();
  const email = document.getElementById('user-email').value.trim();
  const role = document.getElementById('user-role').value;
  const status = document.getElementById('user-status').value;
  if (!name || !email) {
    alert('Please fill in required fields.');
    return;
  }
  const payload = { name, role, status };
  try {
    if (isEdit) {
      await putJson(`users/${encodeURIComponent(userEmail)}`, payload);
    } else {
      await postJson('users', { email, ...payload });
    }
    const updated = await fetchJson('users');
    USERS.length = 0;
    USERS.push(...updated);
    renderUsers();
    closeModal('modal-user');
  } catch (error) {
    console.error('Failed to save user:', error);
    alert('Failed to save user.');
  }
}

async function deleteUser(email) {
  if (!confirm(`Delete user "${email}"?`)) return;
  try {
    await deleteJson(`users/${encodeURIComponent(email)}`);
    const idx = USERS.findIndex(u => u.email === email);
    if (idx !== -1) USERS.splice(idx, 1);
    renderUsers();
  } catch (error) {
    console.error('Failed to delete user:', error);
    alert('Failed to delete user.');
  }
}

async function saveSavingsProduct(isEdit, id) {
  const name = document.getElementById('esp-name').value.trim();
  const interest = parseFloat(document.getElementById('esp-interest').value) || 0;
  const glLiability = document.getElementById('esp-glliability').value.trim();
  const glPayroll = document.getElementById('esp-glpayroll').value.trim();
  const glBank = document.getElementById('esp-glbank').value.trim();
  if (!name) {
    alert('Please fill in required fields.');
    return;
  }
  const payload = { name, interest, glLiability, glPayroll, glBank };
  try {
    if (isEdit) {
      await putJson(`savings-products/${encodeURIComponent(id)}`, payload);
    } else {
      await postJson('savings-products', { id, ...payload });
    }
    const updated = await fetchJson('savings-products');
    SAVINGS_PRODUCTS.length = 0;
    SAVINGS_PRODUCTS.push(...updated);
    renderSavingsProducts();
    closeModal('modal-edit-savings-product');
  } catch (error) {
    console.error('Failed to save savings product:', error);
    alert('Failed to save savings product.');
  }
}

async function deleteSavingsProduct(id) {
  if (!confirm(`Delete savings product?`)) return;
  try {
    await deleteJson(`savings-products/${encodeURIComponent(id)}`);
    const idx = SAVINGS_PRODUCTS.findIndex(p => p.id === id);
    if (idx !== -1) SAVINGS_PRODUCTS.splice(idx, 1);
    renderSavingsProducts();
  } catch (error) {
    console.error('Failed to delete savings product:', error);
    alert('Failed to delete savings product.');
  }
}

async function saveShareProduct(isEdit, id) {
  const name = document.getElementById('esp-name').value.trim();
  const parValue = parseInt(document.getElementById('esp-parvalue').value) || 0;
  const glEquity = document.getElementById('esp-glequity').value.trim();
  if (!name || !parValue) {
    alert('Please fill in required fields.');
    return;
  }
  const payload = { name, parValue, glEquity };
  try {
    if (isEdit) {
      await putJson(`share-products/${encodeURIComponent(id)}`, payload);
    } else {
      await postJson('share-products', { id, ...payload });
    }
    const updated = await fetchJson('share-products');
    SHARE_PRODUCTS.length = 0;
    SHARE_PRODUCTS.push(...updated);
    renderShareProducts();
    closeModal('modal-edit-share-product');
  } catch (error) {
    console.error('Failed to save share product:', error);
    alert('Failed to save share product.');
  }
}

async function deleteShareProduct(id) {
  if (!confirm(`Delete share product?`)) return;
  try {
    await deleteJson(`share-products/${encodeURIComponent(id)}`);
    const idx = SHARE_PRODUCTS.findIndex(p => p.id === id);
    if (idx !== -1) SHARE_PRODUCTS.splice(idx, 1);
    renderShareProducts();
  } catch (error) {
    console.error('Failed to delete share product:', error);
    alert('Failed to delete share product.');
  }
}

async function saveCharge(isEdit, name) {
  const amount = parseInt(document.getElementById('ec-amount').value) || 0;
  const appliesTo = document.getElementById('ec-appliesto').value.trim();
  const timing = document.getElementById('ec-timing').value.trim();
  const defaultOn = document.getElementById('ec-defaulton').checked;
  const gl = document.getElementById('ec-gl').value.trim();
  if (!amount || !appliesTo || !timing) {
    alert('Please fill in required fields.');
    return;
  }
  const payload = { amount, appliesTo, timing, defaultOn, gl };
  try {
    if (isEdit) {
      await putJson(`charges/${encodeURIComponent(name)}`, payload);
    } else {
      await postJson('charges', { name, ...payload });
    }
    const updated = await fetchJson('charges');
    CHARGES.length = 0;
    CHARGES.push(...updated);
    renderCharges();
    closeModal('modal-edit-charge');
  } catch (error) {
    console.error('Failed to save charge:', error);
    alert('Failed to save charge.');
  }
}

async function deleteCharge(name) {
  if (!confirm(`Delete charge?`)) return;
  try {
    await deleteJson(`charges/${encodeURIComponent(name)}`);
    const idx = CHARGES.findIndex(c => c.name === name);
    if (idx !== -1) CHARGES.splice(idx, 1);
    renderCharges();
  } catch (error) {
    console.error('Failed to delete charge:', error);
    alert('Failed to delete charge.');
  }
}

async function fetchMembers(page = 1, search = '') {
  const params = new URLSearchParams({ page: page.toString(), limit: '100' });
  if (search) params.append('search', search);
  return fetchJson(`clients?${params}`);
}

async function refreshData() {
  try {
    const [overview, membersResponse, loans, depositAccounts, kycFields, customFields, customFieldSets, glAccounts, users, loanProducts, savingsProducts, shareProducts, charges, branches, centres, groups, currencies, transactions, cards, notifications, processes, auditLogs, tbData, bsGroups, isGroups] = await Promise.all([
      fetchJson('overview'),
      fetchMembers(currentPage, searchQuery),
      fetchJson('loans'),
      fetchJson('deposit-accounts'),
      fetchJson('kyc-fields'),
      fetchJson('custom-fields'),
      fetchJson('custom-field-sets'),
      fetchJson('gl-accounts'),
      fetchJson('users'),
      fetchJson('loan-products'),
      fetchJson('savings-products'),
      fetchJson('share-products'),
      fetchJson('charges'),
      fetchJson('branches'),
      fetchJson('centres'),
      fetchJson('groups'),
      fetchJson('currencies'),
      fetchJson('transactions'),
      fetchJson('cards'),
      fetchJson('notifications'),
      fetchJson('background-processes'),
      fetchJson('audit-logs'),
      fetchJson('reports/trial-balance'),
      fetchJson('reports/balance-sheet'),
      fetchJson('reports/income-statement'),
    ]);

    MEMBERS.length = 0; MEMBERS.push(...membersResponse.data);
    totalMembers = membersResponse.total;
    LOANS.length = 0; LOANS.push(...loans);
    // Split deposit accounts from Mambu-style response
    SAVINGS.length = 0;
    SHARES.length = 0;
    depositAccounts.forEach(acc => {
      if (acc.accountType === 'SAVINGS' || acc.productTypeKey === 'MD01') {
        SAVINGS.push({
          member: memberDisplayName(MEMBERS.find(m => memberClientId(m) === acc.accountHolderKey)) || acc.accountHolderKey,
          id: acc.accountHolderKey,
          balance: acc.accountBalance,
          last: acc.lastActivityDate || ''
        });
      } else if (acc.accountType === 'SHARE' || acc.productTypeKey === 'SC01') {
        SHARES.push({
          member: memberDisplayName(MEMBERS.find(m => memberClientId(m) === acc.accountHolderKey)) || acc.accountHolderKey,
          id: acc.accountHolderKey,
          amount: acc.accountBalance,
          units: acc.units || 0
        });
      }
    });
    KYC_FIELDS.length = 0; KYC_FIELDS.push(...kycFields);
    CUSTOM_FIELDS.length = 0; CUSTOM_FIELDS.push(...customFields);
    CUSTOM_FIELD_SETS.length = 0; CUSTOM_FIELD_SETS.push(...customFieldSets);
    GL_ACCOUNTS.length = 0; GL_ACCOUNTS.push(...glAccounts);
    USERS.length = 0; USERS.push(...users);
    LOAN_PRODUCTS.length = 0; LOAN_PRODUCTS.push(...loanProducts);
    SAVINGS_PRODUCTS.length = 0; SAVINGS_PRODUCTS.push(...savingsProducts);
    SHARE_PRODUCTS.length = 0; SHARE_PRODUCTS.push(...shareProducts);
    CHARGES.length = 0; CHARGES.push(...charges);
    BRANCHES.length = 0; BRANCHES.push(...branches);
    CENTRES.length = 0; CENTRES.push(...centres);
    GROUPS.length = 0; GROUPS.push(...groups);
    CURRENCIES.length = 0; CURRENCIES.push(...currencies);
    TRANSACTIONS.length = 0; TRANSACTIONS.push(...transactions);
    CARDS.length = 0; CARDS.push(...cards);
    NOTIFICATIONS.length = 0; NOTIFICATIONS.push(...notifications);
    BACKGROUND_PROCESSES.length = 0; BACKGROUND_PROCESSES.push(...processes);
    AUDIT_LOGS.length = 0; AUDIT_LOGS.push(...auditLogs);
    TB_DATA.length = 0; TB_DATA.push(...tbData);
    Object.keys(BS_GROUPS).forEach(k => delete BS_GROUPS[k]);
    Object.assign(BS_GROUPS, bsGroups);
    Object.keys(IS_GROUPS).forEach(k => delete IS_GROUPS[k]);
    Object.assign(IS_GROUPS, isGroups);

    renderMembers(MEMBERS);
    renderLoans();
    renderSavings();
    renderShares();
    renderKYCFields();
    renderCustomFieldFilters();
    renderCustomFields();
    renderCustomFieldSetModuleFilter();
    renderCustomFieldSets();
    renderGLAccounts();
    renderUsers();
    renderLoanProducts();
    renderSavingsProducts();
    renderShareProducts();
    renderCharges();
    renderBranches();
    renderCentres();
    renderGroups();
    renderCurrencies();
    renderTransactions();
    renderCards();
    renderNotifications();
    renderProcesses();
    renderAuditLogs();
    updatePermissions();
    generateReports();
    renderAdvancedReports();
    searchLoanMember('');
    renderPagination();
  } catch (error) {
    console.error('Failed to hydrate UI from API:', error);
  }
}

async function addMember() {
  try {
    const firstName = document.getElementById('member-firstName').value.trim();
    const lastName = document.getElementById('member-lastName').value.trim();
    const kwaraId = document.getElementById('member-kwaraId').value.trim();
    const empNum = document.getElementById('member-empNum').value.trim();
    const nationalId = document.getElementById('member-nationalId').value.trim();
    const kraPin = document.getElementById('member-kraPin').value.trim();
    const phone = document.getElementById('member-phone').value.trim();
    const email = document.getElementById('member-email').value.trim();
    const dob = document.getElementById('member-dob').value;
    const gender = document.getElementById('member-gender').value;
    const entity = document.getElementById('member-entity').value;
    const department = document.getElementById('member-department').value.trim();
    const empType = document.getElementById('member-empType').value;
    const joinDate = document.getElementById('member-joinDate').value;

    if (!firstName || !lastName || !kwaraId || !nationalId || !phone || !entity) {
      alert('Please fill in all required fields.');
      return;
    }

    const name = `${firstName} ${lastName}`;
    const payload = {
      name,
      emp: empNum,
      entity,
      phone,
      status: 'Active',
      kwaraId,
      nationalId,
      kraPin,
      email,
      dob,
      gender,
      department,
      empType,
      joinDate,
      customFields: collectMemberCustomFieldValues()
    };

    let memberResult;
    if (editingMemberId) {
      memberResult = await putJson(`clients/${encodeURIComponent(editingMemberId)}`, payload);
      const idx = MEMBERS.findIndex(m => memberClientId(m) === editingMemberId);
      if (idx !== -1) MEMBERS[idx] = memberResult;
      else MEMBERS.unshift(memberResult);
      editingMemberId = null;
    } else {
      memberResult = await postJson('clients', payload);
      MEMBERS.unshift(memberResult);
      totalMembers = (typeof totalMembers === 'number' ? totalMembers + 1 : MEMBERS.length);
    }
    renderMembers(MEMBERS);
    document.getElementById('member-count').textContent = totalMembers;
    closeModal('modal-member');
    resetMemberForm();
  } catch (error) {
    console.error('Failed to add member:', error);
    alert('Failed to add member. Please try again.');
  }
}

async function addLoan() {
  try {
    const memberSelect = document.getElementById('loan-member-select');
    const member = memberSelect.value;
    const principal = parseFloat(document.getElementById('loan-principal').value);
    const duration = parseInt(document.getElementById('loan-duration').value);
    const disbDate = document.getElementById('loan-disb-date').value;

    if (!member || !principal || !duration || !disbDate) {
      alert('Please fill in all required fields.');
      return;
    }

    const productTypeKey = document.getElementById('loan-product').value;
    const processingFee = document.getElementById('charge-processing-fee').checked;
    const payload = { member, principal, duration, disbDate, productTypeKey, processingFee, status: 'Active' };
    const isEditingLoan = !!editingLoanId;
    let loanResult;

    if (isEditingLoan) {
      loanResult = await putJson(`loans/${encodeURIComponent(editingLoanId)}`, payload);
      const idx = LOANS.findIndex(l => l.id === editingLoanId || l.loanId === editingLoanId);
      if (idx !== -1) LOANS[idx] = loanResult;
      else LOANS.unshift(loanResult);
      editingLoanId = null;
    } else {
      loanResult = await postJson('loans', payload);
      LOANS.unshift(loanResult);
    }

    renderLoans();
    closeModal('modal-loan');
    resetLoanForm();
    alert(isEditingLoan ? '✅ Loan updated.' : '✅ Loan created and queued for disbursement.');
  } catch (error) {
    console.error('Failed to add loan:', error);
    alert('Failed to add loan. Please try again.');
  }
}

// ═══════════════════════════════════════ BRANCH CRUD ═══════════════════════════════════════
async function addBranch() {
  try {
    const id = document.getElementById('branch-id').value.trim();
    const name = document.getElementById('branch-name').value.trim();
    const address = document.getElementById('branch-address').value.trim();
    const city = document.getElementById('branch-city').value.trim();
    const phone = document.getElementById('branch-phone').value.trim();
    const email = document.getElementById('branch-email').value.trim();
    const manager = document.getElementById('branch-manager').value.trim();
    const status = document.getElementById('branch-status').value;

    if (!id || !name || !address) {
      alert('Please fill in all required fields.');
      return;
    }

    const payload = { id, name, address, city, phone, email, manager, status };
    const branch = await postJson('branches', payload);
    BRANCHES.push(branch);
    renderBranches();
    closeModal('modal-branch');
    alert('✅ Branch added successfully.');
  } catch (error) {
    console.error('Failed to add branch:', error);
    alert('Failed to add branch. Please try again.');
  }
}

function editBranch(id) {
  const branch = BRANCHES.find(b => b.id === id);
  if (!branch) return;
  document.getElementById('branch-id').value = branch.id;
  document.getElementById('branch-name').value = branch.name;
  document.getElementById('branch-address').value = branch.address;
  document.getElementById('branch-city').value = branch.city || '';
  document.getElementById('branch-phone').value = branch.phone || '';
  document.getElementById('branch-email').value = branch.email || '';
  document.getElementById('branch-manager').value = branch.manager || '';
  document.getElementById('branch-status').value = branch.status;
  openModal('modal-branch');
}

async function deleteBranch(id) {
  if (!confirm(`Delete branch "${id}"?`)) return;
  try {
    await deleteJson(`branches/${id}`);
    const idx = BRANCHES.findIndex(b => b.id === id);
    if (idx !== -1) BRANCHES.splice(idx, 1);
    renderBranches();
    alert('✅ Branch deleted.');
  } catch (error) {
    console.error('Failed to delete branch:', error);
    alert('Failed to delete branch.');
  }
}

// ═══════════════════════════════════════ CENTRE CRUD ═══════════════════════════════════════
async function addCentre() {
  try {
    const id = document.getElementById('centre-id').value.trim();
    const name = document.getElementById('centre-name').value.trim();
    const branchId = document.getElementById('centre-branch').value;
    const meetingDay = document.getElementById('centre-meeting-day').value;
    const address = document.getElementById('centre-address').value.trim();
    const leader = document.getElementById('centre-leader').value.trim();
    const status = document.getElementById('centre-status').value;

    if (!id || !name || !branchId) {
      alert('Please fill in all required fields.');
      return;
    }

    const payload = { id, name, branchId, meetingDay, address, leader, status };
    const centre = await postJson('centres', payload);
    CENTRES.push(centre);
    renderCentres();
    closeModal('modal-centre');
    alert('✅ Centre added successfully.');
  } catch (error) {
    console.error('Failed to add centre:', error);
    alert('Failed to add centre. Please try again.');
  }
}

function editCentre(id) {
  const centre = CENTRES.find(c => c.id === id);
  if (!centre) return;
  document.getElementById('centre-id').value = centre.id;
  document.getElementById('centre-name').value = centre.name;
  document.getElementById('centre-branch').value = centre.branchId;
  document.getElementById('centre-meeting-day').value = centre.meetingDay;
  document.getElementById('centre-address').value = centre.address || '';
  document.getElementById('centre-leader').value = centre.leader || '';
  document.getElementById('centre-status').value = centre.status;
  openModal('modal-centre');
}

async function deleteCentre(id) {
  if (!confirm(`Delete centre "${id}"?`)) return;
  try {
    await deleteJson(`centres/${id}`);
    const idx = CENTRES.findIndex(c => c.id === id);
    if (idx !== -1) CENTRES.splice(idx, 1);
    renderCentres();
    alert('✅ Centre deleted.');
  } catch (error) {
    console.error('Failed to delete centre:', error);
    alert('Failed to delete centre.');
  }
}

// ═══════════════════════════════════════ GROUP CRUD ═══════════════════════════════════════
async function addGroup() {
  try {
    const id = document.getElementById('group-id').value.trim();
    const name = document.getElementById('group-name').value.trim();
    const centreId = document.getElementById('group-centre').value;
    const leader = document.getElementById('group-leader').value.trim();
    const maxMembers = parseInt(document.getElementById('group-max-members').value) || null;
    const status = document.getElementById('group-status').value;

    if (!id || !name || !centreId) {
      alert('Please fill in all required fields.');
      return;
    }

    const payload = { id, name, centreId, leader, maxMembers, status };
    const group = await postJson('groups', payload);
    GROUPS.push(group);
    renderGroups();
    closeModal('modal-group');
    alert('✅ Group added successfully.');
  } catch (error) {
    console.error('Failed to add group:', error);
    alert('Failed to add group. Please try again.');
  }
}

function editGroup(id) {
  const group = GROUPS.find(g => g.id === id);
  if (!group) return;
  document.getElementById('group-id').value = group.id;
  document.getElementById('group-name').value = group.name;
  document.getElementById('group-centre').value = group.centreId;
  document.getElementById('group-leader').value = group.leader || '';
  document.getElementById('group-max-members').value = group.maxMembers || '';
  document.getElementById('group-status').value = group.status;
  openModal('modal-group');
}

async function deleteGroup(id) {
  if (!confirm(`Delete group "${id}"?`)) return;
  try {
    await deleteJson(`groups/${id}`);
    const idx = GROUPS.findIndex(g => g.id === id);
    if (idx !== -1) GROUPS.splice(idx, 1);
    renderGroups();
    alert('✅ Group deleted.');
  } catch (error) {
    console.error('Failed to delete group:', error);
    alert('Failed to delete group.');
  }
}

// ═══════════════════════════════════════ CURRENCY CRUD ═══════════════════════════════════════
async function addCurrency() {
  try {
    const code = document.getElementById('currency-code').value.trim().toUpperCase();
    const name = document.getElementById('currency-name').value.trim();
    const symbol = document.getElementById('currency-symbol').value.trim();
    const decimalPlaces = parseInt(document.getElementById('currency-decimals').value);
    const exchangeRate = parseFloat(document.getElementById('currency-rate').value);
    const status = document.getElementById('currency-status').value;

    if (!code || !name) {
      alert('Please fill in all required fields.');
      return;
    }

    const payload = { code, name, symbol, decimalPlaces, exchangeRate, status };
    const currency = await postJson('currencies', payload);
    CURRENCIES.push(currency);
    renderCurrencies();
    closeModal('modal-currency');
    alert('✅ Currency added successfully.');
  } catch (error) {
    console.error('Failed to add currency:', error);
    alert('Failed to add currency. Please try again.');
  }
}

function editCurrency(code) {
  const currency = CURRENCIES.find(c => c.code === code);
  if (!currency) return;
  document.getElementById('currency-code').value = currency.code;
  document.getElementById('currency-name').value = currency.name;
  document.getElementById('currency-symbol').value = currency.symbol || '';
  document.getElementById('currency-decimals').value = currency.decimalPlaces;
  document.getElementById('currency-rate').value = currency.exchangeRate;
  document.getElementById('currency-status').value = currency.status;
  openModal('modal-currency');
}

async function deleteCurrency(code) {
  if (!confirm(`Delete currency "${code}"?`)) return;
  try {
    await deleteJson(`currencies/${code}`);
    const idx = CURRENCIES.findIndex(c => c.code === code);
    if (idx !== -1) CURRENCIES.splice(idx, 1);
    renderCurrencies();
    alert('✅ Currency deleted.');
  } catch (error) {
    console.error('Failed to delete currency:', error);
    alert('Failed to delete currency.');
  }
}

// ═══════════════════════════════════════ TRANSACTION CRUD ═══════════════════════════════════════
async function addTransaction() {
  try {
    const id = document.getElementById('transaction-id').value.trim() || `TXN${Date.now()}`;
    const type = document.getElementById('transaction-type').value;
    const accountId = document.getElementById('transaction-account').value.trim();
    const amount = parseFloat(document.getElementById('transaction-amount').value);
    const currency = document.getElementById('transaction-currency').value;
    const date = document.getElementById('transaction-date').value;
    const description = document.getElementById('transaction-description').value.trim();
    const status = document.getElementById('transaction-status').value;

    if (!type || !accountId || !amount || !date) {
      alert('Please fill in all required fields.');
      return;
    }

    const payload = { id, type, accountId, amount, currency, date, description, status };
    const transaction = await postJson('transactions', payload);
    TRANSACTIONS.push(transaction);
    renderTransactions();
    closeModal('modal-transaction');
    alert('✅ Transaction added successfully.');
  } catch (error) {
    console.error('Failed to add transaction:', error);
    alert('Failed to add transaction. Please try again.');
  }
}

function viewTransaction(id) {
  const transaction = TRANSACTIONS.find(t => t.id === id);
  if (!transaction) return;
  // For now, just show an alert with transaction details
  alert(`Transaction ${transaction.id}\nType: ${transaction.type}\nAccount: ${transaction.accountId}\nAmount: ${fmt(transaction.amount)}\nDate: ${transaction.date}\nStatus: ${transaction.status}`);
}

// ═══════════════════════════════════════ CARD CRUD ═══════════════════════════════════════
async function addCard() {
  try {
    const id = document.getElementById('card-id').value.trim() || `CARD${Date.now()}`;
    const memberId = document.getElementById('card-member').value.trim();
    const cardNumber = document.getElementById('card-number').value.trim();
    const type = document.getElementById('card-type').value;
    const expiryMonth = document.getElementById('card-expiry-month').value;
    const expiryYear = document.getElementById('card-expiry-year').value;
    const cvv = document.getElementById('card-cvv').value.trim();
    const status = document.getElementById('card-status').value;

    if (!memberId || !cardNumber) {
      alert('Please fill in all required fields.');
      return;
    }

    const payload = { id, memberId, cardNumber, type, expiryMonth, expiryYear, cvv, status };
    const card = await postJson('cards', payload);
    CARDS.push(card);
    renderCards();
    closeModal('modal-card');
    alert('✅ Card issued successfully.');
  } catch (error) {
    console.error('Failed to add card:', error);
    alert('Failed to add card. Please try again.');
  }
}

function editCard(id) {
  const card = CARDS.find(c => c.id === id);
  if (!card) return;
  document.getElementById('card-id').value = card.id;
  document.getElementById('card-member').value = card.memberId;
  document.getElementById('card-number').value = card.cardNumber;
  document.getElementById('card-type').value = card.type;
  document.getElementById('card-expiry-month').value = card.expiryMonth;
  document.getElementById('card-expiry-year').value = card.expiryYear;
  document.getElementById('card-cvv').value = card.cvv || '';
  document.getElementById('card-status').value = card.status;
  openModal('modal-card');
}

async function deleteCard(id) {
  if (!confirm(`Delete card "${id}"?`)) return;
  try {
    await deleteJson(`cards/${id}`);
    const idx = CARDS.findIndex(c => c.id === id);
    if (idx !== -1) CARDS.splice(idx, 1);
    renderCards();
    alert('✅ Card deleted.');
  } catch (error) {
    console.error('Failed to delete card:', error);
    alert('Failed to delete card.');
  }
}

// ═══════════════════════════════════════ ADVANCED FEATURES ═══════════════════════════════════════
async function sendNotification() {
  try {
    const type = document.getElementById('notification-type').value;
    const recipient = document.getElementById('notification-recipient').value.trim();
    const title = document.getElementById('notification-title').value.trim();
    const message = document.getElementById('notification-message').value.trim();

    if (!recipient || !title || !message) {
      alert('Please fill in all required fields.');
      return;
    }

    const notification = await postJson('notifications', { type, title, message, recipient });
    NOTIFICATIONS.unshift(notification);
    renderNotifications();
    closeModal('modal-notification');
    alert('✅ Notification sent successfully.');
  } catch (error) {
    console.error('Failed to send notification:', error);
    alert('Failed to send notification. Please try again.');
  }
}

async function markAsRead(id) {
  try {
    await putJson(`notifications/${id}/read`, {});
    const notification = NOTIFICATIONS.find(n => n.id === id);
    if (notification) {
      notification.status = 'READ';
      renderNotifications();
    }
  } catch (error) {
    console.error('Failed to mark notification as read:', error);
  }
}

async function runProcess(id) {
  try {
    const result = await postJson(`background-processes/${id}/run`, {});
    alert(`✅ Process "${result.process.name}" started successfully.`);
    // Refresh processes after a short delay
    setTimeout(() => {
      fetchJson('background-processes').then(processes => {
        BACKGROUND_PROCESSES.length = 0;
        BACKGROUND_PROCESSES.push(...processes);
        renderProcesses();
      });
    }, 1000);
  } catch (error) {
    console.error('Failed to run process:', error);
    alert('Failed to run process. Please try again.');
  }
}

async function runInterestAccrual() {
  try {
    const result = await postJson('processes/accrue-interest', {});
    const resultDiv = document.getElementById('process-result');
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = `
      <div class="info-box" style="background: rgba(16,185,129,0.08); border-color: rgba(16,185,129,0.2);">
        <strong>✅ Interest Accrual Completed</strong><br>
        Total Interest Accrued: KSh ${fmt(result.totalInterestAccrued)}<br>
        Loans Processed: ${result.loansProcessed}<br>
        Transactions Created: ${result.transactionsCreated}
      </div>
    `;
    // Refresh data to show new transactions
    await refreshData();
  } catch (error) {
    console.error('Failed to run interest accrual:', error);
    const resultDiv = document.getElementById('process-result');
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = `
      <div class="warning-box">
        <strong>❌ Interest Accrual Failed</strong><br>
        ${error.message}
      </div>
    `;
  }
}

// ═══════════════════════════════════════ RENDERING FUNCTIONS ═══════════════════════════════════════
function renderNotifications() {
  const tbody = document.querySelector('#notifications-table tbody');
  tbody.innerHTML = '';

  NOTIFICATIONS.forEach(notification => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${notification.id}</td>
      <td><span class="badge badge-${notification.type.toLowerCase()}">${notification.type}</span></td>
      <td>${notification.title}</td>
      <td>${notification.recipient}</td>
      <td><span class="badge badge-${notification.status.toLowerCase()}">${notification.status}</span></td>
      <td>${new Date(notification.createdAt).toLocaleString()}</td>
      <td>
        ${notification.status === 'UNREAD' ? `<button class="btn btn-sm btn-primary" onclick="markAsRead('${notification.id}')">Mark Read</button>` : ''}
      </td>
    `;
    tbody.appendChild(row);
  });

  // Update notification stats
  const unreadCount = NOTIFICATIONS.filter(n => n.status === 'UNREAD').length;
  document.getElementById('notification-stats').innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${NOTIFICATIONS.length}</div>
      <div class="stat-label">Total Notifications</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${unreadCount}</div>
      <div class="stat-label">Unread</div>
    </div>
  `;
}

function renderProcesses() {
  const tbody = document.querySelector('#processes-table tbody');
  tbody.innerHTML = '';

  BACKGROUND_PROCESSES.forEach(process => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${process.id}</td>
      <td>${process.name}</td>
      <td>${process.description}</td>
      <td><span class="badge badge-${process.status.toLowerCase()}">${process.status}</span></td>
      <td>${process.lastRun ? new Date(process.lastRun).toLocaleString() : 'Never'}</td>
      <td>${process.nextRun ? new Date(process.nextRun).toLocaleString() : 'Not scheduled'}</td>
      <td>
        <button class="btn btn-sm btn-primary" onclick="runProcess('${process.id}')" ${process.status === 'RUNNING' ? 'disabled' : ''}>
          ${process.status === 'RUNNING' ? 'Running...' : 'Run Now'}
        </button>
      </td>
    `;
    tbody.appendChild(row);
  });
}

function renderAuditLogs() {
  const tbody = document.querySelector('#audit-logs-table tbody');
  tbody.innerHTML = '';

  AUDIT_LOGS.forEach(log => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${log.id}</td>
      <td>${log.user}</td>
      <td><span class="badge badge-${log.action.toLowerCase()}">${log.action}</span></td>
      <td>${log.resource}</td>
      <td>${log.resourceId}</td>
      <td>${new Date(log.timestamp).toLocaleString()}</td>
      <td>${log.details || ''}</td>
    `;
    tbody.appendChild(row);
  });

  // Update audit stats
  const today = new Date().toDateString();
  const todayLogs = AUDIT_LOGS.filter(log => new Date(log.timestamp).toDateString() === today).length;
  document.getElementById('audit-stats').innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${AUDIT_LOGS.length}</div>
      <div class="stat-label">Total Logs</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${todayLogs}</div>
      <div class="stat-label">Today</div>
    </div>
  `;
}

function renderAdvancedReports() {
  // Portfolio Analytics
  const portfolioStats = document.getElementById('portfolio-stats');
  const totalLoans = LOANS.reduce((sum, loan) => sum + loan.amount, 0);
  const totalSavings = SAVINGS.reduce((sum, saving) => sum + saving.balance, 0);
  const totalDeposits = DEPOSITS.reduce((sum, deposit) => sum + deposit.amount, 0);

  portfolioStats.innerHTML = `
    <div class="stat-card">
      <div class="stat-value">KSh ${fmt(totalLoans)}</div>
      <div class="stat-label">Total Loans Portfolio</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">KSh ${fmt(totalSavings)}</div>
      <div class="stat-label">Total Savings</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">KSh ${fmt(totalDeposits)}</div>
      <div class="stat-label">Total Deposits</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${CLIENTS.length}</div>
      <div class="stat-label">Active Clients</div>
    </div>
  `;

  // Engagement Analytics
  const engagementStats = document.getElementById('engagement-stats');
  const recentTransactions = TRANSACTIONS.filter(t => {
    const transactionDate = new Date(t.transactionDate);
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    return transactionDate >= weekAgo;
  }).length;

  const activeClients = new Set(TRANSACTIONS.map(t => t.clientId)).size;
  const avgTransactionValue = TRANSACTIONS.length > 0 ?
    TRANSACTIONS.reduce((sum, t) => sum + t.amount, 0) / TRANSACTIONS.length : 0;

  engagementStats.innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${recentTransactions}</div>
      <div class="stat-label">Transactions (7 days)</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${activeClients}</div>
      <div class="stat-label">Active Clients (7 days)</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">KSh ${fmt(avgTransactionValue)}</div>
      <div class="stat-label">Avg Transaction Value</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${TRANSACTIONS.length}</div>
      <div class="stat-label">Total Transactions</div>
    </div>
  `;

  // Risk Analytics
  const riskStats = document.getElementById('risk-stats');
  const overdueLoans = LOANS.filter(loan => loan.status === 'OVERDUE').length;
  const highRiskLoans = LOANS.filter(loan => loan.amount > 100000).length; // Simple risk criteria
  const defaultRate = LOANS.length > 0 ? (overdueLoans / LOANS.length * 100).toFixed(1) : 0;

  riskStats.innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${overdueLoans}</div>
      <div class="stat-label">Overdue Loans</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${highRiskLoans}</div>
      <div class="stat-label">High-Risk Loans</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${defaultRate}%</div>
      <div class="stat-label">Default Rate</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${LOANS.filter(l => l.status === 'ACTIVE').length}</div>
      <div class="stat-label">Active Loans</div>
    </div>
  `;
}

// ═══════════════════════════════════════ CUSTOM FIELDS ═══════════════════════════════════════
let customFieldFilterModule = 'All';
let customFieldFilterSet = 'All';

function getFieldSetOptions(module) {
  if (module === 'All') module = Object.keys(CUSTOM_FIELD_SET_OPTIONS)[0] || 'Clients';
  const dynamicSets = CUSTOM_FIELD_SETS.filter(set => set.module === module).map(set => set.name);
  if (dynamicSets.length) return ['All', ...dynamicSets];
  return CUSTOM_FIELD_SET_OPTIONS[module] ? CUSTOM_FIELD_SET_OPTIONS[module] : ['All', 'General'];
}

function renderCustomFieldFilters() {
  const moduleSelect = document.getElementById('custom-field-module-filter');
  const filterSelect = document.getElementById('custom-field-set-filter');
  if (!moduleSelect || !filterSelect) return;

  moduleSelect.innerHTML = (CUSTOM_FIELD_MODULES || ['All']).map(m => `
    <option value="${m}">${m}</option>`).join('');
  moduleSelect.value = customFieldFilterModule;
  populateCustomFieldSets(customFieldFilterModule, customFieldFilterSet);
}

function populateCustomFieldSets(module, selected = 'All') {
  const setSelect = document.getElementById('cf-fieldset');
  const filterSelect = document.getElementById('custom-field-set-filter');
  const options = getFieldSetOptions(module);

  if (setSelect) {
    setSelect.innerHTML = options.map(set => `<option value="${set}">${set}</option>`).join('');
    setSelect.value = options.includes(selected) ? selected : options[0];
  }

  if (filterSelect) {
    const filterOptions = options.includes('All') ? options : ['All', ...options.filter(set => set !== 'All')];
    filterSelect.innerHTML = filterOptions.map(set => `<option value="${set}">${set}</option>`).join('');
    filterSelect.value = filterOptions.includes(selected) ? selected : 'All';
  }
}

function setCustomFieldModuleFilter(module = 'All') {
  customFieldFilterModule = module;
  customFieldFilterSet = 'All';
  renderCustomFieldFilters();
  renderCustomFields();
}

function setCustomFieldSetFilter(fieldSet = 'All') {
  customFieldFilterSet = fieldSet;
  renderCustomFields();
}

function setCustomFieldSetPageFilter(module = 'All') {
  const moduleSelect = document.getElementById('custom-field-set-module-filter');
  if (moduleSelect) moduleSelect.value = module;
  renderCustomFieldSets();
}

function renderCustomFieldSets() {
  const tbody = document.getElementById('custom-field-sets-tbody');
  const filter = document.getElementById('custom-field-set-module-filter')?.value || 'All';
  if (!tbody) return;

  const filtered = CUSTOM_FIELD_SETS.filter(set => filter === 'All' || set.module === filter);
  tbody.innerHTML = filtered.length > 0 ? filtered.map(set => `
    <tr>
      <td>${set.name}</td>
      <td>${set.module}</td>
      <td>${set.type}</td>
      <td>${set.notes || ''}</td>
      <td>
        <button class="btn btn-sm btn-outline" onclick="editCustomFieldSet('${set.id}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteCustomFieldSet('${set.id}')">Delete</button>
      </td>
    </tr>`).join('') : `
    <tr><td colspan="5" style="text-align:center;color:var(--text3);padding:16px">No custom field sets found.</td></tr>`;
}

function toggleCustomFieldOptions(type) {
  const panel = document.getElementById('cf-options-panel');
  if (!panel) return;
  if (type === 'Dropdown') {
    panel.style.display = 'block';
  } else {
    panel.style.display = 'none';
    currentCustomFieldOptions = [];
    renderCustomFieldOptions();
  }
}

function renderCustomFieldOptions() {
  const list = document.getElementById('cf-options-list');
  if (!list) return;
  list.innerHTML = currentCustomFieldOptions.length > 0 ? currentCustomFieldOptions.map((opt, i) => `
    <div class="custom-field-option-row" style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:8px;margin-bottom:8px;">
      <input class="form-control" placeholder="Option label" value="${opt.label}" onchange="updateCustomFieldOption(${i}, 'label', this.value)" />
      <input class="form-control" placeholder="Option ID" value="${opt.id}" onchange="updateCustomFieldOption(${i}, 'id', this.value)" />
      <input class="form-control" placeholder="Score" value="${opt.score || ''}" onchange="updateCustomFieldOption(${i}, 'score', this.value)" />
      <button class="btn btn-sm btn-danger" style="padding:8px 12px;" onclick="removeCustomFieldOption(${i})">Remove</button>
    </div>`).join('') : '<div style="color:var(--text3);font-size:13px">No selection options added yet.</div>';
}

function addCustomFieldOption() {
  currentCustomFieldOptions.push({ label:'', id:`opt${Date.now()}`, score:'' });
  renderCustomFieldOptions();
}

function updateCustomFieldOption(index, key, value) {
  if (!currentCustomFieldOptions[index]) return;
  currentCustomFieldOptions[index][key] = value;
}

function removeCustomFieldOption(index) {
  currentCustomFieldOptions.splice(index, 1);
  renderCustomFieldOptions();
}

function initCustomFieldSetModal() {
  const moduleSelect = document.getElementById('cfs-module');
  if (moduleSelect) {
    moduleSelect.innerHTML = (CUSTOM_FIELD_MODULES || ['Clients']).filter(m => m !== 'All').map(m => `<option value="${m}">${m}</option>`).join('');
    moduleSelect.value = customFieldFilterModule === 'All' ? 'Clients' : customFieldFilterModule;
  }
  document.getElementById('cfs-name').value = '';
  document.getElementById('cfs-type').value = 'Standard';
  document.getElementById('cfs-notes').value = '';
  editingCustomFieldSetId = null;
  const submit = document.getElementById('cfs-submit-button');
  if (submit) {
    submit.textContent = 'Add Field Set';
    submit.onclick = addCustomFieldSet;
  }
}

async function addCustomFieldSet() {
  const module = document.getElementById('cfs-module').value;
  const name = document.getElementById('cfs-name').value.trim();
  const type = document.getElementById('cfs-type').value;
  const notes = document.getElementById('cfs-notes').value.trim();

  if (!module || !name) {
    alert('Please fill in all required fields.');
    return;
  }

  try {
    const response = await fetch('/api/custom-field-sets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ module, name, type, notes })
    });

    if (!response.ok) {
      throw new Error('Could not save custom field set.');
    }

    const newSet = await response.json();
    CUSTOM_FIELD_SETS.push(newSet);
    renderCustomFieldSets();
    renderCustomFieldFilters();
    closeModal('modal-custom-field-set');
    initCustomFieldSetModal();
  } catch (error) {
    console.error('Error saving custom field set:', error);
    alert('Failed to save custom field set.');
  }
}

function editCustomFieldSet(id) {
  const fieldSet = CUSTOM_FIELD_SETS.find(set => set.id === id);
  if (!fieldSet) return;

  initCustomFieldSetModal();
  document.getElementById('cfs-module').value = fieldSet.module || 'Clients';
  document.getElementById('cfs-name').value = fieldSet.name || '';
  document.getElementById('cfs-type').value = fieldSet.type || 'Standard';
  document.getElementById('cfs-notes').value = fieldSet.notes || '';
  editingCustomFieldSetId = id;
  const submit = document.getElementById('cfs-submit-button');
  if (submit) {
    submit.textContent = 'Update Field Set';
    submit.onclick = () => updateCustomFieldSet(id);
  }
  openModal('modal-custom-field-set');
}

async function updateCustomFieldSet(id) {
  const module = document.getElementById('cfs-module').value;
  const name = document.getElementById('cfs-name').value.trim();
  const type = document.getElementById('cfs-type').value;
  const notes = document.getElementById('cfs-notes').value.trim();

  if (!module || !name) {
    alert('Please fill in all required fields.');
    return;
  }

  try {
    const response = await fetch(`/api/custom-field-sets/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ module, name, type, notes })
    });

    if (!response.ok) {
      throw new Error('Could not update custom field set.');
    }

    const updatedSet = await response.json();
    const index = CUSTOM_FIELD_SETS.findIndex(set => set.id === id);
    if (index !== -1) {
      CUSTOM_FIELD_SETS[index] = updatedSet;
    }
    renderCustomFieldSets();
    renderCustomFieldFilters();
    closeModal('modal-custom-field-set');
    initCustomFieldSetModal();
  } catch (error) {
    console.error('Error updating custom field set:', error);
    alert('Failed to update custom field set.');
  }
}

async function deleteCustomFieldSet(id) {
  if (!confirm('Delete this custom field set? This action cannot be undone.')) return;

  try {
    const response = await fetch(`/api/custom-field-sets/${id}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      throw new Error('Could not delete custom field set.');
    }

    const idx = CUSTOM_FIELD_SETS.findIndex(set => set.id === id);
    if (idx !== -1) {
      CUSTOM_FIELD_SETS.splice(idx, 1);
    }
    renderCustomFieldSets();
    renderCustomFieldFilters();
  } catch (error) {
    console.error('Error deleting custom field set:', error);
    alert('Failed to delete custom field set.');
  }
}

function renderCustomFieldSetModuleFilter() {
  const moduleSelect = document.getElementById('custom-field-set-module-filter');
  if (!moduleSelect) return;
  moduleSelect.innerHTML = (CUSTOM_FIELD_MODULES || ['All']).map(m => `<option value="${m}">${m}</option>`).join('');
  moduleSelect.value = 'All';
}

function renderCustomFields() {
  const tbody = document.getElementById('custom-fields-tbody');
  if (!tbody) return;

  const filtered = CUSTOM_FIELDS.filter(field =>
    (customFieldFilterModule === 'All' || field.module === customFieldFilterModule) &&
    (customFieldFilterSet === 'All' || field.fieldSet === customFieldFilterSet)
  );

  tbody.innerHTML = filtered.length > 0 ? filtered.map(field => `
    <tr>
      <td>${field.label}</td>
      <td><span class="badge badge-purple">${field.module}</span></td>
      <td>${field.fieldSet}</td>
      <td><span class="badge badge-secondary">${field.type}</span></td>
      <td>${field.usage || 'Available'}</td>
      <td><span class="badge ${field.usage === 'Required' ? 'badge-red' : 'badge-amber'}">${field.required || (field.usage === 'Required' ? 'Required' : 'Optional')}</span></td>
      <td>${field.section}</td>
      <td>
        <button class="btn btn-sm btn-outline" onclick="editCustomField('${field.id}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteCustomField('${field.id}')">Delete</button>
      </td>
    </tr>`).join('') : `
    <tr><td colspan="8" style="text-align:center;color:var(--text3);padding:16px">No custom fields defined for this selection.</td></tr>`;
}

async function addCustomField() {
  const module = document.getElementById('cf-module').value;
  const fieldSet = document.getElementById('cf-fieldset').value;
  const label = document.getElementById('cf-label').value.trim();
  const type = document.getElementById('cf-type').value;
  const section = document.getElementById('cf-section').value;
  const usage = document.getElementById('cf-usage').value;
  const hint = document.getElementById('cf-hint').value.trim();
  const options = type === 'Dropdown' ? currentCustomFieldOptions : [];

  if (!module || !label || !type) {
    alert('Please fill in all required fields.');
    return;
  }

  try {
    const response = await fetch('/api/custom-fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ module, fieldSet, label, type, section, usage, required: usage === 'Required' ? 'Required' : 'Optional', hint, options })
    });

    if (response.ok) {
      const newField = await response.json();
      CUSTOM_FIELDS.push(newField);
      renderCustomFields();
      renderKYCFields();
      renderCustomFieldFilters();
      closeModal('modal-custom-field');
      initCustomFieldModal();
    } else {
      alert('Failed to add custom field.');
    }
  } catch (error) {
    console.error('Error adding custom field:', error);
    alert('Error adding custom field.');
  }
}

function editCustomField(id) {
  const field = CUSTOM_FIELDS.find(f => f.id === id);
  if (!field) return;

  document.getElementById('cf-module').value = field.module || 'Clients';
  populateCustomFieldSets(field.module || 'Clients', field.fieldSet || 'General');
  document.getElementById('cf-label').value = field.label;
  document.getElementById('cf-type').value = field.type;
  document.getElementById('cf-section').value = field.section;
  document.getElementById('cf-usage').value = field.usage || 'Available';
  document.getElementById('cf-hint').value = field.hint || '';
  currentCustomFieldOptions = field.type === 'Dropdown' ? (field.options || []) : [];
  toggleCustomFieldOptions(field.type);
  if (field.type === 'Dropdown') {
    renderCustomFieldOptions();
  }

  const modal = document.getElementById('modal-custom-field');
  const addBtn = modal.querySelector('.btn-primary');
  addBtn.textContent = 'Update Field';
  addBtn.onclick = () => updateCustomField(id);

  openModal('modal-custom-field');
}

async function updateCustomField(id) {
  const module = document.getElementById('cf-module').value;
  const fieldSet = document.getElementById('cf-fieldset').value;
  const label = document.getElementById('cf-label').value.trim();
  const type = document.getElementById('cf-type').value;
  const section = document.getElementById('cf-section').value;
  const usage = document.getElementById('cf-usage').value;
  const hint = document.getElementById('cf-hint').value.trim();
  const options = type === 'Dropdown' ? currentCustomFieldOptions : [];

  if (!module || !label || !type) {
    alert('Please fill in all required fields.');
    return;
  }

  try {
    const response = await fetch(`/api/custom-fields/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ module, fieldSet, label, type, section, usage, required: usage === 'Required' ? 'Required' : 'Optional', hint, options })
    });

    if (response.ok) {
      const updatedField = await response.json();
      const index = CUSTOM_FIELDS.findIndex(f => f.id === id);
      if (index !== -1) {
        CUSTOM_FIELDS[index] = updatedField;
      }
      renderCustomFields();
      renderKYCFields();
      renderCustomFieldFilters();
      closeModal('modal-custom-field');
      initCustomFieldModal();
    } else {
      alert('Failed to update custom field.');
    }
  } catch (error) {
    console.error('Error updating custom field:', error);
    alert('Error updating custom field.');
  }
}

async function deleteCustomField(id) {
  if (!confirm('Are you sure you want to delete this custom field?')) {
    return;
  }

  try {
    const response = await fetch(`/api/custom-fields/${id}`, {
      method: 'DELETE'
    });

    if (response.ok) {
      const index = CUSTOM_FIELDS.findIndex(f => f.id === id);
      if (index !== -1) {
        CUSTOM_FIELDS.splice(index, 1);
      }
      renderCustomFields();
      renderKYCFields();
    } else {
      alert('Failed to delete custom field.');
    }
  } catch (error) {
    console.error('Error deleting custom field:', error);
    alert('Error deleting custom field.');
  }
}

function openCustomFieldModal() {
  try {
    initCustomFieldModal();
    openModal('modal-custom-field');
  } catch (error) {
    console.error('Failed to open custom field modal:', error);
    alert('Unable to open custom field modal. Please refresh the page and try again.');
  }
}

function initCustomFieldModal() {
  const moduleSelect = document.getElementById('cf-module');
  if (moduleSelect) {
    moduleSelect.innerHTML = (CUSTOM_FIELD_MODULES || ['Clients']).filter(m => m !== 'All').map(m => `<option value="${m}">${m}</option>`).join('');
    moduleSelect.value = customFieldFilterModule === 'All' ? 'Clients' : customFieldFilterModule;
  }

  const defaultModule = moduleSelect?.value || 'Clients';
  populateCustomFieldSets(defaultModule, 'General');
  document.getElementById('cf-label').value = '';
  document.getElementById('cf-type').value = 'Text';
  document.getElementById('cf-section').value = 'Personal';
  document.getElementById('cf-usage').value = 'Available';
  document.getElementById('cf-hint').value = '';
  currentCustomFieldOptions = [];
  toggleCustomFieldOptions('Text');

  const modal = document.getElementById('modal-custom-field');
  const addBtn = modal.querySelector('.btn-primary');
  addBtn.textContent = 'Add Field';
  addBtn.onclick = addCustomField;
}

// ═══════════════════════════════════════ MODAL INITIALIZATION ═══════════════════════════════════════
function initBranchModal() {
  document.getElementById('branch-id').value = '';
  document.getElementById('branch-name').value = '';
  document.getElementById('branch-address').value = '';
  document.getElementById('branch-city').value = '';
  document.getElementById('branch-phone').value = '';
  document.getElementById('branch-email').value = '';
  document.getElementById('branch-manager').value = '';
  document.getElementById('branch-status').value = 'ACTIVE';
}

function initCentreModal() {
  document.getElementById('centre-id').value = '';
  document.getElementById('centre-name').value = '';
  document.getElementById('centre-branch').innerHTML = '<option value="">Select Branch...</option>' +
    BRANCHES.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
  document.getElementById('centre-meeting-day').value = 'WEDNESDAY';
  document.getElementById('centre-address').value = '';
  document.getElementById('centre-leader').value = '';
  document.getElementById('centre-status').value = 'ACTIVE';
}

function initGroupModal() {
  document.getElementById('group-id').value = '';
  document.getElementById('group-name').value = '';
  document.getElementById('group-centre').innerHTML = '<option value="">Select Centre...</option>' +
    CENTRES.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  document.getElementById('group-leader').value = '';
  document.getElementById('group-max-members').value = '';
  document.getElementById('group-status').value = 'ACTIVE';
}

function initCurrencyModal() {
  document.getElementById('currency-code').value = '';
  document.getElementById('currency-name').value = '';
  document.getElementById('currency-symbol').value = '';
  document.getElementById('currency-decimals').value = '2';
  document.getElementById('currency-rate').value = '1.0';
  document.getElementById('currency-status').value = 'ACTIVE';
}

function initTransactionModal() {
  document.getElementById('transaction-id').value = `TXN${Date.now()}`;
  document.getElementById('transaction-type').value = 'DEPOSIT';
  document.getElementById('transaction-account').value = '';
  document.getElementById('transaction-amount').value = '';
  document.getElementById('transaction-currency').value = 'KES';
  document.getElementById('transaction-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('transaction-description').value = '';
  document.getElementById('transaction-status').value = 'COMPLETED';
}

function initCardModal() {
  document.getElementById('card-id').value = `CARD${Date.now()}`;
  document.getElementById('card-member').value = '';
  document.getElementById('card-number').value = '';
  document.getElementById('card-type').value = 'DEBIT';
  document.getElementById('card-expiry-month').value = '12';
  document.getElementById('card-expiry-year').value = '2028';
  document.getElementById('card-cvv').value = '';
  document.getElementById('card-status').value = 'ACTIVE';
}
