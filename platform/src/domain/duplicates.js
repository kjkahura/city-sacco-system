'use strict';

const SETUP = require('./clientSetup');

/**
 * The duplicate checks for clients (the reference platform's Internal Controls): a document
 * number (the national ID or any ID document, compared without spaces,
 * hyphens or case), name with birth date, phone (the last nine digits, so
 * 0712... and 254712... match) and email, each at NONE, WARNING or ERROR
 * (client_controls.duplicate_checks). The lookup runs in the database as the
 * table owner (duplicate_members, tenant migration 033), so a
 * branch-limited user does not miss a duplicate in a branch they cannot
 * see. Used by ./clients and ./idTemplates.
 */

const normId = (v) => String(v).replace(/\s/g, '').toUpperCase();
const docKey = (v) => String(v).replace(/[\s-]/g, '').toUpperCase();
const phoneKey = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-9) : null;
};

/**
 * Possible duplicates of a client: [{check, level, memberId, memberNo,
 * state}] for every check not at NONE. `row` holds the columns as they will
 * be; `docs` the ID documents it brings.
 */
async function find(c, row, { docs = [], exclude = null } = {}) {
  if (row.holder_type === 'GROUP') return [];
  const ctl = await SETUP.controlsRow(c);
  const lv = ctl.duplicate_checks || {};
  const on = (k) => lv[k] && lv[k] !== 'NONE';
  const keys = on('DOCUMENT_ID') ? [...new Set([row.national_id, ...docs.map((d) => d.document_id)].filter(Boolean).map(docKey))] : [];
  const phones = on('PHONE') ? [...new Set([row.phone, row.phone2].map(phoneKey).filter(Boolean))] : [];
  const { rows } = await c.query('SELECT * FROM duplicate_members($1,$2,$3,$4,$5,$6,$7)', [
    exclude, keys,
    row.first_name || null, row.last_name || null, on('NAME_AND_BIRTH_DATE') ? row.date_of_birth || null : null,
    phones, on('EMAIL') ? row.email || null : null]);
  const seen = new Set();
  return rows.filter((r) => on(r.check_name)).filter((r) => {
    const k = `${r.check_name}:${r.member_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((r) => ({ check: r.check_name, level: lv[r.check_name], memberId: r.member_id, memberNo: r.member_no, state: r.status }));
}

module.exports = { find, normId, docKey, phoneKey };
