'use strict';

const { pageParams } = require('../lib/page');
const H = require('../lib/handlers');
const TS = require('../domain/transactionSearch');

/**
 * POST /api/loans/transactions:search and POST /api/deposits/transactions:search:
 * every loan or deposit transaction matching { filterCriteria, sortingCriteria },
 * paged by offset and limit, with Items-Total when paginationDetails=ON.
 * The permission (the account kind's view permission) is in lib/routePermissions.
 */

const searchOf = (side) => H.run(async (c, req, res) => {
  const body = req.body || {};
  const pg = pageParams({ ...req.query, ...body });
  const out = await TS.search(c, side, body, pg);
  H.pagingHeaders(req, res, { ...pg, total: out.total });
  return out.rows;
});

module.exports = { loans: searchOf('LOAN'), deposits: searchOf('DEPOSIT') };
