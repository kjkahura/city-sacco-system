'use strict';

const acct = require('./accounting');
const savings = require('./savings');
const customFields = require('./customFields');
const lending = require('./controls');
const { err, round2 } = acct;
const { lock } = require('./ledger');
const { recordAudit } = require('../lib/auditLog');

/**
 * Security and eligibility: guarantors pledging their deposits, the value
 * of collateral pledged, and the rules a loan must meet to be approved
 * (deposit multiplier, required cover, product band, exposure controls).
 *
 * Collateral assets themselves are recorded in ./securities; their value is
 * summed here because cover is one figure made of deposits, pledges and
 * collateral, and approval, release of security and the teller's preview
 * must all read the same one.
 */

/** Value of the collateral pledged on a loan. */
async function collateralCoverage(c, loanId, { exclude = null } = {}) {
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(SUM(value), 0) AS v FROM loan_collateral
     WHERE loan_id = $1 AND status = 'PLEDGED' AND ($2::uuid IS NULL OR id <> $2)`, [loanId, exclude]);
  return round2(r.v);
}

// --------------------------------------------------------------------------
// Guarantors. The SACCO-specific piece: members pledge their own deposits.
// --------------------------------------------------------------------------

const OPEN_APPLICATION = ['PARTIAL_APPLICATION', 'PENDING_APPROVAL'];
// The reference platform: guarantors may be added when the loan is created or at any time
// after, and removed from a running loan when no longer required.
const TAKES_GUARANTORS = [...OPEN_APPLICATION, 'APPROVED', 'ACTIVE', 'IN_ARREARS', 'LOCKED'];
const COVER_CHECKED = ['APPROVED', 'ACTIVE', 'IN_ARREARS', 'LOCKED'];

async function addGuarantor(c, loanId, { memberId, amount, createdBy = null, customFields: cf = undefined, user = null }) {
  const l = await lock(c, loanId);
  if (l.enable_guarantors === false) throw err('PRODUCT_DOES_NOT_TAKE_GUARANTORS', 409);
  if (!TAKES_GUARANTORS.includes(l.status)) {
    throw err(`CANNOT_ADD_GUARANTOR_IN_STATE: ${l.status}`, 409);
  }
  const { rows: [again] } = await c.query(
    "SELECT id, status FROM loan_guarantors WHERE loan_id = $1 AND member_id = $2", [l.id, memberId]);
  if (memberId === l.member_id) throw err('MEMBER_CANNOT_GUARANTEE_OWN_LOAN');
  // The guarantor's state and type (the reference platform's life cycle and "Allow as
  // guarantor"); the database checks the same when the pledge is stored.
  const { rows: [gm] } = await c.query(
    `SELECT m.status, m.member_no, t.can_guarantee, t.name AS type_name FROM members m JOIN client_types t ON t.id = m.client_type_id
      WHERE m.id::text = $1`, [String(memberId)]);
  if (gm && !['INACTIVE', 'ACTIVE'].includes(gm.status)) throw err(`GUARANTOR_MAY_NOT_PLEDGE: ${gm.member_no} is ${gm.status}`, 409);
  if (gm && !gm.can_guarantee) throw err(`TYPE_MAY_NOT_GUARANTEE: ${gm.member_no} is of the type ${gm.type_name}`, 409);
  const amt = round2(amount);
  if (!(amt > 0)) throw err('INVALID_PLEDGE_AMOUNT');

  // The guarantor must actually have the deposits they are pledging, net of
  // anything already pledged elsewhere. One pledge or withdrawal at a time per
  // member (the same lock as savings withdrawals), so two cannot both count the same deposits.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`member-funds:${memberId}`]);
  const { rows: [bal] } = await c.query(
    'SELECT COALESCE(SUM(balance), 0) AS total FROM savings_accounts WHERE member_id = $1 AND status = ANY($2)',
    [memberId, ['ACTIVE', 'IN_ARREARS']]
  );
  const alreadyPledged = await savings.pledgedAmount(c, memberId);
  const free = round2(bal.total - alreadyPledged);
  if (amt > free) {
    throw err(`GUARANTOR_HAS_INSUFFICIENT_FREE_DEPOSITS: free ${free}, pledged ${amt}`, 409);
  }

  // A guarantor released earlier pledges again on the same row.
  if (again && again.status === 'PLEDGED') throw err('ALREADY_A_GUARANTOR_ON_THIS_LOAN', 409);
  const values = await customFields.prepare(c, 'GUARANTOR', { patch: cf || {}, user, creating: true, recordId: again ? again.id : null });
  const { rows } = again
    ? await c.query("UPDATE loan_guarantors SET pledged_amount = $2, status = 'PLEDGED', recovered = 0, custom_fields = $3 WHERE id = $1 RETURNING *", [again.id, amt, JSON.stringify(values)])
    : await c.query(
      `INSERT INTO loan_guarantors (loan_id, member_id, pledged_amount, custom_fields) VALUES ($1,$2,$3,$4) RETURNING *`,
      [l.id, memberId, amt, JSON.stringify(values)]);
  if (!OPEN_APPLICATION.includes(l.status)) {
    await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'GUARANTOR_ADDED', entity: 'loan_guarantor', entityId: rows[0].id, after: JSON.stringify({ loan: l.account_no, memberId, amount: amt, status: l.status }) });
  }
  return rows[0];
}

/**
 * Take a guarantor off a loan: their pledge is released and their deposits
 * are free again. On an approved or running loan whose product requires
 * cover, refused if the loan would then be under it (the principal
 * outstanding, or the amount approved before disbursement).
 */
async function removeGuarantor(c, loanId, guarantorId, { note = null, createdBy } = {}) {
  const l = await lock(c, loanId);
  const { rows: [g] } = await c.query('SELECT * FROM loan_guarantors WHERE id = $1 AND loan_id = $2 FOR UPDATE', [guarantorId, l.id]);
  if (!g) throw err('GUARANTOR_NOT_FOUND_ON_THIS_LOAN', 404);
  if (g.status !== 'PLEDGED') throw err(`GUARANTOR_NOT_PLEDGED: ${g.status}`, 409);
  if (!TAKES_GUARANTORS.includes(l.status)) throw err(`CANNOT_REMOVE_GUARANTOR_IN_STATE: ${l.status}`, 409);
  if (COVER_CHECKED.includes(l.status) && l.require_guarantor_cover) {
    const outstanding = round2(Number(l.principal_disbursed) + Number(l.principal_capitalized || 0) - Number(l.principal_paid));
    const e = await checkEligibility(c, { memberId: l.member_id, productId: l.product_id, principal: outstanding > 0 ? outstanding : l.principal,
      loanId: l.id, excludeGuarantorId: g.id });
    if (e.rules.guarantorCover === 'BREACHED') {
      throw err(`REMOVING_THE_GUARANTOR_LEAVES_THE_LOAN_UNDER_COVER: cover ${e.cover} of ${e.coverRequired} required`, 409);
    }
  }
  const { rows: [out] } = await c.query("UPDATE loan_guarantors SET status = 'RELEASED' WHERE id = $1 RETURNING *", [g.id]);
  await recordAudit(c, { actor: createdBy || 'SYSTEM', action: 'GUARANTOR_REMOVED', entity: 'loan_guarantor', entityId: g.id, before: JSON.stringify(g), after: JSON.stringify({ note, loan: l.account_no }) });
  return out;
}

async function guarantorCoverage(c, loanId, { exclude = null } = {}) {
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(SUM(pledged_amount), 0) AS pledged
     FROM loan_guarantors WHERE loan_id = $1 AND status = 'PLEDGED' AND ($2::uuid IS NULL OR id <> $2)`,
    [loanId, exclude]
  );
  return round2(r.pledged);
}

async function releaseGuarantors(c, loanId) {
  const { rows } = await c.query(
    "UPDATE loan_guarantors SET status = 'RELEASED' WHERE loan_id = $1 AND status = 'PLEDGED' RETURNING id",
    [loanId]
  );
  return rows.map((r) => r.id);
}

// --------------------------------------------------------------------------
// Eligibility
// --------------------------------------------------------------------------

/**
 * The SACCO rules: you may borrow up to N times your own deposits, and the
 * loan must be covered by your deposits plus what guarantors have pledged.
 *
 * Returns the picture; `enforceEligibility` below is what refuses. Kept
 * separate so a teller can show a member the ceiling before an application
 * is written, and so approval and the preview cannot disagree about it.
 */
async function checkEligibility(c, { memberId, productId, principal, loanId = null, refinancing = null, excludeCollateralId = null, excludeGuarantorId = null }) {
  const { rows: [p] } = await c.query('SELECT * FROM loan_products WHERE id = $1', [productId]);
  if (!p) throw err('UNKNOWN_LOAN_PRODUCT', 404);
  // A top-up application settles a running loan: that loan's guarantors and
  // collateral move to the new one, so they count towards its cover now, and
  // its balance is inside the new principal, so it is not exposure twice.
  if (loanId && !refinancing) {
    const { rows: [a] } = await c.query('SELECT refinance_of FROM loan_accounts WHERE id = $1', [loanId]);
    refinancing = a?.refinance_of || null;
  }
  const { rows: [d] } = await c.query(
    "SELECT COALESCE(SUM(balance), 0) AS total FROM savings_accounts WHERE member_id = $1 AND status IN ('ACTIVE', 'IN_ARREARS')",
    [memberId]
  );
  const deposits = round2(d.total);
  const requested = round2(principal);
  const ceiling = round2(deposits * Number(p.max_multiplier));
  const carriedPledges = refinancing ? await guarantorCoverage(c, refinancing) : 0;
  const carriedCollateral = refinancing ? await collateralCoverage(c, refinancing) : 0;
  const pledged = round2((loanId ? await guarantorCoverage(c, loanId, { exclude: excludeGuarantorId }) : 0) + carriedPledges);
  const collateral = round2((loanId ? await collateralCoverage(c, loanId, { exclude: excludeCollateralId }) : 0) + carriedCollateral);
  const coverRequired = round2(requested * Number(p.min_cover_percent || 100) / 100);
  // The member's own deposits count towards cover unless the product says
  // otherwise (the reference platform counts guarantees and collateral only).
  const depositCover = p.cover_counts_deposits === false ? 0 : deposits;
  const cover = round2(depositCover + pledged + collateral);

  const withinMultiplier = requested <= ceiling;
  const covered = cover >= coverRequired;
  const reasons = [];
  if (p.enforce_deposit_multiplier && !withinMultiplier) reasons.push('LOAN_EXCEEDS_DEPOSIT_MULTIPLIER');
  if (p.require_guarantor_cover && !covered) reasons.push('INSUFFICIENT_GUARANTOR_COVER');
  if (p.min_principal && requested < Number(p.min_principal)) reasons.push('BELOW_PRODUCT_MINIMUM');
  if (p.max_principal && requested > Number(p.max_principal)) reasons.push('ABOVE_PRODUCT_MAXIMUM');

  // Tenant-wide exposure controls (the reference platform "Internal Controls").
  const controls = await lending.exposure(c, { memberId, loanId, refinancing, requested });
  reasons.push(...controls.reasons);

  return {
    deposits,
    multiplier: Number(p.max_multiplier),
    ceiling,
    requested,
    eligible: withinMultiplier,                 // kept for older clients
    shortfall: round2(Math.max(0, requested - ceiling)),
    pledged,
    collateral,
    ...(refinancing ? { refinancing, carried: { pledged: carriedPledges, collateral: carriedCollateral } } : {}),
    coverRequired,
    cover,
    depositCover,
    coverShortfall: round2(Math.max(0, coverRequired - cover)),
    exposure: controls.exposure,
    rules: {
      depositMultiplier: p.enforce_deposit_multiplier ? (withinMultiplier ? 'MET' : 'BREACHED') : 'NOT_ENFORCED',
      guarantorCover: p.require_guarantor_cover ? (covered ? 'MET' : 'BREACHED') : 'NOT_ENFORCED',
      ...controls.rules,
    },
    approvable: reasons.length === 0,
    reasons,
  };
}

/**
 * The reference platform checks the required securities at disbursement as well as at
 * approval: a guarantor released or collateral taken off in between is
 * caught before the money leaves.
 */
async function assertCovered(c, l) {
  if (!l.require_guarantor_cover) return null;
  const e = await checkEligibility(c, { memberId: l.member_id, productId: l.product_id, principal: l.principal, loanId: l.id });
  if (e.rules.guarantorCover === 'BREACHED') {
    throw err(`INSUFFICIENT_GUARANTOR_COVER_AT_DISBURSEMENT: cover ${e.cover} of ${e.coverRequired} required`, 409);
  }
  return e;
}

/** Refuse a loan that breaks a rule its product enforces. */
async function enforceEligibility(c, l) {
  const e = await checkEligibility(c, {
    memberId: l.member_id, productId: l.product_id, principal: l.principal, loanId: l.id,
  });
  if (!e.approvable) {
    throw err(`${e.reasons[0]}: deposits ${e.deposits}, pledged ${e.pledged}, requested ${e.requested}`, 409);
  }
  return e;
}

module.exports = {
  OPEN_APPLICATION, TAKES_GUARANTORS, addGuarantor, removeGuarantor, guarantorCoverage, releaseGuarantors, collateralCoverage, assertCovered,
  checkEligibility, enforceEligibility,
};
