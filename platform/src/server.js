'use strict';

const path = require('path');
const express = require('express');
const { pool } = require('./db/pool');
const { resolveTenant, requireAuth } = require('./tenancy/resolve');
const { apiError } = require('./lib/http');
const { rateLimit, tenantConcurrency, stats, store } = require('./lib/limits');
const provision = require('./tenancy/provision');
const { drift } = require('./db/migrate');
const eod = require('./ops/eod');
const backup = require('./ops/backup');

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
    res.json({
      status: 'ok',
      time: new Date().toISOString(),
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      rateStore: store.health(),
    });
  } catch (e) {
    res.status(503).json({ status: 'degraded', error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Back office console
//
// Static files, no build step, no server-side rendering: the console is an
// ordinary API client that happens to be served from the same origin. It
// carries no secrets, so it needs no authentication to fetch; everything it
// can actually do still goes through the API with a token.
//
// The CSP is strict and self-only. There is no CDN and no inline script, so
// a stored cross-site payload in a member name has nowhere to execute.
// ---------------------------------------------------------------------------
const CONSOLE_DIR = path.join(__dirname, '..', 'public');
app.use('/console', (req, res, next) => {
  res.set('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
}, express.static(CONSOLE_DIR, { index: 'index.html', maxAge: '5m' }));

app.get('/', (_req, res) => res.redirect(302, '/console/'));

// ---------------------------------------------------------------------------
// Control plane. Platform admins only; never tenant-scoped.
// ---------------------------------------------------------------------------
const admin = express.Router();
admin.use(resolveTenant({ required: false }), requireAuth('PLATFORM_ADMIN'));

const wrap = (fn) => async (req, res, next) => {
  try { res.json(await fn(req)); } catch (e) { next(e); }
};

admin.get('/tenants', wrap(() => provision.listTenants()));
admin.post('/tenants', async (req, res, next) => {
  try { res.status(201).json(await provision.provisionTenant(req.body || {})); } catch (e) { next(e); }
});
admin.get('/migrations/drift', wrap(() => drift()));
admin.get('/limits', wrap(() => stats()));

admin.post('/eod/run', wrap((req) => eod.runAll(req.body || {})));
admin.get('/eod/history', wrap((req) => eod.history(req.query)));

admin.post('/backups/run', wrap((req) => (req.body?.slug
  ? backup.backupTenant(req.body.slug)
  : backup.backupAll({}))));
admin.post('/backups/prune', wrap((req) => backup.prune(req.body || {})));
admin.post('/backups/verify', wrap((req) => backup.verifyLatest(req.body?.slug)));
admin.post('/backups/rekey', wrap((req) => backup.rekeyAll(req.body || {})));
admin.get('/backups/keys', wrap(() => backup.keyReport({})));

app.use('/admin', admin);

// ---------------------------------------------------------------------------
// Tenant plane. Everything below is bound to exactly one SACCO.
// ---------------------------------------------------------------------------
const tenantApi = express.Router();
tenantApi.use(resolveTenant({ required: true }));
tenantApi.use(rateLimit());
tenantApi.use(tenantConcurrency());

tenantApi.use('/auth', require('./routes/auth'));

const members = require('./routes/members');
tenantApi.post('/members:search', ...members.searchMembers);
tenantApi.use('/members', members);

const savings = require('./routes/savings');
tenantApi.use('/savings', savings);
tenantApi.use('/loans', require('./routes/loans'));
tenantApi.use('/accounting', savings.accounting);

const shares = require('./routes/shares');
tenantApi.use('/shares', shares);
tenantApi.use('/dividends', shares.dividends);
tenantApi.use('/reports', require('./routes/reports'));

const finance = require('./routes/finance');
tenantApi.use('/provisioning', finance.provisioning);
tenantApi.use('/periods', finance.periods);
tenantApi.use('/returns', finance.returns);

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
  store.connect().then((info) => console.log('[ratestore]', JSON.stringify(info)));
  app.listen(port, () => console.log(`sacco platform listening on :${port}`));
  if (process.env.SCHEDULER === 'on') require('./ops/scheduler').start({});
}

module.exports = app;
