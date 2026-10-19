'use strict';

/**
 * Outbound email content.
 *
 * These exist because the invitation email was a dead end: it told the
 * recipient an account had been created and gave them a link to the portal,
 * but carried no credentials at all. The temporary password was returned to
 * the administrator in the API response instead, to be passed on by hand, so
 * anybody invited remotely simply could not sign in. Nothing failed — the
 * account was real, the message was delivered, and it was useless.
 *
 * An email body is the one output nothing else checks: it is not a status
 * code, not a schema, and the person who would notice is the recipient. So
 * the assertions here are on what a reader actually receives.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'disabled';
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'test-qr-secret-value';
process.env.FIELD_ENCRYPTION_KEY =
  process.env.FIELD_ENCRYPTION_KEY || 'test-field-encryption-key-at-least-32-chars';

// Enough for config.brevo.enabled; nothing is actually sent — fetch is stubbed.
process.env.BREVO_API_KEY = process.env.BREVO_API_KEY || 'test-brevo-key';
process.env.BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'noreply@blueid.test.invalid';
process.env.EMAIL_DRY_RUN = 'false';

const emailService = require('../src/services/email.service');
const logger = require('../src/config/logger');

logger.level = 'silent';

/** Captures the payload the service would have posted to Brevo. */
async function capture(fn) {
  const original = global.fetch;
  let sent = null;

  global.fetch = async (url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ messageId: 'test-message-id' }) };
  };

  try {
    await fn();
  } finally {
    global.fetch = original;
  }

  assert.ok(sent, 'no message was sent');
  return { ...sent, plain: sent.htmlContent.replace(/<[^>]+>/g, ' ') };
}

const invite = {
  to: 'okon.effiom@crsg.test.invalid',
  name: 'Okon Effiom',
  role: 'LGA_ADMIN',
  invitedBy: 'Diana Nsemo',
  temporaryPassword: 'Yk3Qd7bXm9TzLpR2vNs1aHcZ',
  userId: 'officer-014',
};

test('the invitation delivers the User ID and the password', async () => {
  const sent = await capture(() => emailService.sendOfficerInvite(invite));

  for (const part of ['textContent', 'plain']) {
    assert.match(
      sent[part],
      /officer-014/,
      `the ${part} must carry the User ID the sign-in form asks for`
    );
    assert.match(
      sent[part],
      /Yk3Qd7bXm9TzLpR2vNs1aHcZ/,
      `the ${part} must carry the password, or the recipient cannot sign in`
    );
  }
});

test('it says the password has to be replaced, because the server enforces that', async () => {
  const sent = await capture(() => emailService.sendOfficerInvite(invite));

  // The account is created with mustChangePassword, so the first sign-in goes
  // nowhere else. A recipient who is not told that reads it as a broken login.
  assert.match(
    sent.textContent,
    /choose your own password the first time you sign in/i,
    'the message must set the expectation that the password is temporary'
  );
});

test('an account with no User ID is told to sign in with its email address', async () => {
  // staffId is optional on an invitation. Sign-in accepts either identifier,
  // so the message names the one the account actually has rather than telling
  // the recipient to go and ask somebody.
  const { userId, ...withoutUserId } = invite;
  const sent = await capture(() => emailService.sendOfficerInvite(withoutUserId));

  assert.match(sent.textContent, /okon\.effiom@crsg\.test\.invalid/, 'the address must be named');
  assert.match(sent.textContent, /Yk3Qd7bXm9TzLpR2vNs1aHcZ/, 'the password must still be there');
});

test('a password containing HTML is escaped, not rendered', async () => {
  /**
   * A generated password is base64url and safe, but an administrator may
   * supply one. An unescaped `&` or `<` would reach the recipient mangled or
   * swallowed by the markup — and a password that arrives altered is
   * indistinguishable from a wrong one.
   */
  const sent = await capture(() =>
    emailService.sendOfficerInvite({ ...invite, temporaryPassword: 'a&b<c>d"e' })
  );

  assert.ok(
    !sent.htmlContent.includes('a&b<c>d"e'),
    'the raw password must not be interpolated into the markup unescaped'
  );
  assert.match(sent.htmlContent, /a&amp;b&lt;c&gt;d/, 'it must appear escaped');
  assert.match(sent.textContent, /a&b<c>d"e/, 'and verbatim in the plain-text part');
});

test('the dry-run log does not print the password', async () => {
  /**
   * The dry-run branch logs the first 200 characters of the text body as a
   * preview, which is exactly where the credentials now sit. Logging them
   * would put a live password in the application log — the one place the
   * invitation flow takes care to keep it out of.
   */
  const config = require('../src/config');
  const lines = [];

  const originalInfo = logger.info.bind(logger);
  const originalDryRun = config.brevo.dryRun;
  config.brevo.dryRun = true;
  logger.info = (obj, msg) => { lines.push({ obj, msg }); };

  try {
    await emailService.sendOfficerInvite(invite);
  } finally {
    logger.info = originalInfo;
    config.brevo.dryRun = originalDryRun;
  }

  const dryRun = lines.find((l) => String(l.msg).startsWith('EMAIL_DRY_RUN'));
  assert.ok(dryRun, 'the dry-run branch should have logged');
  assert.ok(
    !JSON.stringify(dryRun.obj).includes(invite.temporaryPassword),
    'the password must not reach the log'
  );
  assert.match(String(dryRun.obj.preview), /redacted/, 'and the preview should say why it is absent');
});

test('a message with no credential still gets a readable preview', async () => {
  // The redaction is keyed on the message carrying a credential, not applied
  // to every email — otherwise dry-run stops being useful for debugging.
  const config = require('../src/config');
  const lines = [];

  const originalInfo = logger.info.bind(logger);
  const originalDryRun = config.brevo.dryRun;
  config.brevo.dryRun = true;
  logger.info = (obj, msg) => { lines.push({ obj, msg }); };

  try {
    await emailService.sendAccountActivated({ to: invite.to, name: invite.name, role: invite.role });
  } finally {
    logger.info = originalInfo;
    config.brevo.dryRun = originalDryRun;
  }

  const dryRun = lines.find((l) => String(l.msg).startsWith('EMAIL_DRY_RUN'));
  assert.ok(dryRun, 'the dry-run branch should have logged');
  assert.doesNotMatch(
    String(dryRun.obj.preview),
    /redacted/,
    'an ordinary notification should still show its preview'
  );
});
