#!/usr/bin/env node
'use strict';

/**
 * The climate-adaptation layer against a real City SACCO platform, in-process:
 * a tenant, the layer's API keys, its fields and webhook made by `setup`, loans
 * created through the platform's API, the webhook delivered by the platform's own
 * dispatcher, and the tag read back from the loan. The model classifier is checked
 * against a stand-in for the Messages API, so no key is needed.
 *
 * Needs the platform's database settings (platform/.env) and its node_modules.
 */

process.env.NOTIFY_AFTER_REQUEST = 'off';
process.env.SANDBOX_AFTER_REQUEST = 'off';
process.env.CALLBACK_ALLOW_PRIVATE = 'true';

const path = require('path');
const crypto = require('crypto');
const P = (m) => require(path.join(__dirname, '..', '..', 'platform', m));
const app = P('src/server');
const { pool } = P('src/db/pool');
const { withTenant } = P('src/db/tenantContext');
const { migratePlatform, migrateAllTenants } = P('src/db/migrate');
const provision = P('src/tenancy/provision');
const store = P('src/lib/ratestore');
const D = P('src/domain/notifications/dispatch');

const TAX = require('../src/taxonomy');
const CLS = require('../src/classifiers');
const claude = require('../src/classifiers/claude');
const adapters = require('../src/adapters/citySacco');
const { tagLoan, tagBackBook } = require('../src/tagger');
const { createServer } = require('../src/server');
const { verify } = require('../src/webhook');
const { redact } = require('../src/redact');

let pass = 0, fail = 0;
const failures = [];
const section = (s) => console.log(`\n${s}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}

const SLUG = 'climatetest';
const SCHEMA = `tenant_${SLUG}`;
const PORT = 4151;
const LAYER_PORT = 4152;
const PASSWORD = 'a sufficiently long passphrase';
const T = (fn) => withTenant(SCHEMA, fn);
let token = null;

async function call(method, p, body) {
  const headers = { 'x-tenant': SLUG };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`http://localhost:${PORT}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  return { status: r.status, body: d, text: text.slice(0, 400) };
}
async function login(email, password) {
  const b = Math.floor(Date.now() / 900_000);
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) await store.reset(`rl:login:ip:${ip}:${b}`);
  await store.reset(`rl:login:acct:${SLUG}:${email}:${b}`);
  return (await call('POST', '/api/auth/login', { email, password })).body?.accessToken;
}
async function consumerKey(name, permissions) {
  const k = (await call('POST', '/api/consumers', { name, access: { permissions } })).body;
  return (await call('POST', `/api/consumers/${k.id}/keys`, {})).body?.apiKey;
}

(async () => {
  const server = app.listen(PORT);
  let layer = null;
  try {
    section('setup');
    await migratePlatform();
    if ((await pool.query('SELECT 1 FROM platform.tenants WHERE slug=$1', [SLUG])).rowCount) await provision.deprovisionTenant(SLUG, { confirm: SLUG });
    await pool.query('DELETE FROM platform.tenants WHERE slug=$1', [SLUG]);
    await provision.provisionTenant({ slug: SLUG, name: 'Climate SACCO', mfaRequiredRoles: [], adminEmail: 'admin@climate.local', adminPassword: PASSWORD });
    await pool.query('UPDATE platform.tenants SET rate_limit_per_min = 5000 WHERE slug = $1', [SLUG]);
    await migrateAllTenants({});
    token = await login('admin@climate.local', PASSWORD);
    await call('POST', '/api/branches', { code: 'HQ', name: 'Head office' });
    const m1 = (await call('POST', '/api/members', { firstName: 'Wanjiku', lastName: 'Mwangi', branchId: 'HQ', phone: '0712345678' })).body;
    const setupKey = await consumerKey('Climate layer setup', ['VIEW_CUSTOM_FIELD', 'CREATE_CUSTOM_FIELD', 'EDIT_CUSTOM_FIELD', 'CREATE_COMMUNICATION_TEMPLATES']);
    const runKey = await consumerKey('Climate layer', ['VIEW_LOAN_ACCOUNT_DETAILS', 'EDIT_LOAN_ACCOUNT', 'VIEW_CLIENT_DETAILS']);
    check('a SACCO, a member and the layer\'s two API keys (setup, and a narrow one to run)', m1?.id && setupKey && runKey, JSON.stringify(m1).slice(0, 200));

    const taxonomy = TAX.load();
    const base = { baseUrl: `http://localhost:${PORT}`, tenant: SLUG };
    const setupAdapter = adapters.create({ ...base, apiKey: setupKey });
    const adapter = adapters.create({ ...base, apiKey: runKey });
    const classifier = CLS.create(taxonomy, { kind: 'keyword' });
    const deps = { taxonomy, classifier, adapter };

    // ------------------------------------------------------------------------
    section('taxonomy and redaction');
    check('the draft taxonomy loads with its version, categories and the not-adaptation class',
      taxonomy.version && taxonomy.categories.length >= 4 && taxonomy.ids.includes('not_adaptation') && taxonomy.eligible('irrigation') && !taxonomy.eligible('not_adaptation'));
    const red = redact('Wanjiku Mwangi, ID 23456789, tel 0712 345 678 or +254712345678, wanjiku@mail.co.ke, wants KSh 50,000 for a drip kit',
      { names: ['Wanjiku', 'Mwangi'] });
    check('names, ID numbers, phone numbers and e-mail are removed; the amount and purpose stay',
      !/Wanjiku|Mwangi|23456789|0712|254712|@/.test(red) && /50,000/.test(red) && /drip kit/.test(red), red);
    const red2 = redact('Ngũgĩ Mũthoni, ID 23 456 789, passport AK0123456, PIN A123456789Z, 0712.345.678, +254 (0)712 345 678, KSh 1500000', { names: ['Ngũgĩ Mũthoni'] });
    check('Kikuyu names with diacritics, spaced IDs, passports, KRA PINs and dotted or (0) phone forms too; a plain amount stays',
      !/Ngũgĩ|Mũthoni|23 456 789|AK0123456|A123456789Z|0712|\(0\)712/.test(red2) && /1500000/.test(red2), red2);
    const kw = CLS.create(taxonomy, { kind: 'keyword' });
    const plain = await Promise.all(['Loan processing fee and school fees', 'Cooler box for selling sodas', 'Warehouse rent for hardware stock', 'Stock for my shop']
      .map((t) => kw.classify({ text: t })));
    check('ordinary purposes are not mistaken for adaptation (processing fee, cooler box, warehouse rent, shop stock)',
      plain.every((x) => x.category === 'not_adaptation'), JSON.stringify(plain.map((x) => x.category)));
    const agri = await Promise.all(['Drip irrigation kit', 'Hermetic bags for maize', 'Biogas digester', 'Posho mill', 'Fodder and silage for zero grazing']
      .map((t) => kw.classify({ text: t })));
    check('and adaptation purposes are found', JSON.stringify(agri.map((x) => x.category))
      === JSON.stringify(['irrigation', 'storage', 'renewable_energy', 'agro_processing', 'climate_smart_inputs']), JSON.stringify(agri.map((x) => x.category)));

    // ------------------------------------------------------------------------
    section('setup on the platform');
    const f1 = await setupAdapter.ensureTagFields(taxonomy);
    const f2 = await setupAdapter.ensureTagFields(taxonomy);
    check('setup makes the _arcafim loan field set and its eight fields, and a second run makes nothing', f1.set === '_arcafim' && f1.made.length === 8 && f2.made.length === 0,
      JSON.stringify([f1, f2]));
    const w1 = await setupAdapter.ensureWebhook({ url: `http://localhost:${LAYER_PORT}/hooks/loans` });
    const w2 = await setupAdapter.ensureWebhook({ url: `http://localhost:${LAYER_PORT}/hooks/loans` });
    check('and the LOAN_CREATED webhook, with its signing secret once', w1.created && /^[0-9a-f]{64}$/.test(w1.signingSecret || '') && !w2.created && w2.id === w1.id,
      JSON.stringify([w1.created, w2]));
    const bigger = { ...taxonomy, categories: [...taxonomy.categories, { id: 'livestock_resilience', label: 'Livestock resilience', description: 'x', keywords: [] }] };
    bigger.ids = [...taxonomy.ids, 'livestock_resilience'];
    await setupAdapter.ensureTagFields(bigger);
    const cat = (await call('GET', `/api/custom-fields/definitions/${adapters.fieldId('category')}`)).body;
    check('a new taxonomy category is added to the options; none are removed', cat.options.some((o) => o.id === 'livestock_resilience') && cat.options.some((o) => o.id === 'irrigation'),
      JSON.stringify(cat.options));
    const narrow = adapters.create({ ...base, apiKey: runKey });
    let refused = null;
    try { await narrow.ensureTagFields(taxonomy); } catch (e) { refused = e.message; }
    check('the running key cannot change the field set (least privilege)', /PLATFORM_403/.test(refused || ''), refused);

    // ------------------------------------------------------------------------
    section('tagging through the webhook');
    const done = [];
    let waiters = [];
    const onTagged = (e, r) => { done.push({ e, r }); waiters.forEach((w) => w()); waiters = []; };
    const tagged = async (n) => { while (done.length < n) await new Promise((ok) => { waiters.push(ok); setTimeout(ok, 5000); }); };
    layer = createServer(deps, { webhookSecret: w1.signingSecret, onTagged }).listen(LAYER_PORT);
    const mkLoan = async (purpose, notes = null) => (await call('POST', '/api/loans', { memberId: m1.id, productId: 'NL01', principal: 50000, termMonths: 12, purpose, notes })).body;
    const drip = await mkLoan('Drip irrigation kit and water tank for tomatoes', 'Member Wanjiku, phone 0712345678, farms 1 acre in Kirinyaga');
    const fees = await mkLoan('School fees for second term');
    check('two loans are applied for through the API', drip?.id && fees?.id, JSON.stringify([drip, fees]).slice(0, 300));
    await D.runTenant(SCHEMA);
    await tagged(2);
    const t1 = await adapter.getTag(drip.id);
    check('the platform delivers LOAN_CREATED, signed; the layer answers at once and tags the irrigation loan eligible, unreviewed',
      t1?.category === 'irrigation' && t1.eligibility === 'eligible' && t1.reviewStatus === undefined && t1.reviewedBy === undefined && t1.taggedBy === 'keyword'
      && t1.taxonomyVersion === taxonomy.version && t1.confidence > 0 && /Irrigation/.test(t1.reason), JSON.stringify(t1));
    const t2 = await adapter.getTag(fees.id);
    check('the school fees loan is tagged not adaptation, not eligible', t2?.category === 'not_adaptation' && t2.eligibility === 'ineligible', JSON.stringify(t2));
    const msgs = await T(async (c) => (await c.query("SELECT state, response_status FROM notification_messages WHERE event = 'LOAN_CREATED'")).rows);
    check('both messages are logged as delivered (202)', msgs.length === 2 && msgs.every((m) => m.state === 'SENT' && m.response_status === 202), JSON.stringify(msgs));
    const view = (await call('GET', `/api/custom-fields/values/LOAN_ACCOUNT/${drip.id}`)).body;
    check('credit staff see the tag on the loan, as custom fields', view?.values?._arcafim?.[adapters.fieldId('category')] === 'irrigation', JSON.stringify(view).slice(0, 300));

    // ------------------------------------------------------------------------
    section('idempotence and review');
    const again = await tagLoan(deps, drip.id);
    check('a retried or resent event changes nothing', again.skipped === 'ALREADY_TAGGED');
    await adapter.setTag(drip.id, { category: 'storage', eligibility: 'eligible', reviewStatus: 'corrected', reviewedBy: 'officer@climate.local' });
    const forced = await tagLoan(deps, drip.id, { force: true });
    check('a tag a person corrected is never overwritten, even with force', forced.skipped === 'REVIEWED' && forced.tag.category === 'storage', JSON.stringify(forced));
    const newVersion = { ...taxonomy, version: 'draft-2026-11' };
    const retag = await tagLoan({ ...deps, taxonomy: newVersion }, fees.id);
    check('a new taxonomy version tags an unreviewed loan again', !retag.skipped && retag.tag.taxonomyVersion === 'draft-2026-11', JSON.stringify(retag));
    const empty = await mkLoan(null);
    const te = await tagLoan(deps, empty.id);
    check('a loan with no purpose is tagged not eligible by rule, unreviewed', te.tag.category === 'not_adaptation' && te.tag.taggedBy === 'rule' && te.tag.reviewStatus === undefined, JSON.stringify(te));
    let writes = 0;
    let reads = 0;
    const racing = { ...adapter,
      getTag: async () => (++reads === 1 ? null : { category: 'irrigation', reviewStatus: 'confirmed', reviewedBy: 'officer@climate.local' }),
      setTag: async () => { writes += 1; } };
    const race = await tagLoan({ ...deps, adapter: racing }, drip.id);
    check('a review made while the loan was being classified is kept: the layer checks again and does not write',
      race.skipped === 'REVIEWED' && writes === 0, JSON.stringify(race));

    // ------------------------------------------------------------------------
    section('the webhook endpoint');
    const post = (body, sig) => fetch(`http://localhost:${LAYER_PORT}/hooks/loans`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'x-sacco-signature': sig } : {}) }, body });
    const sign = (secret, body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
    const body = JSON.stringify({ event: 'LOAN_CREATED', loanKey: drip.id });
    check('an unsigned request is refused', (await post(body)).status === 401);
    check('a request signed with another secret is refused', (await post(body, sign('f'.repeat(64), body))).status === 401);
    check('an old signature is refused (no replay)', (await post(body, sign(w1.signingSecret, body, Math.floor(Date.now() / 1000) - 3600))).status === 401);
    check('verify() reads the platform\'s header format', verify('s', sign('s', 'x'), 'x').ok && !verify('s', sign('s', 'x'), 'y').ok);
    const other = JSON.stringify({ event: 'LOAN_APPROVAL', loanKey: drip.id });
    check('another event is acknowledged and ignored', (await (await post(other, sign(w1.signingSecret, other))).json()).ignored === 'LOAN_APPROVAL');
    const ghost = JSON.stringify({ event: 'LOAN_CREATED', loanKey: '00000000-0000-0000-0000-000000000000' });
    const before = done.length;
    const gr = await post(ghost, sign(w1.signingSecret, ghost));
    await tagged(before + 1);
    check('a loan the platform cannot find is accepted, then logged as failed for the daily catch-up', gr.status === 202 && done[before]?.e && /PLATFORM_404/.test(done[before].e.message),
      `${gr.status} ${done[before]?.e?.message}`);
    const nul = 'null';
    check('a signed body that is not a JSON object is refused, without hanging', (await post(nul, sign(w1.signingSecret, nul))).status === 400);
    check('health names the classifier and taxonomy', (await (await fetch(`http://localhost:${LAYER_PORT}/health`)).json()).taxonomy === taxonomy.version);

    // ------------------------------------------------------------------------
    section('the back book');
    await T((c) => c.query("UPDATE notification_templates SET activated = false WHERE event = 'LOAN_CREATED'"));
    const solar = await mkLoan('Solar home system and a biogas digester');
    const mill = await mkLoan('Posho mill for maize value addition');
    const bb = await tagBackBook(deps, {});
    check('the back book run tags untagged loans and skips the ones already tagged',
      bb.failed === 0 && bb.tagged >= 2 && bb.skipped >= 2, JSON.stringify(bb));
    check('the solar pump and the posho mill get their categories',
      (await adapter.getTag(solar.id))?.category === 'renewable_energy' && (await adapter.getTag(mill.id))?.category === 'agro_processing');

    // ------------------------------------------------------------------------
    section('the model classifier (a stand-in for the Messages API)');
    let sent = null;
    const fake = (answer, status = 200) => async (url, init) => {
      sent = { url, init, body: JSON.parse(init.body) };
      return { ok: status < 300, status, json: async () => answer };
    };
    let threw = null;
    try { claude.create(taxonomy, { apiKey: 'k', model: '' }); } catch (e) { threw = e.message; }
    check('there is no default model: one must be chosen', /ARCAFIM_MODEL_NOT_SET/.test(threw || ''), threw);
    const good = CLS.create(taxonomy, { kind: 'claude', apiKey: 'test-key', model: 'model-under-test',
      fetchImpl: fake({ content: [{ type: 'tool_use', name: 'tag_loan', input: { category: 'storage', confidence: 0.91, reason: 'Hermetic bags for maize.' } }] }) });
    const gl = await mkLoan('Hermetic storage bags', 'Wanjiku Mwangi 0712345678');
    const gt = await tagLoan({ ...deps, classifier: good }, gl.id);
    check('the model\'s answer is stored with the model\'s name', gt.tag.category === 'storage' && gt.tag.confidence === 0.91 && gt.tag.taggedBy === 'claude:model-under-test'
      && gt.tag.reviewStatus === undefined, JSON.stringify(gt.tag));
    const prompt = JSON.stringify(sent.body);
    check('the request is forced through the tag_loan tool, with the taxonomy\'s categories as the only answers',
      sent.url === 'https://api.anthropic.com/v1/messages' && sent.body.tool_choice?.name === 'tag_loan' && sent.body.model === 'model-under-test'
      && JSON.stringify(sent.body.tools[0].input_schema.properties.category.enum) === JSON.stringify(taxonomy.ids)
      && sent.init.headers['x-api-key'] === 'test-key' && sent.init.headers['anthropic-version'], JSON.stringify(sent.body).slice(0, 300));
    check('and carries the purpose only: no notes, no member name or phone number', !/Wanjiku|Mwangi|0712345678/.test(prompt) && /Hermetic storage bags/.test(prompt), prompt.slice(0, 400));
    process.env.ARCAFIM_INCLUDE_NOTES = 'on';
    const nl = await mkLoan('Hermetic storage bags', 'Wanjiku Mwangi 0712345678 stores maize from 2 acres');
    await tagLoan({ ...deps, classifier: good }, nl.id);
    delete process.env.ARCAFIM_INCLUDE_NOTES;
    const p2 = JSON.stringify(sent.body);
    check('with ARCAFIM_INCLUDE_NOTES=on the notes go too, redacted', /stores maize from 2 acres/.test(p2) && !/Wanjiku|Mwangi|0712345678/.test(p2), p2.slice(0, 400));
    const bad = CLS.create(taxonomy, { kind: 'claude', apiKey: 'k', model: 'm', fetchImpl: fake({ content: [{ type: 'tool_use', name: 'tag_loan', input: { category: 'casino', confidence: 1, reason: 'x' } }] }) });
    const down = CLS.create(taxonomy, { kind: 'claude', apiKey: 'k', model: 'm', fetchImpl: fake({}, 529) });
    const rb = await bad.classify({ text: 'Biogas digester for the farm' });
    const rd = await down.classify({ text: 'Biogas digester for the farm' });
    check('an answer outside the taxonomy, or the model unavailable, falls back to the keyword classifier and says so',
      rb.by === 'keyword' && rb.category === 'renewable_energy' && /Model unavailable: MODEL_ANSWER_INVALID/.test(rb.reason)
      && rd.by === 'keyword' && /MODEL_REQUEST_FAILED/.test(rd.reason), JSON.stringify([rb, rd]));
  } catch (e) {
    fail++; failures.push(`threw: ${e.stack}`);
    console.error(`\nFAILED: ${e.stack}`);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    if (layer) layer.close();
    server.close();
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
