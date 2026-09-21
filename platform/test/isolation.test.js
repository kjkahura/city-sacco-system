#!/usr/bin/env node
'use strict';

/**
 * Tenant isolation tests.
 *
 * With real member data on the line, "the schemas are separate" is a claim,
 * not a fact, until something proves it. These tests try to break the
 * boundary the way a bug or an attacker would.
 */

const assert = require('assert');
const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { withTenant, withTenantRead, assertSchemaName } = require('../src/db/tenantContext');
const { migratePlatform, migrateTenant, drift } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const { hashPassword } = require('../src/auth/passwords');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}
async function throws(label, fn, matcher) {
  try { await fn(); check(label, false, 'did not throw'); }
  catch (e) { check(label, matcher ? matcher(e) : true, e.message.slice(0, 120)); }
}

const PORT = 4099;
let server;
const B = () => `http://localhost:${PORT}`;

async function call(method, path, { token, tenant, host, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant'] = tenant;
  if (host) headers.host = host;
  const r = await fetch(B() + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, body: d };
}

(async () => {
  server = app.listen(PORT);

  try {
    section('setup');
    await migratePlatform();
    for (const slug of ['citysacco', 'washasacco']) {
      await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [slug])
        .then(async (r) => { if (r.rowCount) await provision.deprovisionTenant(slug, { confirm: slug }); });
      await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [slug]);
    }
    await pool.query("DELETE FROM platform.users WHERE email LIKE '%@isolationtest.local'");

    const a = await provision.provisionTenant({
      slug: 'citysacco', name: 'City SACCO',
      adminEmail: 'admin@isolationtest.local', adminPassword: 'correct horse battery',
    });
    const b = await provision.provisionTenant({
      slug: 'washasacco', name: 'Washa SACCO',
      adminEmail: 'admin@isolationtest.local', adminPassword: 'a different long passphrase',
    });
    check('provisioned two tenants', a.status === 'ACTIVE' && b.status === 'ACTIVE');
    check('distinct schemas', a.schema_name === 'tenant_citysacco' && b.schema_name === 'tenant_washasacco');
    check('same admin email allowed in both tenants', true);

    section('schema name validation');
    for (const bad of ['public', 'tenant_x; DROP SCHEMA public CASCADE', 'TENANT_Upper', '../etc', '']) {
      let threw = false;
      try { assertSchemaName(bad); } catch { threw = true; }
      check(`rejects unsafe schema name ${JSON.stringify(bad).slice(0, 40)}`, threw);
    }
    await throws('reserved slug refused', () => provision.provisionTenant({
      slug: 'public', name: 'x', adminEmail: 'a@b.co', adminPassword: 'aaaaaaaaaaaa',
    }));
    await throws('slug with SQL refused', () => provision.provisionTenant({
      slug: 'x"; DROP SCHEMA public; --', name: 'x', adminEmail: 'a@b.co', adminPassword: 'aaaaaaaaaaaa',
    }));

    section('data does not cross schemas');
    await withTenant('tenant_citysacco', (c) => c.query(
      `INSERT INTO members (member_no, first_name, last_name) VALUES ('M000001','Grace','Njeri')`));
    await withTenant('tenant_washasacco', (c) => c.query(
      `INSERT INTO members (member_no, first_name, last_name) VALUES ('M000001','Peter','Otieno')`));

    const cityMembers = await withTenantRead('tenant_citysacco', async (c) =>
      (await c.query('SELECT member_no, first_name FROM members')).rows);
    const washaMembers = await withTenantRead('tenant_washasacco', async (c) =>
      (await c.query('SELECT member_no, first_name FROM members')).rows);

    check('city sees only its own member', cityMembers.length === 1 && cityMembers[0].first_name === 'Grace',
      JSON.stringify(cityMembers));
    check('washa sees only its own member', washaMembers.length === 1 && washaMembers[0].first_name === 'Peter',
      JSON.stringify(washaMembers));
    check('same member_no reused across tenants', cityMembers[0].member_no === washaMembers[0].member_no);

    section('search_path does not leak across pooled connections');
    // Interleave many queries across both tenants concurrently. If SET LOCAL
    // were a plain SET, a connection returned to the pool would carry the last
    // tenant's search_path and some of these would read the wrong schema.
    const interleaved = await Promise.all(
      Array.from({ length: 60 }, (_, i) => {
        const schema = i % 2 ? 'tenant_washasacco' : 'tenant_citysacco';
        const want = i % 2 ? 'Peter' : 'Grace';
        return withTenantRead(schema, async (c) =>
          ((await c.query('SELECT first_name FROM members')).rows[0]?.first_name === want));
      })
    );
    check('60 interleaved cross-tenant reads all correct', interleaved.every(Boolean),
      `${interleaved.filter(Boolean).length}/60`);

    // And confirm a borrowed connection has no tenant search_path by default.
    const leaked = await pool.query('SHOW search_path');
    check('pool default search_path carries no tenant',
      !/tenant_/.test(leaked.rows[0].search_path), leaked.rows[0].search_path);

    section('token cannot be pointed at another tenant');
    const login = await call('POST', '/api/auth/login', {
      tenant: 'citysacco', body: { email: 'admin@isolationtest.local', password: 'correct horse battery' },
    });
    check('login returns an access token', login.status === 200 && !!login.body?.accessToken, JSON.stringify(login.body).slice(0, 120));
    const cityToken = login.body?.accessToken;

    const wrongPw = await call('POST', '/api/auth/login', {
      tenant: 'citysacco', body: { email: 'admin@isolationtest.local', password: 'a different long passphrase' },
    });
    check('washa password rejected on city tenant', wrongPw.status === 401);

    const own = await call('GET', '/api/members', { token: cityToken, tenant: 'citysacco' });
    check('city token reads city members', own.status === 200 && own.body.length === 1
      && own.body[0].first_name === 'Grace', JSON.stringify(own.body).slice(0, 120));

    const crossHeader = await call('GET', '/api/members', { token: cityToken, tenant: 'washasacco' });
    check('city token + washa header is rejected', crossHeader.status === 403,
      `${crossHeader.status} ${JSON.stringify(crossHeader.body).slice(0, 90)}`);

    // fetch refuses to set Host, so exercise the resolver directly rather
    // than pretending an unreachable request proved anything.
    const { tenantFromRequest } = require('../src/tenancy/resolve');
    const stubReq = (host, hdrs) => ({
      hostname: host,
      get(name) { return hdrs[name.toLowerCase()] || null; },
    });
    check('token tenant wins on a matching host',
      tenantFromRequest(stubReq('citysacco.core.example.com',
        { authorization: `Bearer ${cityToken}` })) === 'citysacco');
    let hostRejected = false;
    try {
      tenantFromRequest(stubReq('washasacco.core.example.com',
        { authorization: `Bearer ${cityToken}` }));
    } catch (e) { hostRejected = e.status === 403; }
    check('city token + washa host is rejected', hostRejected);
    check('subdomain alone resolves when unauthenticated',
      tenantFromRequest(stubReq('washasacco.core.example.com', {})) === 'washasacco');
    check('www and api are not treated as tenants',
      tenantFromRequest(stubReq('api.core.example.com', {})) === null);

    const noToken = await call('GET', '/api/members', { tenant: 'citysacco' });
    check('no token is rejected', noToken.status === 401, String(noToken.status));

    const forged = await call('GET', '/api/members', {
      token: 'eyJhbGciOiJub25lIn0.eyJ0aWQiOiJjaXR5c2FjY28iLCJyb2xlIjoiVEVOQU5UX0FETUlOIn0.',
      tenant: 'citysacco',
    });
    check('alg=none token is rejected', forged.status === 401, String(forged.status));

    const unknown = await call('GET', '/api/members', { tenant: 'doesnotexist' });
    check('unknown tenant is 404', unknown.status === 404, String(unknown.status));

    section('database enforces accounting rules, not just app code');
    await throws('unbalanced journal entry refused by the database', () =>
      withTenant('tenant_citysacco', async (c) => {
        const { rows } = await c.query(
          "INSERT INTO journal_entries (narration) VALUES ('bad') RETURNING id");
        await c.query(
          `INSERT INTO journal_lines (entry_id, gl_code, direction, amount, line_no)
           VALUES ($1,'100-210','DEBIT',100,1), ($1,'200-100','CREDIT',90,2)`, [rows[0].id]);
      }), (e) => /unbalanced/i.test(e.message));

    const entryId = await withTenant('tenant_citysacco', async (c) => {
      const { rows } = await c.query(
        "INSERT INTO journal_entries (narration) VALUES ('good') RETURNING id");
      await c.query(
        `INSERT INTO journal_lines (entry_id, gl_code, direction, amount, line_no)
         VALUES ($1,'100-210','DEBIT',100,1), ($1,'200-100','CREDIT',100,2)`, [rows[0].id]);
      return rows[0].id;
    });
    check('balanced entry commits', !!entryId);

    await throws('posted journal line cannot be updated', () =>
      withTenant('tenant_citysacco', (c) =>
        c.query('UPDATE journal_lines SET amount = 1 WHERE entry_id = $1', [entryId])),
      (e) => /immutable/i.test(e.message));

    await throws('posted journal line cannot be deleted', () =>
      withTenant('tenant_citysacco', (c) =>
        c.query('DELETE FROM journal_lines WHERE entry_id = $1', [entryId])),
      (e) => /immutable/i.test(e.message));

    const washaEntries = await withTenantRead('tenant_washasacco', async (c) =>
      (await c.query('SELECT count(*)::int AS n FROM journal_entries')).rows[0].n);
    check('journal entries did not appear in the other tenant', washaEntries === 0, String(washaEntries));

    section('rollback leaves nothing behind');
    await throws('failed transaction rolls back', () =>
      withTenant('tenant_citysacco', async (c) => {
        await c.query(`INSERT INTO members (member_no, first_name, last_name) VALUES ('M999','Ghost','Row')`);
        throw new Error('deliberate failure');
      }));
    const ghost = await withTenantRead('tenant_citysacco', async (c) =>
      (await c.query("SELECT count(*)::int AS n FROM members WHERE member_no='M999'")).rows[0].n);
    check('rolled-back insert is not visible', ghost === 0, String(ghost));

    section('migration ledger');
    const d = await drift();
    check('both tenants at head', d.tenants.length >= 2 && d.tenants.every((t) => !t.behind),
      JSON.stringify(d.tenants.map((t) => [t.slug, t.at_version])));
    check('drift reports a head version', !!d.head, String(d.head));

    section('cleanup');
    await provision.deprovisionTenant('citysacco', { confirm: 'citysacco' });
    await provision.deprovisionTenant('washasacco', { confirm: 'washasacco' });
    const gone = await pool.query(
      "SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name IN ('tenant_citysacco','tenant_washasacco')");
    check('schemas dropped', gone.rows[0].n === 0, String(gone.rows[0].n));
    await pool.query("DELETE FROM platform.users WHERE email LIKE '%@isolationtest.local'");
    await pool.query("DELETE FROM platform.tenants WHERE slug IN ('citysacco','washasacco')");
  } catch (e) {
    fail++;
    failures.push(`threw: ${e.stack}`);
    console.error(e);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log(failures.map((f) => `  - ${f}`).join('\n'));
  server.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
