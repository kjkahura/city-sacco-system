'use strict';

const express = require('express');
const { pool } = require('./db/pool');
const { resolveTenant, requireAuth } = require('./tenancy/resolve');
const { apiError } = require('./lib/http');
const provision = require('./tenancy/provision');
const { drift } = require('./db/migrate');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');
// Behind a load balancer the tenant subdomain arrives in X-Forwarded-Host.
// Enable only when a trusted proxy actually sets it. Note that even if a
// client forges the header, the JWT tenant claim still wins and a mismatch
// is rejected, so the worst case is a 403 rather than a cross-tenant read.
app.set('trust proxy', process.env.TRUST_PROXY === 'true');

// ---------------------------------------------------------------------------
// Unauthenticated
// ---------------------------------------------------------------------------
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'degraded', error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Control plane. Platform admins only; never tenant-scoped.
// ---------------------------------------------------------------------------
const admin = express.Router();
admin.use(resolveTenant({ required: false }), requireAuth('PLATFORM_ADMIN'));

admin.get('/tenants', async (_req, res, next) => {
  try { res.json(await provision.listTenants()); } catch (e) { next(e); }
});

admin.post('/tenants', async (req, res, next) => {
  try { res.status(201).json(await provision.provisionTenant(req.body || {})); } catch (e) { next(e); }
});

admin.get('/migrations/drift', async (_req, res, next) => {
  try { res.json(await drift()); } catch (e) { next(e); }
});

app.use('/admin', admin);

// ---------------------------------------------------------------------------
// Tenant plane. Everything below is bound to exactly one SACCO.
// ---------------------------------------------------------------------------
const tenantApi = express.Router();
tenantApi.use(resolveTenant({ required: true }));

tenantApi.use('/auth', require('./routes/auth'));
const members = require('./routes/members');
tenantApi.post('/members:search', ...members.searchMembers);
tenantApi.use('/members', members);

const savings = require('./routes/savings');
tenantApi.use('/savings', savings);
tenantApi.use('/loans', require('./routes/loans'));
tenantApi.use('/accounting', savings.accounting);

tenantApi.get('/', requireAuth(), (req, res) => res.json({
  tenant: req.tenant.slug,
  name: req.tenant.name,
  currency: req.tenant.currency_code,
  timezone: req.tenant.timezone,
}));

app.use('/api', tenantApi);

// ---------------------------------------------------------------------------
app.use((req, res) => apiError(res, 404, 404, 'ROUTE_NOT_FOUND', req.path));

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  apiError(res, status, status, err.message || 'INTERNAL_ERROR');
});

if (require.main === module) {
  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => console.log(`sacco platform listening on :${port}`));
}

module.exports = app;
