'use strict';

const { err } = require('../../lib/errors');
const { recordAudit } = require('../../lib/auditLog');

/**
 * Members' and groups' subscriptions to the templates that write to them
 * (the reference platform's opt-in and opt-out). A template with an opt-out
 * option reaches everyone who has not unsubscribed; an opt-in template only
 * those who subscribed. Credit officers are staff: subscriptions do not
 * apply to them. Manual messages are sent whatever the subscription.
 *
 * The templates concerned are the person-facing ones (EMAIL now, SMS next)
 * whose recipient is the member or group itself, or a group role.
 */

const PERSON_TYPES = ['EMAIL', 'SMS'];

/** Whether a template reaches this member or group, from its option and their choice. */
async function subscribed(c, t, memberId) {
  const { rows: [r] } = await c.query('SELECT subscribed FROM notification_subscriptions WHERE template_id = $1 AND member_id = $2', [t.id, memberId]);
  if (r) return r.subscribed;
  return t.subscription_option !== 'OPT_IN';
}

/** The templates a member or group may be written to by, with their subscription. `activeOnly` for the portal. */
async function list(c, memberId, { activeOnly = false } = {}) {
  const { rows } = await c.query(
    `SELECT t.id, t.name, t.type, t.event, t.subscription_option, t.activated, s.subscribed, s.changed_by, s.changed_at
       FROM notification_templates t
       LEFT JOIN notification_subscriptions s ON s.template_id = t.id AND s.member_id = $1
      WHERE t.type = ANY($2::text[]) AND t.recipient IN ('CLIENT', 'GROUP_ROLE') AND ($3::boolean IS FALSE OR t.activated)
      ORDER BY lower(t.name)`, [memberId, PERSON_TYPES, activeOnly]);
  return rows.map((r) => ({
    templateKey: r.id, name: r.name, channel: r.type, event: r.event, subscriptionOption: r.subscription_option, activated: r.activated,
    subscribed: r.subscribed === null ? r.subscription_option !== 'OPT_IN' : r.subscribed,
    lastModifiedBy: r.changed_by || null, lastModifiedDate: r.changed_at ? new Date(r.changed_at).toISOString() : null,
  }));
}

/** Change one subscription; a template the member cannot choose is not found. */
async function set(c, memberId, templateId, subscribedNow, { actor, activeOnly = false }) {
  if (typeof subscribedNow !== 'boolean') throw err('SUBSCRIBED_MUST_BE_TRUE_OR_FALSE');
  const all = await list(c, memberId, { activeOnly });
  const before = all.find((x) => x.templateKey === templateId);
  if (!before) throw err('TEMPLATE_NOT_FOUND', 404);
  await c.query(
    `INSERT INTO notification_subscriptions (template_id, member_id, subscribed, changed_by, changed_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (template_id, member_id) DO UPDATE SET subscribed = EXCLUDED.subscribed, changed_by = EXCLUDED.changed_by, changed_at = now()`,
    [templateId, memberId, subscribedNow, actor]);
  await recordAudit(c, { actor, action: subscribedNow ? 'NOTIFICATION_SUBSCRIBED' : 'NOTIFICATION_UNSUBSCRIBED', entity: 'member', entityId: memberId,
    before: JSON.stringify({ templateKey: templateId, subscribed: before.subscribed }), after: JSON.stringify({ templateKey: templateId, subscribed: subscribedNow }) });
  return (await list(c, memberId, { activeOnly })).find((x) => x.templateKey === templateId);
}

module.exports = { subscribed, list, set, PERSON_TYPES };
