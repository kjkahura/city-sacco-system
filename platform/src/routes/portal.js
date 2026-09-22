'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireMember } = require('../tenancy/resolve');
const { loginRateLimit } = require('../lib/limits');
const { apiError, badRequest, notFound } = require('../lib/http');
const { pageQuery, sendPage } = require('../lib/page');
const MA = require('../auth/memberAuth');
const S = require('../domain/savings');
const L = require('../domain/loans');

/**
 * The member portal API.
 *
 * Every handler after the auth block runs with req.member set by
 * requireMember, and every query is filtered by that member's id. There is
 * no endpoint here that takes a member id from the client: the token says
 * who you are, and that is the only member you can see.
 */

const router = express.Router();

const read = (fn) => [
  requireMember(),
  async (req, res, next) => {
    try {
      const out = await withTenantRead(req.tenant.schema_name, (c) => fn(c, req));
      return out === null ? notFound(res, 'account') : res.json(out);
    } catch (e) { next(e); }
  },
];

const write = (fn) => [
  requireMember(),
  async (req, res, next) => {
    try {
      const out = await withTenant(req.tenant.schema_name, (c) => fn(c, req, { actor: req.member.memberNo }));
      return out === null ? notFound(res, 'account') : res.status(201).json(out);
    } catch (e) { next(e); }
  },
];

/** Turn a committed refusal into the error response it stands for. */
const refused = (res, out) => apiError(res, out.failure.status, out.failure.status, out.failure.code);

// --- auth -----------------------------------------------------------------

router.post('/auth/activate', loginRateLimit({ perIp: 10, perAccount: 5 }), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.memberNo || !b.nationalId || !b.phone || !b.pin) {
      return badRequest(res, 'MEMBER_NO_NATIONAL_ID_PHONE_AND_PIN_REQUIRED');
    }
    res.status(201).json(await withTenant(req.tenant.schema_name, (c) => MA.activate(c, b)));
  } catch (e) { next(e); }
});

// The per-account control for members is the lockout in member_credentials
// (five wrong PINs, fifteen minutes), which survives across processes and
// restarts. The limiter here is for spraying: it keeps its tight per-IP
// window and gives the per-account counter enough room not to fire first.
router.post('/auth/login', loginRateLimit({ perAccount: 20 }), async (req, res, next) => {
  try {
    const { phone, pin } = req.body || {};
    if (!phone || !pin) return badRequest(res, 'PHONE_AND_PIN_REQUIRED');
    const out = await withTenant(req.tenant.schema_name, (c) => MA.login(c, {
      phone, pin, tenantSlug: req.tenant.slug, userAgent: req.get('user-agent'), ip: req.ip,
    }));
    if (out.failure) return refused(res, out);
    res.json({ ...out, tenant: { slug: req.tenant.slug, name: req.tenant.name, currency: req.tenant.currency_code } });
  } catch (e) { next(e); }
});

router.post('/auth/refresh', loginRateLimit({ perIp: 60, perAccount: 60 }), async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return badRequest(res, 'REFRESH_TOKEN_REQUIRED');
    const out = await withTenant(req.tenant.schema_name, (c) => MA.rotate(c, refreshToken, req.tenant.slug, {
      userAgent: req.get('user-agent'), ip: req.ip,
    }));
    if (out.failure) return refused(res, out);
    res.json(out);
  } catch (e) { next(e); }
});

router.post('/auth/logout', async (req, res, next) => {
  try {
    const { refreshToken, allDevices } = req.body || {};
    res.json(await withTenant(req.tenant.schema_name, (c) => MA.logout(c, refreshToken, { all: !!allDevices })));
  } catch (e) { next(e); }
});

router.post('/auth/pin', ...write((c, req) => MA.changePin(c, req.member.id, req.body || {})));

// --- me -------------------------------------------------------------------

router.get('/me', ...read(async (c, req) => {
  const { rows: [m] } = await c.query('SELECT * FROM members WHERE id = $1', [req.member.id]);
  return m ? { member: MA.publicMember(m) } : null;
}));

/**
 * Every account the member holds, in one list, because that is how a member
 * thinks about it. Savings carry a balance, shares carry units and a value,
 * loans carry what is owed. `id` is the account number, which is what the
 * other endpoints here take.
 */
router.get('/accounts', ...read(async (c, req) => {
  const mid = req.member.id;
  const { rows: savings } = await c.query(
    `SELECT a.account_no, a.status, a.balance, a.opened_on, p.name AS product
     FROM savings_accounts a JOIN savings_products p ON p.id = a.product_id
     WHERE a.member_id = $1 ORDER BY a.opened_on, a.account_no`, [mid]);
  const { rows: shares } = await c.query(
    `SELECT a.account_no, a.status, a.units, p.unit_price, p.name AS product
     FROM share_accounts a JOIN share_products p ON p.id = a.product_id
     WHERE a.member_id = $1 ORDER BY a.account_no`, [mid]);
  const { rows: loans } = await c.query(
    `SELECT l.*, p.name AS product FROM loan_accounts l JOIN loan_products p ON p.id = l.product_id
     WHERE l.member_id = $1 AND l.status NOT IN ('PARTIAL_APPLICATION','CLOSED_REJECTED','CLOSED_WITHDRAWN')
     ORDER BY l.created_at DESC`, [mid]);

  const accounts = [
    ...savings.map((a) => ({
      id: a.account_no, accountNumber: a.account_no, accountType: 'SAVINGS', product: a.product,
      accountState: a.status, balance: Number(a.balance), openedOn: a.opened_on,
    })),
    ...shares.map((a) => ({
      id: a.account_no, accountNumber: a.account_no, accountType: 'SHARES', product: a.product,
      accountState: a.status, units: Number(a.units),
      balance: Math.round(Number(a.units) * Number(a.unit_price) * 100) / 100,
    })),
    ...loans.map((l) => {
      const b = L.balances(l);
      return {
        id: l.account_no, accountNumber: l.account_no, accountType: 'LOAN', product: l.product,
        accountState: l.status, principal: Number(l.principal),
        balance: b.total, outstanding: b, disbursedOn: l.disbursed_on,
      };
    }),
  ];
  return { accounts };
}));

/** Transactions on one of the member's accounts, newest first. */
router.get('/accounts/:no/transactions', requireMember(), async (req, res, next) => {
  try {
    const page = await withTenantRead(req.tenant.schema_name, (c) => pageQuery(
      c,
      `SELECT t.reference, t.kind, t.amount, t.value_date, t.narration, t.channel_id,
              t.reversed_by IS NOT NULL AS reversed, t.allocation, t.created_at
       FROM transactions t
       LEFT JOIN savings_accounts s ON s.id = t.savings_account_id
       LEFT JOIN loan_accounts   l ON l.id = t.loan_account_id
       LEFT JOIN share_accounts  h ON h.id = t.share_account_id
       WHERE COALESCE(s.account_no, l.account_no, h.account_no) = $1
         AND COALESCE(s.member_id, l.member_id, h.member_id) = $2
       ORDER BY t.created_at DESC, t.id`,
      [req.params.no, req.member.id],
      req.query
    ));
    sendPage(res, page);
  } catch (e) { next(e); }
});

router.get('/loans/:no/schedule', ...read(async (c, req) => {
  const { rows } = await c.query(
    `SELECT i.number, i.due_date, i.principal_due, i.interest_due, i.fee_due,
            i.principal_paid, i.interest_paid, i.fee_paid, i.status
     FROM loan_installments i JOIN loan_accounts l ON l.id = i.loan_id
     WHERE l.account_no = $1 AND l.member_id = $2 ORDER BY i.number`,
    [req.params.no, req.member.id]);
  return rows.length ? { schedule: rows } : null;
}));

/** Totals for the dashboard tiles, over the member's own transactions. */
router.get('/stats', ...read(async (c, req) => {
  const { rows: [s] } = await c.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'SAVINGS_DEPOSIT'), 0)    AS deposits,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'SAVINGS_WITHDRAWAL'), 0) AS withdrawals,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'SAVINGS_TRANSFER'), 0)   AS transfers,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'LOAN_REPAYMENT'), 0)     AS repayments,
            count(*)::int AS transactions
     FROM transactions WHERE member_id = $1 AND reversed_by IS NULL`, [req.member.id]);
  return { stats: {
    totalDeposits: Number(s.deposits), totalWithdrawals: Number(s.withdrawals),
    totalTransfers: Number(s.transfers), totalRepayments: Number(s.repayments),
    transactions: s.transactions,
  } };
}));

// --- transfers ------------------------------------------------------------

/** A member's own savings account, or null if the number is not theirs. */
async function ownSavings(c, memberId, accountNo) {
  const { rows: [a] } = await c.query(
    "SELECT * FROM savings_accounts WHERE account_no = $1 AND member_id = $2 AND status = 'ACTIVE'",
    [accountNo, memberId]);
  return a || null;
}

/** The savings account transfers to a member land in: the oldest active one. */
async function primarySavings(c, memberId) {
  const { rows: [a] } = await c.query(
    "SELECT * FROM savings_accounts WHERE member_id = $1 AND status = 'ACTIVE' ORDER BY opened_on, account_no LIMIT 1",
    [memberId]);
  return a || null;
}

router.post('/transfers/own', ...write(async (c, req, { actor }) => {
  const { fromAccountId, toAccountId, amount, description } = req.body || {};
  const from = await ownSavings(c, req.member.id, fromAccountId);
  const to = await ownSavings(c, req.member.id, toAccountId);
  if (!from || !to) throw MA.err('ACCOUNT_NOT_YOURS', 404);
  return S.transfer(c, from.id, { toAccountId: to.id, amount, narration: description, createdBy: actor });
}));

/**
 * Who a phone number belongs to, before a member sends money to it. Returns
 * a first name and a masked account number: enough to confirm you have the
 * right person, not enough to enumerate the membership.
 */
router.get('/transfers/lookup', ...read(async (c, req) => {
  const phone = MA.normalisePhone(req.query.phone);
  const { rows: [m] } = await c.query(
    `SELECT m.id, m.first_name, m.last_name FROM members m
     JOIN member_credentials cr ON cr.member_id = m.id
     WHERE cr.phone = $1 AND m.status = 'ACTIVE'`, [phone]);
  if (!m || m.id === req.member.id) return null;
  const a = await primarySavings(c, m.id);
  if (!a) return null;
  return { beneficiary: {
    name: `${m.first_name} ${m.last_name.charAt(0)}.`,
    accountNumber: `${a.account_no.slice(0, 2)}****${a.account_no.slice(-2)}`,
  } };
}));

router.post('/transfers/internal', ...write(async (c, req, { actor }) => {
  const { recipientPhone, amount, description, fromAccountId } = req.body || {};
  const phone = MA.normalisePhone(recipientPhone);
  const from = fromAccountId
    ? await ownSavings(c, req.member.id, fromAccountId)
    : await primarySavings(c, req.member.id);
  if (!from) throw MA.err('NO_SAVINGS_ACCOUNT', 404);

  const { rows: [r] } = await c.query(
    `SELECT m.id FROM members m JOIN member_credentials cr ON cr.member_id = m.id
     WHERE cr.phone = $1 AND m.status = 'ACTIVE'`, [phone]);
  if (!r) throw MA.err('RECIPIENT_NOT_FOUND', 404);
  if (r.id === req.member.id) throw MA.err('CANNOT_TRANSFER_TO_YOURSELF');
  const to = await primarySavings(c, r.id);
  if (!to) throw MA.err('RECIPIENT_HAS_NO_SAVINGS_ACCOUNT', 409);

  return S.transfer(c, from.id, { toAccountId: to.id, amount, narration: description, createdBy: actor });
}));

// --- beneficiaries --------------------------------------------------------

router.get('/beneficiaries', ...read(async (c, req) => {
  const { rows } = await c.query(
    `SELECT b.id, b.name, b.phone, b.account_no, b.relationship, b.daily_limit, b.created_at,
            b.beneficiary_member_id IS NOT NULL AS is_member
     FROM beneficiaries b WHERE b.member_id = $1 ORDER BY b.name`, [req.member.id]);
  return { beneficiaries: rows.map((b) => ({
    id: b.id, name: b.name, mobilePhone: b.phone, accountNumber: b.account_no,
    relationship: b.relationship, dailyLimit: b.daily_limit, isVerified: b.is_member, createdAt: b.created_at,
  })) };
}));

router.post('/beneficiaries', ...write(async (c, req) => {
  const b = req.body || {};
  if (!b.name) throw MA.err('NAME_REQUIRED');
  if (!b.mobilePhone && !b.accountNumber) throw MA.err('PHONE_OR_ACCOUNT_REQUIRED');
  const phone = b.mobilePhone ? MA.normalisePhone(b.mobilePhone) : null;

  // Link to a member of this SACCO when the phone matches one; that is what
  // "verified" means on the portal.
  let linked = null;
  if (phone) {
    const { rows: [m] } = await c.query(
      'SELECT member_id FROM member_credentials WHERE phone = $1', [phone]);
    linked = m?.member_id || null;
  }
  const { rows: [row] } = await c.query(
    `INSERT INTO beneficiaries (member_id, name, phone, account_no, relationship, beneficiary_member_id, daily_limit)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.member.id, b.name, phone, b.accountNumber || null, b.relationship || null, linked,
     b.dailyLimit ? Number(b.dailyLimit) : null]);
  return { beneficiary: { id: row.id, name: row.name, isVerified: !!linked } };
}));

router.delete('/beneficiaries/:id', requireMember(), async (req, res, next) => {
  try {
    const { rowCount } = await withTenant(req.tenant.schema_name, (c) => c.query(
      'DELETE FROM beneficiaries WHERE id = $1 AND member_id = $2', [req.params.id, req.member.id]));
    return rowCount ? res.json({ deleted: true }) : notFound(res, 'beneficiary');
  } catch (e) { next(e); }
});

module.exports = router;
