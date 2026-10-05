'use strict';

/**
 * Getting Started (the reference platform's initial setup): the steps a new
 * SACCO goes through, in the order its setup pages give them, each with its
 * state read from the book itself:
 *
 *   DONE     the SACCO has done it
 *   DEFAULT  the platform's seeded defaults are in place; changing them is optional
 *   TODO     not done yet
 *
 * `done` counts the required steps that are DONE, and `defaults` those left at the seeded defaults.
 *
 * `screen` is the console route of the page where the step is done.
 */

const fs = require('fs');
const path = require('path');
const { SEED_GL } = require('../tenancy/provision');

// The accounts every book starts with: provisioning's chart and those the tenant migrations add.
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations', 'tenant');
const SEED_GL_CODES = [...new Set([...SEED_GL.map(([code]) => code), ...fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))
  .flatMap((f) => (fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').match(/INSERT INTO gl_accounts[\s\S]*?;/g) || []))
  .flatMap((stmt) => stmt.match(/\d{3}-\d{3}/g) || [])])];
const n = async (c, sql, params = []) => Number((await c.query(sql, params)).rows[0].n);

const STEPS = [
  ['organization', 'Organization details: address, phone, email and formats', 'admin/general', false, async (c) => {
    const o = (await c.query('SELECT street_address, phone, email FROM organization_settings LIMIT 1')).rows[0] || {};
    return o.street_address || o.phone || o.email ? 'DONE' : 'TODO';
  }],
  ['branches', 'Branches and centres', 'admin/organization', false, async (c) => ((await n(c, 'SELECT count(*) AS n FROM branches')) ? 'DONE' : 'TODO')],
  ['holidays', 'Holidays and non-working days', 'admin/general', true, async (c) => ((await n(c, 'SELECT count(*) AS n FROM holidays')) ? 'DONE' : 'TODO')],
  ['roles', 'User roles (the built-in ones are ready to use)', 'admin/access', true, async (c) => ((await n(c, 'SELECT count(*) AS n FROM roles')) ? 'DONE' : 'DEFAULT')],
  ['users', 'Staff users', 'admin/access', false, async (c) => ((await n(c,
    'SELECT count(*) AS n FROM platform.users u JOIN platform.tenants t ON t.id = u.tenant_id WHERE t.schema_name = current_schema()')) > 1 ? 'DONE' : 'TODO')],
  ['customFields', 'Custom fields for the forms', 'admin/fields', true, async (c) => ((await n(c, 'SELECT count(*) AS n FROM custom_field_definitions')) ? 'DONE' : 'TODO')],
  ['clientTypes', 'Client and group types (Client and Group are ready)', 'admin/clients', true, async (c) => ((await n(c, 'SELECT count(*) AS n FROM client_types')) > 2 ? 'DONE' : 'DEFAULT')],
  ['channels', 'Transaction channels (cash and the standard ones are ready)', 'admin/general', true, async (c) =>
    ((await n(c, "SELECT count(*) AS n FROM transaction_channels WHERE id NOT IN ('cash', 'mpesa', 'bank', 'cheque', 'payroll', 'internal', 'settlement', 'transfer')")) ? 'DONE' : 'DEFAULT')],
  ['currencies', 'Currencies and exchange rates (the base currency is set)', 'admin/general', false, async (c) =>
    ((await n(c, 'SELECT count(*) AS n FROM currencies WHERE NOT is_base')) || (await n(c, 'SELECT count(*) AS n FROM exchange_rates')) ? 'DONE' : 'DEFAULT')],
  ['rates', 'Index interest rates and tax rates', 'admin/general', true, async (c) => ((await n(c, 'SELECT count(*) AS n FROM index_rates')) ? 'DONE' : 'TODO')],
  ['loanProducts', 'Loan products', 'admin/products', false, async (c) => ((await n(c, "SELECT count(*) AS n FROM loan_products WHERE id <> 'NL01'")) ? 'DONE' : 'DEFAULT')],
  ['depositProducts', 'Deposit products', 'admin/products', false, async (c) => ((await n(c, "SELECT count(*) AS n FROM savings_products WHERE id <> 'SAV01'")) ? 'DONE' : 'DEFAULT')],
  ['accounting', 'Accounting settings and the chart of accounts (a starting chart is set)', 'admin/accounting', false, async (c) =>
    ((await n(c, 'SELECT count(*) AS n FROM gl_accounts WHERE NOT (code = ANY($1))', [SEED_GL_CODES]))
      || (await c.query('SELECT gl_suspense FROM accounting_settings LIMIT 1')).rows[0]?.gl_suspense !== '290-900' ? 'DONE' : 'DEFAULT')],
  ['members', 'Members and groups, typed or imported', 'members', false, async (c) => ((await n(c, 'SELECT count(*) AS n FROM members')) ? 'DONE' : 'TODO')],
];

async function checklist(c) {
  const steps = [];
  for (const [key, title, screen, optional, state] of STEPS) steps.push({ key, title, screen, optional, state: await state(c) });
  const required = steps.filter((s) => !s.optional);
  return { steps, done: required.filter((s) => s.state === 'DONE').length, defaults: required.filter((s) => s.state === 'DEFAULT').length, of: required.length };
}

module.exports = { checklist, STEPS };
