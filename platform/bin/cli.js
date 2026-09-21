#!/usr/bin/env node
'use strict';

const { pool } = require('../src/db/pool');
const { migratePlatform, migrateTenant, migrateAllTenants, drift } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const eod = require('../src/ops/eod');
const backup = require('../src/ops/backup');
const tokens = require('../src/auth/tokens');

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

  async 'eod:run'() {
    const results = await eod.runAll({
      businessDate: arg('date'),
      jobs: (arg('jobs') || 'accrueInterest,markArrears').split(','),
      force: args.includes('--force'),
    });
    for (const r of results) {
      console.log(r.error ? `  FAIL ${r.tenant} ${r.job}: ${r.error}`
        : `  ok   ${r.tenant.padEnd(20)} ${r.job.padEnd(16)} ${r.skipped || JSON.stringify(r)}`);
    }
    if (results.some((r) => r.error)) process.exitCode = 1;
  },

  async 'eod:history'() {
    for (const r of await eod.history({ slug: arg('slug'), limit: Number(arg('limit', 30)) })) {
      console.log(`  ${String(r.business_date).slice(0,10)} ${(r.slug||'').padEnd(20)} ` +
        `${r.job.padEnd(16)} ${r.status.padEnd(10)} ${r.error || JSON.stringify(r.detail)}`);
    }
  },

  async 'backup:run'() {
    const slug = arg('slug');
    const out = slug ? [await backup.backupTenant(slug)] : await backup.backupAll({});
    for (const b of out) {
      console.log(b.ok === false ? `  FAIL ${b.slug}: ${b.error}`
        : `  ok   ${b.slug.padEnd(20)} ${(b.bytes/1024).toFixed(1)}KB  ${b.file}`);
    }
    if (out.some((b) => b.ok === false)) process.exitCode = 1;
  },

  async 'backup:verify'() {
    const out = await backup.verifyLatest(arg('slug'));
    console.log(`  ${out.ok ? 'ok  ' : 'FAIL'} ${out.slug}: restored ${out.tablesRestored} tables from ${out.file}`);
    if (!out.ok) process.exitCode = 1;
  },

  async 'backup:prune'() {
    const pruned = await backup.prune({ keep: Number(arg('keep', 14)) });
    console.log(`pruned ${pruned.length} old dumps`);
  },

  async 'tokens:prune'() {
    console.log(`pruned ${await tokens.prune(Number(arg('days', 60)))} expired refresh tokens`);
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
