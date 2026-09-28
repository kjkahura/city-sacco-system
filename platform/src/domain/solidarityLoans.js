'use strict';

const acct = require('./accounting');
const loans = require('./loans');

const { err, round2 } = acct;

/**
 * Solidarity group loans (the reference platform's solidarity or hybrid groups): one
 * individual loan account per member, each with its own ID, amount and
 * schedule, all made together for a group. Each loan then lives on its own:
 * approved, disbursed, repaid and written off like any individual loan, so
 * one member's default leaves the others running, and a member who
 * defaulted can be left out of the next cycle. Loan cycles advance per
 * member.
 *
 * The product is available to solidarity groups only (the reference platform: Client and
 * Groups unticked), and the loans sit in the group's branch with the group's
 * credit officer, so whoever manages the group sees all of them.
 */

async function groupOf(c, ref) {
  const { rows: [g] } = await c.query('SELECT * FROM members WHERE (id::text = $1 OR member_no = $1) AND holder_type = \'GROUP\'', [String(ref)]);
  if (!g) throw err('GROUP_NOT_FOUND', 404);
  return g;
}

/**
 * Open every member's loan in one transaction. `members` is a list of
 * { memberId, principal (or amount), purpose? }; the loan settings (product,
 * term, the overrides the product allows) are shared.
 */
async function open(c, groupRef, body = {}, { user = null, actor } = {}) {
  const g = await groupOf(c, groupRef);
  if (!['INACTIVE', 'ACTIVE'].includes(g.status)) throw err(`GROUP_MAY_NOT_OPEN_ACCOUNTS: ${g.member_no} is ${g.status}`, 409);
  const productId = body.productId || body.productTypeKey;
  if (!productId) throw err('PRODUCT_ID_REQUIRED', 400);
  const { rows: [p] } = await c.query('SELECT id, available_for FROM loan_products WHERE id = $1 AND is_active', [productId]);
  if (!p) throw err('UNKNOWN_LOAN_PRODUCT', 404);
  if (!(p.available_for || []).includes('SOLIDARITY_GROUPS')) throw err(`PRODUCT_NOT_AVAILABLE_FOR_SOLIDARITY_GROUPS: ${p.id}`, 409);
  const lines = body.members;
  if (!Array.isArray(lines) || !lines.length) throw err('MEMBERS_IS_A_LIST_OF: { memberId, principal }', 400);

  const { rows: inGroup } = await c.query(
    'SELECT m.id, m.member_no FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = $1', [g.id]);
  const byRef = new Map();
  for (const m of inGroup) { byRef.set(m.id, m); byRef.set(m.member_no, m); }
  const seen = new Set();
  const plan = lines.map((x, i) => {
    const m = byRef.get(String(x.memberId ?? x.clientKey ?? ''));
    if (!m) throw err(`NOT_A_MEMBER_OF_THE_GROUP: line ${i + 1} (${x.memberId ?? x.clientKey ?? 'no memberId'})`, 409);
    if (seen.has(m.id)) throw err(`MEMBER_GIVEN_TWICE: ${m.member_no}`, 400);
    seen.add(m.id);
    const principal = round2(x.principal ?? x.amount ?? x.loanAmount);
    if (!(principal > 0)) throw err(`INVALID_PRINCIPAL: ${m.member_no}`, 400);
    return { m, principal, purpose: x.purpose };
  });

  // The shared settings; what identifies the holder or the amount is per line.
  const { members: _m, memberId: _i, principal: _p, branchId: _b, creditOfficer: _o, accountNo: _a, ...shared } = body;
  const made = [];
  for (const { m, principal, purpose } of plan) {
    const l = await loans.apply(c, {
      ...shared, productId: p.id, memberId: m.id, principal, purpose: purpose ?? shared.purpose,
      branchId: g.branch_id, creditOfficer: g.credit_officer || null, createdBy: actor, user,
    }, { solidarityGroupId: g.id });
    made.push(l);
  }
  await c.query(`INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'SOLIDARITY_LOANS_OPENED','member',$2,$3)`,
    [actor || 'SYSTEM', g.id, JSON.stringify({ group: g.member_no, product: p.id, loans: made.map((l) => ({ loan: l.account_no, principal: Number(l.principal) })) })]);
  return forGroup(c, g.id);
}

/** A group's solidarity loans and their totals. */
async function forGroup(c, groupRef) {
  const g = await groupOf(c, groupRef);
  const { rows } = await c.query(
    `SELECT l.id, l.account_no, l.product_id, l.status, l.principal, l.disbursed_on, l.created_at,
            GREATEST(l.principal_disbursed + l.principal_capitalized - l.principal_paid, 0) AS principal_outstanding,
            m.id AS member_id, m.member_no, m.first_name, m.last_name
       FROM loan_accounts l JOIN members m ON m.id = l.member_id
      WHERE l.solidarity_group_id = $1 ORDER BY l.created_at, l.account_no`, [g.id]);
  const running = rows.filter((r) => ['ACTIVE', 'IN_ARREARS', 'LOCKED'].includes(r.status));
  return {
    groupKey: g.id, groupId: g.member_no, groupName: g.first_name,
    loans: rows.map((r) => ({
      encodedKey: r.id, id: r.account_no, productId: r.product_id, accountState: r.status, loanAmount: Number(r.principal),
      principalBalance: Number(r.principal_outstanding), disbursementDate: r.disbursed_on,
      memberKey: r.member_id, memberId: r.member_no, memberName: `${r.first_name} ${r.last_name}`.trim(),
    })),
    totals: {
      loans: rows.length, running: running.length,
      loanAmount: round2(rows.filter((r) => !/^CLOSED_(REJECTED|WITHDRAWN)$/.test(r.status)).reduce((t, r) => t + Number(r.principal), 0)),
      principalBalance: round2(running.reduce((t, r) => t + Number(r.principal_outstanding), 0)),
    },
  };
}

module.exports = { open, forGroup };
