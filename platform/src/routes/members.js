'use strict';

const express = require('express');
const { withTenant, withTenantRead } = require('../db/tenantContext');
const { requireAuth } = require('../tenancy/resolve');
const { apiError, notFound, badRequest, paginate, withPaginationHeaders, applyFilterCriteria } = require('../lib/http');
const { pageQuery, sendPage } = require('../lib/page');
const HIST = require('../domain/loanHistory');

const router = express.Router();

/**
 * Members. Reference implementation of the tenant-scoped resource pattern.
 *
 * Note what is absent: no tenant_id in any WHERE clause. The transaction's
 * search_path already points at exactly one SACCO's schema, so there is no
 * such thing as forgetting the tenant filter here.
 */

const COLUMNS = `id, member_no, first_name, last_name, national_id, kra_pin, phone,
                 email, date_of_birth, gender, branch_id, employer, status,
                 joined_on, exited_on, created_at`;

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const q = req.query.q ? `%${String(req.query.q).toLowerCase()}%` : null;
    const page = await withTenantRead(req.tenant.schema_name, (c) => pageQuery(
      c,
      `SELECT ${COLUMNS} FROM members
       WHERE ($1::text IS NULL OR status = $1::text)
         AND ($2::text IS NULL OR
              lower(first_name) LIKE $2::text OR lower(last_name) LIKE $2::text OR
              lower(member_no) LIKE $2::text OR phone LIKE $2::text)
       ORDER BY last_name, first_name, id`,
      [req.query.status || null, q],
      req.query
    ));
    sendPage(res, page);
  } catch (e) { next(e); }
});

// Exported and mounted by the parent as POST /members:search — Express 5
// cannot match a colon suffix inside a sub-router path.
// The filter operators run in JavaScript, so this one has to materialise
// rows before it can filter them. It is bounded rather than unbounded: a
// scan cap keeps one client from pulling a 40,000-member register into
// memory, and the response says plainly when the scan was cut short instead
// of quietly returning a subset as if it were the whole answer.
const SEARCH_SCAN_CAP = 5000;

const searchMembers = [requireAuth(), async (req, res, next) => {
  try {
    const rows = await withTenantRead(req.tenant.schema_name, async (c) =>
      (await c.query(
        `SELECT ${COLUMNS} FROM members ORDER BY last_name, first_name, id LIMIT $1`,
        [SEARCH_SCAN_CAP + 1]
      )).rows);
    const truncated = rows.length > SEARCH_SCAN_CAP;
    const filtered = applyFilterCriteria(rows.slice(0, SEARCH_SCAN_CAP), req.body?.filterCriteria);
    const p = paginate(req, filtered);
    res.set('items-scan-cap', String(SEARCH_SCAN_CAP));
    res.set('items-truncated', String(truncated));
    withPaginationHeaders(res, p).json(p.page);
  } catch (e) { next(e); }
}];

router.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const row = await withTenantRead(req.tenant.schema_name, async (c) => {
      const byId = /^[0-9a-f-]{36}$/i.test(req.params.id);
      const sql = byId
        ? `SELECT ${COLUMNS} FROM members WHERE id = $1`
        : `SELECT ${COLUMNS} FROM members WHERE member_no = $1`;
      return (await c.query(sql, [req.params.id])).rows[0];
    });
    return row ? res.json(row) : notFound(res, 'member');
  } catch (e) { next(e); }
});

// The member's loan history: closed loans, the largest approved, on-time
// repayment rates and completed loan cycles (./loanHistory).
router.get('/:id/loan-history', requireAuth(), async (req, res, next) => {
  try {
    res.json(await withTenantRead(req.tenant.schema_name, (c) => HIST.forMember(c, req.params.id)));
  } catch (e) { next(e); }
});

router.post('/', requireAuth('TENANT_ADMIN', 'MANAGER', 'TELLER'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.firstName || !b.lastName) return badRequest(res, 'FIRST_AND_LAST_NAME_REQUIRED');

    const row = await withTenant(req.tenant.schema_name, async (c) => {
      // Member numbers are per tenant and generated inside the tenant's own
      // schema, so two SACCOs can both have member 0001.
      const memberNo = b.memberNo || (await c.query(
        `SELECT 'M' || lpad((COALESCE(MAX(NULLIF(regexp_replace(member_no,'\\D','','g'),''))::bigint,0)+1)::text, 6, '0') AS n
         FROM members`
      )).rows[0].n;

      const { rows } = await c.query(
        `INSERT INTO members (member_no, first_name, last_name, national_id, kra_pin,
                              phone, email, date_of_birth, gender, employer, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,'ACTIVE'))
         RETURNING ${COLUMNS}`,
        [memberNo, b.firstName, b.lastName, b.nationalId || null, b.kraPin || null,
         b.phone || null, b.email || null, b.dateOfBirth || null, b.gender || null,
         b.employer || null, b.status || null]
      );

      await c.query(
        `INSERT INTO audit_log (actor, action, entity, entity_id, after)
         VALUES ($1,'MEMBER_CREATED','member',$2,$3)`,
        [req.auth.email, rows[0].id, JSON.stringify(rows[0])]
      );
      return rows[0];
    });
    res.status(201).json(row);
  } catch (e) {
    if (e.code === '23505') return apiError(res, 409, 409, 'DUPLICATE_MEMBER', e.constraint);
    next(e);
  }
});

router.patch('/:id', requireAuth('TENANT_ADMIN', 'MANAGER'), async (req, res, next) => {
  try {
    const allowed = ['first_name', 'last_name', 'phone', 'email', 'employer', 'status', 'kra_pin'];
    const map = { firstName: 'first_name', lastName: 'last_name', kraPin: 'kra_pin' };
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(req.body || {})) {
      const col = map[k] || k;
      if (!allowed.includes(col)) continue;
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) return badRequest(res, 'NO_UPDATABLE_FIELDS');
    params.push(req.params.id);

    const row = await withTenant(req.tenant.schema_name, async (c) => {
      const before = (await c.query('SELECT * FROM members WHERE id = $1', [req.params.id])).rows[0];
      if (!before) return null;
      const { rows } = await c.query(
        `UPDATE members SET ${sets.join(', ')}, updated_at = now()
         WHERE id = $${params.length} RETURNING ${COLUMNS}`, params
      );
      await c.query(
        `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
         VALUES ($1,'MEMBER_UPDATED','member',$2,$3,$4)`,
        [req.auth.email, req.params.id, JSON.stringify(before), JSON.stringify(rows[0])]
      );
      return rows[0];
    });
    return row ? res.json(row) : notFound(res, 'member');
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.searchMembers = searchMembers;
