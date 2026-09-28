'use strict';

const { withTenantRead } = require('../db/tenantContext');

/**
 * The general ledger for a user limited to some branches (Users and Access
 * Control's branch access, carried to accounting). Row security is not put
 * on the journal: the daily balance rollups are written by triggers as
 * entries post, and hiding rows from them would corrupt them. The limit is
 * applied to the reports instead, here, before their routes run:
 *
 *   - a report that takes a branch (balance sheet, income statement, trial
 *     balance, the accounting reports API) is run for one of the user's
 *     branches: their only one when they name none, and refused when they
 *     name another branch or entries with none (NONE);
 *   - the journal is filtered to lines of the user's branches;
 *   - what can only be read for the whole organization (GL balances, the
 *     rollup check, prudential ratios and limits, returns, provisioning,
 *     financial years) is refused with ALL_BRANCH_ACCESS_REQUIRED.
 *
 * A user with every branch sees no change.
 */

const err = (m, status = 403) => Object.assign(new Error(m), { status });

const BRANCH_REPORTS = [
  ['GET', /^\/reports\/balance-sheet\/?$/, 'query'],
  ['GET', /^\/reports\/income-statement\/?$/, 'query'],
  ['GET', /^\/accounting\/trial-balance\/?$/, 'query'],
  ['POST', /^\/accounting\/reports\/?$/, 'body'],
];
const ORG_ONLY = [
  ['GET', /^\/accounting\/gl\/?$/], ['GET', /^\/accounting\/verify\/?$/],
  ['GET', /^\/reports\/prudential\/?$/], ['GET', /^\/reports\/limits\/?$/],
  ['GET', /^\/returns(\/.*)?$/], ['GET', /^\/provisioning(\/.*)?$/], ['GET', /^\/periods(\/.*)?$/],
];

async function branchIdOf(req, v) {
  const s = String(v);
  if (s.toUpperCase() === 'NONE') return null;
  const { rows: [b] } = await withTenantRead(req.tenant.schema_name, (c) => c.query('SELECT id FROM branches WHERE id::text = $1 OR code = $1', [s]));
  return b ? b.id : undefined;
}

function ledgerScope() {
  return async (req, res, next) => {
    try {
      const u = req.auth;
      if (!u || !Array.isArray(u.branches)) return next();
      const p = req.path;
      if (ORG_ONLY.some(([m, re]) => m === req.method && re.test(p))) {
        throw err('ALL_BRANCH_ACCESS_REQUIRED: this is read for the whole organization');
      }
      const spec = BRANCH_REPORTS.find(([m, re]) => m === req.method && re.test(p));
      if (spec) {
        const src = spec[2] === 'body' ? (req.body && typeof req.body === 'object' ? req.body : {}) : { ...req.query };
        let id;
        if (src.branchId === undefined || src.branchId === null || src.branchId === '') {
          if (u.branches.length !== 1) throw err('BRANCH_REQUIRED: your access is limited to some branches; give branchId');
          id = u.branches[0];
        } else {
          id = await branchIdOf(req, src.branchId);
          if (id === undefined) throw err('BRANCH_NOT_FOUND', 404);
          if (!id || !u.branches.includes(id)) throw err('OUTSIDE_YOUR_BRANCH_ACCESS');
        }
        src.branchId = id;
        if (spec[2] === 'body') req.body = src;
        else Object.defineProperty(req, 'query', { value: src, configurable: true, enumerable: true, writable: true });
      }
      if (req.method === 'GET' && /^\/accounting\/journal\/?$/.test(p)) {
        req.ledgerBranches = u.branches;
      }
      return next();
    } catch (e) { return next(e); }
  };
}

module.exports = { ledgerScope };
