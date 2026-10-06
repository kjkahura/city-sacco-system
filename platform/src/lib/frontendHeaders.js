'use strict';

/**
 * The response headers of the two front ends: the back office console
 * (/console) and the member portal (/portal). They are static files with no
 * build step, and they talk to the API only through /api on the same origin.
 *
 * The same headers are set wherever the files are served from: by this
 * server (SERVE_FRONTENDS, on by default), or by the load balancer's
 * backend buckets in production (deploy/security/edge.sh, which carries a
 * copy of these strings; test/frontends.test.js keeps the two the same).
 */

const HSTS = 'max-age=31536000; includeSubDomains';
const BASE = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'";

/**
 * Apps (routes/apps) open in a frame in the console: the launch page here, then
 * the app's own HTTPS page. Plain http frames only where private callbacks are
 * allowed (development).
 */
function csp(kind, { allowHttpFrames = false } = {}) {
  if (kind === 'console') {
    return `${BASE}; frame-src 'self' https:${allowHttpFrames ? ' http:' : ''}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
  }
  if (kind === 'portal') return `${BASE}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
  throw new Error(`unknown front end: ${kind}`);
}

/** Every header a front end's files carry, as name and value pairs. */
function headers(kind, opts = {}) {
  return {
    'Content-Security-Policy': csp(kind, opts),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...(process.env.NODE_ENV === 'production' ? { 'Strict-Transport-Security': HSTS } : {}),
  };
}

/** Whether this server serves the front ends' files itself (SERVE_FRONTENDS, default on). */
const serveFrontends = () => process.env.SERVE_FRONTENDS !== 'off';

module.exports = { csp, headers, serveFrontends, HSTS, KINDS: ['console', 'portal'] };
