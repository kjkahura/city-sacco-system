'use strict';

const { longRunning } = require('../db/tenantContext');

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth, invalidate } = require('../tenancy/resolve');
const PERMS = require('../lib/permissions');
const ORG = require('../domain/organization');
const CAL = require('../domain/calendar');
const B = require('../domain/branches');
const CH = require('../domain/channels');
const IDT = require('../domain/idTemplates');
const CUR = require('../domain/currencies');
const CF = require('../domain/customFields');
const CFC = require('../domain/customFieldConfig');
const DOCS = require('../domain/productDocuments');
const eod = require('../ops/eod');
const { run } = require('../lib/handlers');

/**
 * Managing the organization (the reference platform's Administration pages): details and
 * branding, end-of-day settings, centres, holidays and non-working days,
 * transaction channels, ID templates, currencies, custom fields and product
 * documents. Each router is mounted by the server under /api.
 */


const W = (fn, status = 200) => run(fn, { write: true, status });
const by = (req) => ({ createdBy: req.auth.email, user: req.auth });

// --- organization details, branding, end of day ---------------------------

const organization = express.Router();
organization.get('/', ...run((c) => ORG.get(c)));
organization.put('/', ...W(async (c, req) => {
  const out = await ORG.update(c, req.body || {}, by(req));
  if (out.tenantChanged) invalidate(out.slug);
  return out.organization;
}));

// The logo is shown on the login screen, before anyone signs in: the image
// is public for the tenant named by the host or X-Tenant header.
organization.get('/branding/:kind', async (req, res, next) => {
  try {
    const img = await withTenantRead(req.tenant.schema_name, (c) => ORG.image(c, req.params.kind));
    res.set('content-type', img.type);
    res.set('cache-control', 'no-cache');
    res.set('x-content-type-options', 'nosniff');
    res.send(img.data);
  } catch (e) { next(e); }
});
organization.put('/branding/:kind', ...W((c, req) => ORG.setImage(c, req.params.kind, req.body || {}, by(req))));
organization.delete('/branding/:kind', ...W((c, req) => ORG.clearImage(c, req.params.kind, by(req))));

organization.get('/eod', ...run(async (c) => {
  const o = await ORG.get(c);
  const { rows: completions } = await c.query('SELECT * FROM eod_completions ORDER BY finished_at DESC LIMIT 20');
  const { rows: [x] } = await c.query('SELECT count(*)::int AS n FROM loan_eod_exclusions WHERE included_at IS NULL');
  return { ...o.eod, timeZone: o.timeZone, eodHour: Number(process.env.EOD_HOUR ?? 22), excludedLoans: x.n, completions };
}));
organization.put('/eod', ...W((c, req) => ORG.setEod(c, req.body || {}, by(req))));
// Run Now, for an organization on manual end of day (the reference platform). The business
// date is the organization's local date unless an earlier one is given.
organization.post('/eod/run', requireAuth(), longRunning, async (req, res, next) => {
  try {
    const s = await withTenantRead(req.tenant.schema_name, (c) => ORG.settings(c));
    if (s.eod_mode !== 'MANUAL') return next(Object.assign(new Error('EOD_IS_AUTOMATIC: switch it to MANUAL to run it now'), { status: 409 }));
    const today = ORG.localClock(req.tenant.timezone || 'Africa/Nairobi').date;
    const date = req.body?.businessDate ? String(req.body.businessDate).slice(0, 10) : today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) return next(Object.assign(new Error('BUSINESS_DATE_CANNOT_BE_IN_THE_FUTURE'), { status: 400 }));
    const out = await eod.runTenant(req.tenant, { businessDate: date, trigger: 'MANUAL', createdBy: req.auth.email });
    res.status(201).json(out);
  } catch (e) { next(e); }
});
organization.post('/eod/retry-excluded', ...W((c) => require('../domain/eodExclusions').retryAll(c, { createdBy: 'EOD_RETRY' })));

// --- centres ----------------------------------------------------------------

const centres = express.Router();
centres.get('/', ...run((c, req) => B.centres(c, { branchId: req.query.branchId || null, includeInactive: req.query.includeInactive !== 'false' })));
centres.get('/:id', ...run((c, req) => B.findCentre(c, req.params.id)));
centres.post('/', ...W((c, req) => B.createCentre(c, { ...req.body, ...by(req) }), 201));
centres.patch('/:id', ...W((c, req) => B.updateCentre(c, req.params.id, { ...req.body, ...by(req) })));

// --- holidays and non-working days ------------------------------------------

const holidays = express.Router();
holidays.get('/', ...run((c, req) => CAL.list(c, { branchId: req.query.branchId || null })));
holidays.post('/', ...W((c, req) => CAL.add(c, req.body || {}, by(req)), 201));
holidays.put('/non-working-days', ...W((c, req) => CAL.setNonWorkingDays(c, req.body?.days, by(req))));
holidays.post('/sync', ...W((c, req) => CAL.sync(c, { createdBy: req.auth.email, force: req.body?.force === true })));
holidays.patch('/:ref', ...W((c, req) => CAL.update(c, req.params.ref, req.body || {}, by(req))));
holidays.delete('/:ref', ...W((c, req) => CAL.remove(c, req.params.ref, by(req))));

// --- transaction channels ---------------------------------------------------

const channels = express.Router();
// ?usable=true: the active channels the signed-in user may post through.
channels.get('/', ...run((c, req) => CH.list(c, req.query.usable === 'true' ? { includeInactive: false, user: req.auth } : {})));
channels.put('/order', ...W((c, req) => CH.rearrange(c, req.body?.order, by(req))));
channels.post('/', ...W((c, req) => CH.create(c, req.body || {}, by(req)), 201));
channels.patch('/:id', ...W((c, req) => CH.update(c, req.params.id, req.body || {}, by(req))));
channels.delete('/:id', ...W((c, req) => CH.remove(c, req.params.id, by(req))));

// --- ID templates ------------------------------------------------------------

const idTemplates = express.Router();
idTemplates.get('/', ...run((c) => IDT.list(c)));
idTemplates.put('/other', ...W((c, req) => IDT.setAllowOther(c, req.body?.allow, by(req))));
idTemplates.post('/', ...W((c, req) => IDT.create(c, req.body || {}, by(req)), 201));
idTemplates.patch('/:id', ...W((c, req) => IDT.update(c, req.params.id, req.body || {}, by(req))));
idTemplates.delete('/:id', ...W((c, req) => IDT.remove(c, req.params.id, by(req))));

// --- currencies ----------------------------------------------------------------

const currencies = express.Router();
currencies.get('/', ...run((c) => CUR.list(c), { write: true }));
currencies.get('/presets', requireAuth(), (req, res) => res.json(CUR.presets()));
currencies.post('/', ...W((c, req) => CUR.add(c, req.body || {}, by(req)), 201));
currencies.patch('/:code', ...W((c, req) => CUR.update(c, req.params.code, req.body || {}, by(req))));
currencies.delete('/:code', ...W((c, req) => CUR.remove(c, req.params.code, by(req))));
currencies.get('/:code/rates', ...run((c, req) => CUR.rates(c, req.params.code)));
currencies.post('/:code/exchange-rates', ...W((c, req) => CUR.setExchangeRate(c, req.params.code, req.body || {}, by(req)), 201));
currencies.post('/:code/accounting-rates', ...W((c, req) => CUR.setAccountingRate(c, req.params.code, req.body || {}, by(req)), 201));
// The reference platform's spelling of the same path (POST and GET /currencies/{code}/accountingRates).
currencies.post('/:code/accountingRates', ...W((c, req) => CUR.setAccountingRate(c, req.params.code, req.body || {}, by(req)), 201));
currencies.get('/:code/accountingRates', ...run(async (c, req) => {
  const r = await CUR.rates(c, req.params.code);
  const { rows: [t] } = await c.query('SELECT code FROM currencies WHERE is_base LIMIT 1');
  return r.accounting.map((x) => ({ encodedKey: String(x.id), rate: Number(x.rate), startDate: x.valid_from,
    fromCurrencyCode: t ? t.code : null, toCurrencyCode: r.currency.code, createdBy: x.created_by ?? null }));
}));

// --- custom fields --------------------------------------------------------------

const customFields = express.Router();
customFields.get('/entities', requireAuth(), (req, res) => res.json({ entities: Object.keys(CF.ENTITIES), types: CF.TYPES }));
customFields.get('/sets', ...run((c, req) => CF.sets(c, req.query.entity || null)));
customFields.post('/sets', ...W((c, req) => CF.createSet(c, req.body || {}, by(req)), 201));
customFields.put('/sets/order', ...W((c, req) => CF.rearrangeSets(c, req.body?.entity, req.body?.order)));
customFields.patch('/sets/:id', ...W((c, req) => CF.updateSet(c, req.params.id, req.body || {}, by(req))));
customFields.delete('/sets/:id', ...W((c, req) => CF.deleteSet(c, req.params.id, by(req))));
customFields.get('/definitions', ...run((c, req) => CF.definitions(c, { entity: req.query.entity || null, setId: req.query.setId || null,
  includeInactive: req.query.includeInactive !== 'false' })));
customFields.post('/definitions', ...W((c, req) => CF.createDefinition(c, req.body || {}, by(req)), 201));
customFields.put('/definitions/order', ...W((c, req) => CF.rearrangeDefinitions(c, req.body?.entity, req.body?.order)));
customFields.get('/definitions/:id', ...run((c, req) => CF.findDefinition(c, req.params.id)));
customFields.patch('/definitions/:id', ...W((c, req) => CF.updateDefinition(c, req.params.id, req.body || {}, by(req))));
customFields.delete('/definitions/:id', ...W((c, req) => CF.deleteDefinition(c, req.params.id, by(req))));
// The values on any record, any state. The entity's own permission, the
// user's branches and the member rules decide who may read or write them
// (CF.assertAccess); each field's rights decide which fields.
customFields.get('/values/:entity/:id', ...run(async (c, req) => {
  const e = CF.entityOf(req.params.entity);
  const r = await CF.assertAccess(c, e.name, req.params.id, req.auth, 'view');
  return CF.getValues(c, e.name, r[e.key], { user: req.auth, record: r });
}));
customFields.put('/values/:entity/:id', ...W(async (c, req) => {
  const e = CF.entityOf(req.params.entity);
  const r = await CF.assertAccess(c, e.name, req.params.id, req.auth, 'edit');
  return CF.setValues(c, e.name, r[e.key], req.body || {}, by(req));
}));

// The reference platform's API v2 metadata: GET /customfields/:id,
// /customfieldsets and /customfieldsets/:id/customfields (../domain/customFieldConfig).
const customFieldsMeta = express.Router();
customFieldsMeta.get('/:id', ...run((c, req) => CFC.customField(c, req.params.id)));
const customFieldSetsMeta = express.Router();
customFieldSetsMeta.get('/', ...run((c, req) => CFC.customFieldSets(c, { availableFor: req.query.availableFor || null })));
customFieldSetsMeta.get('/:id/customfields', ...run((c, req) => CFC.fieldsOfSet(c, req.params.id)));

// Configuration as code: GET and PUT /configuration/customfields.yaml, and the template.
const configuration = express.Router();
const YAML_TYPE = 'application/yaml; charset=utf-8';
configuration.get('/customfields.yaml', ...run(async (c, req, res) => {
  res.type(YAML_TYPE).send(await CFC.configurationYaml(c));
}));
configuration.get('/customfields/template.yaml', requireAuth(), (req, res) => res.type(YAML_TYPE).send(CFC.template()));
configuration.put('/customfields.yaml',
  express.text({ type: ['application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml', 'text/plain', 'application/vnd.*+yaml'], limit: '2mb' }),
  ...W((c, req) => CFC.applyConfiguration(c, typeof req.body === 'string' ? req.body : (req.body || {}), by(req))));

// --- product documents -------------------------------------------------------------

const KINDS = { loan: 'LOAN', savings: 'SAVINGS', deposit: 'SAVINGS' };
const kindOf = (k) => {
  const v = KINDS[String(k).toLowerCase()];
  if (!v) throw Object.assign(new Error('DOCUMENT_KIND_IS_LOAN_OR_SAVINGS'), { status: 400 });
  return v;
};
const documents = express.Router();
documents.get('/templates/:kind/:productId', ...run((c, req) => DOCS.list(c, kindOf(req.params.kind), req.params.productId)));
documents.post('/templates/:kind/:productId', ...W((c, req) => DOCS.create(c, kindOf(req.params.kind), req.params.productId, req.body || {}, by(req)), 201));
documents.get('/templates/:id', ...run((c, req) => DOCS.find(c, req.params.id)));
documents.patch('/templates/:id', ...W((c, req) => DOCS.update(c, req.params.id, req.body || {}, by(req))));
documents.delete('/templates/:id', ...W((c, req) => DOCS.remove(c, req.params.id, by(req))));
documents.get('/:kind/:accountId', ...run((c, req) => DOCS.forAccount(c, kindOf(req.params.kind), req.params.accountId)));
// The document itself, as a page to print or save as PDF.
documents.get('/:kind/:accountId/:docId', requireAuth(), async (req, res, next) => {
  try {
    const out = await withTenantRead(req.tenant.schema_name, (c) => DOCS.generate(c, kindOf(req.params.kind), req.params.accountId, req.params.docId, {
      from: req.query.from || null, to: req.query.to || null, reference: req.query.reference || null,
    }));
    res.set('content-security-policy', DOCS.CSP);
    res.set('x-content-type-options', 'nosniff');
    res.type('html').send(out.html);
  } catch (e) { next(e); }
});

module.exports = { organization, centres, holidays, channels, idTemplates, currencies, customFields, customFieldsMeta, customFieldSetsMeta, configuration, documents };
