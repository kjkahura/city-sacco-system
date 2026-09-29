'use strict';

/**
 * Activities, after the reference platform's "Tracking Activities" and its API v1
 * activities: what was done in the organization, by whom and when, read
 * per record (a client or group, a loan or deposit account, a credit
 * arrangement), per branch, or for the whole organization.
 *
 * One read model over three sources:
 *   - the change log (audit_log), linked to its member, accounts, credit
 *     arrangement and branch by migration 042;
 *   - loan state history (application, approval, disbursement, arrears,
 *     closing, write-off and their undos), as LOAN_<action>;
 *   - member state changes, as MEMBER_<action>.
 * A state change also written to the change log in the same transaction
 * (the same moment) is read once, from the change log.
 *
 * Deposits, withdrawals and repayments are not activities: they have their
 * own transaction lists (decision 1 of the audit).
 *
 * Field changes are worked out from the top-level keys of the before and
 * after values when an activity is read.
 */

const acct = require('./accounting');
const { err } = acct;

const SOURCE_SQL = `
  SELECT 'log-' || a.id AS key, a.created_at AS at, a.action AS type, a.actor, a.entity, a.entity_id,
         a.member_id, a.loan_id, a.savings_account_id, a.credit_arrangement_id, a.branch_id,
         a.before, a.after, NULL::text AS notes, host(a.ip) AS ip, a.channel
    FROM audit_log a
  UNION ALL
  SELECT 'loan-' || h.id, h.at, 'LOAN_' || h.action, h.actor, 'loan_account', h.loan_id::text,
         l.member_id, h.loan_id, NULL::uuid, l.credit_arrangement_id, l.branch_id,
         jsonb_build_object('status', h.from_status), jsonb_build_object('status', h.to_status), h.note, NULL, NULL
    FROM loan_state_history h JOIN loan_accounts l ON l.id = h.loan_id
   WHERE NOT EXISTS (SELECT 1 FROM audit_log d WHERE d.loan_id = h.loan_id AND d.created_at = h.at AND d.entity = 'loan_account')
  UNION ALL
  SELECT 'member-' || s.id, s.changed_at, 'MEMBER_' || s.action, s.actor, 'member', s.member_id::text,
         s.member_id, NULL::uuid, NULL::uuid, NULL::uuid, m.branch_id,
         jsonb_build_object('state', s.from_state), jsonb_build_object('state', s.to_state), s.reason, NULL, NULL
    FROM member_state_changes s JOIN members m ON m.id = s.member_id
   WHERE NOT EXISTS (SELECT 1 FROM audit_log d WHERE d.member_id = s.member_id AND d.created_at = s.changed_at AND d.entity = 'member')`;

const FULL_SQL = `
  SELECT v.*, m.holder_type, m.member_no, m.centre_id, b.code AS branch_code,
         la.account_no AS loan_no, la.product_id AS loan_product_id,
         sa.account_no AS savings_no, sa.product_id AS savings_product_id
    FROM (${SOURCE_SQL}) v
    LEFT JOIN members m ON m.id = v.member_id
    LEFT JOIN branches b ON b.id = v.branch_id
    LEFT JOIN loan_accounts la ON la.id = v.loan_id
    LEFT JOIN savings_accounts sa ON sa.id = v.savings_account_id`;

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The reference platform's fieldChanges, from the top-level keys of before and after. */
function fieldChanges(before, after) {
  const b = before && typeof before === 'object' && !Array.isArray(before) ? before : {};
  const a = after && typeof after === 'object' && !Array.isArray(after) ? after : {};
  if (b.redacted || a.redacted) return [];
  const out = [];
  for (const k of [...new Set([...Object.keys(b), ...Object.keys(a)])]) {
    if (same(b[k], a[k])) continue;
    const show = (v) => (v === undefined || v === null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
    out.push({ fieldChangeName: k, originalValue: show(b[k]), newValue: show(a[k]) });
  }
  return out;
}

/** The reference platform's Activity (API v1), with the platform's record kind and id. */
function shape(r) {
  const group = r.holder_type === 'GROUP';
  return {
    encodedKey: r.key,
    type: r.type,
    timestamp: r.at,
    userKey: r.actor ?? null,
    notes: r.notes ?? (r.after && typeof r.after === 'object' && typeof r.after.note === 'string' ? r.after.note : null),
    clientKey: r.member_id && !group ? r.member_id : null,
    groupKey: r.member_id && group ? r.member_id : null,
    memberNo: r.member_no ?? null,
    branchKey: r.branch_id ?? null,
    branchId: r.branch_code ?? null,
    centreKey: r.centre_id ?? null,
    loanAccountKey: r.loan_id ?? null,
    loanAccountId: r.loan_no ?? null,
    loanProductKey: r.loan_product_id ?? null,
    savingsAccountKey: r.savings_account_id ?? null,
    savingsAccountId: r.savings_no ?? null,
    savingsProductKey: r.savings_product_id ?? null,
    creditArrangementKey: r.credit_arrangement_id ?? null,
    entity: r.entity ?? null,
    entityId: r.entity_id ?? null,
    channel: r.channel ?? null,
    ipAddress: r.ip ?? null,
    fieldChanges: fieldChanges(r.before, r.after),
  };
}

async function memberOf(c, ref) {
  const { rows: [m] } = await c.query('SELECT id, holder_type FROM members WHERE id::text = $1 OR member_no = $1', [String(ref)]);
  if (!m) throw err(`MEMBER_NOT_FOUND: ${ref}`, 404);
  return m;
}
async function loanOf(c, ref) {
  const { rows: [l] } = await c.query('SELECT id FROM loan_accounts WHERE id::text = $1 OR account_no = $1', [String(ref)]);
  if (!l) throw err(`LOAN_NOT_FOUND: ${ref}`, 404);
  return l.id;
}
async function savingsOf(c, ref) {
  const { rows: [a] } = await c.query('SELECT id FROM savings_accounts WHERE id::text = $1 OR account_no = $1', [String(ref)]);
  if (!a) throw err(`SAVINGS_ACCOUNT_NOT_FOUND: ${ref}`, 404);
  return a.id;
}
async function arrangementOf(c, ref) {
  const { rows: [x] } = await c.query('SELECT id FROM credit_arrangements WHERE id::text = $1', [String(ref)]);
  if (!x) throw err(`CREDIT_ARRANGEMENT_NOT_FOUND: ${ref}`, 404);
  return x.id;
}

const dayOf = (v, name) => {
  const d = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw err(`INVALID_DATE: ${name}`, 400);
  return d;
};

/**
 * Activities, newest first.
 *
 * Filters (the reference platform's API v1 names, and the platform's ids or numbers): from,
 * to (organization days), branchID, clientID, groupID, centreID, userID,
 * loanAccountID, savingsAccountID, loanProductID, savingsProductID,
 * creditArrangementID, and type (one or a comma list).
 *
 * Who sees what:
 *   branches        a user limited to some branches reads activities in them
 *   noBranch        whether activities with no branch (products, settings)
 *                   are included
 */
async function list(c, q = {}, { branches = null, noBranch = true, types = null, offset = 0, limit = 50 } = {}) {
  const where = [];
  const vals = [];
  const p = (v) => { vals.push(v); return `$${vals.length}`; };
  if (q.from) where.push(`x.at >= ${p(dayOf(q.from, 'from'))}::date`);
  if (q.to) where.push(`x.at < ${p(dayOf(q.to, 'to'))}::date + 1`);
  if (q.branchID) {
    const b = await acct.branchScope(c, q.branchID);
    where.push(b.id === 'NONE' ? 'x.branch_id IS NULL' : `x.branch_id = ${p(b.id)}::uuid`);
  }
  for (const [key, holder] of [['clientID', 'CLIENT'], ['groupID', 'GROUP']]) {
    if (!q[key]) continue;
    const m = await memberOf(c, q[key]);
    if (m.holder_type !== holder) throw err(`${key.toUpperCase()}_IS_NOT_A_${holder}: ${q[key]}`, 400);
    where.push(`x.member_id = ${p(m.id)}::uuid`);
  }
  if (q.memberID) where.push(`x.member_id = ${p((await memberOf(c, q.memberID)).id)}::uuid`);
  if (q.centreID) where.push(`x.centre_id::text = ${p(String(q.centreID))}`);
  if (q.userID) where.push(`lower(x.actor) = lower(${p(String(q.userID))})`);
  if (q.loanAccountID) where.push(`x.loan_id = ${p(await loanOf(c, q.loanAccountID))}::uuid`);
  if (q.savingsAccountID) where.push(`x.savings_account_id = ${p(await savingsOf(c, q.savingsAccountID))}::uuid`);
  if (q.creditArrangementID) where.push(`x.credit_arrangement_id = ${p(await arrangementOf(c, q.creditArrangementID))}::uuid`);
  if (q.loanProductID) where.push(`x.loan_product_id = ${p(String(q.loanProductID))}`);
  if (q.savingsProductID) where.push(`x.savings_product_id = ${p(String(q.savingsProductID))}`);
  const wanted = q.type ? String(q.type).split(',').map((t) => t.trim().toUpperCase()).filter(Boolean) : null;
  if (wanted && wanted.length) where.push(`x.type = ANY(${p(wanted)}::text[])`);
  if (Array.isArray(types) && types.length) where.push(`x.type = ANY(${p(types)}::text[])`);
  if (Array.isArray(branches)) where.push(`x.branch_id = ANY(${p(branches)}::uuid[])`);
  if (!noBranch) where.push('x.branch_id IS NOT NULL');
  const { rows } = await c.query(
    `SELECT x.*, count(*) OVER () AS total FROM (${FULL_SQL}) x
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY x.at DESC, x.key DESC LIMIT ${Math.min(1000, Math.max(1, Number(limit) || 50))} OFFSET ${Math.max(0, Number(offset) || 0)}`, vals);
  return { total: rows.length ? Number(rows[0].total) : 0, items: rows.map(shape) };
}

/** The activity types there are, for choosing what the dashboard shows. */
async function types(c) {
  const { rows } = await c.query(
    `SELECT DISTINCT type FROM (
       SELECT action AS type FROM audit_log
       UNION SELECT 'LOAN_' || action FROM loan_state_history
       UNION SELECT 'MEMBER_' || action FROM member_state_changes) t ORDER BY 1`);
  return rows.map((r) => r.type);
}

module.exports = { list, types, fieldChanges, shape, memberOf, loanOf, savingsOf, arrangementOf };
