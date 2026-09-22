'use strict';

/**
 * Member portal.
 *
 * The Qona-MBS client, wired to the platform. The screens and their ids are
 * the original's; what changed is everything behind them: the API it talks
 * to, activation in place of registration, no inline handlers or styles so
 * it runs under the same Content-Security-Policy as the back office, and
 * escaping of everything the server sends before it touches the DOM.
 */

let currentMember = null;
let currentAccounts = [];
let currentTransactionAccount = null;
let currentTransactionPage = 0;
const TRANSACTION_LIMIT = 20;

const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const kes = (n) => `KES ${Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d) => (d ? new Date(d).toLocaleDateString('en-KE') : '');

const KIND_LABELS = {
  SAVINGS_DEPOSIT: 'Deposit', SAVINGS_WITHDRAWAL: 'Withdrawal', SAVINGS_TRANSFER: 'Transfer',
  LOAN_DISBURSEMENT: 'Loan disbursed', LOAN_REPAYMENT: 'Loan repayment', LOAN_FEE: 'Loan fee',
  LOAN_INTEREST_ACCRUAL: 'Interest', SHARE_PURCHASE: 'Share purchase', SHARE_TRANSFER: 'Share transfer',
  DIVIDEND_PAYOUT: 'Dividend', REVERSAL: 'Reversal',
};
const kindLabel = (k) => KIND_LABELS[k] || k;

// --------------------------------------------------------------------------
// Start-up
// --------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', initializeApp);

async function initializeApp() {
  attachEventListeners();

  const params = new URLSearchParams(location.search);
  if (params.get('tenant')) api.setTenant(params.get('tenant'));
  if (api.tenant) $('login-tenant').value = api.tenant;

  if (api.refresh && api.tenant && await api.refreshSession()) {
    try {
      const me = await api.getCurrentUser();
      currentMember = me.member;
      showApp();
      loadDashboard();
      return;
    } catch { /* fall through to the login screen */ }
  }
  showLoginScreen();
}

function showLoginScreen() {
  $('login-screen').classList.add('active');
  $('register-screen').classList.remove('active');
  $('app-container').hidden = true;
}

function showApp() {
  $('login-screen').classList.remove('active');
  $('register-screen').classList.remove('active');
  $('app-container').hidden = false;
}

function setError(id, message) {
  const el = $(id);
  el.textContent = message || '';
  el.hidden = !message;
}

// --------------------------------------------------------------------------
// Events
// --------------------------------------------------------------------------

function attachEventListeners() {
  $('show-register').addEventListener('click', (e) => {
    e.preventDefault();
    $('login-screen').classList.remove('active');
    $('register-screen').classList.add('active');
  });
  $('show-login').addEventListener('click', (e) => {
    e.preventDefault();
    $('register-screen').classList.remove('active');
    $('login-screen').classList.add('active');
  });

  $('login-form').addEventListener('submit', handleLogin);
  $('register-form').addEventListener('submit', handleActivate);

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      showView(e.currentTarget.dataset.view);
      document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
      e.currentTarget.classList.add('active');
    });
  });

  $('logout-btn').addEventListener('click', logout);
  $('logout-settings-btn').addEventListener('click', logout);
  $('sidebar-toggle')?.addEventListener('click', () => document.querySelector('.sidebar')?.classList.toggle('collapsed'));

  $('own-account-transfer').addEventListener('click', () => {
    $('own-transfer-form').hidden = false;
    $('internal-transfer-form').hidden = true;
    loadAccountSelectsForOwnTransfer();
  });
  $('internal-transfer').addEventListener('click', () => {
    $('internal-transfer-form').hidden = false;
    $('own-transfer-form').hidden = true;
  });
  document.querySelectorAll('.cancel-transfer').forEach((b) => b.addEventListener('click', resetTransferForm));

  $('lookup-recipient').addEventListener('click', handleLookupRecipient);
  $('own-transfer-submit').addEventListener('submit', handleOwnTransfer);
  $('internal-transfer-submit').addEventListener('submit', handleInternalTransfer);

  $('add-beneficiary-btn').addEventListener('click', () => { $('add-beneficiary-modal').hidden = false; });
  $('close-modal').addEventListener('click', closeAddBeneficiaryModal);
  $('add-beneficiary-form').addEventListener('submit', handleAddBeneficiary);
  // Delete buttons are rendered later, so the list delegates.
  $('beneficiaries-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-delete]');
    if (b) deleteBeneficiary(b.dataset.delete);
  });

  // Account cards are rendered later too.
  for (const id of ['quick-accounts', 'all-accounts']) {
    $(id).addEventListener('click', (e) => {
      const card = e.target.closest('.account-card[data-account]');
      if (card) viewAccountTransactions(card.dataset.account);
    });
  }

  $('prev-page').addEventListener('click', previousPage);
  $('next-page').addEventListener('click', nextPage);
  $('transaction-account').addEventListener('change', (e) => {
    currentTransactionAccount = e.target.value; currentTransactionPage = 0; loadTransactions();
  });
  $('transaction-search').addEventListener('input', renderTransactionFilter);
  $('transaction-type-filter').addEventListener('change', renderTransactionFilter);
  $('transaction-status-filter').addEventListener('change', renderTransactionFilter);

  $('change-pin-btn').addEventListener('click', handleChangePin);
}

// --------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------

async function handleLogin(e) {
  e.preventDefault();
  setError('login-error', '');
  api.setTenant($('login-tenant').value);
  try {
    const response = await api.login($('login-phone').value, $('login-pin').value);
    currentMember = response.member;
    if (response.tenant?.name) {
      $('sidebar-sacco-name').textContent = response.tenant.name;
      $('login-sacco-name').textContent = response.tenant.name;
    }
    showApp();
    loadDashboard();
    e.target.reset();
    $('login-tenant').value = api.tenant;
  } catch (error) {
    setError('login-error', friendly(error.message));
  }
}

async function handleActivate(e) {
  e.preventDefault();
  setError('register-error', '');
  api.setTenant($('login-tenant').value);
  if (!api.tenant) return setError('register-error', 'Enter your SACCO code on the sign-in screen first.');
  try {
    await api.activate({
      memberNo: $('reg-member-no').value.trim(),
      nationalId: $('reg-id').value.trim(),
      phone: $('reg-phone').value.trim(),
      pin: $('reg-pin').value,
    });
    api.showToast('Activated. Sign in with your phone number and PIN.', 'success');
    $('login-phone').value = $('reg-phone').value.trim();
    $('register-form').reset();
    $('register-screen').classList.remove('active');
    $('login-screen').classList.add('active');
  } catch (error) {
    setError('register-error', friendly(error.message));
  }
}

async function logout() {
  await api.logout();
  currentMember = null;
  currentAccounts = [];
  showLoginScreen();
}

async function handleChangePin() {
  const currentPin = window.prompt('Current PIN');
  if (currentPin === null) return;
  const newPin = window.prompt('New PIN (4 to 6 digits)');
  if (newPin === null) return;
  try {
    await api.changePin(currentPin, newPin);
    api.showToast('PIN changed. Other devices have been signed out.', 'success');
  } catch (error) {
    api.showToast(friendly(error.message), 'error');
  }
}

/** Server reason codes are for logs; members get a sentence. */
function friendly(code) {
  const map = {
    INVALID_CREDENTIALS: 'Wrong phone number or PIN.',
    TOO_MANY_ATTEMPTS_ACCOUNT_LOCKED: 'Too many wrong PINs. Try again in 15 minutes.',
    ACCOUNT_DISABLED: 'This account is not active. Contact your SACCO.',
    MEMBER_DETAILS_DO_NOT_MATCH: 'Those details do not match a member record. Check them, or contact your SACCO.',
    MEMBER_ALREADY_ACTIVATED: 'This membership is already activated. Sign in instead.',
    PHONE_ALREADY_IN_USE: 'That phone number is already linked to another membership.',
    PIN_MUST_BE_4_TO_6_DIGITS: 'The PIN must be 4 to 6 digits.',
    INVALID_PHONE: 'That does not look like a phone number.',
    TOO_MANY_LOGIN_ATTEMPTS: 'Too many attempts. Wait a few minutes and try again.',
    RECIPIENT_NOT_FOUND: 'No activated member has that phone number.',
    CANNOT_TRANSFER_TO_YOURSELF: 'That is your own number.',
    SAME_ACCOUNT_TRANSFER: 'Choose two different accounts.',
    NO_SAVINGS_ACCOUNT: 'You have no active savings account to send from.',
    'unknown tenant': 'No SACCO has that code.',
  };
  if (!code) return 'Something went wrong.';
  if (code.startsWith('ACCOUNT_LOCKED_UNTIL_')) return 'This account is temporarily locked. Try again later.';
  if (code.startsWith('INSUFFICIENT_AVAILABLE_BALANCE')) return `Not enough available balance (${code.split(': ')[1] || ''}).`;
  for (const [k, v] of Object.entries(map)) if (code.startsWith(k)) return v;
  return code.replace(/_/g, ' ').toLowerCase();
}

// --------------------------------------------------------------------------
// Navigation
// --------------------------------------------------------------------------

function showView(viewName) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $(`view-${viewName}`).classList.add('active');
  switch (viewName) {
    case 'dashboard': loadDashboard(); break;
    case 'accounts': loadAccounts(); break;
    case 'transactions': loadTransactions(); break;
    case 'beneficiaries': loadBeneficiaries(); break;
    case 'settings': loadSettings(); break;
    default: break;
  }
}

// --------------------------------------------------------------------------
// Dashboard and accounts
// --------------------------------------------------------------------------

function accountCard(account) {
  const state = account.accountState;
  const sub = account.accountType === 'SHARES'
    ? `${Number(account.units).toLocaleString()} units`
    : account.accountType === 'LOAN' ? 'outstanding' : 'Balance';
  return `
    <div class="account-card" data-account="${esc(account.accountNumber)}" role="button" tabindex="0">
      <div class="account-type">${esc(account.accountType)} · ${esc(account.product || '')}</div>
      <div class="account-number">${esc(account.accountNumber)}</div>
      <div class="account-balance">
        <div class="balance-label">${esc(sub)}</div>
        <div class="balance-value">${kes(account.balance)}</div>
      </div>
      <div class="account-state">${esc(state)}</div>
    </div>`;
}

async function loadDashboard() {
  try {
    const [accounts, stats] = await Promise.all([api.getAccounts(), api.getTransactionStats()]);
    currentAccounts = accounts.accounts || [];

    $('member-name').textContent = `Welcome, ${currentMember.firstName} ${currentMember.lastName}`;

    const savings = currentAccounts.filter((a) => a.accountType === 'SAVINGS');
    $('total-balance').textContent = kes(savings.reduce((s, a) => s + Number(a.balance || 0), 0));
    $('total-deposits').textContent = kes(stats.stats.totalDeposits);
    $('total-withdrawals').textContent = kes(stats.stats.totalWithdrawals);
    $('total-transfers').textContent = kes(stats.stats.totalTransfers);

    $('quick-accounts').innerHTML = currentAccounts.map(accountCard).join('');

    const first = savings[0] || currentAccounts[0];
    if (first) {
      const statement = await api.getMiniStatement(first.accountNumber);
      renderRecentTransactions(statement.transactions);
    } else {
      renderRecentTransactions([]);
    }
  } catch (error) {
    api.showToast(friendly(error.message), 'error');
  }
}

function transactionRow(t, withReference) {
  const status = t.reversed ? 'REVERSED' : 'POSTED';
  return `
    <tr>
      <td>${esc(day(t.value_date))}</td>
      <td>${esc(kindLabel(t.kind))}</td>
      <td>${esc(t.narration || '')}</td>
      <td>${kes(t.amount)}</td>
      ${withReference ? `<td>${esc(t.reference)}</td>` : ''}
      <td><span class="status-badge ${status.toLowerCase()}">${status}</span></td>
    </tr>`;
}

function renderRecentTransactions(transactions) {
  const tbody = $('dashboard-transactions');
  tbody.innerHTML = transactions.slice(0, 5).map((t) => transactionRow(t, false)).join('')
    || '<tr><td colspan="5" class="empty-cell">No transactions yet</td></tr>';
}

async function loadAccounts() {
  try {
    const accounts = await api.getAccounts();
    currentAccounts = accounts.accounts || [];
    $('all-accounts').innerHTML = currentAccounts.map(accountCard).join('')
      || '<p class="empty-cell">No accounts yet</p>';
  } catch (error) {
    api.showToast(friendly(error.message), 'error');
  }
}

function viewAccountTransactions(accountNo) {
  document.querySelectorAll('.nav-item').forEach((i) => i.classList.toggle('active', i.dataset.view === 'transactions'));
  currentTransactionAccount = accountNo;
  currentTransactionPage = 0;
  showView('transactions');
}

// --------------------------------------------------------------------------
// Transactions
// --------------------------------------------------------------------------

let loadedTransactions = [];

async function loadTransactions() {
  try {
    if (!currentAccounts.length) currentAccounts = (await api.getAccounts()).accounts || [];
    const select = $('transaction-account');
    select.innerHTML = currentAccounts.map((a) =>
      `<option value="${esc(a.accountNumber)}">${esc(a.accountType)} ${esc(a.accountNumber)}</option>`).join('');
    if (!currentTransactionAccount && currentAccounts.length) currentTransactionAccount = currentAccounts[0].accountNumber;
    select.value = currentTransactionAccount || '';

    if (!currentTransactionAccount) {
      $('transactions-list').innerHTML = '<tr><td colspan="6" class="empty-cell">No accounts yet</td></tr>';
      return;
    }

    const response = await api.getTransactionHistory(currentTransactionAccount, {
      limit: TRANSACTION_LIMIT, offset: currentTransactionPage * TRANSACTION_LIMIT,
    });
    loadedTransactions = response.transactions;
    renderTransactionFilter();

    const from = response.pagination.total === 0 ? 0 : response.pagination.offset + 1;
    const to = Math.min(response.pagination.offset + TRANSACTION_LIMIT, response.pagination.total);
    $('page-info').textContent = `${from}–${to} of ${response.pagination.total}`;
    $('prev-page').disabled = currentTransactionPage === 0;
    $('next-page').disabled = !response.pagination.hasMore;
  } catch (error) {
    api.showToast(friendly(error.message), 'error');
  }
}

/** The filters narrow the page in hand; paging itself is done by the server. */
function renderTransactionFilter() {
  const q = $('transaction-search').value.trim().toLowerCase();
  const kind = $('transaction-type-filter').value;
  const status = $('transaction-status-filter').value;
  const rows = loadedTransactions.filter((t) =>
    (!kind || t.kind === kind)
    && (!status || (status === 'REVERSED') === Boolean(t.reversed))
    && (!q || `${t.reference} ${t.narration || ''}`.toLowerCase().includes(q)));
  $('transactions-list').innerHTML = rows.map((t) => transactionRow(t, true)).join('')
    || '<tr><td colspan="6" class="empty-cell">No transactions found</td></tr>';
}

function previousPage() {
  if (currentTransactionPage > 0) { currentTransactionPage -= 1; loadTransactions(); }
}
function nextPage() { currentTransactionPage += 1; loadTransactions(); }

// --------------------------------------------------------------------------
// Transfers
// --------------------------------------------------------------------------

function loadAccountSelectsForOwnTransfer() {
  const options = currentAccounts.filter((a) => a.accountType === 'SAVINGS' && a.accountState === 'ACTIVE')
    .map((a) => `<option value="${esc(a.accountNumber)}">${esc(a.accountNumber)} (${kes(a.balance)})</option>`).join('');
  $('own-from-account').innerHTML = `<option value="">Select account</option>${options}`;
  $('own-to-account').innerHTML = `<option value="">Select account</option>${options}`;
}

async function handleLookupRecipient() {
  const phone = $('internal-phone').value.trim();
  if (!phone) return api.showToast('Enter a phone number', 'error');
  try {
    const response = await api.lookupBeneficiary(phone);
    $('recipient-name').textContent = response.beneficiary.name;
    $('recipient-account').textContent = response.beneficiary.accountNumber;
    $('recipient-info').hidden = false;
  } catch (error) {
    api.showToast(error.status === 404 ? friendly('RECIPIENT_NOT_FOUND') : friendly(error.message), 'error');
    $('recipient-info').hidden = true;
  }
}

async function handleOwnTransfer(e) {
  e.preventDefault();
  const from = $('own-from-account').value;
  const to = $('own-to-account').value;
  if (from === to) return api.showToast('Choose two different accounts', 'error');
  try {
    const tx = await api.transferOwnAccounts(from, to, $('own-amount').value, $('own-description').value);
    api.showToast(`Transfer posted (${tx.reference})`, 'success');
    resetTransferForm();
    loadDashboard();
  } catch (error) {
    api.showToast(friendly(error.message), 'error');
  }
}

async function handleInternalTransfer(e) {
  e.preventDefault();
  try {
    const tx = await api.transferInternal($('internal-phone').value.trim(), $('internal-amount').value, $('internal-description').value);
    api.showToast(`Transfer posted (${tx.reference})`, 'success');
    resetTransferForm();
    loadDashboard();
  } catch (error) {
    api.showToast(friendly(error.message), 'error');
  }
}

function resetTransferForm() {
  $('own-transfer-form').hidden = true;
  $('internal-transfer-form').hidden = true;
  $('own-transfer-submit').reset();
  $('internal-transfer-submit').reset();
  $('recipient-info').hidden = true;
}

// --------------------------------------------------------------------------
// Beneficiaries
// --------------------------------------------------------------------------

async function loadBeneficiaries() {
  try {
    const response = await api.getBeneficiaries();
    const container = $('beneficiaries-list');
    if (!response.beneficiaries.length) {
      container.innerHTML = '<p class="empty-cell wide">No beneficiaries yet</p>';
      return;
    }
    container.innerHTML = response.beneficiaries.map((ben) => `
      <div class="beneficiary-card">
        <div class="beneficiary-name">${esc(ben.name)}</div>
        <div class="beneficiary-info">
          ${ben.mobilePhone ? `<div>${esc(ben.mobilePhone)}</div>` : ''}
          ${ben.accountNumber ? `<div>${esc(ben.accountNumber)}</div>` : ''}
          <div>${esc(ben.relationship || '')}</div>
        </div>
        <div><span class="beneficiary-badge">${ben.isVerified ? 'Member of this SACCO' : 'Not a member'}</span></div>
        <div class="beneficiary-actions">
          <button class="btn btn-small btn-secondary" data-delete="${esc(ben.id)}">Delete</button>
        </div>
      </div>`).join('');
  } catch (error) {
    api.showToast(friendly(error.message), 'error');
  }
}

function closeAddBeneficiaryModal() {
  $('add-beneficiary-modal').hidden = true;
  $('add-beneficiary-form').reset();
}

async function handleAddBeneficiary(e) {
  e.preventDefault();
  try {
    await api.addBeneficiary({
      name: $('ben-name').value,
      mobilePhone: $('ben-phone').value || null,
      accountNumber: $('ben-account').value || null,
      relationship: $('ben-relationship').value,
      dailyLimit: $('ben-limit').value ? Number($('ben-limit').value) : null,
    });
    api.showToast('Beneficiary added', 'success');
    closeAddBeneficiaryModal();
    loadBeneficiaries();
  } catch (error) {
    api.showToast(friendly(error.message), 'error');
  }
}

async function deleteBeneficiary(id) {
  if (!window.confirm('Remove this beneficiary?')) return;
  try {
    await api.deleteBeneficiary(id);
    api.showToast('Beneficiary removed', 'success');
    loadBeneficiaries();
  } catch (error) {
    api.showToast(friendly(error.message), 'error');
  }
}

// --------------------------------------------------------------------------
// Settings
// --------------------------------------------------------------------------

function loadSettings() {
  $('settings-member-name').textContent = `${currentMember.firstName} ${currentMember.lastName} (${currentMember.memberNo})`;
  $('settings-member-phone').textContent = currentMember.phone || '';
  $('settings-member-email').textContent = currentMember.email || '';
}
