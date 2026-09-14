// Global state
let currentMember = null;
let currentAccounts = [];
let currentTransactionPage = 0;
let currentTransactionLimit = 20;

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
  await initializeApp();
});

async function initializeApp() {
  const token = localStorage.getItem('accessToken');

  if (token) {
    try {
      const user = await api.getCurrentUser();
      currentMember = user.member;
      showApp();
      loadDashboard();
    } catch (error) {
      logout();
    }
  } else {
    showLoginScreen();
  }

  attachEventListeners();
}

function showLoginScreen() {
  document.getElementById('login-screen').classList.add('active');
  document.getElementById('app-container').style.display = 'none';
}

function showApp() {
  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('register-screen').classList.remove('active');
  document.getElementById('app-container').style.display = 'flex';
}

// Event Listeners
function attachEventListeners() {
  // Auth
  document.getElementById('show-register').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('register-screen').classList.add('active');
  });

  document.getElementById('show-login').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('register-screen').classList.remove('active');
    document.getElementById('login-screen').classList.add('active');
  });

  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('register-form').addEventListener('submit', handleRegister);

  // Navigation
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const view = e.currentTarget.dataset.view;
      showView(view);

      document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
      e.currentTarget.classList.add('active');
    });
  });

  // Logout
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('logout-settings-btn').addEventListener('click', logout);

  // Transfer buttons
  document.getElementById('own-account-transfer').addEventListener('click', () => {
    document.getElementById('own-transfer-form').style.display = 'block';
    document.getElementById('internal-transfer-form').style.display = 'none';
    loadAccountSelectsForOwnTransfer();
  });

  document.getElementById('internal-transfer').addEventListener('click', () => {
    document.getElementById('internal-transfer-form').style.display = 'block';
    document.getElementById('own-transfer-form').style.display = 'none';
  });

  document.getElementById('lookup-recipient').addEventListener('click', handleLookupRecipient);
  document.getElementById('own-transfer-submit').addEventListener('submit', handleOwnTransfer);
  document.getElementById('internal-transfer-submit').addEventListener('submit', handleInternalTransfer);

  // Beneficiaries
  document.getElementById('add-beneficiary-btn').addEventListener('click', openAddBeneficiaryModal);
  document.getElementById('close-modal').addEventListener('click', closeAddBeneficiaryModal);
  document.getElementById('add-beneficiary-form').addEventListener('submit', handleAddBeneficiary);

  // Pagination
  document.getElementById('prev-page').addEventListener('click', previousPage);
  document.getElementById('next-page').addEventListener('click', nextPage);

  // Transaction filters
  document.getElementById('transaction-search').addEventListener('input', filterTransactions);
  document.getElementById('transaction-type-filter').addEventListener('change', filterTransactions);
  document.getElementById('transaction-status-filter').addEventListener('change', filterTransactions);
}

// Auth Functions
async function handleLogin(e) {
  e.preventDefault();

  const phone = document.getElementById('login-phone').value;
  const pin = document.getElementById('login-pin').value;
  const errorEl = document.getElementById('login-error');

  try {
    errorEl.style.display = 'none';
    const response = await api.login(phone, pin);
    api.setToken(response.accessToken);
    currentMember = response.member;
    showApp();
    loadDashboard();
    e.target.reset();
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.style.display = 'block';
  }
}

async function handleRegister(e) {
  e.preventDefault();

  const data = {
    firstName: document.getElementById('reg-first-name').value,
    lastName: document.getElementById('reg-last-name').value,
    dateOfBirth: document.getElementById('reg-dob').value,
    idNumber: document.getElementById('reg-id').value,
    mobilePhone: document.getElementById('reg-phone').value,
    email: document.getElementById('reg-email').value,
    pin: document.getElementById('reg-pin').value,
  };

  const errorEl = document.getElementById('register-error');

  try {
    errorEl.style.display = 'none';
    const response = await api.register(data);
    api.showToast('Account created successfully! Please login.', 'success');
    document.getElementById('register-form').reset();
    document.getElementById('register-screen').classList.remove('active');
    document.getElementById('login-screen').classList.add('active');
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.style.display = 'block';
  }
}

async function logout() {
  try {
    await api.logout();
  } catch (error) {
    console.error('Logout error:', error);
  }

  api.setToken(null);
  currentMember = null;
  currentAccounts = [];
  showLoginScreen();
}

// Navigation
function showView(viewName) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById(`view-${viewName}`).classList.add('active');

  switch (viewName) {
    case 'dashboard':
      loadDashboard();
      break;
    case 'accounts':
      loadAccounts();
      break;
    case 'transactions':
      loadTransactions();
      break;
    case 'beneficiaries':
      loadBeneficiaries();
      break;
    case 'settings':
      loadSettings();
      break;
  }
}

// Dashboard
async function loadDashboard() {
  try {
    const [accounts, stats] = await Promise.all([
      api.getAccounts(),
      api.getTransactionStats(),
    ]);

    currentAccounts = accounts.accounts;

    // Update member name
    document.getElementById('member-name').textContent = `Welcome, ${currentMember.firstName} ${currentMember.lastName}`;

    // Update stats
    document.getElementById('total-balance').textContent = `KES ${currentAccounts.reduce((sum, acc) => sum + parseFloat(acc.balance || 0), 0).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
    document.getElementById('total-deposits').textContent = `KES ${parseFloat(stats.stats.totalDeposits || 0).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
    document.getElementById('total-withdrawals').textContent = `KES ${parseFloat(stats.stats.totalWithdrawals || 0).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
    document.getElementById('total-transfers').textContent = `KES ${parseFloat(stats.stats.totalTransfers || 0).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;

    // Quick access accounts
    const quickAccountsEl = document.getElementById('quick-accounts');
    quickAccountsEl.innerHTML = currentAccounts.map((account) => `
      <div class="account-card" data-account-id="${account.id}" onclick="viewAccountTransactions('${account.id}')">
        <div class="account-type">${account.accountType}</div>
        <div class="account-number">${account.accountNumber}</div>
        <div class="account-balance">
          <div class="balance-label">Balance</div>
          <div class="balance-value">KES ${parseFloat(account.balance).toLocaleString('en-KE', { minimumFractionDigits: 2 })}</div>
        </div>
        <div class="account-state">${account.accountState}</div>
      </div>
    `).join('');

    // Recent transactions
    if (currentAccounts.length > 0) {
      const statement = await api.getMiniStatement(currentAccounts[0].id);
      renderRecentTransactions(statement.transactions || []);
    }
  } catch (error) {
    api.showToast(error.message || 'Failed to load dashboard', 'error');
  }
}

function renderRecentTransactions(transactions) {
  const tbody = document.getElementById('dashboard-transactions');
  tbody.innerHTML = transactions.slice(0, 5).map((t) => `
    <tr>
      <td>${new Date(t.createdAt).toLocaleDateString('en-KE')}</td>
      <td>${t.transactionType}</td>
      <td>${t.description}</td>
      <td>KES ${parseFloat(t.amount).toLocaleString('en-KE', { minimumFractionDigits: 2 })}</td>
      <td><span class="status-badge ${t.status.toLowerCase()}">${t.status}</span></td>
    </tr>
  `).join('');

  if (transactions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-secondary);">No transactions yet</td></tr>';
  }
}

// Accounts
async function loadAccounts() {
  try {
    const accounts = await api.getAccounts();
    currentAccounts = accounts.accounts;

    const container = document.getElementById('all-accounts');
    container.innerHTML = currentAccounts.map((account) => `
      <div class="account-card" onclick="viewAccountTransactions('${account.id}')">
        <div class="account-type">${account.accountType}</div>
        <div class="account-number">${account.accountNumber}</div>
        <div class="account-balance">
          <div class="balance-label">Balance</div>
          <div class="balance-value">KES ${parseFloat(account.balance).toLocaleString('en-KE', { minimumFractionDigits: 2 })}</div>
        </div>
        <div class="account-state">${account.accountState}</div>
      </div>
    `).join('');
  } catch (error) {
    api.showToast(error.message || 'Failed to load accounts', 'error');
  }
}

function viewAccountTransactions(accountId) {
  showView('transactions');
  currentTransactionPage = 0;
  loadTransactions(accountId);
}

// Transactions
async function loadTransactions(accountId = null) {
  try {
    if (!accountId && currentAccounts.length > 0) {
      accountId = currentAccounts[0].id;
    }

    if (!accountId) {
      api.showToast('No account selected', 'error');
      return;
    }

    const response = await api.getTransactionHistory(accountId, {
      limit: currentTransactionLimit,
      offset: currentTransactionPage * currentTransactionLimit,
    });

    const tbody = document.getElementById('transactions-list');
    tbody.innerHTML = response.transactions.map((t) => `
      <tr>
        <td>${new Date(t.createdAt).toLocaleDateString('en-KE')}</td>
        <td>${t.transactionType}</td>
        <td>${t.description}</td>
        <td>KES ${parseFloat(t.amount).toLocaleString('en-KE', { minimumFractionDigits: 2 })}</td>
        <td>${t.referenceNumber}</td>
        <td><span class="status-badge ${t.status.toLowerCase()}">${t.status}</span></td>
      </tr>
    `).join('');

    if (response.transactions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary);">No transactions found</td></tr>';
    }

    // Update pagination
    document.getElementById('page-info').textContent = `Page ${currentTransactionPage + 1}`;
    document.getElementById('prev-page').disabled = currentTransactionPage === 0;
    document.getElementById('next-page').disabled = !response.pagination.hasMore;
  } catch (error) {
    api.showToast(error.message || 'Failed to load transactions', 'error');
  }
}

function filterTransactions() {
  // Client-side filtering of loaded data (simplified)
  loadTransactions();
}

function previousPage() {
  if (currentTransactionPage > 0) {
    currentTransactionPage--;
    loadTransactions();
  }
}

function nextPage() {
  currentTransactionPage++;
  loadTransactions();
}

// Transfer
async function loadAccountSelectsForOwnTransfer() {
  const fromSelect = document.getElementById('own-from-account');
  const toSelect = document.getElementById('own-to-account');

  fromSelect.innerHTML = '<option value="">Select account</option>';
  toSelect.innerHTML = '<option value="">Select account</option>';

  currentAccounts.forEach((account) => {
    const option = `<option value="${account.id}">${account.accountType} - ${account.accountNumber}</option>`;
    fromSelect.innerHTML += option;
    toSelect.innerHTML += option;
  });
}

async function handleLookupRecipient() {
  const phone = document.getElementById('internal-phone').value;

  if (!phone) {
    api.showToast('Please enter phone number', 'error');
    return;
  }

  try {
    const response = await api.lookupBeneficiary(phone);
    document.getElementById('recipient-name').textContent = response.beneficiary.name;
    document.getElementById('recipient-account').textContent = response.beneficiary.accountNumber;
    document.getElementById('recipient-info').style.display = 'block';
  } catch (error) {
    api.showToast(error.message || 'Beneficiary not found', 'error');
    document.getElementById('recipient-info').style.display = 'none';
  }
}

async function handleOwnTransfer(e) {
  e.preventDefault();

  const fromAccountId = document.getElementById('own-from-account').value;
  const toAccountId = document.getElementById('own-to-account').value;
  const amount = document.getElementById('own-amount').value;
  const description = document.getElementById('own-description').value;

  if (fromAccountId === toAccountId) {
    api.showToast('Cannot transfer to the same account', 'error');
    return;
  }

  try {
    await api.transferOwnAccounts(fromAccountId, toAccountId, amount, description);
    api.showToast('Transfer completed successfully!', 'success');
    resetTransferForm();
    loadDashboard();
  } catch (error) {
    api.showToast(error.message || 'Transfer failed', 'error');
  }
}

async function handleInternalTransfer(e) {
  e.preventDefault();

  const phone = document.getElementById('internal-phone').value;
  const amount = document.getElementById('internal-amount').value;
  const description = document.getElementById('internal-description').value;

  try {
    await api.transferInternal(phone, amount, description);
    api.showToast('Transfer completed successfully!', 'success');
    resetTransferForm();
    loadDashboard();
  } catch (error) {
    api.showToast(error.message || 'Transfer failed', 'error');
  }
}

function resetTransferForm() {
  document.getElementById('own-transfer-form').style.display = 'none';
  document.getElementById('internal-transfer-form').style.display = 'none';
  document.getElementById('own-transfer-submit').reset();
  document.getElementById('internal-transfer-submit').reset();
  document.getElementById('recipient-info').style.display = 'none';
}

// Beneficiaries
async function loadBeneficiaries() {
  try {
    const response = await api.getBeneficiaries();
    const container = document.getElementById('beneficiaries-list');

    if (response.beneficiaries.length === 0) {
      container.innerHTML = '<p style="grid-column: 1/-1; color: var(--text-secondary); text-align: center;">No beneficiaries yet</p>';
      return;
    }

    container.innerHTML = response.beneficiaries.map((ben) => `
      <div class="beneficiary-card">
        <div class="beneficiary-name">${ben.name}</div>
        <div class="beneficiary-info">
          ${ben.mobilePhone ? `<div>📱 ${ben.mobilePhone}</div>` : ''}
          ${ben.accountNumber ? `<div>💳 ${ben.accountNumber}</div>` : ''}
          <div>${ben.relationship}</div>
        </div>
        <div>
          <span class="beneficiary-badge">${ben.isVerified ? '✓ Verified' : '⏳ Pending'}</span>
        </div>
        <div class="beneficiary-actions">
          <button class="btn btn-small btn-secondary" onclick="deleteBeneficiary('${ben.id}')">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (error) {
    api.showToast(error.message || 'Failed to load beneficiaries', 'error');
  }
}

function openAddBeneficiaryModal() {
  document.getElementById('add-beneficiary-modal').style.display = 'flex';
}

function closeAddBeneficiaryModal() {
  document.getElementById('add-beneficiary-modal').style.display = 'none';
  document.getElementById('add-beneficiary-form').reset();
}

async function handleAddBeneficiary(e) {
  e.preventDefault();

  const data = {
    name: document.getElementById('ben-name').value,
    mobilePhone: document.getElementById('ben-phone').value || null,
    accountNumber: document.getElementById('ben-account').value || null,
    relationship: document.getElementById('ben-relationship').value,
    dailyLimit: document.getElementById('ben-limit').value ? parseFloat(document.getElementById('ben-limit').value) : null,
  };

  try {
    await api.addBeneficiary(data);
    api.showToast('Beneficiary added successfully!', 'success');
    closeAddBeneficiaryModal();
    loadBeneficiaries();
  } catch (error) {
    api.showToast(error.message || 'Failed to add beneficiary', 'error');
  }
}

async function deleteBeneficiary(id) {
  if (!confirm('Are you sure you want to delete this beneficiary?')) {
    return;
  }

  try {
    await api.deleteBeneficiary(id);
    api.showToast('Beneficiary deleted successfully!', 'success');
    loadBeneficiaries();
  } catch (error) {
    api.showToast(error.message || 'Failed to delete beneficiary', 'error');
  }
}

// Settings
async function loadSettings() {
  document.getElementById('settings-member-name').textContent = `${currentMember.firstName} ${currentMember.lastName}`;
  document.getElementById('settings-member-phone').textContent = currentMember.mobilePhone;
  document.getElementById('settings-member-email').textContent = currentMember.email;
}
