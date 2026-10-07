/**
 * Deposit products.
 */

import { $, api, esc, money, toast } from './base.js';
import { ask, card, table, view } from './ui.js';
import { changeMethod, opt, productsView } from './products.js';
import { can } from './access.js';
import { appTabs } from './apps.js';

// --------------------------------------------------------------------------
// Deposit products
// --------------------------------------------------------------------------

const DEPOSIT_TYPES = ['SAVINGS_ACCOUNT', 'CURRENT_ACCOUNT', 'FIXED_DEPOSIT', 'SAVINGS_PLAN', 'INVESTOR_ACCOUNT'];
const DEPOSIT_CATEGORIES = ['UNCATEGORIZED', 'PERSONAL_DEPOSIT', 'BUSINESS_DEPOSIT', 'DAILY_BANKING', 'BUSINESS_BANKING', 'STORED_VALUE'];
const INTEREST_POSTING = ['MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL', 'DAILY', 'FIRST_DAY_OF_MONTH', 'WEEKLY', 'EVERY_OTHER_WEEK',
  'MONTHLY_FROM_ACTIVATION', 'QUARTERLY_FROM_ACTIVATION', 'SEMI_ANNUAL_FROM_ACTIVATION', 'ANNUAL_FROM_ACTIVATION', 'FIXED_DATES', 'ON_MATURITY'];
const DEPOSIT_FIELDS = (p = {}) => [
  { label: 'Name', name: 'name', value: p.name || '' },
  { label: 'Type (fixed once accounts exist)', name: 'productType', options: DEPOSIT_TYPES, value: p.productType || 'SAVINGS_ACCOUNT' },
  { label: 'Category', name: 'category', options: DEPOSIT_CATEGORIES, value: p.category || 'UNCATEGORIZED' },
  { label: 'New account numbers', name: 'idGeneratorType', options: ['SHARED_SA_SERIES', 'INCREMENTAL_NUMBER', 'RANDOM_PATTERN'], value: p.newAccounts?.idGeneratorType || 'SHARED_SA_SERIES' },
  opt({ label: 'Starting number or pattern (# digit, @ letter, $ either)', name: 'idPattern', value: p.newAccounts?.idPattern || '' }),
  { label: 'Withdrawable', name: 'withdrawable', options: ['true', 'false'], value: String(p.withdrawable ?? true) },
  { label: 'Minimum balance', name: 'minBalance', type: 'number', step: '0.01', value: p.minBalance ?? 0 },
  { label: 'Pays interest into the account', name: 'interestPaidIntoAccount', options: ['false', 'true'], value: String(p.interest?.paidIntoAccount ?? false) },
  { label: 'Rate terms', name: 'interestRateTerms', options: ['FIXED', 'INDEX', 'TIERED_BALANCE', 'TIERED_BANDS', 'TIERED_PERIOD'], value: p.interest?.rateTerms || 'FIXED' },
  { label: 'Rate, percent (the default for FIXED)', name: 'annualRate', type: 'number', step: '0.0001', value: p.interest?.annualRate ?? 0 },
  opt({ label: 'Lowest and highest account rate (FIXED), e.g. 2,8', name: 'rateRange', value: p.interest?.rateMin !== null && p.interest?.rateMin !== undefined ? `${p.interest.rateMin},${p.interest.rateMax ?? ''}` : '' }),
  { label: 'Rate given per', name: 'interestRateFrequency', options: ['ANNUALIZED', 'EVERY_MONTH', 'EVERY_FOUR_WEEKS', 'EVERY_WEEK', 'EVERY_X_DAYS'], value: p.interest?.rateFrequency || 'ANNUALIZED' },
  opt({ label: 'X days (EVERY_X_DAYS)', name: 'interestRateXDays', type: 'number', value: p.interest?.rateXDays ?? '' }),
  opt({ label: 'Index rate source (INDEX)', name: 'interestIndexSourceId', value: p.interest?.indexSourceId || '' }),
  opt({ label: 'Spread default, lowest, highest (INDEX), e.g. 1.5,0,3', name: 'spread', value: p.interest?.spread?.default !== null && p.interest?.spread?.default !== undefined ? `${p.interest.spread.default},${p.interest.spread.min ?? ''},${p.interest.spread.max ?? ''}` : '' }),
  opt({ label: 'Tiers (TIERED_*): ending:rate, comma separated, last ending blank, e.g. 50000:2,:5', name: 'tiers', value: (p.interest?.tiers || []).map((t) => `${t.ending ?? ''}:${t.rate}`).join(',') }),
  { label: 'Interest on', name: 'interestCalcBalance', options: ['END_OF_DAY', 'MINIMUM_DAILY', 'AVERAGE_DAILY', 'MINIMUM'], value: p.interest?.calcBalance || 'END_OF_DAY',
    hint: 'MINIMUM is the lowest balance in the interest period (the platform\'s first rule); MINIMUM_DAILY and AVERAGE_DAILY are the reference platform\'s.' },
  opt({ label: 'Maximum balance earning interest (END_OF_DAY)', name: 'interestMaxBalance', type: 'number', step: '0.01', value: p.interest?.maxBalance ?? '' }),
  { label: 'Day count', name: 'interestDayCount', options: ['ACTUAL_365', 'ACTUAL_360', 'THIRTY_360', 'ACTUAL_ACTUAL_ISDA'], value: p.interest?.dayCount || 'ACTUAL_365' },
  { label: 'Applied', name: 'interestApplication', options: INTEREST_POSTING, value: p.interest?.application || 'MONTHLY' },
  opt({ label: 'Fixed dates (FIXED_DATES), MM-DD comma separated', name: 'interestFixedDates', value: (p.interest?.fixedDates || []).join(',') }),
  { label: 'A locked account earns interest', name: 'collectInterestWhenLocked', options: ['true', 'false'], value: String(p.interest?.collectWhenLocked ?? true) },
  { label: 'Interest after maturity', name: 'accrueInterestAfterMaturity', options: ['false', 'true'], value: String(p.interest?.accrueAfterMaturity ?? false) },
  opt({ label: 'Term unit (fixed deposit, savings plan)', name: 'termUnit', options: ['', 'DAYS', 'WEEKS', 'MONTHS'], value: p.term?.unit || '' }),
  opt({ label: 'Term default, lowest, highest, e.g. 6,3,12', name: 'termRange', value: p.term ? `${p.term.default ?? ''},${p.term.min ?? ''},${p.term.max ?? ''}` : '' }),
  opt({ label: 'Opening balance lowest, highest, default', name: 'openingRange', value: p.limits ? [p.limits.openingBalance.min, p.limits.openingBalance.max, p.limits.openingBalance.default].map((x) => x ?? '').join(',') : '' }),
  opt({ label: 'Recommended deposit (fixed deposit, savings plan)', name: 'recommendedDepositAmount', type: 'number', step: '0.01', value: p.limits?.recommendedDepositAmount ?? '' }),
  opt({ label: 'Maximum withdrawal in one transaction', name: 'maxWithdrawalAmount', type: 'number', step: '0.01', value: p.limits?.maxWithdrawalAmount ?? '' }),
  opt({ label: 'Days without activity before dormant', name: 'dormancyDays', type: 'number', value: p.dormancyDays ?? '' }),
  { label: 'Allow arbitrary fees', name: 'allowArbitraryFees', options: ['true', 'false'], value: String(p.allowArbitraryFees ?? true) },
  { label: 'New accounts start', name: 'initialState', options: ['ACTIVE', 'PENDING_APPROVAL', 'APPROVED'], value: p.initialState || 'ACTIVE' },
  { label: 'Allow accounts to be used for offset', name: 'allowOffset', options: ['false', 'true'], value: String(p.allowOffset ?? false) },
  opt({ label: 'Index interest rate reviewed every (blank: daily)', name: 'interestReviewCount', type: 'number', value: p.interest?.review?.count ?? '' }),
  { label: 'Review unit', name: 'interestReviewUnit', options: ['', 'DAYS', 'WEEKS', 'MONTHS'], value: p.interest?.review?.unit || '' },
  opt({ label: 'Index overdraft rate reviewed every (blank: daily)', name: 'overdraftReviewCount', type: 'number', value: p.overdraft?.review?.count ?? '' }),
  { label: 'Overdraft review unit', name: 'overdraftReviewUnit', options: ['', 'DAYS', 'WEEKS', 'MONTHS'], value: p.overdraft?.review?.unit || '' },
  opt({ label: 'Minimum balance to earn interest', name: 'minBalanceForInterest', type: 'number', step: '0.01', value: p.interest?.minBalanceForInterest ?? '' }),
  { label: 'Allow a negative rate', name: 'allowNegativeRate', options: ['false', 'true'], value: String(p.interest?.allowNegativeRate ?? false) },
  opt({ label: 'Withholding tax, percent (blank: none)', name: 'withholdingTaxPercent', type: 'number', step: '0.001', value: p.interest?.withholdingTaxPercent ?? '' }),
  { label: 'Allow overdrafts', name: 'allowOverdraft', options: ['false', 'true'], value: String(p.overdraft?.allowed ?? false) },
  opt({ label: 'Maximum overdraft limit', name: 'maxOverdraftLimit', type: 'number', step: '0.01', value: p.overdraft?.maxLimit ?? '' }),
  { label: 'Overdraft rate terms', name: 'overdraftRateTerms', options: ['FIXED', 'INDEX', 'TIERED_BALANCE'], value: p.overdraft?.rateTerms || 'FIXED' },
  { label: 'Overdraft annual rate, percent (the default for FIXED)', name: 'overdraftAnnualRate', type: 'number', step: '0.0001', value: p.overdraft?.annualRate ?? 0 },
  opt({ label: 'Lowest and highest account overdraft rate, e.g. 10,30', name: 'odRange', value: p.overdraft?.rateMin !== null && p.overdraft?.rateMin !== undefined ? `${p.overdraft.rateMin},${p.overdraft.rateMax ?? ''}` : '' }),
  opt({ label: 'Overdraft index source (INDEX)', name: 'overdraftIndexSourceId', value: p.overdraft?.indexSourceId || '' }),
  opt({ label: 'Overdraft spread default, lowest, highest (INDEX)', name: 'odSpread', value: p.overdraft?.spread?.default !== null && p.overdraft?.spread?.default !== undefined ? `${p.overdraft.spread.default},${p.overdraft.spread.min ?? ''},${p.overdraft.spread.max ?? ''}` : '' }),
  opt({ label: 'Overdraft tiers by amount overdrawn: ending:rate', name: 'odTiers', value: (p.overdraft?.tiers || []).map((t) => `${t.ending ?? ''}:${t.rate}`).join(',') }),
  { label: 'Overdraft interest on', name: 'overdraftCalcBalance', options: ['END_OF_DAY', 'MINIMUM_DAILY'], value: p.overdraft?.calcBalance || 'END_OF_DAY' },
  { label: 'Allow technical overdrafts (charges past zero)', name: 'allowTechnicalOverdraft', options: ['false', 'true'], value: String(p.overdraft?.technicalAllowed ?? false) },
  { label: 'Accounting (fixed once accounts exist; use Change accounting method)', name: 'accountingMethod', options: ['CASH', 'ACCRUAL', 'NONE'], value: p.accountingMethod || 'CASH' },
  { label: 'Accrued interest reaches the ledger (ACCRUAL only)', name: 'interestAccruedAccounting', options: ['NONE', 'DAILY', 'MONTHLY'], value: p.interestAccruedAccounting || 'NONE' },
  { label: 'Accrual entries', name: 'accrualGranularity', options: ['PER_ACCOUNT', 'AGGREGATED'], value: p.accrualGranularity || 'PER_ACCOUNT' },
  opt({ label: 'GL: Savings Control', name: 'glSavingsControl', value: p.gl?.savingsControl || '200-100' }),
  opt({ label: 'GL: Fee Income', name: 'glFeeIncome', value: p.gl?.feeIncome || '400-200' }),
  opt({ label: 'GL: Interest Expense', name: 'glInterestExpense', value: p.gl?.interestExpense || '500-100' }),
  opt({ label: 'GL: Interest Payable (accrual)', name: 'glInterestPayable', value: p.gl?.interestPayable || '200-110' }),
  opt({ label: 'GL: Withholding Tax Payable', name: 'glTaxPayable', value: p.gl?.taxPayable || '200-330' }),
  opt({ label: 'GL: Negative Interest Income', name: 'glNegativeInterestIncome', value: p.gl?.negativeInterestIncome || '400-310' }),
  opt({ label: 'GL: Negative Interest Receivable (accrual)', name: 'glNegativeInterestReceivable', value: p.gl?.negativeInterestReceivable || '100-330' }),
  opt({ label: 'GL: Overdraft Portfolio', name: 'glOverdraftPortfolio', value: p.gl?.overdraftPortfolio || '100-400' }),
  opt({ label: 'GL: Overdraft Write-off', name: 'glOverdraftWriteOff', value: p.gl?.overdraftWriteOff || '500-320' }),
  opt({ label: 'GL: Overdraft Interest Income', name: 'glOverdraftInterestIncome', value: p.gl?.overdraftInterestIncome || '400-300' }),
  opt({ label: 'GL: Overdraft Interest Receivable (accrual)', name: 'glOverdraftInterestReceivable', value: p.gl?.overdraftInterestReceivable || '100-410' }),
];

// Build the body, then ask the server which mappings those settings use and
// send only those: a product refuses an account it would never post to.
async function depositBody(d) {
  const num = (v) => (v === '' || v === undefined ? null : Number(v));
  const parts = (v, n) => { const x = String(v || '').split(',').map((y) => num(y.trim())); while (x.length < n) x.push(null); return x; };
  const tiers = (v) => String(v || '').split(',').filter((x) => x.includes(':')).map((x) => { const [e, r] = x.split(':'); return { ending: num(e.trim()), rate: Number(r) }; });
  const [rateMin, rateMax] = parts(d.rateRange, 2);
  const [spreadDefault, spreadMin, spreadMax] = parts(d.spread, 3);
  const [termDefault, termMin, termMax] = parts(d.termRange, 3);
  const [openMin, openMax, openDefault] = parts(d.openingRange, 3);
  const [odMin, odMax] = parts(d.odRange, 2);
  const [odSpreadDefault, odSpreadMin, odSpreadMax] = parts(d.odSpread, 3);
  const term = d.termUnit ? { termUnit: d.termUnit, termDefault, termMin, termMax } : {};
  const extra = {
    productType: d.productType, category: d.category,
    idGeneratorType: d.idGeneratorType === 'SHARED_SA_SERIES' ? null : d.idGeneratorType, idPattern: d.idGeneratorType === 'SHARED_SA_SERIES' ? null : d.idPattern || null,
    interestRateTerms: d.interestRateTerms, interestRateMin: rateMin, interestRateMax: rateMax, interestRateFrequency: d.interestRateFrequency,
    interestRateXDays: num(d.interestRateXDays), interestIndexSourceId: d.interestIndexSourceId || null,
    interestSpreadDefault: spreadDefault, interestSpreadMin: spreadMin, interestSpreadMax: spreadMax, interestRateTiers: tiers(d.tiers),
    interestMaxBalance: num(d.interestMaxBalance), interestFixedDates: String(d.interestFixedDates || '').split(',').map((x) => x.trim()).filter(Boolean),
    collectInterestWhenLocked: d.collectInterestWhenLocked !== 'false', accrueInterestAfterMaturity: d.accrueInterestAfterMaturity === 'true',
    ...term, minOpeningBalance: openMin, maxOpeningBalance: openMax, defaultOpeningBalance: openDefault,
    recommendedDepositAmount: num(d.recommendedDepositAmount), maxWithdrawalAmount: num(d.maxWithdrawalAmount), dormancyDays: num(d.dormancyDays),
    allowArbitraryFees: d.allowArbitraryFees !== 'false', initialState: d.initialState || 'ACTIVE', allowOffset: d.allowOffset === 'true',
    interestReviewCount: num(d.interestReviewCount), interestReviewUnit: d.interestReviewUnit || null,
    overdraftReviewCount: num(d.overdraftReviewCount), overdraftReviewUnit: d.overdraftReviewUnit || null, overdraftRateTerms: d.overdraftRateTerms, overdraftRateMin: odMin, overdraftRateMax: odMax,
    overdraftIndexSourceId: d.overdraftIndexSourceId || null, overdraftSpreadDefault: odSpreadDefault, overdraftSpreadMin: odSpreadMin,
    overdraftSpreadMax: odSpreadMax, overdraftRateTiers: tiers(d.odTiers), overdraftCalcBalance: d.overdraftCalcBalance,
  };
  const out = {
    ...extra,
    name: d.name, withdrawable: d.withdrawable === 'true', minBalance: num(d.minBalance) ?? 0,
    interestPaidIntoAccount: d.interestPaidIntoAccount === 'true', annualRate: num(d.annualRate) ?? 0,
    interestCalcBalance: d.interestCalcBalance, interestDayCount: d.interestDayCount, interestApplication: d.interestApplication,
    minBalanceForInterest: num(d.minBalanceForInterest), allowNegativeRate: d.allowNegativeRate === 'true',
    withholdingTaxPercent: num(d.withholdingTaxPercent), allowOverdraft: d.allowOverdraft === 'true',
    maxOverdraftLimit: num(d.maxOverdraftLimit), overdraftAnnualRate: num(d.overdraftAnnualRate) ?? 0,
    allowTechnicalOverdraft: d.allowTechnicalOverdraft === 'true', accountingMethod: d.accountingMethod,
    interestAccruedAccounting: d.accountingMethod === 'ACCRUAL' ? d.interestAccruedAccounting : 'NONE', accrualGranularity: d.accrualGranularity,
  };
  const r = await api('POST', '/api/deposit-products/accounting-rules', out);
  const byColumn = {
    gl_liability: 'glSavingsControl', gl_fee_inc: 'glFeeIncome', gl_interest_exp: 'glInterestExpense', gl_interest_payable: 'glInterestPayable',
    gl_tax_payable: 'glTaxPayable', gl_neg_interest_inc: 'glNegativeInterestIncome', gl_neg_interest_rec: 'glNegativeInterestReceivable',
    gl_od_portfolio: 'glOverdraftPortfolio', gl_od_writeoff: 'glOverdraftWriteOff', gl_od_interest_inc: 'glOverdraftInterestIncome',
    gl_od_interest_rec: 'glOverdraftInterestReceivable',
  };
  for (const rule of (r.ok ? r.body : [])) {
    const k = byColumn[rule.column];
    if (k) out[k] = rule.used ? d[k] || null : null;
  }
  return out;
}

async function depositProductDetail(p0) {
  const r = await api('GET', `/api/deposit-products/${p0.id}`);
  if (!r.ok) throw new Error(r.error);
  const p = r.body;
  const etag = r.etag;
  view().innerHTML = `
    <button class="secondary" id="back">← Products</button>
    <div class="toolbar"><h1>${esc(p.id)} · ${esc(p.name)}</h1><span class="spacer"></span>
      <button id="d-edit" class="secondary">Edit settings</button><button id="d-method" class="secondary">Change accounting method</button><button id="d-fee">Add fee</button>
      ${p.accounts === 0 && can('DELETE_SAVINGS_PRODUCT') ? '<button id="d-delete" class="secondary">Delete</button>' : ''}</div>
    <div class="grid">
      ${card('Type and limits', `<dl class="kv" id="deposit-product-type">
        <dt>Type</dt><dd>${esc(String(p.productType).replace(/_/g, ' ').toLowerCase())} · ${esc(String(p.category).replace(/_/g, ' ').toLowerCase())}</dd>
        <dt>Account numbers</dt><dd>${p.newAccounts.idGeneratorType ? `${esc(p.newAccounts.idGeneratorType.replace(/_/g, ' ').toLowerCase())} ${esc(p.newAccounts.idPattern)}` : 'the shared SA series'}</dd>
        <dt>Rate terms</dt><dd>${esc(p.interest.rateTerms)}${p.interest.rateTerms === 'FIXED' && p.interest.rateMin !== null ? `, ${p.interest.rateMin}% to ${p.interest.rateMax ?? 'any'}%` : ''}${p.interest.tiers.length ? `, tiers ${p.interest.tiers.map((t) => `${t.ending ?? 'above'}: ${t.rate}%`).join(' · ')}` : ''}${p.interest.indexSourceId ? `, ${esc(p.interest.indexSourceId)} + ${p.interest.spread.default ?? 0}` : ''}</dd>
        <dt>Term</dt><dd>${p.term ? `${p.term.default} ${esc(p.term.unit.toLowerCase())} (${p.term.min ?? '—'} to ${p.term.max ?? '—'})` : 'none'}</dd>
        <dt>Maximum withdrawal</dt><dd>${p.limits.maxWithdrawalAmount ?? 'none'}</dd><dt>Dormant after</dt><dd>${p.dormancyDays ? `${p.dormancyDays} days` : 'never'}</dd>
        <dt>Arbitrary fees</dt><dd>${p.allowArbitraryFees ? 'allowed' : 'not allowed'}</dd>
        <dt>New accounts start</dt><dd>${esc(String(p.initialState || 'ACTIVE').replace(/_/g, ' ').toLowerCase())}</dd>
        <dt>Offset</dt><dd>${p.allowOffset ? 'accounts may offset loans' : 'no'}</dd>
      </dl>`)}
      ${card('Interest', `<dl class="kv">
        <dt>Paid</dt><dd>${p.interest.paidIntoAccount ? `${p.interest.annualRate}% a year on the ${esc(p.interest.calcBalance.toLowerCase().replace(/_/g, ' '))} balance, ${esc(p.interest.dayCount)}, applied ${esc(p.interest.application.toLowerCase().replace('_', ' '))}` : 'no interest'}</dd>
        <dt>Threshold</dt><dd>${p.interest.minBalanceForInterest ?? 'none'}</dd>
        <dt>Withholding tax</dt><dd>${p.interest.withholdingTaxPercent === null ? 'not set' : `${p.interest.withholdingTaxPercent}%`}</dd>
      </dl>`)}
      ${card('Overdraft', `<dl class="kv">
        <dt>Authorised</dt><dd>${p.overdraft.allowed ? `up to ${p.overdraft.maxLimit ?? 'any amount'} at ${p.overdraft.annualRate}% a year` : 'no'}</dd>
        <dt>Technical</dt><dd>${p.overdraft.technicalAllowed ? 'charges may take the balance below zero' : 'no'}</dd>
      </dl>`)}
      ${card('Accounting', `<dl class="kv">
        <dt>Method</dt><dd>${esc(p.accountingMethod)}${p.accountingMethod === 'ACCRUAL' ? ` · accrued interest to the ledger ${esc(p.interestAccruedAccounting)}, ${esc(p.accrualGranularity.toLowerCase().replace('_', ' '))}` : ''}</dd>
        <dt>GL rules</dt><dd>${p.accountingRules.length ? p.accountingRules.map((x) => `${esc(x.resource)} ${esc(x.glCode)}`).join(' · ') : 'none: not linked to accounting'}</dd>
        <dt>Accounts</dt><dd>${p.accounts}</dd>
      </dl>`)}
    </div>
    ${card('Fees', table([
    { label: 'Code', key: 'code' }, { label: 'Fee', key: 'name' }, { label: 'When', value: (f) => `${f.trigger}${f.applyDateMethod ? ` · ${f.applyDateMethod.replace(/_/g, ' ').toLowerCase()}` : ''}` },
    { label: '', html: true, value: (f) => `<button class="link" data-fee-drop="${esc(f.code)}">delete</button>` },
    { label: 'Amount', num: true, value: (f) => (f.amount === null ? 'set when charged' : money(f.amount)) },
    { label: 'Income GL', value: (f) => f.glIncome || 'product default' },
  ], p.fees, { empty: 'No fees defined.' }))}`;
  $('#back').addEventListener('click', productsView);
  $('#d-edit').addEventListener('click', async () => {
    const d = await ask(DEPOSIT_FIELDS(p), `Edit ${p.id}`);
    if (!d) return;
    const body = await depositBody(d);
    if (p.accounts > 0) { delete body.accountingMethod; delete body.interestAccruedAccounting; }
    const res = await api('PATCH', `/api/deposit-products/${p.id}`, body, { ifMatch: etag });
    toast(res.ok ? `${p.id} saved` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) depositProductDetail(p);
  });
  $('#d-method').addEventListener('click', () => changeMethod('deposit-products', p, depositProductDetail));
  const del = $('#d-delete');
  if (del) del.addEventListener('click', async () => {
    if (!(await ask([], `Delete ${p.id}? Only a product that never had accounts is deleted.`))) return;
    const res = await api('DELETE', `/api/deposit-products/${p.id}`);
    toast(res.ok ? `${p.id} deleted` : res.error, !res.ok);
    if (res.ok) productsView();
  });
  view().querySelectorAll('[data-fee-drop]').forEach((b) => b.addEventListener('click', async () => {
    const res = await api('DELETE', `/api/deposit-products/${p.id}/fees/${b.dataset.feeDrop}`, undefined, { ifMatch: etag });
    toast(res.ok ? 'Fee deleted' : res.error, !res.ok);
    if (res.ok) depositProductDetail(p);
  }));
  $('#d-fee').addEventListener('click', async () => {
    const d = await ask([
      { label: 'Code', name: 'code' }, { label: 'Name', name: 'name' },
      { label: 'When', name: 'trigger', options: ['MANUAL', 'MONTHLY'], value: 'MANUAL' },
      { label: 'Monthly fees are charged', name: 'applyDateMethod', options: ['END_OF_MONTH', 'FIRST_DAY_OF_MONTH', 'MONTHLY_FROM_ACTIVATION'], value: 'END_OF_MONTH' },
      opt({ label: 'Amount', name: 'amount', type: 'number', step: '0.01', value: '' }),
      opt({ label: 'Income GL (blank: product default)', name: 'glIncome', value: '' }),
    ], `New fee on ${p.id}`);
    if (!d) return;
    const res = await api('POST', `/api/deposit-products/${p.id}/fees`, {
      code: d.code.toUpperCase(), name: d.name, trigger: d.trigger, amount: d.amount === '' ? null : Number(d.amount), glIncome: d.glIncome || null,
      applyDateMethod: d.trigger === 'MONTHLY' ? d.applyDateMethod : undefined,
    }, { ifMatch: etag });
    toast(res.ok ? `Fee ${res.body.code} added` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) depositProductDetail(p);
  });
  appTabs('DEPOSIT_PRODUCT_VIEW', p.id);
}

export async function depositProductsSection() {
  const r = await api('GET', '/api/deposit-products');
  if (!r.ok) return;
  const holder = document.createElement('section');
  holder.innerHTML = `
    <div class="toolbar"><h1>Deposit products</h1><span class="spacer"></span><button id="d-new">New deposit product</button></div>
    ${table([
    { label: 'Id', key: 'id' }, { label: 'Name', key: 'name' },
    { label: 'Interest', value: (p) => (p.interest.paidIntoAccount ? `${p.interest.annualRate}% ${p.interest.application.toLowerCase()}` : 'none') },
    { label: 'Overdraft', value: (p) => (p.overdraft.allowed ? `to ${p.overdraft.maxLimit ?? 'any'}` : p.overdraft.technicalAllowed ? 'technical only' : 'no') },
    { label: 'Accounting', value: (p) => `${p.accountingMethod}${p.accountingMethod === 'ACCRUAL' ? ` · ${p.interestAccruedAccounting}` : ''}` },
    { label: 'Accounts', num: true, key: 'accounts' },
  ], r.body, { onRow: true, empty: 'No deposit products' })}`;
  view().appendChild(holder);
  holder.querySelectorAll('tr[data-row]').forEach((tr) => tr.addEventListener('click', () => depositProductDetail(r.body[Number(tr.dataset.row)])));
  $('#d-new').addEventListener('click', async () => {
    const d = await ask([{ label: 'Id (2 to 16 letters, digits or underscore)', name: 'id' }, ...DEPOSIT_FIELDS()], 'New deposit product');
    if (!d) return;
    const res = await api('POST', '/api/deposit-products', { id: d.id, ...(await depositBody(d)) });
    toast(res.ok ? `${res.body.id} created` : `${res.error}${res.body?.errors?.[0]?.errorSource ? ': ' + res.body.errors[0].errorSource : ''}`, !res.ok);
    if (res.ok) productsView();
  });
}
