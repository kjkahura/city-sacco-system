'use strict';

const acct = require('./accounting');
const { err, round2 } = acct;

/**
 * Collateral assets, after Mambu's "Loan Securities - Guarantors and
 * Collateral Assets". Guarantors (members pledging their deposits) live in
 * loans.js; this is the physical side: a vehicle, a title, equipment, with
 * a value the SACCO accepts as security. Both count towards the cover a
 * product requires at approval (require_guarantor_cover / min_cover_percent),
 * as in Mambu's "Required Securities Validation".
 */

const L = () => require('./loans');

async function addCollateral(c, loanId, { assetType = 'OTHER', description, value, originalCurrency = null, originalValue = null, reference = null, note = null, createdBy }) {
  const l = await L().lock(c, loanId);
  if (!l.enable_collateral) throw err('PRODUCT_DOES_NOT_TAKE_COLLATERAL', 409);
  if (!['PARTIAL_APPLICATION', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'IN_ARREARS'].includes(l.status)) {
    throw err(`CANNOT_ADD_COLLATERAL_IN_STATE: ${l.status}`, 409);
  }
  if (!description || !(round2(value) > 0)) throw err('COLLATERAL_NEEDS_DESCRIPTION_AND_VALUE', 400);
  const { rows } = await c.query(
    `INSERT INTO loan_collateral (loan_id, asset_type, description, value, original_currency, original_value, reference, note, added_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [l.id, assetType, description, round2(value), originalCurrency, originalValue, reference, note, createdBy || 'SYSTEM']);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after) VALUES ($1,'COLLATERAL_ADDED','loan_collateral',$2,$3)`,
    [createdBy || 'SYSTEM', rows[0].id, JSON.stringify(rows[0])]);
  return rows[0];
}

/** Release (or record the seizure of) a collateral asset. */
async function releaseCollateral(c, collateralId, { status = 'RELEASED', note = null, createdBy } = {}) {
  if (!['RELEASED', 'SEIZED'].includes(status)) throw err('STATUS_MUST_BE_RELEASED_OR_SEIZED', 400);
  const { rows: [col] } = await c.query('SELECT * FROM loan_collateral WHERE id = $1 FOR UPDATE', [collateralId]);
  if (!col) throw err('COLLATERAL_NOT_FOUND', 404);
  if (col.status !== 'PLEDGED') throw err(`COLLATERAL_ALREADY_${col.status}`, 409);
  const l = await L().lock(c, col.loan_id);
  // Security may not be released from under a running loan if that would
  // leave it under the product's required cover.
  if (status === 'RELEASED' && ['APPROVED', 'ACTIVE', 'IN_ARREARS', 'LOCKED'].includes(l.status) && l.require_guarantor_cover) {
    const e = await L().checkEligibility(c, { memberId: l.member_id, productId: l.product_id, principal: L().principalOutstanding(l) || l.principal, loanId: l.id, excludeCollateralId: col.id });
    if (e.rules.guarantorCover === 'BREACHED') throw err(`RELEASE_WOULD_BREACH_REQUIRED_COVER: cover ${e.cover}, required ${e.coverRequired}`, 409);
  }
  const { rows } = await c.query(
    `UPDATE loan_collateral SET status = $2, released_at = now(), note = COALESCE(note || ' | ', '') || $3 WHERE id = $1 RETURNING *`,
    [collateralId, status, `${status.toLowerCase()}: ${note || ''}`]);
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,$2,'loan_collateral',$3,$4,$5)`,
    [createdBy || 'SYSTEM', `COLLATERAL_${status}`, collateralId, JSON.stringify(col), JSON.stringify(rows[0])]);
  return rows[0];
}

/** Value of the collateral pledged on a loan. */
async function collateralCoverage(c, loanId, { exclude = null } = {}) {
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(SUM(value), 0) AS v FROM loan_collateral
     WHERE loan_id = $1 AND status = 'PLEDGED' AND ($2::uuid IS NULL OR id <> $2)`, [loanId, exclude]);
  return round2(r.v);
}

async function forLoan(c, loanId) {
  const { rows } = await c.query(
    `SELECT k.* FROM loan_collateral k JOIN loan_accounts l ON l.id = k.loan_id
     WHERE l.id::text = $1 OR l.account_no = $1 ORDER BY k.added_at`, [loanId]);
  return rows;
}

/** Collateral on a loan that closes is released; on a write-off, seized. */
async function onClose(c, loanId, { seized = false } = {}) {
  await c.query(
    `UPDATE loan_collateral SET status = $2, released_at = now() WHERE loan_id = $1 AND status = 'PLEDGED'`,
    [loanId, seized ? 'SEIZED' : 'RELEASED']);
}

module.exports = { addCollateral, releaseCollateral, collateralCoverage, forLoan, onClose };
