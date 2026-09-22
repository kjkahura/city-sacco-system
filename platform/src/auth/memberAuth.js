'use strict';

const crypto = require('crypto');
const { hashPin, verifyPassword } = require('./passwords');
const { signToken } = require('../tenancy/resolve');

/**
 * Member sign-in for the portal.
 *
 * Everything here runs inside a tenant transaction (`c` is a client from
 * withTenant), because member credentials live in the tenant schema. A
 * member token carries role MEMBER and the member's id as `mid`; requireAuth
 * refuses MEMBER tokens on every staff route, and the portal routes accept
 * nothing else. The two populations cannot reach each other's endpoints
 * even by accident.
 *
 * PINs are hashed with the same scrypt as staff passwords. A PIN is short,
 * so the defence is not the hash but the lockout: five wrong attempts lock
 * the credential for fifteen minutes, and every attempt is recorded.
 */

const err = (code, status = 400) => Object.assign(new Error(code), { status });

/**
 * A refusal that must be committed.
 *
 * login and rotate record failed attempts, lockouts and family revocations
 * before they refuse. Throwing would roll those writes back with the rest of
 * the transaction, and a lockout that is undone by the very failure that
 * caused it is no lockout at all. So they return a failure instead, and the
 * route turns it into an error only after the transaction has committed.
 */
const refuse = (code, status) => ({ failure: { code, status } });

const ACCESS_TTL = process.env.MEMBER_ACCESS_TTL || '30m';
const REFRESH_TTL_DAYS = Number(process.env.MEMBER_REFRESH_TTL_DAYS || 30);
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const PIN_RE = /^\d{4,6}$/;

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const mint = () => crypto.randomBytes(48).toString('base64url');

/** Kenyan numbers arrive as 07xx, 7xx, +2547xx or 2547xx. Store one shape. */
function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (digits.length >= 9) return digits;   // other countries: keep what was given
  throw err('INVALID_PHONE');
}

/**
 * Claim an existing member record.
 *
 * The member must already exist, and the caller has to know the member
 * number and the national ID on file. If the record carries a phone number
 * the presented one must match it; if it carries none, the presented one is
 * recorded, which is how members admitted before phones were captured get
 * onto the portal without a branch visit.
 */
async function activate(c, { memberNo, nationalId, phone, pin }) {
  if (!PIN_RE.test(String(pin || ''))) throw err('PIN_MUST_BE_4_TO_6_DIGITS');
  const ph = normalisePhone(phone);

  const { rows: [m] } = await c.query(
    'SELECT * FROM members WHERE member_no = $1 FOR UPDATE', [String(memberNo || '').trim()]);
  // One error for every mismatch, so the response does not say which of the
  // three identifiers was wrong.
  const noMatch = err('MEMBER_DETAILS_DO_NOT_MATCH', 404);
  if (!m) throw noMatch;
  if (m.status !== 'ACTIVE') throw err(`MEMBER_NOT_ACTIVE: ${m.status}`, 403);
  if (!m.national_id || String(m.national_id).trim() !== String(nationalId || '').trim()) throw noMatch;
  if (m.phone && normalisePhone(m.phone) !== ph) throw noMatch;

  const { rows: existing } = await c.query(
    'SELECT 1 FROM member_credentials WHERE member_id = $1', [m.id]);
  if (existing.length) throw err('MEMBER_ALREADY_ACTIVATED', 409);

  const { rows: taken } = await c.query(
    'SELECT 1 FROM member_credentials WHERE phone = $1', [ph]);
  if (taken.length) throw err('PHONE_ALREADY_IN_USE', 409);

  if (!m.phone) {
    await c.query('UPDATE members SET phone = $1, updated_at = now() WHERE id = $2', [ph, m.id]);
  }
  await c.query(
    'INSERT INTO member_credentials (member_id, phone, pin_hash) VALUES ($1,$2,$3)',
    [m.id, ph, await hashPin(pin)]
  );
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after)
     VALUES ($1,'MEMBER_PORTAL_ACTIVATED','member',$2,$3)`,
    [m.member_no, m.id, JSON.stringify({ phone: ph })]
  );
  return { memberNo: m.member_no, phone: ph, activated: true };
}

async function issueTokens(c, member, tenantSlug, { familyId = crypto.randomUUID(), userAgent = null, ip = null } = {}) {
  const refresh = mint();
  const expires = new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000);
  await c.query(
    `INSERT INTO member_sessions (member_id, token_hash, family_id, expires_at, user_agent, ip)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [member.id, hash(refresh), familyId, expires, userAgent, ip]
  );
  const access = signToken({
    sub: member.id, mid: member.id, role: 'MEMBER', tid: tenantSlug,
    memberNo: member.member_no, name: `${member.first_name} ${member.last_name}`,
  }, ACCESS_TTL);
  return { accessToken: access, refreshToken: refresh, expiresIn: ACCESS_TTL, refreshExpiresAt: expires };
}

const publicMember = (m) => ({
  id: m.id, memberNo: m.member_no, firstName: m.first_name, lastName: m.last_name,
  phone: m.phone, email: m.email, status: m.status, joinedOn: m.joined_on,
});

async function login(c, { phone, pin, tenantSlug, userAgent = null, ip = null }) {
  const ph = normalisePhone(phone);
  const { rows: [cred] } = await c.query(
    `SELECT cr.*, m.member_no, m.first_name, m.last_name, m.email, m.status AS member_status, m.joined_on
     FROM member_credentials cr JOIN members m ON m.id = cr.member_id
     WHERE cr.phone = $1 FOR UPDATE OF cr`,
    [ph]
  );

  const fail = async (memberId = null) => {
    await c.query(
      'INSERT INTO member_login_attempts (phone, member_id, succeeded, ip) VALUES ($1,$2,false,$3)',
      [ph, memberId, ip]);
  };

  // Verify against a dummy hash when there is no such phone, so timing does
  // not say whether a number is enrolled.
  const ok = await verifyPassword(String(pin || ''),
    cred?.pin_hash || 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');

  if (!cred) { await fail(); return refuse('INVALID_CREDENTIALS', 401); }
  if (cred.status === 'DISABLED' || cred.member_status !== 'ACTIVE') {
    await fail(cred.member_id); return refuse('ACCOUNT_DISABLED', 403);
  }
  if (cred.locked_until && new Date(cred.locked_until) > new Date()) {
    await fail(cred.member_id);
    return refuse(`ACCOUNT_LOCKED_UNTIL_${new Date(cred.locked_until).toISOString()}`, 423);
  }
  if (!ok) {
    const attempts = cred.failed_attempts + 1;
    const lock = attempts >= MAX_ATTEMPTS;
    await c.query(
      `UPDATE member_credentials SET
         failed_attempts = $2,
         locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END,
         status = CASE WHEN $3 THEN 'LOCKED' ELSE status END
       WHERE member_id = $1`,
      [cred.member_id, lock ? 0 : attempts, lock, String(LOCK_MINUTES)]
    );
    await fail(cred.member_id);
    return refuse(lock ? 'TOO_MANY_ATTEMPTS_ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS', lock ? 423 : 401);
  }

  await c.query(
    `UPDATE member_credentials SET failed_attempts = 0, locked_until = NULL,
       status = 'ACTIVE', last_login_at = now() WHERE member_id = $1`,
    [cred.member_id]);
  await c.query(
    'INSERT INTO member_login_attempts (phone, member_id, succeeded, ip) VALUES ($1,$2,true,$3)',
    [ph, cred.member_id, ip]);

  const member = { id: cred.member_id, member_no: cred.member_no, first_name: cred.first_name,
    last_name: cred.last_name, phone: cred.phone, email: cred.email, status: cred.member_status,
    joined_on: cred.joined_on };
  const pair = await issueTokens(c, member, tenantSlug, { userAgent, ip });
  return { ...pair, member: publicMember(member) };
}

/** Rotate a refresh token. A replayed token burns the whole family. */
async function rotate(c, presented, tenantSlug, { userAgent = null, ip = null } = {}) {
  const { rows: [tok] } = await c.query(
    'SELECT * FROM member_sessions WHERE token_hash = $1 FOR UPDATE', [hash(String(presented || ''))]);
  if (!tok) return refuse('INVALID_REFRESH_TOKEN', 401);
  if (tok.revoked_at) return refuse('REFRESH_TOKEN_REVOKED', 401);
  if (tok.used_at) {
    await c.query(
      'UPDATE member_sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
      [tok.family_id]);
    return refuse('REFRESH_TOKEN_REUSED_FAMILY_REVOKED', 401);
  }
  if (new Date(tok.expires_at) < new Date()) return refuse('REFRESH_TOKEN_EXPIRED', 401);

  await c.query('UPDATE member_sessions SET used_at = now() WHERE id = $1', [tok.id]);
  const { rows: [m] } = await c.query('SELECT * FROM members WHERE id = $1', [tok.member_id]);
  if (!m || m.status !== 'ACTIVE') return refuse('ACCOUNT_DISABLED', 403);
  return issueTokens(c, m, tenantSlug, { familyId: tok.family_id, userAgent, ip });
}

async function logout(c, presented, { all = false } = {}) {
  const { rows: [tok] } = await c.query(
    'SELECT * FROM member_sessions WHERE token_hash = $1', [hash(String(presented || ''))]);
  if (!tok) return { revoked: 0 };
  const { rowCount } = all
    ? await c.query('UPDATE member_sessions SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL', [tok.member_id])
    : await c.query('UPDATE member_sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [tok.family_id]);
  return { revoked: rowCount };
}

async function changePin(c, memberId, { currentPin, newPin }) {
  if (!PIN_RE.test(String(newPin || ''))) throw err('PIN_MUST_BE_4_TO_6_DIGITS');
  const { rows: [cred] } = await c.query(
    'SELECT * FROM member_credentials WHERE member_id = $1 FOR UPDATE', [memberId]);
  if (!cred) throw err('NOT_ACTIVATED', 404);
  if (!(await verifyPassword(String(currentPin || ''), cred.pin_hash))) throw err('INVALID_CREDENTIALS', 401);
  await c.query(
    'UPDATE member_credentials SET pin_hash = $1, pin_changed_at = now() WHERE member_id = $2',
    [await hashPin(newPin), memberId]);
  // A PIN change signs out every other device.
  await c.query('UPDATE member_sessions SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL', [memberId]);
  return { changed: true };
}

module.exports = { activate, login, rotate, logout, changePin, normalisePhone, publicMember, err };
