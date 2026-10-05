// Global state
let currentUSSDText = '';
let ussdSessionId = 'session_' + Date.now();

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
    loadDashboard();
});

// Authentication
async function handleLogin() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    try {
        const response = await login(username, password);
        showMessage('Login successful!', 'success');
        document.getElementById('loginForm').style.display = 'none';
        document.getElementById('userInfo').style.display = 'flex';
        document.getElementById('userName').textContent = response.user.full_name;
        loadDashboard();
    } catch (error) {
        showMessage('Login failed: ' + error.message, 'error');
    }
}

function handleLogout() {
    authToken = '';
    localStorage.removeItem('authToken');
    document.getElementById('loginForm').style.display = 'flex';
    document.getElementById('userInfo').style.display = 'none';
    showMessage('Logged out successfully', 'info');
}

function checkAuth() {
    if (authToken) {
        document.getElementById('loginForm').style.display = 'none';
        document.getElementById('userInfo').style.display = 'flex';
    }
}

// Navigation
function showSection(sectionName) {
    // Hide all sections
    document.querySelectorAll('.content-section').forEach(section => {
        section.classList.remove('active');
    });
    
    // Remove active class from all tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Show selected section
    document.getElementById(sectionName).classList.add('active');
    
    // Add active class to clicked tab
    event.target.classList.add('active');
    
    // Load data for the section
    if (sectionName === 'members') loadMembers();
    if (sectionName === 'accounts') loadAccounts();
    if (sectionName === 'transactions') loadTransactions();
    if (sectionName === 'loans') loadLoans();
}

// Dashboard
async function loadDashboard() {
    try {
        const [members, accounts, loans, transactions] = await Promise.all([
            getMembers().catch(() => []),
            getAccounts().catch(() => []),
            getLoans().catch(() => []),
            getTransactions().catch(() => [])
        ]);
        
        document.getElementById('totalMembers').textContent = members.length || 0;
        document.getElementById('totalAccounts').textContent = accounts.length || 0;
        document.getElementById('totalLoans').textContent = loans.length || 0;
        document.getElementById('totalTransactions').textContent = transactions.length || 0;
    } catch (error) {
        showMessage('Error loading dashboard: ' + error.message, 'error');
    }
}

// Members
function showAddMemberForm() {
    document.getElementById('addMemberForm').style.display = 'block';
}

function hideAddMemberForm() {
    document.getElementById('addMemberForm').style.display = 'none';
}

async function handleAddMember(event) {
    event.preventDefault();
    
    const memberData = {
        first_name: document.getElementById('firstName').value,
        last_name: document.getElementById('lastName').value,
        phone: document.getElementById('phone').value,
        id_number: document.getElementById('idNumber').value,
        date_of_birth: document.getElementById('dateOfBirth').value,
        gender: document.getElementById('gender').value,
        address: document.getElementById('address').value,
        occupation: document.getElementById('occupation').value,
        employer: document.getElementById('employer').value,
        monthly_income: document.getElementById('monthlyIncome').value || null
    };
    
    try {
        await createMember(memberData);
        showMessage('Member created successfully!', 'success');
        hideAddMemberForm();
        event.target.reset();
        loadMembers();
    } catch (error) {
        showMessage('Error creating member: ' + error.message, 'error');
    }
}

async function loadMembers() {
    try {
        const members = await getMembers();
        const membersList = document.getElementById('membersList');
        
        if (members.length === 0) {
            membersList.innerHTML = '<p>No members found.</p>';
            return;
        }
        
        let html = '<table><thead><tr><th>ID</th><th>Member Number</th><th>Name</th><th>Phone</th><th>Status</th><th>Join Date</th></tr></thead><tbody>';
        
        members.forEach(member => {
            html += `
                <tr>
                    <td>${member.id}</td>
                    <td>${member.member_number}</td>
                    <td>${member.first_name} ${member.last_name}</td>
                    <td>${member.phone}</td>
                    <td>${member.status}</td>
                    <td>${member.join_date}</td>
                </tr>
            `;
        });
        
        html += '</tbody></table>';
        membersList.innerHTML = html;
    } catch (error) {
        document.getElementById('membersList').innerHTML = '<p>Error loading members: ' + error.message + '</p>';
    }
}

// Accounts
function showAddAccountForm() {
    document.getElementById('addAccountForm').style.display = 'block';
}

function hideAddAccountForm() {
    document.getElementById('addAccountForm').style.display = 'none';
}

async function handleCreateAccount(event) {
    event.preventDefault();
    
    const accountData = {
        member_id: parseInt(document.getElementById('accountMemberId').value),
        account_type: document.getElementById('accountType').value,
        minimum_balance: parseFloat(document.getElementById('minimumBalance').value) || 0,
        interest_rate: parseFloat(document.getElementById('interestRate').value) / 100 || 0
    };
    
    try {
        await createAccount(accountData);
        showMessage('Account created successfully!', 'success');
        hideAddAccountForm();
        event.target.reset();
        loadAccounts();
    } catch (error) {
        showMessage('Error creating account: ' + error.message, 'error');
    }
}

async function loadAccounts() {
    try {
        const accounts = await getAccounts();
        const accountsList = document.getElementById('accountsList');
        
        if (accounts.length === 0) {
            accountsList.innerHTML = '<p>No accounts found.</p>';
            return;
        }
        
        let html = '<table><thead><tr><th>ID</th><th>Account Number</th><th>Type</th><th>Balance</th><th>Status</th></tr></thead><tbody>';
        
        accounts.forEach(account => {
            html += `
                <tr>
                    <td>${account.id}</td>
                    <td>${account.account_number}</td>
                    <td>${account.account_type}</td>
                    <td>KES ${parseFloat(account.balance).toLocaleString()}</td>
                    <td>${account.status}</td>
                </tr>
            `;
        });
        
        html += '</tbody></table>';
        accountsList.innerHTML = html;
    } catch (error) {
        document.getElementById('accountsList').innerHTML = '<p>Error loading accounts: ' + error.message + '</p>';
    }
}

// Transactions
function showTransactionForm(type) {
    document.getElementById('depositForm').style.display = 'none';
    document.getElementById('withdrawForm').style.display = 'none';
    document.getElementById('transferForm').style.display = 'none';
    
    document.getElementById(type + 'Form').style.display = 'block';
}

async function handleDeposit(event) {
    event.preventDefault();
    
    const depositData = {
        account_number: document.getElementById('depositAccount').value,
        amount: parseFloat(document.getElementById('depositAmount').value),
        description: document.getElementById('depositDescription').value
    };
    
    try {
        const result = await deposit(depositData);
        showMessage('Deposit successful! New balance: KES ' + result.new_balance, 'success');
        event.target.reset();
        loadTransactions();
    } catch (error) {
        showMessage('Error processing deposit: ' + error.message, 'error');
    }
}

async function handleWithdraw(event) {
    event.preventDefault();
    
    const withdrawData = {
        account_number: document.getElementById('withdrawAccount').value,
        amount: parseFloat(document.getElementById('withdrawAmount').value),
        description: document.getElementById('withdrawDescription').value
    };
    
    try {
        const result = await withdraw(withdrawData);
        showMessage('Withdrawal successful! New balance: KES ' + result.new_balance, 'success');
        event.target.reset();
        loadTransactions();
    } catch (error) {
        showMessage('Error processing withdrawal: ' + error.message, 'error');
    }
}

async function handleTransfer(event) {
    event.preventDefault();
    
    const transferData = {
        from_account_number: document.getElementById('fromAccount').value,
        to_account_number: document.getElementById('toAccount').value,
        amount: parseFloat(document.getElementById('transferAmount').value),
        description: document.getElementById('transferDescription').value
    };
    
    try {
        const result = await transfer(transferData);
        showMessage('Transfer successful!', 'success');
        event.target.reset();
        loadTransactions();
    } catch (error) {
        showMessage('Error processing transfer: ' + error.message, 'error');
    }
}

async function loadTransactions() {
    try {
        const transactions = await getTransactions();
        const transactionsList = document.getElementById('transactionsList');
        
        if (transactions.length === 0) {
            transactionsList.innerHTML = '<p>No transactions found.</p>';
            return;
        }
        
        let html = '<table><thead><tr><th>ID</th><th>Transaction ID</th><th>Type</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>';
        
        transactions.forEach(transaction => {
            html += `
                <tr>
                    <td>${transaction.id}</td>
                    <td>${transaction.transaction_id}</td>
                    <td>${transaction.transaction_type}</td>
                    <td>KES ${parseFloat(transaction.amount).toLocaleString()}</td>
                    <td>${transaction.status}</td>
                    <td>${transaction.transaction_date}</td>
                </tr>
            `;
        });
        
        html += '</tbody></table>';
        transactionsList.innerHTML = html;
    } catch (error) {
        document.getElementById('transactionsList').innerHTML = '<p>Error loading transactions: ' + error.message + '</p>';
    }
}

// Loans
function showLoanApplicationForm() {
    document.getElementById('loanApplicationForm').style.display = 'block';
}

async function handleLoanApplication(event) {
    event.preventDefault();
    
    const loanData = {
        member_id: parseInt(document.getElementById('loanMemberId').value),
        account_id: parseInt(document.getElementById('loanAccountId').value),
        loan_type: document.getElementById('loanType').value,
        principal_amount: parseFloat(document.getElementById('loanAmount').value),
        term_months: parseInt(document.getElementById('loanTerm').value),
        purpose: document.getElementById('loanPurpose').value
    };
    
    try {
        const result = await applyLoan(loanData);
        showMessage('Loan application submitted! Loan Number: ' + result.loan_number, 'success');
        event.target.reset();
        document.getElementById('loanApplicationForm').style.display = 'none';
        loadLoans();
    } catch (error) {
        showMessage('Error submitting loan application: ' + error.message, 'error');
    }
}

async function loadLoans() {
    try {
        const loans = await getLoans();
        const loansList = document.getElementById('loansList');
        
        if (loans.length === 0) {
            loansList.innerHTML = '<p>No loans found.</p>';
            return;
        }
        
        let html = '<table><thead><tr><th>ID</th><th>Loan Number</th><th>Type</th><th>Amount</th><th>Outstanding</th><th>Status</th></tr></thead><tbody>';
        
        loans.forEach(loan => {
            html += `
                <tr>
                    <td>${loan.id}</td>
                    <td>${loan.loan_number}</td>
                    <td>${loan.loan_type}</td>
                    <td>KES ${parseFloat(loan.principal_amount).toLocaleString()}</td>
                    <td>KES ${parseFloat(loan.total_outstanding).toLocaleString()}</td>
                    <td>${loan.status}</td>
                </tr>
            `;
        });
        
        html += '</tbody></table>';
        loansList.innerHTML = html;
    } catch (error) {
        document.getElementById('loansList').innerHTML = '<p>Error loading loans: ' + error.message + '</p>';
    }
}

// USSD Simulator
function ussdInput(value) {
    currentUSSDText += value;
    document.getElementById('ussdText').value = currentUSSDText;
}

function ussdClear() {
    currentUSSDText = '';
    document.getElementById('ussdText').value = '';
    document.getElementById('ussdDisplay').innerHTML = '<p>Welcome to SACCO Banking</p><p>Dial *123# to start</p>';
}

async function ussdSend() {
    const phone = document.getElementById('ussdPhone').value;
    const text = currentUSSDText;
    
    if (!phone) {
        showMessage('Please enter a phone number', 'error');
        return;
    }
    
    try {
        const response = await simulateUSSD({
            phone: phone,
            session_id: ussdSessionId,
            text: text,
            service_code: '*123#'
        });
        
        document.getElementById('ussdDisplay').innerHTML = '<pre>' + response.response + '</pre>';
        currentUSSDText = '';
        document.getElementById('ussdText').value = '';
    } catch (error) {
        showMessage('USSD Error: ' + error.message, 'error');
    }
}

// Utility Functions
function showMessage(message, type = 'info') {
    const messageDiv = document.getElementById('message');
    messageDiv.textContent = message;
    messageDiv.className = `message ${type}`;
    messageDiv.style.display = 'block';
    
    setTimeout(() => {
        messageDiv.style.display = 'none';
    }, 5000);
}
