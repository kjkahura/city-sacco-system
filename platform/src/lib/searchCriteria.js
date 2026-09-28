'use strict';

/**
 * The reference platform's search body ({ filterCriteria, sortingCriteria }) as SQL, for a
 * fixed map of the reference platform field names to SQL expressions. Custom fields are
 * named `_setId.fieldId` and read from the custom_fields column. Values are
 * always parameters; field names come only from the map.
 *
 *   filterCriteria: [{ field, operator, value, secondValue, values }]
 *   sortingCriteria: { field, order: ASC | DESC }
 *
 * Operators: EQUALS, EQUALS_CASE_SENSITIVE, DIFFERENT_THAN, MORE_THAN,
 * LESS_THAN, BETWEEN, ON, AFTER, AFTER_INCLUSIVE, BEFORE, BEFORE_INCLUSIVE,
 * STARTS_WITH, STARTS_WITH_CASE_SENSITIVE, IN, TODAY, THIS_WEEK, THIS_MONTH,
 * THIS_YEAR, LAST_DAYS, EMPTY, NOT_EMPTY.
 */

const err = (m, status = 400) => Object.assign(new Error(m), { status });

function build(body = {}, fields, { params = [], customColumn = 'm.custom_fields', today = null } = {}) {
  const where = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const expr = (field) => {
    if (fields[field]) return fields[field];
    const m = String(field || '').match(/^(_[A-Za-z0-9_]{1,64})\.([A-Za-z0-9_]{1,64})$/);
    if (m) return { sql: `(${customColumn} -> ${p(m[1])} ->> ${p(m[2])})`, type: 'text' };
    throw err(`UNKNOWN_SEARCH_FIELD: ${field}; one of ${Object.keys(fields).join(', ')}, or _set.field`);
  };
  const criteria = body.filterCriteria === undefined ? [] : body.filterCriteria;
  if (!Array.isArray(criteria)) throw err('FILTER_CRITERIA_IS_A_LIST');
  let dayRef = null;
  const day = () => { if (!today) return 'current_date'; if (!dayRef) dayRef = `${p(today)}::date`; return dayRef; };
  for (const cr of criteria) {
    const f = expr(cr.field);
    const col = f.sql;
    const cast = f.type === 'number' ? '::numeric' : f.type === 'date' ? '::date' : f.type === 'timestamp' ? '::timestamptz' : '';
    const asDate = f.type === 'timestamp' ? `(${col})::date` : col;
    const op = String(cr.operator || 'EQUALS').toUpperCase();
    const v = cr.value;
    switch (op) {
      case 'EQUALS': where.push(f.type === 'text' ? `lower(${col}) = lower(${p(String(v))})` : `${col} = ${p(v)}${cast}`); break;
      case 'EQUALS_CASE_SENSITIVE': where.push(`${col} = ${p(String(v))}${cast}`); break;
      case 'DIFFERENT_THAN': where.push(`${col} IS DISTINCT FROM ${p(v)}${cast}`); break;
      case 'MORE_THAN': where.push(`${col} > ${p(v)}${cast}`); break;
      case 'LESS_THAN': where.push(`${col} < ${p(v)}${cast}`); break;
      case 'BETWEEN': where.push(`${col} BETWEEN ${p(v)}${cast} AND ${p(cr.secondValue)}${cast}`); break;
      case 'ON': where.push(`${asDate} = ${p(v)}::date`); break;
      case 'AFTER': where.push(`${asDate} > ${p(v)}::date`); break;
      case 'AFTER_INCLUSIVE': where.push(`${asDate} >= ${p(v)}::date`); break;
      case 'BEFORE': where.push(`${asDate} < ${p(v)}::date`); break;
      case 'BEFORE_INCLUSIVE': where.push(`${asDate} <= ${p(v)}::date`); break;
      case 'STARTS_WITH': where.push(`lower(${col}) LIKE ${p(`${String(v).toLowerCase().replace(/[\\%_]/g, '\\$&')}%`)}`); break;
      case 'STARTS_WITH_CASE_SENSITIVE': where.push(`${col} LIKE ${p(`${String(v).replace(/[\\%_]/g, '\\$&')}%`)}`); break;
      case 'IN': {
        const list = Array.isArray(cr.values) ? cr.values : Array.isArray(v) ? v : [v];
        where.push(f.type === 'text' ? `lower(${col}) = ANY(${p(list.map((x) => String(x).toLowerCase()))}::text[])`
          : `${col} = ANY(${p(list)}${f.type === 'number' ? '::numeric[]' : f.type === 'date' ? '::date[]' : '::text[]'})`);
        break;
      }
      case 'TODAY': where.push(`${asDate} = ${day()}`); break;
      case 'THIS_WEEK': where.push(`date_trunc('week', ${asDate}) = date_trunc('week', ${day()})`); break;
      case 'THIS_MONTH': where.push(`date_trunc('month', ${asDate}) = date_trunc('month', ${day()})`); break;
      case 'THIS_YEAR': where.push(`date_trunc('year', ${asDate}) = date_trunc('year', ${day()})`); break;
      case 'LAST_DAYS': where.push(`${asDate} > ${day()} - ${p(Number(v) || 0)}::int`); break;
      case 'EMPTY': where.push(`(${col} IS NULL${f.type === 'text' ? ` OR ${col} = ''` : ''})`); break;
      case 'NOT_EMPTY': where.push(`(${col} IS NOT NULL${f.type === 'text' ? ` AND ${col} <> ''` : ''})`); break;
      default: throw err(`UNKNOWN_SEARCH_OPERATOR: ${cr.operator}`);
    }
  }
  let order = null;
  if (body.sortingCriteria && body.sortingCriteria.field) {
    const f = expr(body.sortingCriteria.field);
    order = `${f.sql} ${String(body.sortingCriteria.order || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC'} NULLS LAST`;
  }
  return { where: where.length ? where.join(' AND ') : 'true', order, params };
}

module.exports = { build };
