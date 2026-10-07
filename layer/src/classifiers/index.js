'use strict';

const keyword = require('./keyword');
const claude = require('./claude');

/**
 * CLASSIFIER=claude (the model, with the keyword classifier as fallback when the
 * model fails) or keyword (no model). Default keyword, so nothing calls a model
 * until it is chosen.
 */
function create(taxonomy, opts = {}) {
  const kind = opts.kind || process.env.CLASSIFIER || 'keyword';
  const kw = keyword.create(taxonomy);
  if (kind === 'keyword') return kw;
  if (kind !== 'claude') throw new Error(`CLASSIFIER_UNKNOWN: ${kind}`);
  const model = claude.create(taxonomy, opts);
  return {
    name: model.name,
    async classify(input) {
      try {
        return { ...(await model.classify(input)), by: model.name };
      } catch (e) {
        // The keyword answer goes to review like any other; the failure is in the log and on the tag.
        console.error('[classifier]', e.message);
        const r = await kw.classify(input);
        return { ...r, by: kw.name, reason: `${r.reason} (Model unavailable: ${e.message.split(':')[0]}.)` };
      }
    },
  };
}

module.exports = { create };
