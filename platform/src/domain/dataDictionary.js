'use strict';

const D = require('../db/dictionary');

/**
 * The data dictionary (the reference platform's Data Dictionary page): every table in the
 * tenant's schema, every column with its type, nullability, key and the
 * table it refers to, and what it means. Structure comes from the catalog of
 * the schema the transaction is bound to, so the dictionary is always the
 * schema as it stands; the words come from ../db/dictionary.
 *
 * Dates follow the reference platform's API standard. A DATE column is an organization date:
 * a calendar day in the organization's time zone, read and written as
 * yyyy-MM-dd with no time and no offset. A timestamptz column is a moment,
 * returned in UTC with the offset (yyyy-MM-ddTHH:mm:ss.sssZ).
 */

const DATE_KINDS = {
  date: 'ORGANIZATION_DATE',
  'timestamp with time zone': 'UTC_TIMESTAMP',
  'timestamp without time zone': 'TIMESTAMP',
};

const CONVENTIONS = {
  dates: 'A DATE column is an organization date: a calendar day in the organization\'s time zone, as yyyy-MM-dd. '
    + 'A timestamptz column is a moment, returned in UTC as yyyy-MM-ddTHH:mm:ss.sssZ.',
  amounts: 'Amounts are numeric(18,2) in the column\'s currency (the organization\'s base currency unless the row says otherwise), returned as JSON numbers.',
  identifiers: 'Records are addressed by id (a UUID) or by their own number (member_no, account_no, code) wherever both exist.',
  customFields: 'custom_fields holds values keyed by custom field set id, then field id (see custom_field_definitions).',
};

/** The tables, columns, keys and references of the current schema. */
async function catalog(c) {
  const { rows: tables } = await c.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
     ORDER BY table_name`);
  const { rows: columns } = await c.query(
    `SELECT table_name, column_name, ordinal_position, data_type, udt_name, is_nullable,
            column_default, character_maximum_length, numeric_precision, numeric_scale
     FROM information_schema.columns
     WHERE table_schema = current_schema()
     ORDER BY table_name, ordinal_position`);
  // Keys from pg_constraint rather than information_schema: the latter shows
  // a foreign key only to a user holding a privilege on the referenced table.
  const { rows: keys } = await c.query(
    `SELECT con.contype, rel.relname AS table_name, att.attname AS column_name, k.ord,
            frel.relname AS ref_table, fatt.attname AS ref_column
     FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_namespace ns ON ns.oid = rel.relnamespace AND ns.nspname = current_schema()
     CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
     LEFT JOIN pg_class frel ON frel.oid = con.confrelid
     LEFT JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = con.confkey[k.ord]
     WHERE con.contype IN ('p', 'f')
     ORDER BY rel.relname, con.conname, k.ord`);
  return { tables: tables.map((t) => t.table_name), columns, keys };
}

function typeName(col) {
  if (col.data_type === 'ARRAY') return `${col.udt_name.replace(/^_/, '')}[]`;
  if (col.data_type === 'numeric' && col.numeric_precision) return `numeric(${col.numeric_precision},${col.numeric_scale})`;
  if (col.data_type === 'character' && col.character_maximum_length) return `char(${col.character_maximum_length})`;
  if (col.data_type === 'USER-DEFINED') return col.udt_name;
  return col.data_type;
}

/** The whole dictionary. `missing` lists what has no description. */
async function build(c) {
  const cat = await catalog(c);
  const pk = new Map();
  const fk = new Map();
  for (const k of cat.keys) {
    if (k.contype === 'p') {
      if (!pk.has(k.table_name)) pk.set(k.table_name, []);
      pk.get(k.table_name).push(k.column_name);
    } else {
      fk.set(`${k.table_name}.${k.column_name}`, { table: k.ref_table, column: k.ref_column });
    }
  }
  const byTable = new Map(cat.tables.map((t) => [t, []]));
  for (const col of cat.columns) if (byTable.has(col.table_name)) byTable.get(col.table_name).push(col);

  const missing = [];
  const tables = cat.tables.map((t) => {
    const description = D.TABLES[t] || null;
    if (!description) missing.push(t);
    const keys = pk.get(t) || [];
    return {
      name: t,
      description,
      primaryKey: keys,
      columns: byTable.get(t).map((col) => {
        const d = D.describe(t, col.column_name);
        if (!d) missing.push(`${t}.${col.column_name}`);
        return {
          name: col.column_name,
          type: typeName(col),
          nullable: col.is_nullable === 'YES',
          default: col.column_default,
          primaryKey: keys.includes(col.column_name),
          references: fk.get(`${t}.${col.column_name}`) || null,
          dateKind: DATE_KINDS[col.data_type] || null,
          description: d ? d.text : null,
          descriptionSource: d ? d.source : null,
        };
      }),
    };
  });
  const { rows: [v] } = await c.query(
    'SELECT max(version) AS version FROM platform.schema_migrations WHERE schema_name = current_schema()');
  return { generatedAt: new Date().toISOString(), schema: { version: v?.version || null }, conventions: CONVENTIONS, tables, missing };
}

/** One table's entry, or a 404. */
async function table(c, name) {
  const dict = await build(c);
  const t = dict.tables.find((x) => x.name === name);
  if (!t) throw Object.assign(new Error(`UNKNOWN_TABLE: ${name}`), { status: 404 });
  return t;
}

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The dictionary as one CSV row per column. */
function toCsv(dict) {
  const lines = [['table', 'column', 'type', 'nullable', 'primary_key', 'references', 'date_kind', 'description'].join(',')];
  for (const t of dict.tables) {
    lines.push([t.name, '', '', '', '', '', '', t.description].map(csvCell).join(','));
    for (const col of t.columns) {
      lines.push([t.name, col.name, col.type, col.nullable, col.primaryKey,
        col.references ? `${col.references.table}.${col.references.column}` : '', col.dateKind || '', col.description].map(csvCell).join(','));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * COMMENT ON statements for every described table and column, so the words
 * are in the database too: psql's \d+, a BI tool reading the catalog, or a
 * restored backup all show them.
 */
function commentStatements(dict) {
  const out = [];
  for (const t of dict.tables) {
    if (t.description) out.push(`COMMENT ON TABLE ${ident(t.name)} IS ${lit(t.description)};`);
    for (const col of t.columns) {
      if (col.description) out.push(`COMMENT ON COLUMN ${ident(t.name)}.${ident(col.name)} IS ${lit(col.description)};`);
    }
  }
  return out;
}

/** Write the comments into the schema the transaction is bound to. */
async function applyComments(c) {
  const dict = await build(c);
  const sql = commentStatements(dict);
  // One round trip; the statements are built from the catalog's own names.
  if (sql.length) await c.query(sql.join('\n'));
  return { tables: dict.tables.length, comments: sql.length, missing: dict.missing };
}

/**
 * CREATE TABLE statements for the backup's schema.sql: columns, types,
 * nullability, defaults and primary keys. Enough to load the CSVs into an
 * empty database for analysis; the migrations remain the schema's source.
 */
function schemaSql(dict, only = null) {
  const out = [`-- Schema ${dict.schema.version ? `at migration ${dict.schema.version}` : ''}, generated ${dict.generatedAt}`];
  for (const t of dict.tables) {
    if (only && !only.includes(t.name)) continue;
    const cols = t.columns.map((col) => `  ${ident(col.name)} ${col.type}${col.nullable ? '' : ' NOT NULL'}`);
    if (t.primaryKey.length) cols.push(`  PRIMARY KEY (${t.primaryKey.map(ident).join(', ')})`);
    if (t.description) out.push(`\n-- ${t.description.replace(/\n/g, ' ')}`);
    else out.push('');
    out.push(`CREATE TABLE ${ident(t.name)} (\n${cols.join(',\n')}\n);`);
    for (const col of t.columns) {
      if (col.description) out.push(`COMMENT ON COLUMN ${ident(t.name)}.${ident(col.name)} IS ${lit(col.description)};`);
    }
  }
  return `${out.join('\n')}\n`;
}

/** JSON Schema for a column, as a Singer tap or any other consumer needs it. */
function jsonSchemaFor(col) {
  const nul = col.nullable ? ['null'] : [];
  const base = col.type.replace(/\(.*\)$/, '');
  let s;
  if (col.type.endsWith('[]')) {
    const inner = col.type.slice(0, -2);
    s = { type: [...nul, 'array'], items: { type: /^(int|numeric)/.test(inner) ? 'number' : 'string' } };
  } else if (['integer', 'bigint', 'smallint'].includes(base)) s = { type: [...nul, 'integer'] };
  else if (['numeric', 'double precision', 'real'].includes(base)) s = { type: [...nul, 'number'] };
  else if (base === 'boolean') s = { type: [...nul, 'boolean'] };
  else if (base === 'date') s = { type: [...nul, 'string'], format: 'date' };
  else if (base.startsWith('timestamp')) s = { type: [...nul, 'string'], format: 'date-time' };
  else if (base === 'jsonb' || base === 'json') s = {};
  else s = { type: [...nul, 'string'] };
  if (col.description) s.description = col.description;
  return s;
}

function jsonSchema(t, { omit = [] } = {}) {
  const properties = {};
  for (const col of t.columns) if (!omit.includes(col.name)) properties[col.name] = jsonSchemaFor(col);
  return { type: 'object', properties, ...(t.description ? { description: t.description } : {}) };
}

module.exports = { catalog, build, table, toCsv, commentStatements, applyComments, schemaSql, jsonSchema, jsonSchemaFor, csvCell, CONVENTIONS };
