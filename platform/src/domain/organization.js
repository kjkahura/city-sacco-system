'use strict';

const acct = require('./accounting');
const { err } = acct;

/**
 * The organization, after the reference platform's "Organization Contact Details and Time
 * Zone" and "Branding": the institution name, contact details, base
 * currency, time zone, date formats and decimal mark, and the logo and icon.
 *
 * The name, time zone and base currency live on platform.tenants, where the
 * request path reads them; everything else in organization_settings. The
 * base currency can change only while nothing has been posted, as the reference platform
 * sets it once at onboarding.
 */

const CONTACT = {
  streetAddress: 'street_address', city: 'city', region: 'region', postcode: 'postcode',
  country: 'country', phone: 'phone', email: 'email',
};
const DATE_SYMBOLS = /^[yMdhHmsSaEzZ\s\-/.:,']+$/;

function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

async function tenantRow(c) {
  const { rows: [t] } = await c.query(
    'SELECT id, slug, name, country_code, currency_code, timezone FROM platform.tenants WHERE schema_name = current_schema()');
  if (!t) throw err('TENANT_NOT_FOUND', 404);
  return t;
}

async function settings(c) {
  const { rows: [s] } = await c.query('SELECT * FROM organization_settings WHERE id = 1');
  return s;
}

function view(t, s) {
  return {
    institutionName: t.name, slug: t.slug, countryCode: t.country_code, currency: t.currency_code, timeZone: t.timezone,
    contact: Object.fromEntries(Object.entries(CONTACT).map(([k, col]) => [k, s[col]])),
    localDateFormat: s.date_format, localDateTimeFormat: s.datetime_format, decimalMark: s.decimal_mark,
    branding: { logo: Boolean(s.logo), icon: Boolean(s.icon) },
    nonWorkingDays: s.non_working_days.map(Number),
    allowOtherIdTemplates: s.allow_other_id_templates,
    eod: { mode: s.eod_mode, accountingCutoff: s.accounting_cutoff ? String(s.accounting_cutoff).slice(0, 5) : null, retryExcluded: s.eod_retry_excluded },
    updatedAt: s.updated_at, updatedBy: s.updated_by,
  };
}

async function get(c) {
  return view(await tenantRow(c), await settings(c));
}

async function audit(c, actor, action, before, after) {
  await c.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,$2,'organization',NULL,$3,$4)`,
    [actor || 'SYSTEM', action, JSON.stringify(before), JSON.stringify(after)]);
}

/**
 * Change the organization's details. Takes any of: institutionName,
 * timeZone, currency, contact {..}, localDateFormat, localDateTimeFormat,
 * decimalMark. Returns the details and whether the tenant record changed
 * (the caller refreshes its tenant cache).
 */
async function update(c, patch = {}, { createdBy } = {}) {
  const t = await tenantRow(c);
  const s = await settings(c);
  const before = view(t, s);
  const tenantSets = {};
  if (patch.institutionName !== undefined) {
    const name = String(patch.institutionName || '').trim();
    if (!name) throw err('INSTITUTION_NAME_REQUIRED', 400);
    tenantSets.name = name.slice(0, 200);
  }
  if (patch.timeZone !== undefined) {
    if (!validTimeZone(patch.timeZone)) throw err(`UNKNOWN_TIME_ZONE: ${patch.timeZone}`, 400);
    tenantSets.timezone = patch.timeZone;
  }
  if (patch.currency !== undefined && patch.currency !== t.currency_code) {
    const code = String(patch.currency).toUpperCase();
    const { rows: [cur] } = await c.query('SELECT * FROM currencies WHERE code = $1', [code]);
    if (!cur) throw err(`CURRENCY_NOT_SET_UP: ${code}; add it under currencies first`, 409);
    const { rows: [posted] } = await c.query('SELECT 1 FROM journal_entries LIMIT 1');
    if (posted) throw err('BASE_CURRENCY_CANNOT_CHANGE_ONCE_ANYTHING_IS_POSTED', 409);
    await c.query('UPDATE currencies SET is_base = false WHERE is_base');
    await c.query('UPDATE currencies SET is_base = true WHERE code = $1', [code]);
    await c.query('UPDATE accounting_settings SET currency_decimals = $1', [cur.decimals]);
    tenantSets.currency_code = code;
  }
  const sets = {};
  for (const [k, col] of Object.entries(CONTACT)) {
    if (patch.contact && patch.contact[k] !== undefined) sets[col] = patch.contact[k] === '' ? null : String(patch.contact[k]).slice(0, 255);
  }
  if (patch.contact?.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(patch.contact.email)) throw err('INVALID_EMAIL', 400);
  for (const [k, col] of [['localDateFormat', 'date_format'], ['localDateTimeFormat', 'datetime_format']]) {
    if (patch[k] === undefined) continue;
    const f = String(patch[k] || '').trim();
    if (!f || !DATE_SYMBOLS.test(f) || !/y/.test(f) || !/d/.test(f)) throw err(`INVALID_DATE_FORMAT: ${k}`, 400);
    sets[col] = f;
  }
  if (patch.decimalMark !== undefined) {
    if (!['.', ','].includes(patch.decimalMark)) throw err('DECIMAL_MARK_IS_PERIOD_OR_COMMA', 400);
    sets.decimal_mark = patch.decimalMark;
  }
  const tk = Object.keys(tenantSets);
  if (tk.length) {
    await c.query(`UPDATE platform.tenants SET ${tk.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
      [t.id, ...tk.map((k) => tenantSets[k])]);
  }
  const sk = Object.keys(sets);
  await c.query(`UPDATE organization_settings SET ${[...sk.map((k, i) => `${k} = $${i + 1}`), `updated_at = now()`, `updated_by = $${sk.length + 1}`].join(', ')} WHERE id = 1`,
    [...sk.map((k) => sets[k]), createdBy || 'SYSTEM']);
  const after = await get(c);
  await audit(c, createdBy, 'ORGANIZATION_CHANGED', before, after);
  return { organization: after, tenantChanged: tk.length > 0, slug: t.slug };
}

// --------------------------------------------------------------------------
// Branding
// --------------------------------------------------------------------------

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE = 512 * 1024;

/**
 * Set the logo (login and unlock screens; best 300 x 50, transparent PNG)
 * or the icon (top left of the app; best 16 x 16 or a larger square). An
 * SVG is refused: it can carry script.
 */
async function setImage(c, kind, { data, type }, { createdBy } = {}) {
  if (!['logo', 'icon'].includes(kind)) throw err('IMAGE_IS_LOGO_OR_ICON', 400);
  if (!IMAGE_TYPES.includes(type)) throw err(`IMAGE_TYPE_NOT_ALLOWED: ${type}; use ${IMAGE_TYPES.join(', ')}`, 415);
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ''), 'base64');
  if (!bytes.length) throw err('IMAGE_IS_EMPTY', 400);
  if (bytes.length > MAX_IMAGE) throw err(`IMAGE_TOO_LARGE: at most ${MAX_IMAGE} bytes`, 413);
  await c.query(`UPDATE organization_settings SET ${kind} = $1, ${kind}_type = $2, updated_at = now(), updated_by = $3 WHERE id = 1`,
    [bytes, type, createdBy || 'SYSTEM']);
  await audit(c, createdBy, `ORGANIZATION_${kind.toUpperCase()}_SET`, null, { type, bytes: bytes.length });
  return { kind, type, bytes: bytes.length };
}

async function clearImage(c, kind, { createdBy } = {}) {
  if (!['logo', 'icon'].includes(kind)) throw err('IMAGE_IS_LOGO_OR_ICON', 400);
  await c.query(`UPDATE organization_settings SET ${kind} = NULL, ${kind}_type = NULL, updated_at = now(), updated_by = $1 WHERE id = 1`, [createdBy || 'SYSTEM']);
  await audit(c, createdBy, `ORGANIZATION_${kind.toUpperCase()}_CLEARED`, null, null);
  return { kind, cleared: true };
}

async function image(c, kind) {
  if (!['logo', 'icon'].includes(kind)) throw err('IMAGE_IS_LOGO_OR_ICON', 400);
  const { rows: [r] } = await c.query(`SELECT ${kind} AS data, ${kind}_type AS type FROM organization_settings WHERE id = 1`);
  if (!r || !r.data) throw err(`NO_${kind.toUpperCase()}_SET`, 404);
  return r;
}

// --------------------------------------------------------------------------
// End-of-day settings
// --------------------------------------------------------------------------

/**
 * The reference platform's Administration > Financial Setup > EOD Processing: AUTOMATIC or
 * MANUAL, the accounting cutoff time (HH:MM, or null for none), and whether
 * loans the end of day left out are tried again every hour.
 */
async function setEod(c, { mode, accountingCutoff, retryExcluded } = {}, { createdBy } = {}) {
  const before = (await get(c)).eod;
  const sets = {};
  if (mode !== undefined) {
    if (!['AUTOMATIC', 'MANUAL'].includes(mode)) throw err('EOD_MODE_IS_AUTOMATIC_OR_MANUAL', 400);
    sets.eod_mode = mode;
  }
  if (accountingCutoff !== undefined) {
    if (accountingCutoff !== null && accountingCutoff !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(accountingCutoff)) {
      throw err('ACCOUNTING_CUTOFF_IS_HH_MM', 400);
    }
    sets.accounting_cutoff = accountingCutoff || null;
  }
  if (retryExcluded !== undefined) sets.eod_retry_excluded = retryExcluded === true || retryExcluded === 'true';
  const k = Object.keys(sets);
  if (!k.length) throw err('NO_UPDATABLE_FIELDS', 400);
  await c.query(`UPDATE organization_settings SET ${k.map((x, i) => `${x} = $${i + 1}`).join(', ')}, updated_at = now(), updated_by = $${k.length + 1} WHERE id = 1`,
    [...k.map((x) => sets[x]), createdBy || 'SYSTEM']);
  const after = (await get(c)).eod;
  await audit(c, createdBy, 'EOD_SETTINGS_CHANGED', before, after);
  return after;
}

/** The local date and hour in a time zone. */
function localClock(tz, at = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

module.exports = { get, update, setImage, clearImage, image, setEod, localClock, validTimeZone, tenantRow, settings };
