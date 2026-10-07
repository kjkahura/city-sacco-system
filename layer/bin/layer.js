#!/usr/bin/env node
'use strict';

/**
 * The layer's command line. Settings come from the environment (README).
 *
 *   node bin/layer.js setup --url https://<layer address>/hooks/loans
 *       makes the _arcafim loan fields and the LOAN_CREATED webhook on the platform;
 *       prints the webhook's signing secret once, to store as WEBHOOK_SECRET
 *   node bin/layer.js tag <loan id> [--force]
 *   node bin/layer.js backbook [--status ACTIVE,APPROVED] [--products NL01,AG01] [--force]
 */
const { depsFromEnv } = require('../src/server');
const { tagLoan, tagBackBook } = require('../src/tagger');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const flag = (name) => process.argv.includes(`--${name}`);

(async () => {
  const deps = depsFromEnv();
  const cmd = process.argv[2];
  if (cmd === 'setup') {
    const f = await deps.adapter.ensureTagFields(deps.taxonomy);
    console.log(`fields: ${f.set} (${f.made.length ? `made ${f.made.join(', ')}` : 'already there'})`);
    if (arg('url')) {
      const w = await deps.adapter.ensureWebhook({ url: arg('url') });
      console.log(w.created ? `webhook ${w.id} made. Store this signing secret as WEBHOOK_SECRET now; it is not shown again:\n${w.signingSecret}`
        : `webhook ${w.id} already there`);
    }
  } else if (cmd === 'tag' && process.argv[3]) {
    console.log(JSON.stringify(await tagLoan(deps, process.argv[3], { force: flag('force') }), null, 2));
  } else if (cmd === 'backbook') {
    const out = await tagBackBook(deps, {
      status: arg('status'), productIds: arg('products') ? arg('products').split(',') : null, force: flag('force'),
      log: (r) => console.log(JSON.stringify(r.error ? r : { loan: r.loanId, skipped: r.skipped || null, category: r.tag?.category })),
    });
    console.log(JSON.stringify(out));
  } else {
    console.error('usage: layer.js setup --url <webhook url> | tag <loan id> [--force] | backbook [--status S] [--products P] [--force]');
    process.exitCode = 2;
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
