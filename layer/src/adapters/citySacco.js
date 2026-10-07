'use strict';

/**
 * The City SACCO platform, reached only through its HTTP API with the layer's own
 * API key (an API consumer with a narrow role). Another core banking system gets
 * another adapter with the same methods:
 *
 *   getLoan(id)            -> { id, accountNo, productId, status, purpose, notes, names }
 *   getTag(id)             -> the stored tag, or null
 *   setTag(id, tag)        -> stores the tag on the loan
 *   listLoans({ status })  -> async iterator of loan ids
 *   ensureTagFields(tax)   -> makes the place the tag is stored (idempotent)
 *   ensureWebhook({ url }) -> the event subscription; its signing secret once, when made
 *
 * The tag lives in a loan custom field set, _arcafim, so credit staff see it on the
 * loan page, reports and views can use it, and it is in the platform's audit trail.
 */
const SET = { id: 'arcafim', setId: '_arcafim', name: 'ARCAFIM climate adaptation' };
const REVIEW = [
  { id: 'pending', label: 'Awaiting review' },
  { id: 'confirmed', label: 'Confirmed by credit staff' },
  { id: 'corrected', label: 'Corrected by credit staff' },
];
const ELIGIBILITY = [{ id: 'eligible', label: 'Eligible' }, { id: 'ineligible', label: 'Not eligible' }];
// Field IDs are unique across the whole tenant, so each carries the set's prefix.
const KEYS = ['category', 'eligibility', 'confidence', 'reason', 'taggedBy', 'taxonomyVersion', 'reviewStatus', 'reviewedBy'];
const fieldId = (k) => `arcafim${k[0].toUpperCase()}${k.slice(1)}`;
const toFields = (tag) => Object.fromEntries(Object.entries(tag).filter(([k]) => KEYS.includes(k)).map(([k, v]) => [fieldId(k), v]));
const fromFields = (v) => (v ? Object.fromEntries(KEYS.filter((k) => v[fieldId(k)] !== undefined).map((k) => [k, v[fieldId(k)]])) : null);

const TIMEOUT_MS = () => Number(process.env.PLATFORM_TIMEOUT_MS || 5_000);

function create({ baseUrl = process.env.PLATFORM_URL, tenant = process.env.PLATFORM_TENANT, apiKey = process.env.PLATFORM_API_KEY, fetchImpl = fetch } = {}) {
  if (!baseUrl || !tenant || !apiKey) throw new Error('PLATFORM_URL, PLATFORM_TENANT and PLATFORM_API_KEY must be set');
  const root = baseUrl.replace(/\/+$/, '');

  async function call(method, path, body) {
    const res = await fetchImpl(`${root}/api${path}`, {
      method,
      signal: AbortSignal.timeout(TIMEOUT_MS()),
      headers: { 'x-tenant': tenant, apikey: apiKey, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const reason = json?.errors?.[0]?.errorReason || text.slice(0, 200);
      throw Object.assign(new Error(`PLATFORM_${res.status}: ${method} ${path}: ${reason}`), { status: res.status });
    }
    return json;
  }

  const fields = (taxonomy) => [
    { id: 'category', name: 'Adaptation category', type: 'SELECTION',
      options: [...taxonomy.categories, taxonomy.notAdaptation].map((c) => ({ id: c.id, label: c.label })) },
    { id: 'eligibility', name: 'Eligibility', type: 'SELECTION', options: ELIGIBILITY },
    { id: 'confidence', name: 'Confidence', type: 'NUMBER' },
    { id: 'reason', name: 'Reason', type: 'FREE_TEXT' },
    { id: 'taggedBy', name: 'Tagged by', type: 'FREE_TEXT' },
    { id: 'taxonomyVersion', name: 'Taxonomy version', type: 'FREE_TEXT' },
    { id: 'reviewStatus', name: 'Review', type: 'SELECTION', options: REVIEW },
    { id: 'reviewedBy', name: 'Reviewed by', type: 'FREE_TEXT' },
  ];

  return {
    name: 'city-sacco',
    SET,

    async getLoan(id) {
      const l = await call('GET', `/loans/${encodeURIComponent(id)}`);
      // The member's full name (middle names too), only to remove it from what a model sees.
      const m = l.member_id ? await call('GET', `/members/${encodeURIComponent(l.member_id)}`) : null;
      return {
        id: l.id, accountNo: l.account_no, productId: l.product_id, status: l.status,
        purpose: l.purpose || '', notes: l.notes || '',
        names: [m?.first_name ?? l.first_name, m?.middle_name, m?.last_name ?? l.last_name].filter(Boolean),
      };
    },

    async getTag(id) {
      const r = await call('GET', `/custom-fields/values/LOAN_ACCOUNT/${encodeURIComponent(id)}`);
      const t = fromFields(r?.values?.[SET.setId]);
      return t && Object.keys(t).length ? t : null;
    },

    async setTag(id, tag) {
      return call('PUT', `/custom-fields/values/LOAN_ACCOUNT/${encodeURIComponent(id)}`, { [SET.setId]: toFields(tag) });
    },

    async *listLoans({ status = null, pageSize = 200 } = {}) {
      for (let offset = 0; ; offset += pageSize) {
        const qs = new URLSearchParams({ offset: String(offset), limit: String(pageSize), ...(status ? { status } : {}) });
        const page = await call('GET', `/loans?${qs}`);
        const rows = Array.isArray(page) ? page : page?.items || [];
        for (const l of rows) yield { id: l.id, productId: l.product_id, status: l.status };
        if (rows.length < pageSize) return;
      }
    },

    /** Makes the _arcafim set and its fields, and keeps the category options in step with the taxonomy. */
    async ensureTagFields(taxonomy) {
      const sets = await call('GET', '/custom-fields/sets?entity=LOAN_ACCOUNT');
      if (!(sets || []).some((s) => s.id === SET.setId)) {
        await call('POST', '/custom-fields/sets', { entity: 'LOAN_ACCOUNT', id: SET.id, name: SET.name,
          notes: `Written by the climate-adaptation layer. Taxonomy ${taxonomy.version}.` });
      }
      const have = new Map(((await call('GET', `/custom-fields/definitions?entity=LOAN_ACCOUNT`)) || [])
        .filter((d) => d.set_id === SET.setId).map((d) => [d.id, d]));
      const made = [];
      for (const f of fields(taxonomy).map((x) => ({ ...x, id: fieldId(x.id) }))) {
        const before = have.get(f.id);
        if (!before) {
          await call('POST', '/custom-fields/definitions', { entity: 'LOAN_ACCOUNT', setId: SET.setId, ...f });
          made.push(f.id);
        } else if (f.options) {
          const old = new Set((before.options || []).map((o) => o.id));
          if (f.options.some((o) => !old.has(o.id))) {
            // New categories are added; old ones stay, so loans tagged under an older version keep a valid value.
            const options = [...(before.options || []), ...f.options.filter((o) => !old.has(o.id))];
            await call('PATCH', `/custom-fields/definitions/${f.id}`, { options });
          }
        }
      }
      return { set: SET.setId, made };
    },

    async ensureWebhook({ url, name = 'Climate-adaptation layer: new loans' }) {
      const existing = ((await call('GET', '/templates')) || []).find((t) => t.name === name);
      if (existing) {
        // The layer moved: point the webhook at its new address, keeping its secret.
        if (existing.url && existing.url !== url) await call('PATCH', `/templates/${existing.id}`, [{ op: 'REPLACE', path: '/url', value: url }]);
        return { id: existing.id, created: false, moved: Boolean(existing.url && existing.url !== url) };
      }
      const t = await call('POST', '/templates', {
        name, type: 'WEB_HOOK', target: 'LOANS', event: 'LOAN_CREATED', url, requestType: 'POST', contentType: 'JSON',
        body: '{"event": "{{EVENT}}", "loanKey": "{{ACCOUNT_KEY}}", "loanId": "{{ACCOUNT_ID}}"}',
      });
      return { id: t.id, created: true, signingSecret: t.signingSecret };
    },
  };
}

module.exports = { create, SET, fieldId };
