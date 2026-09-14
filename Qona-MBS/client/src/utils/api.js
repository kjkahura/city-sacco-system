const API_BASE = 'http://localhost:3001/api';

class ApiClient {
  constructor(baseURL = API_BASE) {
    this.baseURL = baseURL;
  }

  getToken() {
    return localStorage.getItem('accessToken');
  }

  setToken(token) {
    if (token) {
      localStorage.setItem('accessToken', token);
    } else {
      localStorage.removeItem('accessToken');
    }
  }

  getHeaders(includeAuth = true) {
    const headers = {
      'Content-Type': 'application/json',
    };

    if (includeAuth) {
      const token = this.getToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    return headers;
  }

  showLoading(show = true) {
    const spinner = document.getElementById('loading-spinner');
    if (spinner) {
      spinner.style.display = show ? 'flex' : 'none';
    }
  }

  showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;

    toast.textContent = message;
    toast.className = `toast show ${type}`;

    setTimeout(() => {
      toast.classList.remove('show');
    }, 3000);
  }

  async request(endpoint, options = {}) {
    const {
      method = 'GET',
      body = null,
      headers = {},
      showLoader = true,
      includeAuth = true,
    } = options;

    const url = `${this.baseURL}${endpoint}`;
    const config = {
      method,
      headers: {
        ...this.getHeaders(includeAuth),
        ...headers,
      },
    };

    if (body) {
      config.body = JSON.stringify(body);
    }

    try {
      if (showLoader) this.showLoading(true);

      const response = await fetch(url, config);

      if (!response.ok) {
        const error = await response.json();
        throw {
          status: response.status,
          message: error.error || error.message || 'An error occurred',
        };
      }

      const data = await response.json();
      return data;
    } catch (error) {
      if (error.status === 401) {
        // Token expired or invalid
        this.setToken(null);
        window.location.href = '/';
      }

      throw error;
    } finally {
      if (showLoader) this.showLoading(false);
    }
  }

  get(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'GET' });
  }

  post(endpoint, body, options = {}) {
    return this.request(endpoint, { ...options, method: 'POST', body });
  }

  put(endpoint, body, options = {}) {
    return this.request(endpoint, { ...options, method: 'PUT', body });
  }

  delete(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'DELETE' });
  }

  // Auth endpoints
  async register(data) {
    return this.post('/auth/register', data, { includeAuth: false });
  }

  async login(phone, pin) {
    return this.post('/auth/login', { mobilePhone: phone, pin }, { includeAuth: false });
  }

  async getCurrentUser() {
    return this.get('/auth/me');
  }

  async logout() {
    return this.post('/auth/logout', {});
  }

  // Account endpoints
  async getAccounts() {
    return this.get('/accounts');
  }

  async getAccount(id) {
    return this.get(`/accounts/${id}`);
  }

  async getBalance(id) {
    return this.get(`/accounts/${id}/balance`);
  }

  async getMiniStatement(id) {
    return this.get(`/accounts/${id}/statement`);
  }

  async getTransactionHistory(accountId, options = {}) {
    const params = new URLSearchParams();
    if (options.limit) params.append('limit', options.limit);
    if (options.offset) params.append('offset', options.offset);
    if (options.type) params.append('type', options.type);
    if (options.status) params.append('status', options.status);
    if (options.dateFrom) params.append('dateFrom', options.dateFrom);
    if (options.dateTo) params.append('dateTo', options.dateTo);
    if (options.search) params.append('search', options.search);

    const query = params.toString() ? `?${params.toString()}` : '';
    return this.get(`/accounts/${accountId}/transactions${query}`);
  }

  async exportStatement(accountId) {
    return this.post(`/accounts/${accountId}/statement/export`, {});
  }

  // Transaction endpoints
  async getTransaction(id) {
    return this.get(`/transactions/${id}`);
  }

  async getReceipt(id) {
    return this.get(`/transactions/${id}/receipt`);
  }

  async disputeTransaction(id, reason) {
    return this.post(`/transactions/${id}/dispute`, { reason });
  }

  async getTransactionLimits() {
    return this.get('/transactions/limits');
  }

  async getTransactionStats() {
    return this.get('/transactions/stats');
  }

  // Transfer endpoints
  async lookupBeneficiary(phone) {
    return this.get(`/transfers/lookup?phone=${encodeURIComponent(phone)}`);
  }

  async transferOwnAccounts(fromAccountId, toAccountId, amount, description = '') {
    return this.post('/transfers/own', {
      fromAccountId,
      toAccountId,
      amount: parseFloat(amount),
      description,
    });
  }

  async transferInternal(recipientPhone, amount, description = '') {
    return this.post('/transfers/internal', {
      recipientPhone,
      amount: parseFloat(amount),
      description,
    });
  }

  // Beneficiary endpoints
  async getBeneficiaries() {
    return this.get('/beneficiaries');
  }

  async getBeneficiary(id) {
    return this.get(`/beneficiaries/${id}`);
  }

  async addBeneficiary(data) {
    return this.post('/beneficiaries', data);
  }

  async updateBeneficiary(id, data) {
    return this.put(`/beneficiaries/${id}`, data);
  }

  async deleteBeneficiary(id) {
    return this.delete(`/beneficiaries/${id}`);
  }
}

const api = new ApiClient();
