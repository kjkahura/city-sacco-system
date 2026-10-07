'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The adaptation taxonomy the loans are tagged against (config/arcafim-taxonomy.json,
 * or the file TAXONOMY_FILE names). Its version is written with every tag, so a new
 * version can be told from the old and loans tagged under it tagged again.
 */
function load(file = process.env.TAXONOMY_FILE || path.join(__dirname, '..', 'config', 'arcafim-taxonomy.json')) {
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!t.version || !Array.isArray(t.categories) || !t.categories.length || !t.notAdaptation?.id) {
    throw new Error(`TAXONOMY_INVALID: ${file} needs a version, categories and notAdaptation`);
  }
  const ids = new Set();
  for (const c of [...t.categories, t.notAdaptation]) {
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(c.id || '') || ids.has(c.id)) throw new Error(`TAXONOMY_INVALID: category id ${c.id}`);
    ids.add(c.id);
  }
  return {
    ...t,
    ids: [...ids],
    eligible: (id) => t.categories.some((c) => c.id === id),
    label: (id) => [...t.categories, t.notAdaptation].find((c) => c.id === id)?.label || id,
  };
}

module.exports = { load };
