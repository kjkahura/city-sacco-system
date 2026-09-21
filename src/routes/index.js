'use strict';

const express = require('express');
const store = require('../store');
const { resourceRouter, searchHandler } = require('../lib/resource');

const router = express.Router();

/**
 * Mambu API v2 resource groups.
 *
 * Every group below gets the baseline contract from resourceRouter:
 * list, get, create, update, patch, delete, search.
 *
 * Groups with real domain behaviour (loans, deposits, accounting) are mounted
 * from their own modules before this map is applied, so their action routes
 * take precedence.
 */
const GROUPS = {
  // group path                collection                      options
  'apiconsumers':             [store.API_CONSUMERS,            { name: 'api consumer' }],
  'branches':                 [store.BRANCHES,                 { name: 'branch' }],
  'cards':                    [store.CARDS,                    { name: 'card' }],
  'centres':                  [store.CENTRES,                  { name: 'centre' }],
  'clients':                  [store.MEMBERS,                  { name: 'client', altIdFields: ['kwaraId'] }],
  'comments':                 [store.COMMENTS,                 { name: 'comment' }],
  'communications':           [store.COMMUNICATIONS,           { name: 'communication' }],
  'configuration':            [store.CONFIGURATIONS,           { name: 'configuration' }],
  'creditarrangements':       [store.CREDIT_ARRANGEMENTS,      { name: 'credit arrangement' }],
  'currencies':               [store.CURRENCIES,               { name: 'currency', idField: 'code' }],
  'customfields':             [store.CUSTOM_FIELDS,            { name: 'custom field' }],
  'customfieldsets':          [store.CUSTOM_FIELD_SETS,        { name: 'custom field set' }],
  'dataimport':               [store.DATA_IMPORTS,             { name: 'data import' }],
  'database/backup':          [store.DATABASE_BACKUPS,         { name: 'database backup' }],
  'depositproducts':          [store.DEPOSIT_PRODUCTS,         { name: 'deposit product' }],
  'documents':                [store.DOCUMENTS,                { name: 'document' }],
  'exchangerates':            [store.EXCHANGE_RATES,           { name: 'exchange rate' }],
  'fundingsources':           [store.FUNDING_SOURCES,          { name: 'funding source' }],
  'groups':                   [store.GROUPS,                   { name: 'group' }],
  'holidays':                 [store.HOLIDAYS,                 { name: 'holiday' }],
  'idtemplates':              [store.ID_TEMPLATES,             { name: 'id template' }],
  'indexratesources':         [store.INDEX_RATES,              { name: 'index rate' }],
  'islamicfinancing':         [store.ISLAMIC_FINANCING,        { name: 'islamic financing' }],
  'loanproducts':             [store.LOAN_PRODUCTS,            { name: 'loan product' }],
  'notificationsettings':     [store.NOTIFICATION_SETTINGS,    { name: 'notification setting' }],
  'notifications':            [store.NOTIFICATIONS,            { name: 'notification' }],
  'organization':             [store.ORGANIZATION,             { name: 'organization' }],
  'profitsharing':            [store.PROFIT_SHARING,           { name: 'profit sharing' }],
  'shareproducts':            [store.SHARE_PRODUCTS,           { name: 'share product' }],
  'shares':                   [store.SHARES,                   { name: 'share' }],
  'streaming/publishers':     [store.STREAMING_PUBLISHERS,     { name: 'streaming publisher' }],
  'subscriptions':            [store.SUBSCRIPTIONS,            { name: 'subscription' }],
  'tasks':                    [store.TASKS,                    { name: 'task' }],
  'templates':                [store.TEMPLATES,                { name: 'template' }],
  'transactionchannels':      [store.TRANSACTION_CHANNELS,     { name: 'transaction channel' }],
  'users':                    [store.USERS,                    { name: 'user', idField: 'email' }],
  // Background / EOD jobs keep their collections but are read-mostly.
  'backgroundprocess':        [store.BACKGROUND_PROCESSES,     { name: 'background process' }],
  'endofdayprocessing':       [store.WORKFLOWS,                { name: 'end of day process' }],
  'bulkoperations':           [store.DATA_IMPORTS,             { name: 'bulk operation' }],
  'generalsetup':             [store.CONFIGURATIONS,           { name: 'general setup' }],
};

const mounted = [];
for (const [path, [collection, opts]] of Object.entries(GROUPS)) {
  if (!Array.isArray(collection)) {
    // A collection that is missing from the store would silently 404 every
    // route under it, so fail loudly at boot instead.
    throw new Error(`Route group "${path}" has no backing collection in store.js`);
  }
  // Mambu's POST /resource:search lives at the parent level; a colon suffix
  // cannot match a sub-router mount point.
  router.post(`/${path}:search`, searchHandler(collection, opts));
  router.use(`/${path}`, resourceRouter(collection, opts));
  mounted.push(path);
}

router._mountedGroups = mounted;
module.exports = router;
