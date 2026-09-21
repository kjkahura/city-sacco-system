#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test over the Mambu v2 surface.
 * Run: npm test
 */

const app = require('../server.js');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const server = app.listen(0, async () => {
  const B = `http://localhost:${server.address().port}`;
  const call = async (m, p, b) => {
    const r = await fetch(B + p, {
      method: m,
      headers: { 'content-type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
    let d = null;
    try { d = await r.json(); } catch { /* 204 */ }
    return { status: r.status, body: d };
  };

  try {
    console.log('\nlegacy dashboard API still works');
    for (const p of ['/api/overview', '/api/clients', '/api/loans', '/api/branches']) {
      const r = await call('GET', p);
      check(`GET ${p}`, r.status === 200, `got ${r.status}`);
    }

    console.log('\nloan lifecycle');
    const created = await call('POST', '/api/v2/loans', {
      principal: 120000, duration: 12, member: 'Grace Njeri', productId: 'NL01',
    });
    check('create loan', created.status === 201);
    const id = created.body.id;

    check('starts PENDING_APPROVAL', created.body.accountState === 'PENDING_APPROVAL', created.body.accountState);

    const early = await call('POST', `/api/v2/loans/${id}/disbursement-transactions`, { amount: 1 });
    check('cannot disburse before approval', early.status === 409, `got ${early.status}`);

    check('approve', (await call('POST', `/api/v2/loans/${id}/approve`)).status === 200);
    check('double approve rejected', (await call('POST', `/api/v2/loans/${id}/approve`)).status === 409);

    const disb = await call('POST', `/api/v2/loans/${id}/disbursement-transactions`, { amount: 120000, channelId: 'bank' });
    check('disburse', disb.status === 201);

    const sch = await call('GET', `/api/v2/loans/${id}/schedule`);
    check('schedule has 12 installments', sch.body?.installments?.length === 12, String(sch.body?.installments?.length));
    check('no due date on a weekend', sch.body.installments.every((i) => {
      const d = new Date(i.dueDate).getUTCDay();
      return d !== 0 && d !== 6;
    }));

    const rep = await call('POST', `/api/v2/loans/${id}/repayment-transactions`, { amount: 12200 });
    check('repay', rep.status === 201);
    check('allocation order pays fees before principal',
      rep.body?.affectedAmounts?.feesAmount === 1000, JSON.stringify(rep.body?.affectedAmounts));

    const bal = await call('GET', `/api/v2/loans/${id}/balances`);
    check('principal reduced by 11200', bal.body.principalBalance === 108800, String(bal.body.principalBalance));

    const adj = await call('POST', `/api/v2/loans/transactions/${rep.body.transactionId}/adjustment`, { notes: 'test reversal' });
    check('repayment adjustable', adj.status === 201);
    const bal2 = await call('GET', `/api/v2/loans/${id}/balances`);
    check('adjustment restored balance', bal2.body.principalBalance === 120000, String(bal2.body.principalBalance));
    const adj2 = await call('POST', `/api/v2/loans/transactions/${rep.body.transactionId}/adjustment`, {});
    check('double adjustment rejected', adj2.status === 409, `got ${adj2.status}`);

    console.log('\ndeposits');
    const dep = await call('POST', '/api/v2/deposits/61110K134/deposit-transactions', { amount: 5000, channelId: 'mpesa' });
    check('deposit', dep.status === 201);
    check('withdraw within balance', (await call('POST', '/api/v2/deposits/61110K134/withdrawal-transactions', { amount: 2000 })).status === 201);
    check('overdraw blocked', (await call('POST', '/api/v2/deposits/61110K134/withdrawal-transactions', { amount: 99999999 })).status === 409);

    const blk = await call('POST', '/api/v2/deposits/61110K134/blocks', { amount: 1000, reason: 'loan guarantee' });
    check('block funds', blk.status === 201);
    const sum = await call('GET', '/api/v2/deposits/61110K134/balances');
    check('blocked amount excluded from available',
      sum.body.availableBalance === sum.body.totalBalance - 1000, JSON.stringify(sum.body));

    console.log('\naccounting');
    const tb = await call('GET', '/api/v2/accounting/trialbalance');
    check('trial balance balances', tb.body.balanced === true, JSON.stringify(tb.body.totals));
    check('unbalanced journal entry rejected',
      (await call('POST', '/api/v2/accounting/journalentries', {
        debits: [{ glCode: '100-000-201', amount: 100 }],
        credits: [{ glCode: '200-000-101', amount: 90 }],
      })).status === 400);
    check('unknown GL account rejected',
      (await call('POST', '/api/v2/accounting/journalentries', {
        debits: [{ glCode: 'NOPE', amount: 100 }],
        credits: [{ glCode: '200-000-101', amount: 100 }],
      })).status === 400);

    console.log('\ngeneric resource contract');
    const h = await call('POST', '/api/v2/holidays', { name: 'Jamhuri Day', date: '2026-12-12' });
    check('create holiday', h.status === 201);
    check('list holidays', (await call('GET', '/api/v2/holidays')).status === 200);
    check('get holiday', (await call('GET', `/api/v2/holidays/${h.body.id}`)).status === 200);
    check('patch holiday', (await call('PATCH', `/api/v2/holidays/${h.body.id}`, [{ op: 'REPLACE', path: '/name', value: 'Jamhuri' }])).status === 204);
    check('search holidays', (await call('POST', '/api/v2/holidays:search', { filterCriteria: [{ field: 'name', operator: 'EQUALS', value: 'Jamhuri' }] })).status === 200);
    check('delete holiday', (await call('DELETE', `/api/v2/holidays/${h.body.id}`)).status === 204);
    check('404 after delete', (await call('GET', `/api/v2/holidays/${h.body.id}`)).status === 404);
  } catch (e) {
    fail++;
    failures.push(`threw: ${e.stack}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log(failures.map((f) => `  - ${f}`).join('\n'));
  server.close();
  process.exit(fail ? 1 : 0);
});
