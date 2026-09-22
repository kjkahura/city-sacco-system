'use strict';

const { round2 } = require('./accounting');

/**
 * Value-added tax on loan income, after Mambu's "Taxes" section of the loan
 * product form. A product names a rate, which of interest, fees and
 * penalties it applies to, and whether the quoted figure is EXCLUSIVE (the
 * tax goes on top and the member pays it) or INCLUSIVE (the figure already
 * contains it and the income recognised is net).
 *
 * The tax is a liability to the revenue authority (gl_tax_payable). Under
 * accrual accounting it is booked when the charge is applied, alongside the
 * income: Dr Receivable (gross), Cr Income (net), Cr Taxes Payable (tax).
 * Under cash accounting nothing is booked until the member pays, and the
 * payment is split the same way.
 */

const FLAG = { INTEREST: 'tax_on_interest', FEE: 'tax_on_fees', PENALTY: 'tax_on_penalties' };

function rateFor(l, component, { taxable = true } = {}) {
  if (!taxable || !l[FLAG[component]] || l.tax_rate_percent === null || l.tax_rate_percent === undefined) return 0;
  return Number(l.tax_rate_percent) / 100;
}

/**
 * Split a quoted charge into what the member owes (gross), what is income
 * (net) and what is tax.
 */
function split(l, component, quoted, opts = {}) {
  const r = rateFor(l, component, opts);
  const q = round2(quoted);
  if (!(r > 0) || !(q > 0)) return { gross: q, income: q, tax: 0, rate: r };
  if (l.tax_method === 'INCLUSIVE') {
    const income = round2(q / (1 + r));
    return { gross: q, income, tax: round2(q - income), rate: r };
  }
  const tax = round2(q * r);
  return { gross: round2(q + tax), income: q, tax, rate: r };
}

/**
 * Split an amount the member paid towards a component that carried tax:
 * whatever the method, a paid amount is (1 + r) parts of which r is tax.
 */
function splitPaid(l, component, paid, opts = {}) {
  const r = rateFor(l, component, opts);
  const p = round2(paid);
  if (!(r > 0) || !(p > 0)) return { income: p, tax: 0 };
  const income = round2(p / (1 + r));
  return { income, tax: round2(p - income) };
}

/** The credit lines that recognise `s` (a split) against `glIncome`. */
function incomeCredits(l, s, glIncome, memberId) {
  const lines = [{ glCode: glIncome, amount: s.income, memberId }];
  if (s.tax > 0) lines.push({ glCode: l.gl_tax_payable, amount: s.tax, memberId });
  return lines.filter((x) => x.amount > 0);
}

module.exports = { rateFor, split, splitPaid, incomeCredits };
