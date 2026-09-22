'use strict';

const acct = require('./accounting');
const { err, round2 } = acct;

/**
 * Regulatory return engine.
 *
 * A return is rows in return_templates and return_lines, not code. Each line
 * either sums a slice of the chart of accounts or computes from other lines,
 * so adding a form, or changing one when the regulator reissues it, is an
 * INSERT.
 *
 * No official form is shipped with this. The line items of a real return are
 * a legal document and this system has not read one; the only template in
 * the migration is a sample, flagged is_official = false, and every rendered
 * return says which it is. Load your own with `cli returns:load`.
 */

// --------------------------------------------------------------------------
// Expression evaluation
// --------------------------------------------------------------------------

/**
 * Arithmetic over other lines: "A1 + A2 - A3", "L9 / A9 * 100".
 *
 * Parsed and walked rather than handed to eval or new Function. A template
 * is data, data gets edited by whoever administers the tenant, and giving an
 * editable string to the JavaScript engine is how a reporting form turns
 * into remote code execution.
 */
function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z][A-Za-z0-9_]*)|([+\-*/()]))/y;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) {
      if (/^\s+$/.test(src.slice(i))) break;
      throw err(`RETURN_EXPRESSION_INVALID_TOKEN: ${src.slice(i, i + 12)}`);
    }
    i = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'ref', v: m[2] });
    else tokens.push({ t: 'op', v: m[3] });
  }
  return tokens;
}

function evaluate(src, values) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (v) => {
    const t = tokens[pos];
    if (!t || t.t !== 'op' || t.v !== v) return false;
    pos += 1;
    return true;
  };

  function primary() {
    const t = tokens[pos];
    if (!t) throw err('RETURN_EXPRESSION_UNEXPECTED_END');
    if (eat('(')) {
      const v = expr();
      if (!eat(')')) throw err('RETURN_EXPRESSION_UNBALANCED_PARENS');
      return v;
    }
    if (eat('-')) return -primary();
    if (eat('+')) return primary();
    pos += 1;
    if (t.t === 'num') return t.v;
    if (t.t === 'ref') {
      if (!(t.v in values)) throw err(`RETURN_EXPRESSION_UNKNOWN_LINE: ${t.v}`);
      return Number(values[t.v]);
    }
    throw err(`RETURN_EXPRESSION_UNEXPECTED: ${t.v}`);
  }

  function term() {
    let left = primary();
    for (;;) {
      if (eat('*')) left *= primary();
      else if (eat('/')) {
        const d = primary();
        // A ratio line on an empty book divides by zero. Null is the honest
        // answer; Infinity would print as a number.
        left = d === 0 ? null : left / d;
      } else return left;
      if (left === null) return null;
    }
  }

  function expr() {
    let left = term();
    for (;;) {
      if (eat('+')) left += term();
      else if (eat('-')) left -= term();
      else return left;
    }
  }

  const out = expr();
  if (pos !== tokens.length) throw err(`RETURN_EXPRESSION_TRAILING_INPUT: ${peek()?.v}`);
  return out === null ? null : round2(out);
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

async function listTemplates(c) {
  const { rows } = await c.query(
    `SELECT t.*, count(l.id)::int AS line_count
     FROM return_templates t
     LEFT JOIN return_lines l ON l.template_code = t.code
     GROUP BY t.code ORDER BY t.code`);
  return rows;
}

async function template(c, code) {
  const { rows: [t] } = await c.query('SELECT * FROM return_templates WHERE code = $1', [code]);
  if (!t) throw err(`RETURN_TEMPLATE_NOT_FOUND: ${code}`, 404);
  const { rows: lines } = await c.query(
    'SELECT * FROM return_lines WHERE template_code = $1 ORDER BY line_no, id', [code]);
  return { ...t, lines };
}

/**
 * Render a return for a period.
 *
 * POINT_IN_TIME templates read cumulative balances up to `asAt`, which is
 * what a statement of financial position means. PERIOD templates read
 * movement between `from` and `to`, excluding the year-end sweep, the same
 * basis as the income statement.
 */
async function render(c, code, { from = null, to = null, asAt = null } = {}) {
  const t = await template(c, code);

  const pointInTime = t.period_kind === 'POINT_IN_TIME';
  const windowFrom = pointInTime ? null : from;
  const windowTo = pointInTime ? (asAt || to) : to;

  const movement = pointInTime ? acct.MOVEMENT_SQL : acct.MOVEMENT_SQL_TRADING;
  const { rows: accounts } = await c.query(
    `SELECT g.code, g.type, g.regulatory_class,
            COALESCE(m.debit,0) - COALESCE(m.credit,0) AS net
     FROM gl_accounts g
     LEFT JOIN (${movement}) m ON m.gl_code = g.code`,
    [windowFrom, windowTo]
  );

  const sumWhere = (pred) => round2(accounts.filter(pred).reduce((s, a) => s + Number(a.net), 0));

  const values = {};
  const out = [];
  for (const l of t.lines) {
    let value = null;
    if (l.measure === 'HEADING') {
      out.push({ ref: l.ref, label: l.label, heading: true, value: null, note: l.note });
      continue;
    }
    if (l.measure === 'GL_CODES') value = sumWhere((a) => l.selector.includes(a.code));
    else if (l.measure === 'REGULATORY_CLASSES') value = sumWhere((a) => l.selector.includes(a.regulatory_class));
    else if (l.measure === 'ACCOUNT_TYPES') value = sumWhere((a) => l.selector.includes(a.type));
    else if (l.measure === 'EXPRESSION') value = evaluate(l.expression, values);

    // Expressions are computed from already-signed lines, so the sign flip
    // applies only to the raw sums; applying it twice would negate totals.
    if (l.measure !== 'EXPRESSION' && value !== null) value = round2(value * l.sign);

    values[l.ref] = value === null ? 0 : value;
    out.push({
      ref: l.ref, label: l.label, measure: l.measure, value,
      selector: l.selector || null, expression: l.expression || null, note: l.note,
    });
  }

  return {
    code: t.code,
    name: t.name,
    periodKind: t.period_kind,
    period: pointInTime
      ? { asAt: windowTo || new Date().toISOString().slice(0, 10) }
      : { from, to },
    official: t.is_official,
    sourceNote: t.source_note,
    lines: out,
    // Said on every render, because a rendered form looks authoritative
    // whatever the flag says.
    disclaimer: t.is_official
      ? 'Line items were marked as confirmed against the published form by whoever loaded this template. The arithmetic is this system\'s; the mapping is theirs. Check both before filing.'
      : 'This template is NOT an official return. Its line items are a sample or a draft and must not be filed.',
  };
}

// --------------------------------------------------------------------------
// Loading templates
// --------------------------------------------------------------------------

const MEASURES = ['GL_CODES', 'REGULATORY_CLASSES', 'ACCOUNT_TYPES', 'EXPRESSION', 'HEADING'];

/**
 * Load or replace a template from a plain object, which is what the CLI
 * reads out of a JSON file. Replacing is a delete and reinsert of the lines,
 * inside the caller's transaction, so a half-loaded form cannot survive.
 */
async function loadTemplate(c, def, { createdBy = 'SYSTEM' } = {}) {
  if (!def?.code || !def?.name) throw err('RETURN_TEMPLATE_CODE_AND_NAME_REQUIRED');
  if (!Array.isArray(def.lines) || !def.lines.length) throw err('RETURN_TEMPLATE_HAS_NO_LINES');

  const kind = def.periodKind || 'POINT_IN_TIME';
  if (!['POINT_IN_TIME', 'PERIOD'].includes(kind)) throw err('RETURN_TEMPLATE_INVALID_PERIOD_KIND');

  await c.query(
    `INSERT INTO return_templates (code, name, description, period_kind, is_official, source_note)
     VALUES ($1,$2,$3,$4,COALESCE($5,false),$6)
     ON CONFLICT (code) DO UPDATE SET
       name = EXCLUDED.name, description = EXCLUDED.description,
       period_kind = EXCLUDED.period_kind, is_official = EXCLUDED.is_official,
       source_note = EXCLUDED.source_note, updated_at = now()`,
    [def.code, def.name, def.description || null, kind, def.official === true, def.sourceNote || null]
  );

  await c.query('DELETE FROM return_lines WHERE template_code = $1', [def.code]);

  let n = 0;
  const seen = new Set();
  for (const l of def.lines) {
    n += 10;
    if (!l.ref || !l.label) throw err('RETURN_LINE_REF_AND_LABEL_REQUIRED');
    if (seen.has(l.ref)) throw err(`RETURN_LINE_DUPLICATE_REF: ${l.ref}`);
    seen.add(l.ref);
    const measure = l.measure || (l.expression ? 'EXPRESSION' : 'GL_CODES');
    if (!MEASURES.includes(measure)) throw err(`RETURN_LINE_INVALID_MEASURE: ${measure}`);
    // Fail on a bad expression here rather than at render time, and refuse
    // one that points at a line the form does not define.
    if (measure === 'EXPRESSION') {
      const stub = Object.fromEntries([...seen].map((r) => [r, 0]));
      evaluate(l.expression, stub);
    }
    await c.query(
      `INSERT INTO return_lines (template_code, ref, line_no, label, measure, selector, sign, expression, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [def.code, l.ref, l.lineNo || n, l.label, measure,
       l.selector || null, l.sign === -1 ? -1 : 1, l.expression || null, l.note || null]
    );
  }

  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, after)
     VALUES ($1,'RETURN_TEMPLATE_LOADED','return_template',$2,$3)`,
    [createdBy, def.code, JSON.stringify({ lines: def.lines.length, official: def.official === true })]
  );

  return template(c, def.code);
}

module.exports = { listTemplates, template, render, loadTemplate, evaluate };
