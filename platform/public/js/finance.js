/**
 * Provisioning, the year-end close and the regulatory returns.
 */

import { $, api, day, el, esc, money, toast, today } from './base.js';
import { ask, card, table, view, wireRows } from './ui.js';

// --------------------------------------------------------------------------
// Provisioning and the year-end close
// --------------------------------------------------------------------------

export async function financeView() {
  const [bands, years, settings] = await Promise.all([
    api('GET', '/api/provisioning/bands'),
    api('GET', '/api/periods'),
    api('GET', '/api/periods/settings'),
  ]);
  if (!bands.ok) throw new Error(bands.error);

  const unset = (bands.body || []).filter((b) => b.rate_percent === null);
  const pct = settings.body?.statutory_reserve_percent;

  view().innerHTML = `
    <h1>Period and provisions</h1>
    ${unset.length ? `<p class="notice">${unset.length} provisioning band(s) have no rate.
      Provisioning will refuse to run until every band has one. The system ships no rates on purpose:
      they are a regulatory figure and must be entered from the rules that apply to this SACCO.</p>` : ''}
    ${pct === null || pct === undefined ? `<p class="notice">No statutory reserve percentage is set.
      A year cannot be closed until it is.</p>` : ''}
    <div class="grid">
      ${card('Provision bands', table([
    { label: 'Band', key: 'label' },
    { label: 'Days', value: (b) => `${b.min_days}–${b.max_days ?? '∞'}` },
    { label: 'Rate %', num: true, value: (b) => (b.rate_percent === null ? 'not set' : b.rate_percent) },
  ], bands.body || [], { onRow: true }) + '<p class="hint">Click a band to set its rate.</p>')}
      ${card('Close settings', `<dl class="kv">
        <dt>Statutory reserve</dt><dd>${pct === null || pct === undefined ? 'not set' : `${pct}%`}</dd>
        <dt>Retained earnings</dt><dd>${esc(settings.body?.gl_retained_earnings || '')}</dd>
        <dt>Statutory reserve account</dt><dd>${esc(settings.body?.gl_statutory_reserve || '')}</dd>
      </dl><button id="f-settings" class="secondary">Set reserve percentage</button>`)}
    </div>
    ${card('Provisioning', `<div class="toolbar">
      <button id="f-preview">Preview</button>
      <button id="f-run" class="secondary">Post the movement</button>
    </div><div id="f-prov"></div>`)}
    ${card('Financial years', table([
    { label: 'Year', key: 'year' },
    { label: 'From', value: (y) => day(y.starts_on) },
    { label: 'To', value: (y) => day(y.ends_on) },
    { label: 'Status', key: 'status' },
    { label: 'Surplus', num: true, value: (y) => money(y.surplus) },
  ], years.body || [], { onRow: true }) + `<div class="toolbar spaced">
      <button id="f-openyear" class="secondary">Open a year</button></div>
    <p class="hint">Click a year to preview or run its close.</p>`)}`;

  wireRows(bands.body || [], async (b) => {
    const d = await ask([{ label: `Rate % for ${b.label} (${b.min_days}–${b.max_days ?? '∞'} days)`,
      name: 'ratePercent', type: 'number', step: '0.001', value: b.rate_percent ?? '' },
    { label: 'Source note', name: 'sourceNote', required: false, value: b.source_note || '' }],
    'Set provisioning rate');
    if (!d) return;
    const r = await api('PATCH', `/api/provisioning/bands/${b.code}`,
      { ratePercent: Number(d.ratePercent), sourceNote: d.sourceNote });
    toast(r.ok ? `${b.code} set to ${d.ratePercent}%` : r.error, !r.ok);
    if (r.ok) financeView();
  });

  $('#f-settings').addEventListener('click', async () => {
    const d = await ask([
      { label: 'Statutory reserve percentage of surplus', name: 'statutoryReservePercent', type: 'number', step: '0.001', value: pct ?? '' },
      { label: 'Source note', name: 'sourceNote', required: false, value: settings.body?.source_note || '' },
    ], 'Close settings');
    if (!d) return;
    const r = await api('PATCH', '/api/periods/settings',
      { statutoryReservePercent: Number(d.statutoryReservePercent), sourceNote: d.sourceNote });
    toast(r.ok ? 'Saved' : r.error, !r.ok);
    if (r.ok) financeView();
  });

  const showProvision = (p) => {
    el('f-prov').innerHTML = table([
      { label: 'Band', key: 'label' }, { label: 'Loans', num: true, key: 'loans' },
      { label: 'Outstanding', num: true, value: (x) => money(x.outstanding) },
      { label: 'Rate %', num: true, key: 'rate' },
      { label: 'Required', num: true, value: (x) => money(x.required) },
    ], p.lines || []) + `<dl class="kv spaced">
      <dt>Required</dt><dd>${money(p.requiredTotal)}</dd>
      <dt>Already held</dt><dd>${money(p.heldTotal)}</dd>
      <dt>Movement to post</dt><dd><strong>${money(p.movement)}</strong></dd></dl>`;
  };

  $('#f-preview').addEventListener('click', async () => {
    const r = await api('GET', '/api/provisioning/preview');
    if (!r.ok) return toast(r.error, true);
    showProvision(r.body);
  });

  $('#f-run').addEventListener('click', async () => {
    const r = await api('POST', '/api/provisioning/run', {});
    if (!r.ok) return toast(r.error, true);
    showProvision(r.body);
    toast(r.body.skipped ? 'Already run for this date' : `Posted ${money(r.body.movement)}`);
  });

  $('#f-openyear').addEventListener('click', async () => {
    const d = await ask([{ label: 'Year', name: 'year', type: 'number', value: new Date().getFullYear() }],
      'Open a financial year');
    if (!d) return;
    const r = await api('POST', '/api/periods', { year: Number(d.year) });
    toast(r.ok ? `Opened ${d.year}` : r.error, !r.ok);
    if (r.ok) financeView();
  });

  wireRows(years.body || [], yearDetail);
}

async function yearDetail(y) {
  const p = await api('GET', `/api/periods/${y.year}/close-preview`);
  if (!p.ok) return toast(p.error, true);
  const v = p.body;

  view().innerHTML = `
    <button class="secondary" id="back">← Period and provisions</button>
    <h1>Financial year ${y.year} <span class="badge">${esc(y.status)}</span></h1>
    <div class="grid">
      ${card('Income', table([{ label: 'Account', key: 'name' },
    { label: 'Amount', num: true, value: (x) => money(x.amount) }], v.income))}
      ${card('Expenses', table([{ label: 'Account', key: 'name' },
    { label: 'Amount', num: true, value: (x) => money(x.amount) }], v.expenses))}
    </div>
    ${card('What the close would post', `<dl class="kv">
      <dt>Total income</dt><dd>${money(v.totalIncome)}</dd>
      <dt>Total expenses</dt><dd>${money(v.totalExpenses)}</dd>
      <dt>Surplus</dt><dd><strong>${money(v.surplus)}</strong></dd>
      <dt>Statutory reserve</dt><dd>${v.reservePercent === null ? 'percentage not set' : `${v.reservePercent}% = ${money(v.reserveAmount)}`}</dd>
      <dt>To retained earnings</dt><dd>${money(v.retainedAmount)}</dd>
    </dl>
    <div class="toolbar spaced">
      ${y.status === 'OPEN' ? '<button id="y-close">Close the year</button>'
    : '<button id="y-reopen" class="secondary">Reopen</button>'}
    </div>
    <p class="hint">Closing sweeps income and expenses to retained earnings, transfers the reserve,
      and locks the year in the database. Reopening reverses the close and unlocks it; both stay on the record.</p>`)}`;

  $('#back').addEventListener('click', financeView);
  const closeBtn = $('#y-close');
  if (closeBtn) closeBtn.addEventListener('click', async () => {
    if (!window.confirm(`Close ${y.year}? Nothing can be posted into it afterwards without reopening.`)) return;
    const r = await api('POST', `/api/periods/${y.year}/close`, {});
    toast(r.ok ? `Closed ${y.year}` : r.error, !r.ok);
    if (r.ok) financeView();
  });
  const reopenBtn = $('#y-reopen');
  if (reopenBtn) reopenBtn.addEventListener('click', async () => {
    const d = await ask([{ label: 'Reason', name: 'reason' }], `Reopen ${y.year}`);
    if (!d) return;
    const r = await api('POST', `/api/periods/${y.year}/reopen`, { reason: d.reason });
    toast(r.ok ? `Reopened ${y.year}` : r.error, !r.ok);
    if (r.ok) financeView();
  });
}

// --------------------------------------------------------------------------
// Returns
// --------------------------------------------------------------------------

export async function returnsView() {
  const r = await api('GET', '/api/returns');
  if (!r.ok) throw new Error(r.error);
  view().innerHTML = `
    <h1>Regulatory returns</h1>
    <p class="notice">Returns are defined as data, and nothing official ships with the system.
      A template marked "not official" has line items that nobody has checked against a published form.</p>
    ${table([
    { label: 'Code', key: 'code' }, { label: 'Name', key: 'name' },
    { label: 'Basis', value: (t) => (t.period_kind === 'PERIOD' ? 'period' : 'as at a date') },
    { label: 'Lines', num: true, key: 'line_count' },
    {
      label: 'Status',
      html: true,
      value: (t) => (t.is_official ? '<span class="badge">confirmed by your team</span>'
        : '<span class="badge warn">not official</span>'),
    },
  ], r.body, { onRow: true, empty: 'No templates loaded' })}`;
  wireRows(r.body, renderReturn);
}

async function renderReturn(t) {
  const qs = new URLSearchParams();
  const from = t.period_kind === 'PERIOD' ? `${new Date().getFullYear()}-01-01` : '';
  if (from) { qs.set('from', from); qs.set('to', today()); } else qs.set('asAt', today());
  const r = await api('GET', `/api/returns/${t.code}?${qs}`);
  if (!r.ok) return toast(r.error, true);
  const v = r.body;

  view().innerHTML = `
    <button class="secondary" id="back">← Returns</button>
    <h1>${esc(v.name)}</h1>
    <p class="notice">${esc(v.disclaimer)}</p>
    <p class="hint">${v.periodKind === 'PERIOD' ? `${esc(from)} to ${today()}` : `As at ${today()}`}</p>
    <table><thead><tr><th>Ref</th><th>Line</th><th class="num">Amount</th></tr></thead><tbody>
      ${v.lines.map((l) => `<tr class="${l.heading ? 'heading' : ''}">
        <td>${esc(l.ref)}</td><td>${esc(l.label)}${l.note ? `<br><span class="hint">${esc(l.note)}</span>` : ''}</td>
        <td class="num">${l.value === null || l.value === undefined ? '' : money(l.value)}</td></tr>`).join('')}
    </tbody></table>`;
  $('#back').addEventListener('click', returnsView);
}
