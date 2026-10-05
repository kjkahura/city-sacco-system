// API Configuration
const API_BASE_URL = 'http://localhost:8000/api/v1';

// Store authentication token
let authToken = localStorage.getItem('authToken') || '';

// API Helper Functions
async function apiRequest(endpoint, options = {}) {
    const url = `${API_BASE_URL}${endpoint}`;
    
    const defaultOptions = {
        headers: {
            'Content-Type': 'application/json',
        }
    };
    
    if (authToken) {
        defaultOptions.headers['Authorization'] = `Bearer ${authToken}`;
    }
    
    const config = { ...defaultOptions, ...options };
    
    try {
        const response = await fetch(url, config);
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.detail || 'Request failed');
        }
        
        return data;
    } catch (error) {
        console.error('API Error:', error);
        throw error;
    }
}

// Authentication API
async function login(username, password) {
    const response = await apiRequest('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
    });
    
    if (response.access_token) {
        authToken = response.access_token;
        localStorage.setItem('authToken', authToken);
    }
    
    return response;
}

// Members API
async function getMembers() {
    return await apiRequest('/members/');
}

async function createMember(memberData) {
    return await apiRequest('/members/', {
        method: 'POST',
        body: JSON.stringify(memberData)
    });
}

// Accounts API
async function getAccounts() {
    return await apiRequest('/accounts/');
}

async function createAccount(accountData) {
    return await apiRequest('/accounts/', {
        method: 'POST',
        body: JSON.stringify(accountData)
    });
}

async function getAccountBalance(accountId) {
    return await apiRequest(`/accounts/${accountId}/balance`);
}

// Transactions API
async function deposit(depositData) {
    return await apiRequest('/transactions/deposit', {
        method: 'POST',
        body: JSON.stringify(depositData)
    });
}

async function withdraw(withdrawData) {
    return await apiRequest('/transactions/withdraw', {
        method: 'POST',
        body: JSON.stringify(withdrawData)
    });
}

async function transfer(transferData) {
    return await apiRequest('/transactions/transfer', {
        method: 'POST',
        body: JSON.stringify(transferData)
    });
}

async function getTransactions() {
    return await apiRequest('/transactions/');
}

// Loans API
async function getLoans() {
    return await apiRequest('/loans/');
}

async function applyLoan(loanData) {
    return await apiRequest('/loans/apply', {
        method: 'POST',
        body: JSON.stringify(loanData)
    });
}

async function approveLoan(loanId, approvalData) {
    return await apiRequest(`/loans/${loanId}/approve`, {
        method: 'POST',
        body: JSON.stringify(approvalData)
    });
}

async function disburseLoan(loanId, disbursementData) {
    return await apiRequest(`/loans/${loanId}/disburse`, {
        method: 'POST',
        body: JSON.stringify(disbursementData)
    });
}

async function repayLoan(loanId, repaymentData) {
    return await apiRequest(`/loans/${loanId}/repay`, {
        method: 'POST',
        body: JSON.stringify(repaymentData)
    });
}

// USSD API
async function simulateUSSD(ussdData) {
    return await apiRequest('/ussd/simulate', {
        method: 'POST',
        body: JSON.stringify(ussdData)
    });
}
