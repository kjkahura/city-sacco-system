'use strict';

/**
 * The reference platform's API standards, where the platform follows them by request.
 *
 * Nulls. The reference platform leaves a field out of a response when it has no value. This
 * API returns every column, null or not, because the console and the tests
 * read fields by name and an absent field and a null one would otherwise
 * both have to be handled. A client that wants the reference platform's behaviour asks for it
 * with the reference platform's media type (Accept: application/vnd.sacco.v2+json) or with
 * ?nulls=omit, and gets the same body with every null field removed, at any
 * depth. Nulls inside an array stay: an array's positions mean something.
 */

const VENDOR_V2 = 'application/vnd.sacco.v2+json';

function omitNulls(v) {
  if (Array.isArray(v)) return v.map(omitNulls);
  if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === null || x === undefined) continue;
      out[k] = omitNulls(x);
    }
    return out;
  }
  return v;
}

const wantsNullsOmitted = (req) =>
  String(req.get('accept') || '').toLowerCase().includes(VENDOR_V2)
  || String(req.query?.nulls || '').toLowerCase() === 'omit';

/** Express middleware: wraps res.json when the request asks for it. */
function nullHandling() {
  return (req, res, next) => {
    if (wantsNullsOmitted(req)) {
      const json = res.json.bind(res);
      res.json = (body) => json(omitNulls(body));
      res.set('x-nulls', 'omitted');
    }
    next();
  };
}

module.exports = { omitNulls, wantsNullsOmitted, nullHandling, VENDOR_V2 };
