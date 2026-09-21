#!/usr/bin/env node
'use strict';

const { pool } = require('../src/db/pool');
const { migratePlatform, migrateTenant, migrateAllTenants, drift } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');

const [, , cmd, ...args] = process.argv;

function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

const COMMANDS = {
  async 'migrate:platform'() {
    const done = await migratePlatform();
    console.log(done.length ? `applied: ${done.join(', ')}` : 'platform already up to date');
  },

  async 'migrate:tenant'() {
    const slug = arg('slug');
    if (!slug) throw new Error('--slug is required');
    const t = await provision.getTenantBySlug(slug);
    if (!t) throw new Error(`unknown tenant: ${slug}`);
    const done = await migrateTenant(t.schema_name);
    console.log(done.length ? `${slug}: applied ${done.join(', ')}` : `${slug} already up to date`);
  },

  async 'migrate:all'() {
    const results = await migrateAllTenants();
    for (const r of results) {
      console.log(r.ok
        ? `  ok   ${r.tenant} ${r.applied.length ? '-> ' + r.applied.join(', ') : '(current)'}`
        : `  FAIL ${r.tenant}: ${r.error}`);
    }
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  },

  async drift() {
    const d = await drift();
    console.log(`head: ${d.head} (${d.total} migrations)\n`);
    for (const t of d.tenants) {
      const flag = t.behind ? 'BEHIND' : 'ok    ';
      console.log(`  ${flag} ${t.slug.padEnd(24)} at ${t.at_version}` +
        (t.missing.length ? `  missing: ${t.missing.join(', ')}` : ''));
    }
    if (d.tenants.some((t) => t.behind)) process.exitCode = 1;
  },

  async 'tenant:create'() {
    const t = await provision.provisionTenant({
      slug: arg('slug'),
      name: arg('name', arg('slug')),
      countryCode: arg('country', 'KE'),
      currencyCode: arg('currency', 'KES'),
      adminEmail: arg('admin-email'),
      adminPassword: arg('admin-password'),
      adminName: arg('admin-name'),
    });
    console.log(`provisioned ${t.slug} -> ${t.schema_name} (${t.status})`);
  },

  async 'tenant:list'() {
    const rows = await provision.listTenants();
    if (!rows.length) return console.log('no tenants');
    for (const t of rows) {
      console.log(`  ${t.slug.padEnd(24)} ${t.status.padEnd(12)} ${t.schema_name.padEnd(30)} ${t.name}`);
    }
  },

  async 'tenant:drop'() {
    const slug = arg('slug');
    const out = await provision.deprovisionTenant(slug, { confirm: arg('confirm') });
    console.log(`dropped ${out.dropped}`);
  },
};

(async () => {
  try {
    const fn = COMMANDS[cmd];
    if (!fn) {
      console.log(`usage: cli <command> [options]\n\ncommands:\n  ${Object.keys(COMMANDS).join('\n  ')}`);
      process.exitCode = cmd ? 1 : 0;
      return;
    }
    await fn();
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
