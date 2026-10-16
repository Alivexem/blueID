'use strict';

const mongoose = require('mongoose');
const crypto = require('node:crypto');

/**
 * A refresh-token session.
 *
 * Access tokens are short-lived and stateless, which makes them fast but
 * impossible to withdraw. Refresh tokens are the opposite: long-lived, and
 * therefore stored here so they CAN be withdrawn. Suspending an officer,
 * signing out a device, or detecting a stolen token all work by revoking
 * rows in this collection.
 *
 * Only a hash of the token is stored. A dump of this collection does not let
 * anyone impersonate a session.
 *
 * ROTATION AND REUSE DETECTION
 * Each refresh issues a new token and retires the old one. If a token that
 * has already been rotated is presented again, something has gone wrong — the
 * most likely explanation is that it was stolen and the thief is racing the
 * legitimate client. The whole session family is then revoked, which logs
 * both parties out and forces a fresh sign-in.
 */
const sessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** SHA-256 of the refresh token. The plaintext is returned once. */
    tokenHash: { type: String, required: true, unique: true, index: true },

    /**
     * Groups every token derived from one sign-in. Revoking a family on reuse
     * invalidates the thief's token and the victim's together, which is the
     * safe outcome — a surprise sign-out beats a silent impersonation.
     */
    family: { type: String, required: true, index: true },

    /** Set when this token is rotated away, so reuse is detectable. */
    rotatedAt: { type: Date, default: null },
    rotatedTo: { type: String, default: null },

    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },

    /** The TTL index below sweeps expired rows; no separate index needed. */
    expiresAt: { type: Date, required: true },

    // Context, so an officer can recognise their own sessions in a list.
    ipAddress: String,
    userAgent: String,
    deviceCode: String,

    lastUsedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        // Never serialise the hash, even though it is not the token itself.
        delete ret.tokenHash;
        return ret;
      },
    },
  }
);

sessionSchema.index({ user: 1, revokedAt: 1 });
/** Expired rows are swept by MongoDB rather than accumulating forever. */
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Tokens are compared by hash; the plaintext is never stored. */
sessionSchema.statics.hashToken = function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
};

sessionSchema.virtual('isActive').get(function isActive() {
  return !this.revokedAt && !this.rotatedAt && this.expiresAt > new Date();
});

/** Revokes every session in a family — used on refresh-token reuse. */
sessionSchema.statics.revokeFamily = function revokeFamily(family, reason) {
  return this.updateMany(
    { family, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
};

/** Signs a user out everywhere: suspension, password change, logout-all. */
sessionSchema.statics.revokeAllForUser = function revokeAllForUser(userId, reason) {
  return this.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
};

module.exports = mongoose.model('Session', sessionSchema);
