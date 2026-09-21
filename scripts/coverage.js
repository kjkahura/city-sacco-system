#!/usr/bin/env node
'use strict';

/**
 * Walks the Express app and prints every mounted route, then reports which of
 * Mambu API v2's 40 resource groups are covered.
 *
 * Run: npm run coverage
 */

process.env.PORT = process.env.PORT || '0';
process.env.SILENT = '1';

const path = require('path');
const app = require(path.join(__dirname, '..', 'server.js'));

// Mambu API v2 resource groups, taken from the reference navigation at
// https://docs.mambu.com/api/pages/api-v2/welcome/ (read 2026-09-21).
const MAMBU_GROUPS = {
  'Accounting': ['accounting'],
  'API Consumers': ['apiconsumers'],
  'Background Process': ['backgroundprocess'],
  'Branches': ['branches'],
  'Bulk Operations': ['bulkoperations', 'transactions/bulk'],
  'Cards': ['cards'],
  'Centres': ['centres'],
  'Clients': ['clients'],
  'Comments': ['comments'],
  'Communications': ['communications'],
  'Configuration as Code': ['configuration'],
  'Credit Arrangements': ['creditarrangements'],
  'Currencies': ['currencies'],
  'Custom Fields': ['customfields', 'customfieldsets'],
  'Data Import': ['dataimport'],
  'Database Backup': ['database/backup'],
  'Deposits': ['deposits', 'depositproducts'],
  'Documents': ['documents'],
  'End of Day Processing': ['endofdayprocessing'],
  'Exchange Rates': ['exchangerates'],
  'Funding Sources': ['fundingsources'],
  'General Ledger Accounts': ['glaccounts'],
  'General Setup': ['generalsetup'],
  'Groups': ['groups'],
  'Holidays': ['holidays'],
  'ID Templates': ['idtemplates'],
  'Index Rates': ['indexratesources'],
  'Islamic Financing': ['islamicfinancing'],
  'Journal Entries': ['journalentries'],
  'Loans': ['loans', 'loanproducts'],
  'Notification Settings': ['notificationsettings'],
  'Organization': ['organization'],
  'Process Orchestration': ['endofdayprocessing'],
  'Profit Sharing': ['profitsharing'],
  'Streaming Publisher': ['streaming/publishers'],
  'Subscription': ['subscriptions'],
  'Tasks': ['tasks'],
  'Templates': ['templates'],
  'Transaction Channels': ['transactionchannels'],
  'Users': ['users'],
};

function collect(stack, prefix = '') {
  const out = [];
  for (const layer of stack || []) {
    if (layer.route) {
      const p = prefix + layer.route.path;
      for (const m of Object.keys(layer.route.methods)) {
        if (layer.route.methods[m]) out.push(`${m.toUpperCase()} ${p}`);
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      const src = layer.regexp?.source || '';
      const seg = src
        .replace('^\\/', '/')
        .replace('\\/?(?=\\/|$)', '')
        .replace(/\\\//g, '/')
        .replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, ':param')
        .replace(/\$$/, '')
        .replace(/\?\(\?=\/\|\$\)/, '');
      out.push(...collect(layer.handle.stack, prefix + (seg === '/' ? '' : seg)));
    }
  }
  return out;
}

const routes = [...new Set(collect(app._router?.stack))].sort();
const v2 = routes.filter((r) => r.includes('/api/v2'));
const legacy = routes.filter((r) => r.includes('/api/') && !r.includes('/api/v2'));

const covered = [];
const missing = [];
for (const [group, paths] of Object.entries(MAMBU_GROUPS)) {
  const hit = paths.some((p) => v2.some((r) => r.includes(p)));
  (hit ? covered : missing).push(group);
}

if (process.argv.includes('--routes')) {
  console.log('\n--- all routes ---');
  routes.forEach((r) => console.log(' ', r));
}

console.log('\nRoute counts');
console.log(`  legacy dashboard API (/api/*)   ${legacy.length}`);
console.log(`  Mambu v2 API (/api/v2/*)        ${v2.length}`);
console.log(`  total                           ${routes.length}`);

console.log(`\nMambu v2 resource groups: ${covered.length}/${Object.keys(MAMBU_GROUPS).length} mounted`);
if (missing.length) {
  console.log('  not mounted:');
  missing.forEach((m) => console.log(`    - ${m}`));
} else {
  console.log('  all groups mounted');
}

console.log('\nNote: "mounted" means the group has routes, not that every one of');
console.log('Mambu\'s documented operations for it is implemented. Deep coverage');
console.log('exists for Loans, Deposits and Accounting; other groups have the');
console.log('baseline list/get/create/update/patch/delete/search contract only.\n');

process.exit(missing.length ? 1 : 0);
