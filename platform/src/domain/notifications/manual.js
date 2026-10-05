'use strict';

const { withTenant } = require('../../db/tenantContext');
const { err } = require('../../lib/errors');
const PERMS = require('../../lib/permissions');
const R = require('./render');
const CTX = require('./context');
const CH = require('./channels');
const D = require('./dispatch');
const MSG = require('./messages');
const SMS = require('./channels/sms');

/**
 * A manual email (the reference platform's Send > Send Email): to a member
 * or group, from its page or from one of its loan or deposit accounts,
 * always addressed to the holder. With a template, the template's subject
 * and body are filled for that record; changing them before sending needs
 * EDIT_COMMUNICATION_TEMPLATES. Without one, the subject and body are typed.
 * Subscriptions do not apply: the user chose to write. The message is
 * logged and sent at once.
 */

const uuid = /^[0-9a-f-]{36}$/i;

async function holderOf(c, b) {
  const pick = (k) => (b[k] && uuid.test(String(b[k])) ? String(b[k]) : null);
  if (pick('loanAccountKey')) {
    const { rows: [l] } = await c.query('SELECT id, member_id, branch_id FROM loan_accounts WHERE id = $1', [pick('loanAccountKey')]);
    if (!l) throw err('LOAN_ACCOUNT_NOT_FOUND', 404);
    return { member_id: l.member_id, loan_id: l.id, branch_id: l.branch_id };
  }
  if (pick('depositAccountKey')) {
    const { rows: [a] } = await c.query('SELECT id, member_id, branch_id FROM savings_accounts WHERE id = $1', [pick('depositAccountKey')]);
    if (!a) throw err('DEPOSIT_ACCOUNT_NOT_FOUND', 404);
    return { member_id: a.member_id, savings_account_id: a.id, branch_id: a.branch_id };
  }
  const key = pick('clientKey') || pick('groupKey');
  if (!key) throw err('A_CLIENT_GROUP_LOAN_OR_DEPOSIT_ACCOUNT_KEY_IS_REQUIRED');
  const { rows: [m] } = await c.query('SELECT id, branch_id, holder_type FROM members WHERE id = $1', [key]);
  if (!m || (b.groupKey && m.holder_type !== 'GROUP')) throw err(b.groupKey ? 'GROUP_NOT_FOUND' : 'CLIENT_NOT_FOUND', 404);
  return { member_id: m.id, branch_id: m.branch_id };
}

async function sendEmail(schema, b = {}, { actor, user }) {
  const queued = await withTenant(schema, async (c) => {
    if (!(await CH.ready(c, 'EMAIL'))) throw err('EMAIL_SERVICE_NOT_ENABLED: switch email on in Administration > Email > Settings', 409);
    const e = await holderOf(c, b);
    let t = null;
    if (b.templateKey) {
      if (!uuid.test(String(b.templateKey))) throw err('TEMPLATE_NOT_FOUND', 404);
      ({ rows: [t] } = await c.query("SELECT * FROM notification_templates WHERE id = $1 AND type = 'EMAIL'", [b.templateKey]));
      if (!t) throw err('TEMPLATE_NOT_FOUND', 404);
      const changed = (b.subject !== undefined && b.subject !== t.subject) || (b.body !== undefined && b.body !== t.body);
      if (changed && !PERMS.can(user, 'EDIT_COMMUNICATION_TEMPLATES')) throw err('CHANGING_A_TEMPLATE_BEFORE_SENDING_NEEDS_EDIT_COMMUNICATION_TEMPLATES', 403);
    }
    const subjectText = String(b.subject ?? t?.subject ?? '').trim();
    const bodyText = String(b.body ?? t?.body ?? '');
    if (!subjectText) throw err('SUBJECT_REQUIRED');
    if (subjectText.length > 255) throw err('SUBJECT_IS_AT_MOST_255_CHARACTERS');
    if (!bodyText.trim()) throw err('BODY_REQUIRED');
    R.assertHtmlPlaceholders(bodyText);
    const { rows: [holder] } = await c.query('SELECT email FROM members WHERE id = $1', [e.member_id]);
    if (!holder?.email) throw err('MISSING_EMAIL_RECIPIENT: the client or group has no email address', 400);
    const event = { ...e, event: t?.event || 'MANUAL_EMAIL' };
    const values = await CTX.build(c, event);
    return D.queueEmail(c, { t, e: event, to: holder.email, subject: R.subject(subjectText, values), html: R.fill(bodyText, values, 'HTML'), manual: true, actor });
  });
  await D.sendDue(schema, [queued.id]);
  return withTenant(schema, async (c) => MSG.shape((await c.query('SELECT * FROM notification_messages WHERE id = $1', [queued.id])).rows[0]));
}

/**
 * A manual SMS (Send > Send SMS): to the holder's phone number, from a
 * template or typed, at most six segments once filled. SEND_MANUAL_SMS;
 * changing a template's text needs EDIT_COMMUNICATION_TEMPLATES.
 */
async function sendSms(schema, b = {}, { actor, user }) {
  const queued = await withTenant(schema, async (c) => {
    if (!(await CH.ready(c, 'SMS'))) throw err('SMS_SERVICE_NOT_ENABLED: switch SMS on in Administration > SMS > Settings', 409);
    const e = await holderOf(c, b);
    let t = null;
    if (b.templateKey) {
      if (!uuid.test(String(b.templateKey))) throw err('TEMPLATE_NOT_FOUND', 404);
      ({ rows: [t] } = await c.query("SELECT * FROM notification_templates WHERE id = $1 AND type = 'SMS'", [b.templateKey]));
      if (!t) throw err('TEMPLATE_NOT_FOUND', 404);
      if (b.body !== undefined && b.body !== t.body && !PERMS.can(user, 'EDIT_COMMUNICATION_TEMPLATES')) {
        throw err('CHANGING_A_TEMPLATE_BEFORE_SENDING_NEEDS_EDIT_COMMUNICATION_TEMPLATES', 403);
      }
    }
    const bodyText = String(b.body ?? t?.body ?? '');
    if (!bodyText.trim()) throw err('BODY_REQUIRED');
    const { rows: [holder] } = await c.query('SELECT phone FROM members WHERE id = $1', [e.member_id]);
    if (!holder?.phone) throw err('MISSING_SMS_RECIPIENT: the client or group has no phone number', 400);
    const { rows: [tn] } = await c.query('SELECT country_code FROM platform.tenants WHERE schema_name = current_schema()');
    if (!SMS.toE164(holder.phone, tn?.country_code || 'KE')) throw err(`UNDEFINED_DESTINATION: ${holder.phone} is not a phone number`, 400);
    const event = { ...e, event: t?.event || 'MANUAL_SMS' };
    const values = await CTX.build(c, event);
    const text = R.fill(bodyText, values, 'PLAIN_TEXT');
    SMS.assertLength(text);
    return D.queueSms(c, { t, e: event, to: holder.phone, text, manual: true, actor });
  });
  await D.sendDue(schema, [queued.id]);
  return withTenant(schema, async (c) => MSG.shape((await c.query('SELECT * FROM notification_messages WHERE id = $1', [queued.id])).rows[0]));
}

module.exports = { sendEmail, sendSms };
