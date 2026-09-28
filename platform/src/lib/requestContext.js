'use strict';

const { AsyncLocalStorage } = require('async_hooks');

/**
 * The signed-in user of the request being served, for code that runs below
 * the routes without being handed it: db/tenantContext puts the user's email
 * and whether they must post cash through a till into the transaction's
 * session settings, where the till triggers read them. Set by requireAuth;
 * empty for background jobs, which are not tellers.
 */
const store = new AsyncLocalStorage();

const run = (ctx, fn) => store.run(ctx, fn);
const current = () => store.getStore() || null;

module.exports = { run, current };
