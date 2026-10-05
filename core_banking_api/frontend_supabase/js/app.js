// Core Banking App - Supabase Version
// Global state
let currentUser = null;

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    checkSupabaseConnection();
    checkAuth();
    loadDashboard();
});

// Check Supabase connection
function checkSupabaseConnection() {
    if (!supabase) {
        if (!initSupabase()) {
            showMessage('Supabase not configured. Please update js/config.js', 'error');
            return false;
        }
    }
    return true;
}

// Authentication
async function handleLogin() {
    if (!checkSupabaseConnection()) return;
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    try {
        // Query users table for matching username
        const { data: users, error } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .limit(1);
        
        if (error) throw error;
        
        if (!users || users.length === 0) {
            throw new Error('Invalid credentials');
        }
        
        const user = users[0];
        
        // In production, you should hash and verify passwords properly
        // For demo, we'll do simple comparison
        if (user.hashed_password !== password) {
            throw new Error('Invalid credentials');
        }
        
        currentUser = user;
        localStorage.setItem('currentUser', JSON.stringify(user));
        
        showMessage('Login successful!', 'success');
        document.getElementById('loginForm').style.display = 'none';
        document.getElementById('userInfo').style.display = 'flex';
        document.getElementById('userName').textContent = user.full_name;
        loadDashboard();
    } catch (error) {
        showMessage('Login failed: ' + error.message, 'error');
    }
}

function handleLogout() {
    currentUser = null;
    localStorage.removeItem('currentUser');
    document.getElementById('loginForm').style.display = 'flex';
    document.getElementById('userInfo').style.display = 'none';
    showMessage('Logged out successfully', 'info');
}

function checkAuth() {
    const stored = localStorage.getItem('currentUser');
    if (stored) {
        currentUser = JSON.parse(stored);
        document.getElementById('loginForm').style.display = 'none';
        document.getElementById('userInfo').style.display = 'flex';
        document.getElementById('userName').textContent = currentUser.full_name;
    }
}

// Navigation
function showSection(sectionName) {
    document.querySelectorAll('.content-section').forEach(section => {
        section.classList.remove('active');
    });
    
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    document.getElementById(sectionName).classList.add('active');
    event.target.classList.add('active');
    
    if (sectionName === 'members') loadMembers();
    if (sectionName === 'accounts') loadAccounts();
    if (sectionName === 'transactions') loadTransactions();
    if (sectionName === 'loans') loadLoans();
}

// Dashboard
async function loadDashboard() {
    if (!checkSupabaseConnection()) return;
    
    try {
        const [members, accounts, loans, transactions] = await Promise.all([
            supabase.from('members').select('id', { count: 'exact' }).then(r => ({ count: r.count || 0 })),
            supabase.from('accounts').select('id', { count: 'exact' }).then(r => ({ count: r.count || 0 })),
            supabase.from('loans').select('id', { count: 'exact' }).then(r => ({ count: r.count || 0 })),
            supabase.from('transactions').select('id', { count: 'exact' }).then(r => ({ count: r.count || 0 }))
        ]);
        
        document.getElementById('totalMembers').textContent = members.count || 0;
        document.getElementById('totalAccounts').textContent = accounts.count || 0;
        document.getElementById('totalLoans').textContent = loans.count || 0;
        document.getElementById('totalTransactions').textContent = transactions.count || 0;
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
    if (!checkSupabaseConnection()) return;
    
    // Generate member number
    const { count } = await supabase.from('members').select('id', { count: 'exact', head: true });
    const memberCount = count || 0;
    const memberNumber = `MEM${String(memberCount + 1).padStart(6, '0')}`;
    
    const memberData = {
        member_number: memberNumber,
        first_name: document.getElementById('firstName').value,
        last_name: document.getElementById('lastName').value,
        middle_name: document.getElementById('middleName')?.value || null,
        phone: document.getElementById('phone').value,
        id_number: document.getElementById('idNumber').value,
        date_of_birth: document.getElementById('dateOfBirth').value,
        gender: document.getElementById('gender').value,
        address: document.getElementById('address').value,
        occupation: document.getElementById('occupation').value || null,
        employer: document.getElementById('employer').value || null,
        monthly_income: document.getElementById('monthlyIncome').value || null,
        join_date: new Date().toISOString().split('T')[0],
        status: 'active'
    };
    
    try {
        const { data, error } = await supabase
            .from('members')
            .insert([memberData])
            .select();
        
        if (error) throw error;
        
        showMessage('Member created successfully!', 'success');
        hideAddMemberForm();
        event.target.reset();
        loadMembers();
    } catch (error) {
        showMessage('Error creating member: ' + error.message, 'error');
    }
}

async function loadMembers() {
    if (!checkSupabaseConnection()) return;
    
    try {
        const { data: members, error } = await supabase
            .from('members')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        
        const membersList = document.getElementById('membersList');
        
        if (!members || members.length === 0) {
            membersList.innerHTML = '<p>No members found.</p>';
            return;
        }
        
        let html = '<table><thead><tr><th>ID</th><th>Member Number</th><th>Name</th><th>Phone</th><th>Status</th><th>Join Date</th></tr></thead><tbody>';
        
        members.forEach(member => {
            html += `
                <tr>
                    <td>${member.id.substring(0, 8)}...</td>
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
    if (!checkSupabaseConnection()) return;
    
    // Generate account number
    const { count } = await supabase.from('accounts').select('id', { count: 'exact', head: true });
    const accountCount = count || 0;
    const accountNumber = `ACC${String(accountCount + 1).padStart(8, '0')}`;
    
    const accountData = {
        account_number: accountNumber,
        member_id: document.getElementById('accountMemberId').value,
        account_type: document.getElementById('accountType').value,
        minimum_balance: parseFloat(document.getElementById('minimumBalance').value) || 0,
        interest_rate: parseFloat(document.getElementById('interestRate').value) / 100 || 0,
        open_date: new Date().toISOString().split('T')[0],
        status: 'active',
        balance: 0,
        available_balance: 0
    };
    
    try {
        const { data, error } = await supabase
            .from('accounts')
            .insert([accountData])
            .select();
        
        if (error) throw error;
        
        showMessage('Account created successfully!', 'success');
        hideAddAccountForm();
        event.target.reset();
        loadAccounts();
    } catch (error) {
        showMessage('Error creating account: ' + error.message, 'error');
    }
}

async function loadAccounts() {
    if (!checkSupabaseConnection()) return;
    
    try {
        const { data: accounts, error } = await supabase
            .from('accounts')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        
        const accountsList = document.getElementById('accountsList');
        
        if (!accounts || accounts.length === 0) {
            accountsList.innerHTML = '<p>No accounts found.</p>';
            return;
        }
        
        let html = '<table><thead><tr><th>ID</th><th>Account Number</th><th>Type</th><th>Balance</th><th>Status</th></tr></thead><tbody>';
        
        accounts.forEach(account => {
            html += `
                <tr>
                    <td>${account.id.substring(0, 8)}...</td>
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
    if (!checkSupabaseConnection()) return;
    
    const accountNumber = document.getElementById('depositAccount').value;
    const amount = parseFloat(document.getElementById('depositAmount').value);
    
    try {
        // Get account
        const { data: accounts, error: accountError } = await supabase
            .from('accounts')
            .select('*')
            .eq('account_number', accountNumber)
            .single();
        
        if (accountError) throw accountError;
        if (!accounts) throw new Error('Account not found');
        
        // Update balance
        const newBalance = parseFloat(accounts.balance) + amount;
        const { error: updateError } = await supabase
            .from('accounts')
            .update({
                balance: newBalance,
                available_balance: newBalance
            })
            .eq('id', accounts.id);
        
        if (updateError) throw updateError;
        
        // Create transaction
        const transactionId = 'TXN' + Date.now();
        const { error: transError } = await supabase
            .from('transactions')
            .insert([{
                transaction_id: transactionId,
                account_id: accounts.id,
                transaction_type: 'deposit',
                amount: amount,
                balance_after: newBalance,
                status: 'completed',
                description: document.getElementById('depositDescription').value,
                transaction_date: new Date().toISOString().split('T')[0]
            }]);
        
        if (transError) throw transError;
        
        showMessage('Deposit successful! New balance: KES ' + newBalance.toLocaleString(), 'success');
        event.target.reset();
        loadTransactions();
    } catch (error) {
        showMessage('Error processing deposit: ' + error.message, 'error');
    }
}

async function handleWithdraw(event) {
    event.preventDefault();
    if (!checkSupabaseConnection()) return;
    
    const accountNumber = document.getElementById('withdrawAccount').value;
    const amount = parseFloat(document.getElementById('withdrawAmount').value);
    
    try {
        // Get account
        const { data: account, error: accountError } = await supabase
            .from('accounts')
            .select('*')
            .eq('account_number', accountNumber)
            .single();
        
        if (accountError) throw accountError;
        if (parseFloat(account.available_balance) < amount) {
            throw new Error('Insufficient balance');
        }
        
        // Update balance
        const newBalance = parseFloat(account.balance) - amount;
        const { error: updateError } = await supabase
            .from('accounts')
            .update({
                balance: newBalance,
                available_balance: newBalance
            })
            .eq('id', account.id);
        
        if (updateError) throw updateError;
        
        // Create transaction
        const transactionId = 'TXN' + Date.now();
        await supabase.from('transactions').insert([{
            transaction_id: transactionId,
            account_id: account.id,
            transaction_type: 'withdrawal',
            amount: amount,
            balance_after: newBalance,
            status: 'completed',
            description: document.getElementById('withdrawDescription').value,
            transaction_date: new Date().toISOString().split('T')[0]
        }]);
        
        showMessage('Withdrawal successful! New balance: KES ' + newBalance.toLocaleString(), 'success');
        event.target.reset();
        loadTransactions();
    } catch (error) {
        showMessage('Error processing withdrawal: ' + error.message, 'error');
    }
}

async function handleTransfer(event) {
    event.preventDefault();
    if (!checkSupabaseConnection()) return;
    
    const fromAccountNumber = document.getElementById('fromAccount').value;
    const toAccountNumber = document.getElementById('toAccount').value;
    const amount = parseFloat(document.getElementById('transferAmount').value);
    
    try {
        // Get both accounts
        const { data: fromAccount, error: fromError } = await supabase
            .from('accounts')
            .select('*')
            .eq('account_number', fromAccountNumber)
            .single();
        
        const { data: toAccount, error: toError } = await supabase
            .from('accounts')
            .select('*')
            .eq('account_number', toAccountNumber)
            .single();
        
        if (fromError) throw new Error('Source account not found');
        if (toError) throw new Error('Destination account not found');
        if (parseFloat(fromAccount.available_balance) < amount) {
            throw new Error('Insufficient balance');
        }
        
        // Update balances
        const fromNewBalance = parseFloat(fromAccount.balance) - amount;
        const toNewBalance = parseFloat(toAccount.balance) + amount;
        
        await supabase.from('accounts').update({
            balance: fromNewBalance,
            available_balance: fromNewBalance
        }).eq('id', fromAccount.id);
        
        await supabase.from('accounts').update({
            balance: toNewBalance,
            available_balance: toNewBalance
        }).eq('id', toAccount.id);
        
        // Create transactions
        const transactionId = 'TXN' + Date.now();
        await supabase.from('transactions').insert([
            {
                transaction_id: transactionId + '-D',
                account_id: fromAccount.id,
                transaction_type: 'transfer',
                amount: amount,
                balance_after: fromNewBalance,
                status: 'completed',
                description: document.getElementById('transferDescription').value,
                transaction_date: new Date().toISOString().split('T')[0],
                to_account_id: toAccount.id
            },
            {
                transaction_id: transactionId + '-C',
                account_id: toAccount.id,
                transaction_type: 'transfer',
                amount: amount,
                balance_after: toNewBalance,
                status: 'completed',
                description: document.getElementById('transferDescription').value,
                transaction_date: new Date().toISOString().split('T')[0],
                to_account_id: fromAccount.id
            }
        ]);
        
        showMessage('Transfer successful!', 'success');
        event.target.reset();
        loadTransactions();
    } catch (error) {
        showMessage('Error processing transfer: ' + error.message, 'error');
    }
}

async function loadTransactions() {
    if (!checkSupabaseConnection()) return;
    
    try {
        const { data: transactions, error } = await supabase
            .from('transactions')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100);
        
        if (error) throw error;
        
        const transactionsList = document.getElementById('transactionsList');
        
        if (!transactions || transactions.length === 0) {
            transactionsList.innerHTML = '<p>No transactions found.</p>';
            return;
        }
        
        let html = '<table><thead><tr><th>Transaction ID</th><th>Type</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>';
        
        transactions.forEach(transaction => {
            html += `
                <tr>
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
    if (!checkSupabaseConnection()) return;
    
    // Generate loan number
    const { count } = await supabase.from('loans').select('id', { count: 'exact', head: true });
    const loanCount = count || 0;
    const loanNumber = `LOAN${String(loanCount + 1).padStart(6, '0')}`;
    
    const principalAmount = parseFloat(document.getElementById('loanAmount').value);
    const termMonths = parseInt(document.getElementById('loanTerm').value);
    const interestRate = 0.12; // 12% default
    
    // Calculate monthly payment (simplified)
    const monthlyRate = interestRate / 12;
    const monthlyPayment = monthlyRate > 0 
        ? principalAmount * (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1)
        : principalAmount / termMonths;
    
    const loanData = {
        loan_number: loanNumber,
        member_id: document.getElementById('loanMemberId').value,
        account_id: document.getElementById('loanAccountId').value,
        loan_type: document.getElementById('loanType').value,
        principal_amount: principalAmount,
        interest_rate: interestRate,
        term_months: termMonths,
        monthly_payment: monthlyPayment,
        outstanding_principal: principalAmount,
        outstanding_interest: 0,
        total_outstanding: principalAmount,
        application_date: new Date().toISOString().split('T')[0],
        status: 'pending',
        purpose: document.getElementById('loanPurpose').value || null
    };
    
    try {
        const { data, error } = await supabase
            .from('loans')
            .insert([loanData])
            .select();
        
        if (error) throw error;
        
        showMessage('Loan application submitted! Loan Number: ' + loanNumber, 'success');
        event.target.reset();
        document.getElementById('loanApplicationForm').style.display = 'none';
        loadLoans();
    } catch (error) {
        showMessage('Error submitting loan application: ' + error.message, 'error');
    }
}

async function loadLoans() {
    if (!checkSupabaseConnection()) return;
    
    try {
        const { data: loans, error } = await supabase
            .from('loans')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        
        const loansList = document.getElementById('loansList');
        
        if (!loans || loans.length === 0) {
            loansList.innerHTML = '<p>No loans found.</p>';
            return;
        }
        
        let html = '<table><thead><tr><th>Loan Number</th><th>Type</th><th>Amount</th><th>Outstanding</th><th>Status</th></tr></thead><tbody>';
        
        loans.forEach(loan => {
            html += `
                <tr>
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
