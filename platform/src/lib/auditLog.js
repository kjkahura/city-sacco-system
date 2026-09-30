'use strict';

/**
 * The change log (audit_log): one row per change, written in the same
 * transaction as the change. Migration 042 links each row to its member,
 * accounts, credit arrangement and branch, and adds the request's IP
 * address and channel, so a caller gives only what changed.
 *
 *   recordAudit(c, { actor, action, entity, entityId, before, after })
 *
 * before and after are stored as JSON: a string of JSON, or an object.
 */
async function recordAudit(c, { actor = null, action, entity = null, entityId = null, before = null, after = null }) {
  await c.query(
    'INSERT INTO audit_log (actor, action, entity, entity_id, before, after) VALUES ($1,$2,$3,$4,$5,$6)',
    [actor, action, entity, entityId === null || entityId === undefined ? null : String(entityId), before ?? null, after ?? null]);
}

module.exports = { recordAudit };
