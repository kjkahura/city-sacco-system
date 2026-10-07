'use strict';

/**
 * Classifies a loan with Claude through the Anthropic Messages API. The answer is
 * forced through one tool, so it is always a category from the taxonomy, a
 * confidence and a one-line reason, never free text to parse.
 *
 * Settings: ANTHROPIC_API_KEY (from Secret Manager in production) and
 * ARCAFIM_MODEL, a model ID from https://docs.claude.com/en/docs/about-claude/models.
 * There is no default model: a model is chosen deliberately and recorded with
 * every tag. The request carries the redacted purpose and notes only.
 */
const API = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = () => Number(process.env.ARCAFIM_MODEL_TIMEOUT_MS || 15_000);

function system(taxonomy) {
  const lines = [...taxonomy.categories, taxonomy.notAdaptation].map((c) => `- ${c.id}: ${c.label}. ${c.description}`);
  return [
    'You classify SACCO and microfinance loans in East Africa for a climate-adaptation lending programme.',
    'Read the loan purpose and notes (English or Swahili) and choose the one category that fits best:',
    ...lines,
    `Choose ${taxonomy.notAdaptation.id} unless the money is clearly for one of the adaptation categories.`,
    'Confidence is your probability, from 0 to 1, that a credit officer would agree with the category.',
    'The reason is one plain sentence a credit officer can check against the application.',
  ].join('\n');
}

function create(taxonomy, { apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.ARCAFIM_MODEL, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY_NOT_SET');
  if (!model) throw new Error('ARCAFIM_MODEL_NOT_SET: choose a model ID from the Claude models page');
  const tool = {
    name: 'tag_loan',
    description: 'Record the adaptation category of the loan.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: taxonomy.ids },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reason: { type: 'string', maxLength: 300 },
      },
      required: ['category', 'confidence', 'reason'],
    },
  };
  return {
    name: `claude:${model}`,
    async classify({ text }) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS());
      let body;
      try {
        const res = await fetchImpl(API, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model,
            max_tokens: 400,
            system: system(taxonomy),
            tools: [tool],
            tool_choice: { type: 'tool', name: tool.name },
            messages: [{ role: 'user', content: `Loan purpose and notes:\n${text}` }],
          }),
        });
        if (!res.ok) throw new Error(`MODEL_REQUEST_FAILED: HTTP ${res.status}`);
        body = await res.json();
      } catch (e) {
        throw e.name === 'AbortError' ? new Error('MODEL_REQUEST_FAILED: timed out') : e;
      } finally { clearTimeout(timer); }
      const use = (body.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
      const out = use?.input || {};
      if (!taxonomy.ids.includes(out.category)) throw new Error('MODEL_ANSWER_INVALID: category');
      const confidence = Math.max(0, Math.min(1, Number(out.confidence)));
      if (!Number.isFinite(confidence)) throw new Error('MODEL_ANSWER_INVALID: confidence');
      return { category: out.category, confidence, reason: String(out.reason || '').slice(0, 300) };
    },
  };
}

module.exports = { create, system };
