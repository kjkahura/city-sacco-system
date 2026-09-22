'use strict';

/**
 * Portal API client.
 *
 * Same origin as the platform, so the base path is relative and there is
 * no CORS and no configured server address. The SACCO is identified by an
 * X-Tenant header when the host has no tenant subdomain; the server ignores
 * the header once a token is present, because the token says which SACCO
 * signed it.
 *
 * Tokens: the access token lives in memory, the refresh token in
 * sessionStorage so a reload keeps a member signed in and closing the tab
 * signs them out. Nothing goes in localStorage: on a shared phone it would
 * outlive the person who used it.
 */

const API_BASE = '/api/portal';

class ApiClient {
  constructor() {
    this.access = null;
    this.tenant = sessionStorage.getItem('portal.tenant') || localStorage.getItem('portal.tenant') || '';
  }

  get refresh() { return sessionStorage.getItem('portal.refresh'); }
  set refresh(v) {
    if (v) sessionStorage.setItem('portal.refresh', v);
    else sessionStorage.removeItem('portal.refresh');
  }

  setTenant(slug) {
    this.tenant = String(slug || '').trim().toLowerCase();
    sessionStorage.setItem('portal.tenant', this.tenant);
    // The SACCO code is not a secret and remembering it saves typing next
    // time. It is the only thing kept beyond the tab.
    localStorage.setItem('portal.tenant', this.tenant);
  }

  setSession(pair) {
    this.access = pair?.accessToken || null;
    this.refresh = pair?.refreshToken || null;
  }

  clearSession() {
    this.access = null;
    this.refresh = null;
  }

  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.tenant) h['X-Tenant'] = this.tenant;
    if (this.access) h.Authorization = `Bearer ${this.access}`;
    return h;
  }

  showLoading(show) {
    const spinner = document.getElementById('loading-spinner');
    if (spinner) spinner.hidden = !show;
  }

  showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
  }

  async refreshSession() {
    const token = this.refresh;
    if (!token) return false;
    const r = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ refreshToken: token }),
    });
    if (!r.ok) { this.clearSession(); return false; }
    this.setSession(await r.json());
    return true;
  }

  /**
   * One request. On a 401 with a refresh token in hand, refresh once and
   * retry; on any other failure, throw an error whose message is the
   * server's reason code, which the app shows as is.
   */
  async request(endpoint, { method = 'GET', body = null, showLoader = true, retry = true } = {}) {
    try {
      if (showLoader) this.showLoading(true);
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method, headers: this.headers(), body: body ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await response.json(); } catch { /* no body */ }

      if (response.status === 401 && retry && this.refresh && !endpoint.startsWith('/auth/')) {
        if (await this.refreshSession()) {
          return this.request(endpoint, { method, body, showLoader, retry: false });
        }
      }
      if (!response.ok) {
        const message = data?.errors?.[0]?.errorReason || data?.error || `HTTP ${response.status}`;
        throw Object.assign(new Error(message), { status: response.status });
      }
      return {
        data,
        total: Number(response.headers.get('items-total') || 0),
        offset: Number(response.headers.get('items-offset') || 0),
        limit: Number(response.headers.get('items-limit') || 0),
      };
    } finally {
      if (showLoader) this.showLoading(false);
    }
  }

  get(endpoint, options = {}) { return this.request(endpoint, { ...options, method: 'GET' }); }
  post(endpoint, body, options = {}) { return this.request(endpoint, { ...options, method: 'POST', body }); }
  delete(endpoint, options = {}) { return this.request(endpoint, { ...options, method: 'DELETE' }); }

  // --- auth ---------------------------------------------------------------

  async activate({ memberNo, nationalId, phone, pin }) {
    return (await this.post('/auth/activate', { memberNo, nationalId, phone, pin })).data;
  }

  async login(phone, pin) {
    const { data } = await this.post('/auth/login', { phone, pin });
    this.setSession(data);
    return data;
  }

  async getCurrentUser() {
    return (await this.get('/me', { showLoader: false })).data;
  }

  async logout() {
    const token = this.refresh;
    this.clearSession();
    if (token) await this.post('/auth/logout', { refreshToken: token }, { showLoader: false }).catch(() => {});
  }

  async changePin(currentPin, newPin) {
    return (await this.post('/auth/pin', { currentPin, newPin })).data;
  }

  // --- accounts -----------------------------------------------------------

  async getAccounts() {
    return (await this.get('/accounts')).data;
  }

  async getTransactionHistory(accountNo, { limit = 20, offset = 0 } = {}) {
    const q = new URLSearchParams({ limit, offset });
    const r = await this.get(`/accounts/${encodeURIComponent(accountNo)}/transactions?${q}`);
    return {
      transactions: r.data || [],
      pagination: { total: r.total, offset: r.offset, limit: r.limit, hasMore: r.offset + (r.data || []).length < r.total },
    };
  }

  async getMiniStatement(accountNo) {
    return this.getTransactionHistory(accountNo, { limit: 5 });
  }

  async getLoanSchedule(accountNo) {
    return (await this.get(`/loans/${encodeURIComponent(accountNo)}/schedule`)).data;
  }

  async getTransactionStats() {
    return (await this.get('/stats', { showLoader: false })).data;
  }

  // --- transfers ----------------------------------------------------------

  async lookupBeneficiary(phone) {
    return (await this.get(`/transfers/lookup?phone=${encodeURIComponent(phone)}`)).data;
  }

  async transferOwnAccounts(fromAccountId, toAccountId, amount, description = '') {
    return (await this.post('/transfers/own', { fromAccountId, toAccountId, amount: Number(amount), description })).data;
  }

  async transferInternal(recipientPhone, amount, description = '', fromAccountId = null) {
    return (await this.post('/transfers/internal', { recipientPhone, amount: Number(amount), description, fromAccountId })).data;
  }

  // --- beneficiaries ------------------------------------------------------

  async getBeneficiaries() { return (await this.get('/beneficiaries')).data; }
  async addBeneficiary(data) { return (await this.post('/beneficiaries', data)).data; }
  async deleteBeneficiary(id) { return (await this.delete(`/beneficiaries/${encodeURIComponent(id)}`)).data; }
}

const api = new ApiClient();
