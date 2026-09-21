'use strict';

// Error envelope. Shape kept from the earlier surface: one array of errors,
// each with a machine code and a reason, so clients parse one thing everywhere.
function apiError(res, status, errorCode, errorReason, errorSource) {
  return res.status(status).json({
    errors: [{ errorCode, errorReason, ...(errorSource ? { errorSource } : {}) }],
  });
}

const notFound = (res, what = 'Resource') =>
  apiError(res, 404, 404, `${what.toUpperCase()}_NOT_FOUND`);

const badRequest = (res, reason, source) =>
  apiError(res, 400, 400, reason, source);

const conflict = (res, reason) => apiError(res, 409, 409, reason);

// offset/limit query params plus items-* count headers.
function paginate(req, rows) {
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const rawLimit = parseInt(req.query.limit, 10);
  const limit = Math.min(1000, rawLimit > 0 ? rawLimit : 50);
  return { page: rows.slice(offset, offset + limit), offset, limit, total: rows.length };
}

function withPaginationHeaders(res, { offset, limit, total }) {
  res.set('items-offset', String(offset));
  res.set('items-limit', String(limit));
  res.set('items-total', String(total));
  return res;
}

// detailsLevel: BASIC strips nested/expanded objects, FULL returns everything.
function applyDetailsLevel(req, row) {
  const level = String(req.query.detailsLevel || 'BASIC').toUpperCase();
  if (level === 'FULL' || !row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) continue;
    out[k] = v;
  }
  return out;
}

const shape = (req, rows) =>
  Array.isArray(rows) ? rows.map((r) => applyDetailsLevel(req, r)) : applyDetailsLevel(req, rows);

// sortBy syntax: "field:ASC" / "field:DESC"
function applySort(rows, sortBy) {
  if (!sortBy) return rows;
  const [field, dir = 'ASC'] = String(sortBy).split(':');
  const sign = dir.toUpperCase() === 'DESC' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a?.[field];
    const bv = b?.[field];
    if (av === bv) return 0;
    return (av > bv ? 1 : -1) * sign;
  });
}

// Filter operators for the POST /<resource>:search endpoints.
const OPERATORS = {
  EQUALS: (v, val) => v === val,
  EQUALS_CASE_SENSITIVE: (v, val) => v === val,
  DIFFERENT_THAN: (v, val) => v !== val,
  MORE_THAN: (v, val) => Number(v) > Number(val),
  LESS_THAN: (v, val) => Number(v) < Number(val),
  BETWEEN: (v, val, val2) => Number(v) >= Number(val) && Number(v) <= Number(val2),
  ON: (v, val) => String(v).slice(0, 10) === String(val).slice(0, 10),
  AFTER: (v, val) => new Date(v) > new Date(val),
  BEFORE: (v, val) => new Date(v) < new Date(val),
  BEFORE_INCLUSIVE: (v, val) => new Date(v) <= new Date(val),
  STARTS_WITH: (v, val) => String(v ?? '').toLowerCase().startsWith(String(val).toLowerCase()),
  IN: (v, _val, _v2, values) => (values || []).includes(v),
  TODAY: (v) => String(v).slice(0, 10) === new Date().toISOString().slice(0, 10),
  EMPTY: (v) => v === null || v === undefined || v === '',
  NOT_EMPTY: (v) => !(v === null || v === undefined || v === ''),
};

function applyFilterCriteria(rows, criteria = []) {
  if (!Array.isArray(criteria) || !criteria.length) return rows;
  return rows.filter((row) =>
    criteria.every((c) => {
      const op = OPERATORS[String(c.operator || 'EQUALS').toUpperCase()];
      if (!op) return true;
      return op(row?.[c.field], c.value, c.secondValue, c.values);
    })
  );
}

module.exports = {
  apiError,
  notFound,
  badRequest,
  conflict,
  paginate,
  withPaginationHeaders,
  applyDetailsLevel,
  shape,
  applySort,
  applyFilterCriteria,
  OPERATORS,
};
