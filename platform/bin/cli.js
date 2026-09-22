#!/usr/bin/env node
'use strict';

const { pool } = require('../src/db/pool');
const { migratePlatform, migrateTenant, migrateAllTenants, drift } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const eod = require('../src/ops/eod');
const backup = require('../src/ops/backup');
const tokens = require('../src/auth/tokens');
const { withTenant, withTenantRead } = require('../src/db/tenantContext');
const PV = require('../src/domain/provisioning');
const CL = require('../src/domain/close');
const RT = require('../src/domain/returns');

const [, , cmd, ...args] = process.argv;

function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

/** Run a block inside one tenant's schema. Every per-tenant command needs it. */
async function inTenant(fn, { read = false } = {}) {
  const slug = arg('slug');
  if (!slug) throw new Error('--slug is required');
  const t = await provision.getTenantBySlug(slug);
  if (!t) throw new Error(`unknown tenant: ${slug}`);
  return (read ? withTenantRead : withTenant)(t.schema_name, fn);
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

  async 'backup:rekey'() {
    const out = await backup.rekeyAll({ slug: arg('slug') });
    console.log(`current key: ${out.currentKeyId}`);
    for (const f of out.files) {
      console.log(f.skipped ? `  --   ${f.slug}/${f.file} ${f.skipped}`
        : f.ok ? `  ok   ${f.slug}/${f.file} ${f.from} -> ${f.to}`
        : `  FAIL ${f.slug}/${f.file}: ${f.error}`);
    }
    if (out.files.some((f) => f.ok === false)) process.exitCode = 1;
  },

  async 'backup:keys'() {
    for (const r of backup.keyReport({})) {
      console.log(`  ${r.slug.padEnd(20)} v${r.version ?? '?'} key=${r.keyId || '(v1, unlabelled)'}  ${r.file}`);
    }
  },

  // --- provisioning, close and returns, per tenant ------------------------

  async 'provision:bands'() {
    await inTenant(async (c) => {
      const rate = arg('rate');
      if (arg('band')) {
        const b = await PV.setBand(c, arg('band'), {
          ratePercent: rate === undefined ? undefined : Number(rate),
          sourceNote: arg('note'),
          createdBy: arg('by', 'cli'),
        });
        console.log(`  set ${b.code} -> ${b.rate_percent ?? '(unset)'}%`);
      }
      for (const b of await PV.bands(c)) {
        console.log(`  ${b.code.padEnd(12)} ${String(b.min_days).padStart(4)}..` +
          `${String(b.max_days ?? '').padStart(4) || '   +'}  ` +
          `${b.rate_percent === null ? 'NOT SET' : `${b.rate_percent}%`}`);
      }
    });
  },

  async 'provision:preview'() {
    await inTenant(async (c) => {
      const p = await PV.compute(c, { asAt: arg('date') });
      for (const l of p.lines) {
        console.log(`  ${l.band.padEnd(12)} ${String(l.loans).padStart(5)} loans  ` +
          `${l.outstanding.toFixed(2).padStart(16)} x ${l.rate}% = ${l.required.toFixed(2)}`);
      }
      console.log(`  required ${p.requiredTotal.toFixed(2)}  held ${p.heldTotal.toFixed(2)}  ` +
        `movement ${p.movement.toFixed(2)}`);
    }, { read: true });
  },

  async 'provision:run'() {
    await inTenant(async (c) => {
      const out = await PV.run(c, { asAt: arg('date'), createdBy: arg('by', 'cli') });
      console.log(out.skipped
        ? `  skipped: ${out.skipped} for ${out.asAt}`
        : `  posted movement ${out.movement.toFixed(2)} as at ${out.asAt} (entry ${out.entryId || 'none'})`);
    });
  },

  async 'year:open'() {
    await inTenant(async (c) => {
      const y = await CL.openYear(c, {
        year: Number(arg('year')), startsOn: arg('from'), endsOn: arg('to'), createdBy: arg('by', 'cli'),
      });
      console.log(`  opened ${y.year}: ${String(y.starts_on).slice(0, 10)} to ${String(y.ends_on).slice(0, 10)}`);
    });
  },

  async 'year:preview'() {
    await inTenant(async (c) => {
      const p = await CL.preview(c, Number(arg('year')));
      console.log(`  income ${p.totalIncome.toFixed(2)}  expenses ${p.totalExpenses.toFixed(2)}  ` +
        `surplus ${p.surplus.toFixed(2)}`);
      console.log(p.configured
        ? `  reserve ${p.reservePercent}% = ${p.reserveAmount.toFixed(2)}, retained ${p.retainedAmount.toFixed(2)}`
        : '  reserve percentage NOT SET: closing will be refused until it is');
    }, { read: true });
  },

  async 'year:close'() {
    await inTenant(async (c) => {
      const out = await CL.close(c, Number(arg('year')), { createdBy: arg('by', 'cli') });
      console.log(`  closed ${out.year}: surplus ${out.surplus.toFixed(2)}, ` +
        `reserve ${out.reserveAmount.toFixed(2)}, retained ${out.retainedAmount.toFixed(2)}`);
    });
  },

  async 'year:reopen'() {
    await inTenant(async (c) => {
      const out = await CL.reopen(c, Number(arg('year')), {
        reason: arg('reason', ''), createdBy: arg('by', 'cli') });
      console.log(`  reopened ${out.year}`);
    });
  },

  async 'returns:load'() {
    const file = arg('file');
    if (!file) throw new Error('--file is required');
    const def = JSON.parse(require('fs').readFileSync(file, 'utf8'));
    await inTenant(async (c) => {
      const t = await RT.loadTemplate(c, def, { createdBy: arg('by', 'cli') });
      console.log(`  loaded ${t.code}: ${t.lines.length} lines, official=${t.is_official}`);
    });
  },

  async 'returns:render'() {
    await inTenant(async (c) => {
      const r = await RT.render(c, arg('code'), { asAt: arg('date'), from: arg('from'), to: arg('to') });
      console.log(`  ${r.name}${r.official ? '' : '   [NOT AN OFFICIAL RETURN]'}`);
      for (const l of r.lines) {
        console.log(l.heading
          ? `\n  ${l.label}`
          : `  ${l.ref.padEnd(5)} ${l.label.padEnd(42)} ${l.value === null ? '-' : l.value.toFixed(2).padStart(16)}`);
      }
    }, { read: true });
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
