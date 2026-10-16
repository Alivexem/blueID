'use strict';

const config = require('../config');
const logger = require('../config/logger');

/**
 * Transactional email via Brevo's HTTP API.
 *
 * Called directly with `fetch` rather than through the SDK: the payload is a
 * single well-documented JSON shape, and avoiding the dependency keeps the
 * deployment lighter and the failure modes visible.
 *
 * Sending never throws. An email is a notification about work that has already
 * been committed — failing a fisherman's registration because a mail server
 * was slow would be the wrong trade. Failures are logged and reported in the
 * return value for the caller to act on if it cares.
 */

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const TIMEOUT_MS = 10_000;

function sender() {
  return { email: config.brevo.senderEmail, name: config.brevo.senderName };
}

/**
 * @returns {Promise<{sent: boolean, skipped?: string, messageId?: string, error?: string}>}
 */
async function send({ to, subject, html, text, cc, bcc, replyTo, tags, params }) {
  const recipients = (Array.isArray(to) ? to : [to])
    .filter(Boolean)
    .map((r) => (typeof r === 'string' ? { email: r } : r))
    .filter((r) => r.email);

  if (!recipients.length) {
    return { sent: false, skipped: 'no recipients' };
  }

  if (!config.brevo.enabled) {
    logger.warn({ subject, to: recipients.map((r) => r.email) }, 'Brevo not configured — email skipped');
    return { sent: false, skipped: 'brevo not configured' };
  }

  if (config.brevo.dryRun) {
    logger.info(
      { subject, to: recipients.map((r) => r.email), preview: text?.slice(0, 200) },
      'EMAIL_DRY_RUN — email logged instead of sent'
    );
    return { sent: false, skipped: 'dry run' };
  }

  const body = {
    sender: sender(),
    to: recipients,
    subject,
    ...(html ? { htmlContent: html } : {}),
    ...(text ? { textContent: text } : {}),
    ...(cc ? { cc: toList(cc) } : {}),
    ...(bcc ? { bcc: toList(bcc) } : {}),
    ...(replyTo || config.brevo.replyTo ? { replyTo: { email: replyTo || config.brevo.replyTo } } : {}),
    ...(tags?.length ? { tags } : {}),
    ...(params ? { params } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': config.brevo.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.error({ status: response.status, detail, subject }, 'Brevo rejected the message');
      return { sent: false, error: `brevo responded ${response.status}` };
    }

    const result = await response.json().catch(() => ({}));
    logger.info({ subject, messageId: result.messageId }, 'Email sent');
    return { sent: true, messageId: result.messageId };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : err.message;
    logger.error({ err, subject }, 'Email send failed');
    return { sent: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

const toList = (value) =>
  (Array.isArray(value) ? value : [value]).filter(Boolean).map((v) => (typeof v === 'string' ? { email: v } : v));

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const BRAND = '#0B4F6C';

function layout({ title, body, footerNote }) {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f4f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a2b34;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e3e8ec;">
      <tr>
        <td style="background:${BRAND};padding:20px 24px;color:#ffffff;">
          <div style="font-size:18px;font-weight:600;">Cross River State Blue Economy</div>
          <div style="font-size:13px;opacity:0.85;">Blue ID &amp; Fisheries Information Management System</div>
        </td>
      </tr>
      <tr>
        <td style="padding:24px;">
          <h1 style="margin:0 0 16px;font-size:18px;">${title}</h1>
          ${body}
        </td>
      </tr>
      <tr>
        <td style="padding:16px 24px;background:#f8fafb;border-top:1px solid #e3e8ec;font-size:12px;color:#5b6b75;">
          ${footerNote || 'This is an automated message from the Blue ID platform. Please do not reply.'}
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

const button = (href, label) =>
  `<p style="margin:20px 0;"><a href="${href}" style="background:${BRAND};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-weight:600;">${label}</a></p>`;

/** Sent when an administrator adds a new officer to the platform. */
async function sendOfficerInvite({ to, name, role, invitedBy }) {
  const title = 'You have been added to the Blue ID platform';
  return send({
    to,
    subject: `${config.app.name} — account created`,
    tags: ['officer-invite'],
    text: `Hello ${name}, an account has been created for you on the Blue ID platform as ${role}. Sign in at ${config.app.portalUrl}.`,
    html: layout({
      title,
      body: `
        <p>Hello ${escapeHtml(name)},</p>
        <p>${escapeHtml(invitedBy || 'An administrator')} has created an account for you on the Cross River State Blue ID platform with the role <strong>${escapeHtml(role)}</strong>.</p>
        <p>Sign in with this email address to get started.</p>
        ${button(config.app.portalUrl, 'Open the portal')}
        <p style="font-size:13px;color:#5b6b75;">If you were not expecting this, you can ignore this message.</p>`,
    }),
  });
}

/** Sent when a pending account is approved. */
async function sendAccountActivated({ to, name, role }) {
  return send({
    to,
    subject: `${config.app.name} — your account is active`,
    tags: ['account-activated'],
    text: `Hello ${name}, your Blue ID account has been activated with the role ${role}.`,
    html: layout({
      title: 'Your account has been activated',
      body: `
        <p>Hello ${escapeHtml(name)},</p>
        <p>Your account has been approved and is now active with the role <strong>${escapeHtml(role)}</strong>.</p>
        ${button(config.app.portalUrl, 'Sign in')}`,
    }),
  });
}

/** Alerts administrators that a registration needs a duplicate decision (§10). */
async function sendDuplicateReviewAlert({ to, fisherman, matches, lga }) {
  const rows = matches
    .slice(0, 5)
    .map(
      (m) => `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eef2f4;">${escapeHtml(m.fullName || '—')}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eef2f4;">${escapeHtml(m.blueId || 'not issued')}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eef2f4;"><strong>${Math.round(m.score * 100)}%</strong></td>
        <td style="padding:6px 8px;border-bottom:1px solid #eef2f4;font-size:12px;color:#5b6b75;">${escapeHtml((m.reasons || []).join('; '))}</td>
      </tr>`
    )
    .join('');

  return send({
    to,
    subject: `Possible duplicate registration in ${lga} — review required`,
    tags: ['duplicate-review'],
    text: `A registration for ${fisherman.fullName} in ${lga} matched ${matches.length} existing record(s) and is awaiting review.`,
    html: layout({
      title: 'A registration needs your review',
      body: `
        <p>A new registration for <strong>${escapeHtml(fisherman.fullName)}</strong> in <strong>${escapeHtml(lga)}</strong> closely matches existing records in the register.</p>
        <p>The record has been held for review. It has <em>not</em> been deleted and no Blue ID has been issued.</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin-top:12px;">
          <tr style="background:#f3f6f8;">
            <th align="left" style="padding:6px 8px;">Existing record</th>
            <th align="left" style="padding:6px 8px;">Blue ID</th>
            <th align="left" style="padding:6px 8px;">Match</th>
            <th align="left" style="padding:6px 8px;">Why</th>
          </tr>
          ${rows}
        </table>
        ${button(`${config.app.portalUrl}/fishermen/${fisherman.id || ''}`, 'Review the record')}`,
    }),
  });
}

/** Confirms a benefit was recorded against a Blue ID (§6). */
async function sendAllocationNotice({ to, fishermanName, blueId, programmeName, itemDescription }) {
  return send({
    to,
    subject: `${programmeName} — allocation recorded`,
    tags: ['allocation'],
    text: `${itemDescription} has been recorded for ${fishermanName} (${blueId}) under ${programmeName}.`,
    html: layout({
      title: 'Allocation recorded',
      body: `
        <p>An allocation has been recorded under <strong>${escapeHtml(programmeName)}</strong>.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:12px 0;">
          <tr><td style="padding:4px 12px 4px 0;color:#5b6b75;">Beneficiary</td><td><strong>${escapeHtml(fishermanName)}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#5b6b75;">Blue ID</td><td><strong>${escapeHtml(blueId)}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#5b6b75;">Item</td><td>${escapeHtml(itemDescription || '—')}</td></tr>
        </table>`,
    }),
  });
}

/** Warns an administrator that a device's sync batch partly failed (§4d). */
async function sendSyncFailureAlert({ to, deviceCode, rejected, batchId }) {
  return send({
    to,
    subject: `Sync issues on device ${deviceCode}`,
    tags: ['sync-alert'],
    text: `Device ${deviceCode} submitted a batch with ${rejected} rejected record(s). Batch ${batchId}.`,
    html: layout({
      title: 'Some field records could not be accepted',
      body: `
        <p>Device <strong>${escapeHtml(deviceCode)}</strong> submitted a synchronisation batch in which <strong>${rejected}</strong> record(s) were rejected.</p>
        <p>The rejected records have been retained on the server and can be corrected from the portal — no field data has been lost.</p>
        ${button(`${config.app.portalUrl}/sync/batches/${batchId}`, 'Open the batch')}`,
    }),
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  send,
  sendOfficerInvite,
  sendAccountActivated,
  sendDuplicateReviewAlert,
  sendAllocationNotice,
  sendSyncFailureAlert,
  layout,
  isEnabled: () => config.brevo.enabled,
};
