'use strict';

const express = require('express');
const R = require('../domain/rates');
const { json } = require('../lib/handlers');
const run = (fn, { write = false, status = 200 } = {}) => json(fn, { write, status });

/**
 * Rate sources and their values (/api/index-rates), the reference platform's
 * Administration > Financial Setup > Rates: index interest rates, and
 * value-added and withholding tax rates (kind VAT or WITHHOLDING). A new
 * index value applies to indexed loans at their next review; a tax value
 * reaches its products on its date.
 */


const router = express.Router();
router.get('/', ...run((c) => R.sources(c)));
router.post('/', ...run((c, req) => R.addSource(c, { ...req.body, createdBy: req.auth.email }), { write: true, status: 201 }));
router.get('/:id/rates', ...run((c, req) => R.ratesOf(c, req.params.id)));
router.post('/:id/rates', ...run((c, req) => R.setIndexRate(c, req.params.id, { ...req.body, createdBy: req.auth.email }), { write: true, status: 201 }));
router.patch('/:id', ...run((c, req) => R.updateSource(c, req.params.id, req.body || {}, { createdBy: req.auth.email }), { write: true }));
router.delete('/:id', ...run((c, req) => R.deleteSource(c, req.params.id, { createdBy: req.auth.email }), { write: true }));
router.patch('/:id/rates/:validFrom', ...run((c, req) =>
  R.editIndexRate(c, req.params.id, req.params.validFrom, req.body || {}, { createdBy: req.auth.email }), { write: true }));
router.delete('/:id/rates/:validFrom', ...run((c, req) =>
  R.deleteIndexRate(c, req.params.id, req.params.validFrom, { createdBy: req.auth.email }), { write: true }));
// The reference platform's TAX_RATE_UPDATE on demand (the end of day runs it every night).
router.post('/tax-update', ...run((c, req) => R.updateTaxRates(c, { date: req.body?.date || undefined }), { write: true }));

module.exports = router;
