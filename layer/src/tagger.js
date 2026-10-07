'use strict';

const { redact } = require('./redact');

/**
 * Tags one loan: read it through the adapter, classify it, and store the category,
 * eligibility, confidence, reason, who tagged it and the taxonomy version.
 *
 * The layer never writes the review fields (reviewStatus, reviewedBy): those belong
 * to credit staff. A tag with no review status is awaiting review, and only a
 * reviewed tag counts (human in the loop; Data Protection Act 2019 section 35).
 *
 * What the model sees is the loan's purpose, redacted; its notes too only with
 * ARCAFIM_INCLUDE_NOTES=on. The keyword classifier runs here and reads both.
 *
 * Idempotent: a loan already tagged under the same taxonomy version is left alone,
 * so a webhook retried or resent changes nothing. A reviewed tag is never
 * overwritten, not even with `force`; it is checked again just before the write, so a
 * review made while the model was answering is kept.
 */
const reviewed = (t) => Boolean(t && t.reviewStatus && t.reviewStatus !== 'pending');

async function tagLoan({ adapter, classifier, taxonomy }, loanId, { force = false } = {}) {
  const existing = await adapter.getTag(loanId);
  if (reviewed(existing)) return { loanId, skipped: 'REVIEWED', tag: existing };
  if (existing && existing.taxonomyVersion === taxonomy.version && existing.category && !force) {
    return { loanId, skipped: 'ALREADY_TAGGED', tag: existing };
  }
  const loan = await adapter.getLoan(loanId);
  const notesToModel = process.env.ARCAFIM_INCLUDE_NOTES === 'on';
  const text = redact([loan.purpose, notesToModel ? loan.notes : null].filter(Boolean).join('\n'), { names: loan.names });
  const localText = [loan.purpose, loan.notes].filter(Boolean).join('\n');
  let tag;
  if (!localText.trim()) {
    tag = { category: taxonomy.notAdaptation.id, eligibility: 'ineligible', confidence: 0,
      reason: 'The loan has no purpose or notes to classify.', taggedBy: 'rule', taxonomyVersion: taxonomy.version };
  } else {
    const r = await classifier.classify({ text: text.trim() ? text : '(no purpose given)', localText });
    tag = {
      category: r.category,
      eligibility: taxonomy.eligible(r.category) ? 'eligible' : 'ineligible',
      confidence: Math.round(r.confidence * 100) / 100,
      reason: r.reason,
      taggedBy: r.by || classifier.name,
      taxonomyVersion: taxonomy.version,
    };
  }
  const now = await adapter.getTag(loanId);
  if (reviewed(now)) return { loanId, skipped: 'REVIEWED', tag: now };
  await adapter.setTag(loanId, tag);
  return { loanId, tag };
}

/** Tags every loan the adapter lists (the back book, or a daily catch-up), one at a time; returns counts. */
async function tagBackBook(deps, { status = null, productIds = null, force = false, log = () => {} } = {}) {
  const out = { tagged: 0, skipped: 0, failed: 0 };
  for await (const l of deps.adapter.listLoans({ status })) {
    if (productIds && !productIds.includes(l.productId)) continue;
    try {
      const r = await tagLoan(deps, l.id, { force });
      if (r.skipped) out.skipped += 1; else out.tagged += 1;
      log(r);
    } catch (e) {
      out.failed += 1;
      log({ loanId: l.id, error: e.message });
    }
  }
  return out;
}

module.exports = { tagLoan, tagBackBook, reviewed };
