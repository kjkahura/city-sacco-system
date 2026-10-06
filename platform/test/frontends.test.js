#!/usr/bin/env node
'use strict';

/**
 * The front ends are deployed apart from the API (README, "The front ends,
 * deployed apart from the API"). These checks hold the line between them:
 * the console and portal reach the server only through /api on their own
 * origin and import nothing outside their own folder; the headers they carry
 * are the same from this server and from the load balancer's buckets; and
 * the API runs without serving them (SERVE_FRONTENDS=off).
 */

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const ROOT = path.join(__dirname, '..');
const DIRS = { console: path.join(ROOT, 'public'), portal: path.join(ROOT, 'portal') };
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

async function serve(app, port) {
  return new Promise((ok) => { const s = app.listen(port, () => ok(s)); });
}

async function main() {
  const FRONTEND = require('../src/lib/frontendHeaders');

  section('the front ends depend on nothing but the API');
  for (const [kind, dir] of Object.entries(DIRS)) {
    const files = walk(dir).filter((f) => f.endsWith('.js'));
    const outside = [];
    const absolute = [];
    const notApi = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
        const target = path.resolve(path.dirname(f), m[1]);
        if (!m[1].startsWith('.') || !target.startsWith(dir + path.sep)) outside.push(`${path.relative(ROOT, f)}: ${m[1]}`);
      }
      if (/\brequire\s*\(/.test(src)) outside.push(`${path.relative(ROOT, f)}: require()`);
      for (const m of src.matchAll(/fetch\(\s*(['"`])([^'"`]*)/g)) {
        if (/^https?:/i.test(m[2])) absolute.push(`${path.relative(ROOT, f)}: ${m[2]}`);
        else if (m[2].startsWith('/') && !m[2].startsWith('/api/')) notApi.push(`${path.relative(ROOT, f)}: ${m[2]}`);
      }
    }
    check(`${kind}: every import stays inside its own folder`, files.length > 0 && outside.length === 0, outside.join(', '));
    check(`${kind}: no request goes to another origin`, absolute.length === 0, absolute.join(', '));
    check(`${kind}: every literal request path is under /api`, notApi.length === 0, notApi.join(', '));
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc=/.test(m[1]) || m[2].trim());
    check(`${kind}: index.html has no inline script (the CSP refuses it)`, inline.length === 0, String(inline.length));
  }
  check('the app launch page\'s script is in the console (routes/apps loads /console/js/appframe.js)',
    fs.existsSync(path.join(DIRS.console, 'js', 'appframe.js')));

  section('the same headers wherever the files are served from');
  const edge = fs.readFileSync(path.join(ROOT, 'deploy', 'security', 'edge.sh'), 'utf8');
  check('the console bucket\'s CSP in edge.sh is the server\'s', edge.includes(`CONSOLE_CSP="${FRONTEND.csp('console')}"`), FRONTEND.csp('console'));
  check('the portal bucket\'s CSP in edge.sh is the server\'s', edge.includes(`PORTAL_CSP="${FRONTEND.csp('portal')}"`), FRONTEND.csp('portal'));
  for (const name of ['X-Content-Type-Options: nosniff', 'Referrer-Policy: same-origin', `Strict-Transport-Security: ${FRONTEND.HSTS}`]) {
    check(`the buckets carry ${name.split(':')[0]}`, edge.includes(`"${name}"`));
  }

  section('served by this server (SERVE_FRONTENDS on, the default)');
  delete process.env.SERVE_FRONTENDS;
  const on = await serve(require('../src/server'), 4141);
  try {
    for (const kind of FRONTEND.KINDS) {
      const r = await fetch(`http://localhost:4141/${kind}/`);
      const body = await r.text();
      check(`/${kind}/ is served with its CSP`, r.status === 200 && /<html/i.test(body)
        && r.headers.get('content-security-policy') === FRONTEND.csp(kind, { allowHttpFrames: process.env.CALLBACK_ALLOW_PRIVATE === 'true' }),
      `${r.status} ${r.headers.get('content-security-policy')}`);
    }
  } finally { on.close(); }

  section('the API without the front ends (SERVE_FRONTENDS=off)');
  process.env.SERVE_FRONTENDS = 'off';
  delete require.cache[require.resolve('../src/server')];
  const off = await serve(require('../src/server'), 4142);
  try {
    const c = await fetch('http://localhost:4142/console/');
    const p = await fetch('http://localhost:4142/portal/index.html');
    check('/console/ and /portal/ are not served', c.status === 404 && p.status === 404, `${c.status} ${p.status}`);
    const h = await fetch('http://localhost:4142/healthcheck');
    check('the API still answers', h.status === 200 || h.status === 503, String(h.status));
    const a = await fetch('http://localhost:4142/api/auth/me');
    check('and its routes are unchanged (an unauthenticated call is refused, not missing)', a.status === 401 || a.status === 400, String(a.status));
  } finally {
    off.close();
    delete process.env.SERVE_FRONTENDS;
  }
}

main()
  .catch((e) => { fail++; failures.push(`threw: ${e.stack}`); console.error(`\nFAILED: ${e.stack}`); })
  .finally(async () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    try { await require('../src/db/pool').pool.end(); } catch { /* not opened */ }
    process.exit(fail ? 1 : 0);
  });
