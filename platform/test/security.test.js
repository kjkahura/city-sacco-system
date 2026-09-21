#!/usr/bin/env node
'use strict';

/**
 * MFA, distributed rate limiting, and encrypted offsite backups.
 *
 * These are the three things that stood between the platform and real
 * member data, so each is tested by trying to defeat it rather than by
 * confirming the happy path works.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.BACKUP_ENCRYPTION_KEY = process.env.BACKUP_ENCRYPTION_KEY
  || crypto.randomBytes(48).toString('base64');

const OFFSITE = path.join(__dirname, '..', '.tmp-offsite');
const LOCAL = path.join(__dirname, '..', '.tmp-backups2');
process.env.BACKUP_OFFSITE = `dir:${OFFSITE}`;

const app = require('../src/server');
const { pool } = require('../src/db/pool');
const { migratePlatform, migrateAllTenants } = require('../src/db/migrate');
const provision = require('../src/tenancy/provision');
const totp = require('../src/auth/totp');
const mfa = require('../src/auth/mfa');
const crypt = require('../src/ops/crypt');
const offsite = require('../src/ops/offsite');
const backup = require('../src/ops/backup');
const store = require('../src/lib/ratestore');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}
async function throws(label, fn, matcher) {
  try { await fn(); check(label, false, 'did not throw'); }
  catch (e) { check(label, matcher ? matcher(e) : true, e.message.slice(0, 140)); }
}

const SLUG = 'sectest';
const PORT = 4097;
let server;

async function call(method, p, { token, tenant = SLUG, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant'] = tenant;
  const r = await fetch(`http://localhost:${PORT}${p}`,
    { method, headers, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, body: d };
}

(async () => {
  server = app.listen(PORT);
  try {
    section('setup');
    await migratePlatform();
    const ex = await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG]);
    if (ex.rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({
      slug: SLUG, name: 'Security Test SACCO',
      adminEmail: 'admin@sectest.local', adminPassword: 'a sufficiently long passphrase',
    });
    await migrateAllTenants({});
    const hasMfa = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='platform' AND table_name='users' AND column_name='mfa_enabled'");
    check('mfa migration applied', hasMfa.rowCount === 1);

    // The seeded admin is TENANT_ADMIN, which the default policy requires
    // MFA for. Add a teller who does not, to test both paths.
    const { hashPassword } = require('../src/auth/passwords');
    const tenantRow = (await pool.query('SELECT * FROM platform.tenants WHERE slug=$1', [SLUG])).rows[0];
    await pool.query(
      `INSERT INTO platform.users (tenant_id, email, password_hash, full_name, role)
       VALUES ($1,'teller@sectest.local',$2,'Teller','TELLER')`,
      [tenantRow.id, await hashPassword('another long teller passphrase')]
    );

    section('TOTP primitive');
    const secret = totp.generateSecret();
    check('secret is 32 base32 chars', /^[A-Z2-7]{32}$/.test(secret), secret);
    const now = Date.now();
    const c1 = totp.code(secret, { at: now });
    check('code is six digits', /^\d{6}$/.test(c1), c1);
    check('same step gives the same code', totp.code(secret, { at: now + 1000 }) === c1);
    check('next step gives a different code', totp.code(secret, { at: now + 31_000 }) !== c1);
    check('verify accepts the current code', totp.verify(c1, secret, { at: now }).ok);
    check('verify accepts one step of drift',
      totp.verify(totp.code(secret, { at: now - 30_000 }), secret, { at: now }).ok);
    check('verify rejects three steps of drift',
      !totp.verify(totp.code(secret, { at: now - 90_000 }), secret, { at: now }).ok);
    check('verify rejects a wrong code', !totp.verify('000000', secret, { at: now }).ok
      || totp.code(secret, { at: now }) === '000000');
    check('verify rejects nonsense', !totp.verify('abcdef', secret).ok);
    check('provisioning uri is otpauth', totp.provisioningUri({ secret, account: 'a@b.co' })
      .startsWith('otpauth://totp/'));

    // RFC 6238 test vector: secret "12345678901234567890" (ASCII) at T=59
    // is 94287082 for SHA-1 with 8 digits.
    const rfcSecret = totp.base32Encode(Buffer.from('12345678901234567890', 'ascii'));
    check('matches the RFC 6238 test vector',
      totp.code(rfcSecret, { at: 59_000, digits: 8 }) === '94287082',
      totp.code(rfcSecret, { at: 59_000, digits: 8 }));

    section('MFA is demanded of the roles the tenant requires');
    const adminLogin = await call('POST', '/api/auth/login', {
      body: { email: 'admin@sectest.local', password: 'a sufficiently long passphrase' } });
    check('admin with correct password gets no session yet',
      adminLogin.status === 403 && adminLogin.body.enrolmentRequired === true,
      JSON.stringify(adminLogin.body).slice(0, 120));

    const tellerLogin = await call('POST', '/api/auth/login', {
      body: { email: 'teller@sectest.local', password: 'another long teller passphrase' } });
    check('teller is not forced into MFA', tellerLogin.status === 200 && !!tellerLogin.body.accessToken);

    section('a fresh tenant admin can bootstrap out of the MFA requirement');
    // Requiring MFA for an admin who has not enrolled would be a deadlock
    // without this: no session without a code, no code without a session.
    const enrolToken = adminLogin.body.enrolmentToken;
    check('the 403 carries an enrolment-scoped token', !!enrolToken);
    const scopedElsewhere = await call('GET', '/api/members', { token: enrolToken });
    check('the enrolment token is useless on ordinary routes',
      scopedElsewhere.status === 403, String(scopedElsewhere.status));
    const bootstrapEnrol = await call('POST', '/api/auth/mfa/enrol', { token: enrolToken });
    check('but it does reach the enrolment endpoint',
      bootstrapEnrol.status === 200 && !!bootstrapEnrol.body.secret,
      JSON.stringify(bootstrapEnrol.body).slice(0, 100));

    section('enrolment');
    // Enrol the admin out of band, the way the first-run flow would.
    const adminId = (await pool.query(
      "SELECT id FROM platform.users WHERE email='admin@sectest.local'")).rows[0].id;
    const enrol = await mfa.beginEnrolment({ id: adminId, email: 'admin@sectest.local' });
    check('enrolment returns a secret and a uri', !!enrol.secret && enrol.uri.includes(enrol.secret));

    const stillOff = await pool.query('SELECT mfa_enabled FROM platform.users WHERE id=$1', [adminId]);
    check('mfa is not on until the code is proven', stillOff.rows[0].mfa_enabled === false);

    await throws('confirm rejects a wrong code',
      () => mfa.completeEnrolment(adminId, '000001'), (e) => /INVALID_MFA_CODE/.test(e.message));

    const done = await mfa.completeEnrolment(adminId, totp.code(enrol.secret));
    check('confirm enables mfa and returns recovery codes',
      done.enabled && done.recoveryCodes.length === 10, String(done.recoveryCodes?.length));
    const recovery = done.recoveryCodes;

    section('login with a second factor');
    const step1 = await call('POST', '/api/auth/login', {
      body: { email: 'admin@sectest.local', password: 'a sufficiently long passphrase' } });
    check('password alone yields a ticket, not a token',
      step1.status === 200 && step1.body.mfaRequired === true
      && !!step1.body.mfaTicket && !step1.body.accessToken,
      JSON.stringify(step1.body).slice(0, 120));

    const bad = await call('POST', '/api/auth/mfa/verify', {
      body: { mfaTicket: step1.body.mfaTicket, code: '000000' } });
    check('wrong code is rejected', bad.status === 401, String(bad.status));

    // Enrolment consumed the current counter, which is correct anti-replay
    // behaviour. Use the next time step, which still verifies inside the
    // +1 drift window but carries a different counter.
    const nextStepCode = () => totp.code(enrol.secret, { at: Date.now() + 30_000 });
    const good = await call('POST', '/api/auth/mfa/verify', {
      body: { mfaTicket: step1.body.mfaTicket, code: nextStepCode() } });
    check('correct code yields a session', good.status === 200 && !!good.body.accessToken,
      JSON.stringify(good.body).slice(0, 120));

    const reuseTicket = await call('POST', '/api/auth/mfa/verify', {
      body: { mfaTicket: step1.body.mfaTicket, code: nextStepCode() } });
    check('a consumed ticket cannot be reused', reuseTicket.status === 401, String(reuseTicket.status));

    section('an observed code cannot be replayed inside its window');
    const step2 = await call('POST', '/api/auth/login', {
      body: { email: 'admin@sectest.local', password: 'a sufficiently long passphrase' } });
    const replay = await call('POST', '/api/auth/mfa/verify', {
      body: { mfaTicket: step2.body.mfaTicket, code: nextStepCode() } });
    check('the same code at the same counter is refused',
      replay.status === 401 && /ALREADY_USED/.test(JSON.stringify(replay.body)),
      JSON.stringify(replay.body).slice(0, 120));

    section('recovery codes');
    const step3 = await call('POST', '/api/auth/login', {
      body: { email: 'admin@sectest.local', password: 'a sufficiently long passphrase' } });
    const rec = await call('POST', '/api/auth/mfa/verify', {
      body: { mfaTicket: step3.body.mfaTicket, recoveryCode: recovery[0] } });
    check('a recovery code logs you in', rec.status === 200 && !!rec.body.accessToken);
    check('and reports how many are left', rec.body.recoveryCodesRemaining === 9,
      String(rec.body.recoveryCodesRemaining));

    const step4 = await call('POST', '/api/auth/login', {
      body: { email: 'admin@sectest.local', password: 'a sufficiently long passphrase' } });
    const recAgain = await call('POST', '/api/auth/mfa/verify', {
      body: { mfaTicket: step4.body.mfaTicket, recoveryCode: recovery[0] } });
    check('a spent recovery code is refused', recAgain.status === 401, String(recAgain.status));

    section('ticket brute force is bounded');
    const step5 = await call('POST', '/api/auth/login', {
      body: { email: 'admin@sectest.local', password: 'a sufficiently long passphrase' } });
    let burned = false;
    for (let i = 0; i < 7; i += 1) {
      const r = await call('POST', '/api/auth/mfa/verify', {
        body: { mfaTicket: step5.body.mfaTicket, code: '111111' } });
      if (/TOO_MANY_MFA_ATTEMPTS/.test(JSON.stringify(r.body))) { burned = true; break; }
    }
    check('ticket is burned after repeated wrong codes', burned);

    section('distributed rate limiting');
    const info = await store.connect({ url: process.env.REDIS_URL, log: () => {} });
    check('rate store connected to redis', info.backend === 'redis', JSON.stringify(info));

    const key = `rl:test:${crypto.randomUUID()}`;
    const first = await store.incr(key, 60_000);
    const second = await store.incr(key, 60_000);
    check('counter increments across calls', first.count === 1 && second.count === 2);
    check('counter is served by redis', second.backend === 'redis', second.backend);

    // The point of Redis: a second process sees the same counter. Simulate
    // by talking to the same key from a fresh client.
    const { createClient } = require('redis');
    const other = createClient({ url: process.env.REDIS_URL });
    await other.connect();
    const seen = Number(await other.get(key));
    check('another process sees the same counter', seen === 2, String(seen));
    await other.quit();

    const ttl = second.resetMs;
    check('window has a ttl so the key expires', ttl > 0 && ttl <= 60_000, String(ttl));
    await store.reset(key);
    const afterReset = await store.incr(key, 60_000);
    check('reset clears the counter', afterReset.count === 1, String(afterReset.count));

    section('rate limiter fails open rather than locking everyone out');
    await store.disconnect();
    const degradedKey = `rl:test:${crypto.randomUUID()}`;
    const deg = await store.incr(degradedKey, 60_000);
    check('falls back to memory when redis is gone',
      deg.backend === 'memory' && deg.count === 1, JSON.stringify(deg));
    check('health reports the backend', /memory|redis/.test(store.health().backend),
      JSON.stringify(store.health()));

    section('backup encryption');
    fs.rmSync(LOCAL, { recursive: true, force: true });
    fs.rmSync(OFFSITE, { recursive: true, force: true });

    const b = await backup.backupTenant(SLUG, { dir: LOCAL });
    check('backup is encrypted', b.encrypted === true && b.file.endsWith('.enc'), b.file);
    check('plaintext dump is not left on disk',
      !fs.existsSync(b.file.replace(/\.enc$/, '')), 'plaintext still present');

    const meta = crypt.inspect(b.file);
    check('file carries the format magic and key id',
      meta.version === 2 && /^[0-9a-f]{8}$/.test(meta.keyId), JSON.stringify(meta));

    const raw = fs.readFileSync(b.file);
    check('ciphertext does not contain the schema name in clear',
      !raw.includes(Buffer.from('tenant_sectest')), 'schema name visible in ciphertext');

    section('tamper detection');
    const copy = path.join(LOCAL, 'tampered.enc');
    fs.copyFileSync(b.file, copy);
    const buf = fs.readFileSync(copy);
    buf[Math.floor(buf.length / 2)] ^= 0xff;      // flip a byte in the middle
    fs.writeFileSync(copy, buf);
    await throws('an altered backup fails to decrypt',
      () => crypt.decryptFile(copy, `${copy}.out`),
      (e) => /authentication|altered|wrong key/i.test(e.message));

    const savedKey = process.env.BACKUP_ENCRYPTION_KEY;
    process.env.BACKUP_ENCRYPTION_KEY = crypto.randomBytes(48).toString('base64');
    await throws('the wrong key fails to decrypt',
      () => crypt.decryptFile(b.file, path.join(LOCAL, 'wrongkey.out')),
      (e) => /authentication|wrong key/i.test(e.message));
    process.env.BACKUP_ENCRYPTION_KEY = savedKey;

    section('offsite copy');
    check('backup was shipped offsite', b.offsite?.shipped === true, JSON.stringify(b.offsite));
    const shipped = offsite.list({ slug: SLUG });
    check('offsite has the encrypted file', shipped.length === 1, JSON.stringify(shipped));
    check('offsite copy is byte-identical in size',
      shipped[0].bytes === b.bytes, `${shipped[0].bytes} vs ${b.bytes}`);

    section('restore from the offsite copy');
    const pulled = path.join(LOCAL, 'pulled.enc');
    await offsite.fetch(shipped[0].name, { slug: SLUG, to: pulled });
    const plain = path.join(LOCAL, 'pulled.dump');
    await crypt.decryptFile(pulled, plain);
    check('offsite copy decrypts', fs.existsSync(plain) && fs.statSync(plain).size > 0);

    const verified = await backup.verifyLatest(SLUG, { dir: LOCAL });
    check('encrypted backup restores end to end',
      verified.ok && verified.encrypted === true && verified.tablesRestored > 0,
      JSON.stringify(verified));

    section('refuses to write an unencrypted offsite backup');
    delete process.env.BACKUP_ENCRYPTION_KEY;
    check('crypt reports itself unconfigured', crypt.isConfigured() === false);
    await throws('encrypting without a key is refused',
      () => crypt.encryptFile(plain, `${plain}.x`), (e) => /BACKUP_ENCRYPTION_KEY/.test(e.message));
    process.env.BACKUP_ENCRYPTION_KEY = savedKey;

    section('cleanup');
    fs.rmSync(LOCAL, { recursive: true, force: true });
    fs.rmSync(OFFSITE, { recursive: true, force: true });
    await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query("DELETE FROM platform.users WHERE email LIKE '%@sectest.local'");
    await pool.query('DELETE FROM platform.tenants WHERE slug = $1', [SLUG]);
    check('tenant removed', true);
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`); console.error(e);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log(failures.map((f) => `  - ${f}`).join('\n'));
  server.close();
  await store.disconnect();
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
