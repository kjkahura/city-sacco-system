'use strict';

const http = require('http');
const { verify } = require('./webhook');
const { tagLoan } = require('./tagger');

/**
 * The layer's HTTP service. Two routes:
 *   POST /hooks/loans  the platform's LOAN_CREATED webhook. The signature is checked
 *                      and the request answered 202 at once; the loan is tagged after
 *                      the answer, so a slow model never runs into the platform's
 *                      10-second webhook timeout. A loan whose tagging fails is picked
 *                      up by the daily catch-up run (`bin/layer.js backbook`).
 *   GET  /health
 * On Cloud Run the service runs with CPU always allocated (--no-cpu-throttling), so
 * work after the answer is not starved. No other route, no state of its own: the tags
 * live on the loans.
 */
function createServer(deps, { webhookSecret = process.env.WEBHOOK_SECRET, onTagged = () => {} } = {}) {
  const inFlight = new Set();

  async function tagInBackground(loanKey, deliveryKey) {
    if (inFlight.has(loanKey)) return;
    inFlight.add(loanKey);
    try {
      const r = await tagLoan(deps, loanKey);
      console.log('[tag]', JSON.stringify({ loan: r.loanId, key: deliveryKey, skipped: r.skipped || null, category: r.tag?.category, by: r.tag?.taggedBy }));
      onTagged(null, r);
    } catch (e) {
      console.error('[tag-failed]', loanKey, e.message);
      onTagged(e, { loanId: loanKey });
    } finally {
      inFlight.delete(loanKey);
    }
  }

  return http.createServer((req, res) => {
    const send = (status, body) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok', classifier: deps.classifier.name, taxonomy: deps.taxonomy.version });
    if (req.method !== 'POST' || req.url !== '/hooks/loans') return send(404, { error: 'NOT_FOUND' });
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > 64 * 1024) { send(413, { error: 'BODY_TOO_LARGE' }); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const v = verify(webhookSecret, req.headers['x-sacco-signature'], body);
        if (!v.ok) return send(401, { error: v.reason });
        let msg = null;
        try { msg = JSON.parse(body); } catch { /* checked below */ }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return send(400, { error: 'BODY_NOT_A_JSON_OBJECT' });
        if (msg.event !== 'LOAN_CREATED') return send(200, { ignored: typeof msg.event === 'string' ? msg.event : null });
        if (typeof msg.loanKey !== 'string' || !msg.loanKey) return send(400, { error: 'LOAN_KEY_MISSING' });
        send(202, { accepted: msg.loanKey });
        tagInBackground(msg.loanKey, req.headers['x-notifications-idempotency-key'] || null);
      } catch (e) {
        console.error('[hook]', e.message);
        send(500, { error: 'ERROR' });
      }
      return undefined;
    });
    return undefined;
  });
}

function depsFromEnv() {
  const taxonomy = require('./taxonomy').load();
  return {
    taxonomy,
    classifier: require('./classifiers').create(taxonomy),
    adapter: require('./adapters/citySacco').create(),
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  createServer(depsFromEnv()).listen(port, () => console.log(`climate-adaptation layer listening on :${port}`));
}

module.exports = { createServer, depsFromEnv };
