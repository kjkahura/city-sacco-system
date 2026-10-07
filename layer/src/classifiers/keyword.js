'use strict';

/**
 * A transparent classifier: the category whose keywords appear most in the text.
 * It runs with no model and no key, for tests, for a SACCO that does not want a model,
 * and as the fallback when the model cannot be reached. Its confidence is low by
 * design, so its tags go to review.
 */
function create(taxonomy) {
  const words = taxonomy.categories.map((c) => ({
    id: c.id,
    patterns: (c.keywords || []).map((k) => new RegExp(`(^|[^a-z])${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i')),
  }));
  return {
    name: 'keyword',
    async classify({ text, localText }) {
      // Runs here, so it may read the notes the model is not sent.
      text = localText || text;
      const scored = words.map((w) => ({ id: w.id, hits: w.patterns.filter((p) => p.test(text)).length }))
        .filter((w) => w.hits > 0).sort((a, b) => b.hits - a.hits);
      if (!scored.length) {
        return { category: taxonomy.notAdaptation.id, confidence: 0.4, reason: 'No adaptation keyword in the loan purpose or notes.' };
      }
      const [top, next] = scored;
      const tied = next && next.hits === top.hits;
      return {
        category: top.id,
        confidence: tied ? 0.45 : Math.min(0.7, 0.5 + 0.1 * top.hits),
        reason: `Keywords for ${taxonomy.label(top.id)}${tied ? ` and ${taxonomy.label(next.id)}` : ''} in the loan purpose or notes.`,
      };
    },
  };
}

module.exports = { create };
