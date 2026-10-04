'use strict';

const { orgToday } = require('../../lib/orgDate');

/**
 * The values a message's placeholders are filled from: the event's member,
 * account, transaction, credit arrangement and journal entry, the branch,
 * the organization, and the custom fields of the event's main record (by
 * field ID; a grouped set's entries as FIELD_1, FIELD_2...).
 */

const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : '');
const money = (v) => (v === null || v === undefined ? '' : Number(v).toFixed(2));
const one = async (c, sql, params) => (await c.query(sql, params)).rows[0] || null;

function customValues(cf) {
  const out = {};
  for (const set of Object.values(cf || {})) {
    if (Array.isArray(set)) {
      set.forEach((entry, i) => { for (const [k, v] of Object.entries(entry || {})) out[`${k}_${i + 1}`] = v; });
    } else if (set && typeof set === 'object') {
      for (const [k, v] of Object.entries(set)) out[k] = v;
    }
  }
  return out;
}

async function build(c, e) {
  const v = { EVENT: e.event, ACTIVITY_TYPE: e.activity_type || '', ...(e.data || {}) };
  const org = await one(c, 'SELECT name, currency_code FROM platform.tenants WHERE schema_name = current_schema()');
  v.ORGANIZATION_NAME = org?.name || '';
  v.CURRENCY_CODE = org?.currency_code || '';
  v.CURRENT_DATE = await orgToday(c);
  v.SYSTEM_DATE = new Date().toISOString();
  if (e.data?.businessDate) v.BUSINESS_DATE = day(e.data.businessDate);
  let custom = {};

  if (e.member_id) {
    const m = await one(c, 'SELECT * FROM members WHERE id = $1', [e.member_id]);
    if (m) {
      const group = m.holder_type === 'GROUP';
      Object.assign(v, {
        CLIENT_KEY: m.id, CLIENT_ID: m.member_no, FIRST_NAME: group ? '' : m.first_name, MIDDLE_NAME: m.middle_name || '',
        LAST_NAME: group ? '' : m.last_name || '', CLIENT_NAME: [m.first_name, m.middle_name, m.last_name].filter(Boolean).join(' '),
        GROUP_NAME: group ? m.first_name : '', MOBILE_PHONE: m.phone || '', EMAIL_ADDRESS: m.email || '',
      });
      v.RECIPIENT_NAME = v.CLIENT_NAME;
      custom = customValues(m.custom_fields);
    }
  }
  const branchId = e.branch_id;
  if (branchId) {
    const b = await one(c, 'SELECT code, name FROM branches WHERE id = $1', [branchId]);
    if (b) Object.assign(v, { BRANCH_ID: b.code, BRANCH_NAME: b.name });
  }
  if (e.loan_id) {
    const l = await one(c, `SELECT l.*, p.name AS product_name FROM loan_accounts l LEFT JOIN loan_products p ON p.id = l.product_id WHERE l.id = $1`, [e.loan_id]);
    if (l) {
      Object.assign(v, {
        ACCOUNT_KEY: l.id, ACCOUNT_ID: l.account_no, ACCOUNT_NAME: l.product_name || l.product_id, ACCOUNT_STATE: l.status,
        PRODUCT_ID: l.product_id, PRODUCT_NAME: l.product_name || '', LOAN_AMOUNT: money(l.principal),
        PRINCIPAL_BALANCE: money(Number(l.principal_disbursed) + Number(l.principal_capitalized || 0) - Number(l.principal_paid)),
        INTEREST_RATE: l.monthly_rate === null ? '' : String(Number(l.monthly_rate)), DISBURSEMENT_DATE: day(l.disbursed_on),
        DAYS_IN_ARREARS: l.arrears_since ? String(Math.max(0, Math.round((Date.parse(v.CURRENT_DATE) - Date.parse(day(l.arrears_since))) / 86400000))) : '0',
      });
      const inst = e.data?.installmentNumber
        ? await one(c, 'SELECT * FROM loan_installments WHERE loan_id = $1 AND number = $2', [l.id, e.data.installmentNumber])
        : await one(c, "SELECT * FROM loan_installments WHERE loan_id = $1 AND status <> 'PAID' ORDER BY number LIMIT 1", [l.id]);
      if (inst) {
        const pDue = Number(inst.principal_due) - Number(inst.principal_paid);
        const iDue = Number(inst.interest_due) - Number(inst.interest_paid);
        const fDue = Number(inst.fee_due) - Number(inst.fee_paid);
        Object.assign(v, {
          INSTALLMENT_NUMBER: String(inst.number), INSTALLMENT_DUE_DATE: day(inst.due_date), PRINCIPAL_DUE: money(pDue),
          INTEREST_DUE: money(iDue), INSTALLMENT_DUE_AMOUNT: money(pDue + iDue + fDue),
        });
      }
      custom = { ...custom, ...customValues(l.custom_fields) };
    }
  }
  if (e.savings_account_id) {
    const a = await one(c, `SELECT a.*, p.name AS product_name FROM savings_accounts a LEFT JOIN savings_products p ON p.id = a.product_id WHERE a.id = $1`, [e.savings_account_id]);
    if (a) {
      Object.assign(v, {
        ACCOUNT_KEY: a.id, ACCOUNT_ID: a.account_no, ACCOUNT_NAME: a.name || a.product_name || a.product_id, ACCOUNT_STATE: a.status,
        PRODUCT_ID: a.product_id, PRODUCT_NAME: a.product_name || '', TOTAL_BALANCE: money(a.balance),
        AVAILABLE_BALANCE: money(Number(a.balance) + Number(a.overdraft_limit || 0)),
      });
      custom = { ...custom, ...customValues(a.custom_fields) };
    }
  }
  if (e.transaction_id) {
    const t = await one(c, 'SELECT * FROM transactions WHERE id = $1', [e.transaction_id]);
    if (t) {
      Object.assign(v, {
        TRANSACTION_KEY: t.id, TRANSACTION_ID: t.reference, TRANSACTION_TYPE: t.kind, TRANSACTION_AMOUNT: money(t.amount),
        TRANSACTION_VALUE_DATE: day(t.value_date), TRANSACTION_CHANNEL: t.channel_id || '', REVERSAL_OF: t.allocation?.reversalOf || '',
      });
      custom = { ...custom, ...customValues(t.custom_fields) };
    }
  }
  if (e.credit_arrangement_id || e.data?.arrangementNo) {
    const ca = e.credit_arrangement_id ? await one(c, 'SELECT arrangement_no FROM credit_arrangements WHERE id = $1', [e.credit_arrangement_id]) : null;
    v.CREDIT_ARRANGEMENT_ID = ca?.arrangement_no || e.data?.arrangementNo || '';
  }
  if (e.journal_entry_id) v.JOURNAL_ENTRY_ID = e.journal_entry_id;
  return { ...custom, ...v };
}

module.exports = { build, customValues };
