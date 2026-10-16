'use strict';

// firebase-admin v13+ exposes a modular API; the old `admin.auth()` namespace
// was removed, so the entry points are imported directly.
const { initializeApp, getApps, cert, applicationDefault } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const config = require('./index');
const logger = require('./logger');

/**
 * Firebase Admin — used for exactly two things:
 *
 *   1. Verifying ID tokens minted by the client application.
 *   2. Administering the identity record (disable an account, revoke its
 *      refresh tokens) when an officer is suspended here.
 *
 * It is NOT used for Firestore, storage or messaging. The register lives in
 * MongoDB; Firebase is the identity provider and nothing more.
 *
 * Why `verifyIdToken` rather than verifying the JWT by hand against Google's
 * JWKS: the SDK pins the audience to this project and the issuer to
 * `securetoken.google.com/<projectId>`. Without that pinning, a correctly
 * signed token from ANY Firebase project satisfies the signature check,
 * because Google signs for all of them with the same keys. That is a full
 * authentication bypass, and it is the single most important reason this file
 * exists.
 */

let app = null;
let initialised = false;

/**
 * Credentials come from an explicit service account, or from Application
 * Default Credentials when the process runs on Google infrastructure.
 * The private key is stored with escaped newlines in most secret managers.
 */
function buildCredential() {
  const { projectId, clientEmail, privateKey } = config.firebase;

  if (projectId && clientEmail && privateKey) {
    return cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n'),
    });
  }

  // GOOGLE_APPLICATION_CREDENTIALS or a metadata-server identity.
  return applicationDefault();
}

function initialise() {
  if (initialised) return app;

  if (!config.firebase.enabled) {
    initialised = true;
    const message = 'Firebase is not configured — AUTH_MODE=firebase will fail';
    if (config.auth.mode === 'firebase') logger.error(message);
    else logger.debug(message);
    return null;
  }

  try {
    // Reuse an existing app when the module is re-required (tests, workers).
    const existing = getApps();
    app = existing.length
      ? existing[0]
      : initializeApp({
          credential: buildCredential(),
          projectId: config.firebase.projectId,
        });

    initialised = true;
    logger.info({ projectId: config.firebase.projectId }, 'Firebase Admin initialised');
    return app;
  } catch (err) {
    initialised = true;
    logger.error({ err }, 'Failed to initialise Firebase Admin');
    if (config.auth.mode === 'firebase') throw err;
    return null;
  }
}

function auth() {
  if (!initialised) initialise();
  if (!app) {
    const err = new Error('Firebase Admin is not configured');
    err.code = 'FIREBASE_NOT_CONFIGURED';
    throw err;
  }
  return getAuth(app);
}

/**
 * Verifies an ID token.
 *
 * `checkRevoked` is always true. Without it, disabling an account or revoking
 * its refresh tokens in Firebase has no effect here until the token expires —
 * up to an hour during which a compromised account stays live. The flag costs
 * one lookup against the Firebase Auth backend and makes revocation effective
 * on the next request.
 *
 * It also enforces `aud` and `iss` against this project (see the note above).
 */
async function verifyIdToken(idToken) {
  return auth().verifyIdToken(idToken, true);
}

/**
 * Cuts off an account immediately: existing refresh tokens stop working and
 * no new ID token can be minted. Called when an officer is suspended or
 * disabled in the local register, so the two systems cannot disagree.
 *
 * Never throws — a failure here must not block the local suspension, which is
 * itself enforced on every request. The failure is logged loudly instead.
 */
async function revokeAccess(authUid, { disable = false } = {}) {
  if (!authUid || !config.firebase.enabled) return { revoked: false, skipped: true };

  try {
    const client = auth();
    await client.revokeRefreshTokens(authUid);
    if (disable) await client.updateUser(authUid, { disabled: true });

    logger.info({ authUid, disabled: disable }, 'Firebase access revoked');
    return { revoked: true, disabled: disable };
  } catch (err) {
    logger.error(
      { err, authUid },
      'Could not revoke Firebase access — the local account is still blocked on every request'
    );
    return { revoked: false, error: err.message };
  }
}

/** Re-enables an account that was disabled when it was suspended. */
async function restoreAccess(authUid) {
  if (!authUid || !config.firebase.enabled) return { restored: false, skipped: true };

  try {
    await auth().updateUser(authUid, { disabled: false });
    logger.info({ authUid }, 'Firebase account re-enabled');
    return { restored: true };
  } catch (err) {
    logger.error({ err, authUid }, 'Could not re-enable the Firebase account');
    return { restored: false, error: err.message };
  }
}

/** Reads the identity record, for an administrator inspecting an account. */
async function getUser(authUid) {
  if (!authUid || !config.firebase.enabled) return null;
  try {
    const user = await auth().getUser(authUid);
    return {
      uid: user.uid,
      email: user.email,
      emailVerified: user.emailVerified,
      disabled: user.disabled,
      lastSignInAt: user.metadata?.lastSignInTime,
      createdAt: user.metadata?.creationTime,
      providers: (user.providerData || []).map((p) => p.providerId),
      tokensValidAfterTime: user.tokensValidAfterTime,
    };
  } catch (err) {
    if (err.code === 'auth/user-not-found') return null;
    logger.warn({ err, authUid }, 'Could not read the Firebase user record');
    return null;
  }
}

const isEnabled = () => config.firebase.enabled;

module.exports = {
  initialise,
  auth,
  verifyIdToken,
  revokeAccess,
  restoreAccess,
  getUser,
  isEnabled,
};
