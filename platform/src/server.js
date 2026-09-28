'use strict';

const path = require('path');
const express = require('express');
const { pool } = require('./db/pool');
const { resolveTenant, requireAuth, permissionGate } = require('./tenancy/resolve');
const auditTrail = require('./ops/auditTrail');
const { apiError } = require('./lib/http');
const { rateLimit, tenantConcurrency, stats, store } = require('./lib/limits');
const provision = require('./tenancy/provision');
const { drift } = require('./db/migrate');
const eod = require('./ops/eod');
const backup = require('./ops/backup');
const { nullHandling } = require('./lib/apiStandards');

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

// The member portal, same rules as the console: static, self-only CSP, an
// ordinary API client on the same origin. Members never see /console and
// staff never sign in here; the API enforces that, the paths just make it
// obvious.
const PORTAL_DIR = path.join(__dirname, '..', 'portal');
app.use('/portal', (req, res, next) => {
  res.set('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
}, express.static(PORTAL_DIR, { index: 'index.html', maxAge: '5m' }));

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
// The reference platform's null handling, on request (./lib/apiStandards).
tenantApi.use(nullHandling());
tenantApi.use(resolveTenant({ required: true }));
tenantApi.use(auditTrail.recorder());
tenantApi.use(rateLimit());
tenantApi.use(tenantConcurrency());
// What each route needs (lib/routePermissions), before any route runs.
tenantApi.use(permissionGate());
// The general ledger for a branch-limited user (lib/ledgerScope).
tenantApi.use(require('./lib/ledgerScope').ledgerScope());

tenantApi.use('/auth', require('./routes/auth'));

// ?viewfilter= on the list endpoints (the reference platform's custom views with API v1),
// ahead of the routers; without the parameter the request goes on to them.
const views = require('./routes/views');
tenantApi.get('/members', ...views.viewfilter('MEMBERS'));
tenantApi.get('/clients', ...views.viewfilter('MEMBERS'));
tenantApi.get('/groups', ...views.viewfilter('GROUPS'));
tenantApi.get('/loans', ...views.viewfilter('LOANS'));
tenantApi.get('/loans/transactions', ...views.viewfilter('LOAN_TRANSACTIONS', { required: true }));
tenantApi.get('/savings', ...views.viewfilter('DEPOSITS'));
tenantApi.get('/savings/transactions', ...views.viewfilter('DEPOSIT_TRANSACTIONS', { required: true }));
tenantApi.get('/accounting/journal', ...views.viewfilter('JOURNAL_ENTRIES'));
tenantApi.get('/activities', ...views.viewfilter('ACTIVITIES', { required: true }));
tenantApi.get('/tasks', ...views.viewfilter('TASKS'));
tenantApi.use('/views', views);
const menus = require('./routes/menus');
tenantApi.use('/menu', menus.menu);
tenantApi.use('/menu-items', menus.items);
tenantApi.use('/roles', require('./routes/roles'));
tenantApi.use('/tasks', require('./routes/tasks'));
tenantApi.use('/tills', require('./routes/tills'));
tenantApi.use('/report-templates', require('./routes/reportTemplates'));

// The reference platform's colon actions (/members:search) escape the colon: unescaped, Express
// reads ':search' as a route parameter and the paths overlap.
const members = require('./routes/members');
tenantApi.post('/members\\:search', ...members.searchMembers);
tenantApi.post('/members\\:duplicates', ...members.checkDuplicates);
tenantApi.post('/members\\:reassign', ...members.reassignMembers);
tenantApi.use('/members', members);
// The reference platform's API v2 for clients and groups, and their setup (./routes/clients).
const clientRoutes = require('./routes/clients');
tenantApi.post('/clients\\:search', ...clientRoutes.searchClients);
tenantApi.post('/groups\\:search', ...clientRoutes.searchGroups);
tenantApi.use('/clients', clientRoutes.clients);
tenantApi.use('/groups', clientRoutes.groups);
tenantApi.use('/client-types', clientRoutes.types);
tenantApi.use('/group-role-names', clientRoutes.roleNames);
tenantApi.use('/client-controls', clientRoutes.controls);

const savings = require('./routes/savings');
tenantApi.use('/savings', savings);
tenantApi.use('/loans', require('./routes/loans'));
tenantApi.use('/loan-products', require('./routes/loanProducts'));
tenantApi.use('/index-rates', require('./routes/indexRates'));
tenantApi.use('/accounting/reports', require('./routes/reports').accountingReports);
tenantApi.use('/accounting', savings.accounting);
const branchRoutes = require('./routes/branches');
tenantApi.use('/branches', branchRoutes.branches);
tenantApi.use('/accounting', branchRoutes.accounting);
tenantApi.use('/deposit-products', require('./routes/depositProducts'));
const org = require('./routes/organization');
tenantApi.use('/organization', org.organization);
tenantApi.use('/centres', org.centres);
tenantApi.use('/holidays', org.holidays);
tenantApi.use('/transaction-channels', org.channels);
tenantApi.use('/id-templates', org.idTemplates);
tenantApi.use('/currencies', org.currencies);
tenantApi.use('/custom-fields', org.customFields);
tenantApi.use('/documents', org.documents);
tenantApi.use('/users', require('./routes/users'));
const access = require('./routes/access');
tenantApi.use('/access-preferences', access.prefs);
tenantApi.use('/consumers', access.consumers);
tenantApi.use('/audit-trail', access.trail);
tenantApi.use('/profile', access.profile);

const data = require('./routes/dataManagement');
tenantApi.use('/data-dictionary', data.dictionary);
tenantApi.use('/extract', data.extract);
tenantApi.use('/database', data.database);
tenantApi.use('/data-imports', data.imports);
tenantApi.use('/data', data.importApi);

const shares = require('./routes/shares');
tenantApi.use('/shares', shares);
tenantApi.use('/dividends', shares.dividends);
tenantApi.use('/reports', require('./routes/reports'));
tenantApi.use('/portal', require('./routes/portal'));

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
  // The ledger's own locks (closed year, accounting closure, savings floor)
  // raise from triggers; they are refusals, not server faults.
  const dbRefusal = err.code === '23001' || err.code === '23514';
  // Row security (branch access) and the till's permission checks.
  if (err.code === '42501' && /row-level security/.test(err.message || '')) err.message = 'OUTSIDE_YOUR_BRANCH_ACCESS';
  const status = err.status || (err.code === '42501' ? 403 : err.code === '22023' ? 400 : dbRefusal ? 409 : 500);
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
