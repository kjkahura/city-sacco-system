'use strict';

const acct = require('../accounting');
const tranches = require('../tranches');
const { dynamicTerm } = require('./dynamicTerm');
const { err, round2 } = acct;

/**
 * TRANCHED: a dynamic-term loan paid out in planned parts.
 *
 * Each disbursement pays the next planned tranche (or an amount up to the
 * principal left). The first draws the schedule over what was paid out; a
 * later one brings interest to the day on the old balance and redraws the
 * future installments over the new one. Everything else is dynamic term.
 *
 * The strategy contract is documented in ./index.js.
 */

const tranched = {
  ...dynamicTerm,
  type: 'TRANCHED',
  plansTranches: true,
  disbursesAgain: true,

  async disbursementAmount(c, l, { amount, tranche }) {
    const planned = await tranches.nextPlanned(c, l.id);
    if (!planned) throw err('NO_TRANCHE_LEFT_TO_DISBURSE', 409);
    if (tranche && Number(tranche) !== planned.number) throw err(`NEXT_TRANCHE_IS_${planned.number}`, 409);
    const amt = round2(amount ?? planned.amount);
    const remaining = round2(Number(l.principal) - Number(l.principal_disbursed));
    if (amt > remaining) throw err(`TRANCHE_EXCEEDS_REMAINING_PRINCIPAL: ${remaining}`, 400);
    return { amount: amt, tranche: planned };
  },

  async afterDisbursement(c, ctx, ops) {
    if (ctx.first) return dynamicTerm.afterDisbursement.call(this, c, ctx, ops);
    await ops.accrueInterest(c, ctx.l.id, { valueDate: ctx.date, createdBy: ctx.createdBy });
    await ops.reschedule(c, await ops.lock(c, ctx.l.id), ctx.date, { force: true });
    return null;
  },

  async recordDisbursement(c, { tranche, amount, date, record }) {
    if (tranche) await tranches.markDisbursed(c, tranche.id, { amount, date, transactionId: record.id });
  },
};

module.exports = { tranched };
