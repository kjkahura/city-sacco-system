'use strict';

const { JOURNAL_ENTRIES, GL_ACCOUNTS } = require('../store');
const { newKey } = require('../lib/resource');

/**
 * Double-entry posting.
 *
 * Every money movement in the system routes through post(). Nothing writes a
 * balance directly. This is what gives the trial balance and the balance sheet
 * a real source instead of the hardcoded TB_DATA the reports used before.
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function glAccount(code) {
  return GL_ACCOUNTS.find((a) => a.code === code || a.glCode === code);
}

/**
 * @param {object} p
 * @param {Array<{glCode:string, amount:number}>} p.debits
 * @param {Array<{glCode:string, amount:number}>} p.credits
 */
function post({
  debits = [],
  credits = [],
  bookingDate = new Date().toISOString(),
  notes = '',
  transactionId = null,
  accountKey = null,
  channelId = null,
  currencyCode = 'KES',
  userKey = 'SYSTEM',
}) {
  const totalDr = round2(debits.reduce((s, d) => s + Number(d.amount || 0), 0));
  const totalCr = round2(credits.reduce((s, c) => s + Number(c.amount || 0), 0));

  if (totalDr <= 0 && totalCr <= 0) {
    throw Object.assign(new Error('JOURNAL_ENTRY_EMPTY'), { status: 400 });
  }
  if (totalDr !== totalCr) {
    throw Object.assign(
      new Error(`JOURNAL_ENTRY_UNBALANCED: debits ${totalDr} != credits ${totalCr}`),
      { status: 400 }
    );
  }

  const unknown = [...debits, ...credits]
    .map((l) => l.glCode)
    .filter((code) => !glAccount(code));
  if (unknown.length) {
    throw Object.assign(new Error(`GL_ACCOUNT_NOT_FOUND: ${unknown.join(', ')}`), { status: 400 });
  }

  const entryId = newKey();
  const lines = [
    ...debits.map((d) => ({ type: 'DEBIT', ...d })),
    ...credits.map((c) => ({ type: 'CREDIT', ...c })),
  ].map((l, i) => ({
    entryId: `${entryId}-${i + 1}`,
    parentEntryId: entryId,
    glAccountCode: l.glCode,
    glAccountName: glAccount(l.glCode)?.name || null,
    type: l.type,
    amount: round2(l.amount),
    bookingDate,
    creationDate: new Date().toISOString(),
    currencyCode,
    transactionId,
    accountKey,
    channelId,
    userKey,
    notes,
    reversalEntryId: null,
  }));

  JOURNAL_ENTRIES.push(...lines);
  return { entryId, lines, amount: totalDr };
}

/**
 * Mambu never deletes a posted journal entry. Reversal writes the mirror image
 * and links both directions, so the audit trail keeps the original.
 */
function reverse(parentEntryId, notes = 'Reversal') {
  const originals = JOURNAL_ENTRIES.filter((e) => e.parentEntryId === parentEntryId && !e.reversalEntryId);
  if (!originals.length) {
    throw Object.assign(new Error('JOURNAL_ENTRY_NOT_FOUND'), { status: 404 });
  }
  const debits = originals.filter((e) => e.type === 'CREDIT').map((e) => ({ glCode: e.glAccountCode, amount: e.amount }));
  const credits = originals.filter((e) => e.type === 'DEBIT').map((e) => ({ glCode: e.glAccountCode, amount: e.amount }));

  const result = post({
    debits,
    credits,
    notes,
    transactionId: originals[0].transactionId,
    accountKey: originals[0].accountKey,
    currencyCode: originals[0].currencyCode,
  });
  originals.forEach((e) => { e.reversalEntryId = result.entryId; });
  result.lines.forEach((l) => { l.reversalEntryId = parentEntryId; });
  return result;
}

/** Net movement on one GL account, debit-positive. */
function balance(glCode, { from, to } = {}) {
  return round2(
    JOURNAL_ENTRIES.filter((e) => {
      if (e.glAccountCode !== glCode) return false;
      if (from && new Date(e.bookingDate) < new Date(from)) return false;
      if (to && new Date(e.bookingDate) > new Date(to)) return false;
      return true;
    }).reduce((s, e) => s + (e.type === 'DEBIT' ? e.amount : -e.amount), 0)
  );
}

function trialBalance({ from, to } = {}) {
  return GL_ACCOUNTS.map((a) => {
    const code = a.code || a.glCode;
    const net = balance(code, { from, to });
    return {
      glCode: code,
      name: a.name,
      type: a.type,
      debit: net > 0 ? net : 0,
      credit: net < 0 ? -net : 0,
      balance: net,
    };
  }).filter((r) => r.debit || r.credit);
}

module.exports = { post, reverse, balance, trialBalance, round2, glAccount };
