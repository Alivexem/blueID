'use strict';

const mongoose = require('mongoose');
const crypto = require('node:crypto');
const { DEVICE_STATUS, LGA_CODES } = require('../../config/constants');

/**
 * A registered field device (concept note §9: "device authentication").
 *
 * Every offline record carries the device it was captured on, so a batch of
 * suspect registrations can be traced to one tablet and that tablet revoked
 * without touching the enumerator's account.
 *
 * `deviceCode` is a short human-readable identifier (e.g. BAK-07) used in the
 * temporary registration reference printed for the fisherman before the record
 * has synchronised and received a real Blue ID.
 */
const deviceSchema = new mongoose.Schema(
  {
    deviceCode: { type: String, required: true, trim: true, uppercase: true, unique: true, index: true },
    label: { type: String, trim: true },

    /** Hardware fingerprint reported by the app — detects a cloned install. */
    hardwareId: { type: String, trim: true, index: true, sparse: true },
    platform: { type: String, enum: ['ANDROID', 'IOS', 'WEB', 'OTHER'], default: 'ANDROID' },
    model: String,
    osVersion: String,
    appVersion: String,

    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    lga: { type: String, enum: LGA_CODES, uppercase: true, index: true },
    communities: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Community' }],

    status: {
      type: String,
      enum: Object.values(DEVICE_STATUS),
      default: DEVICE_STATUS.ACTIVE,
      index: true,
    },

    /** Hash of the device's sync secret — the plaintext is shown once. */
    secretHash: { type: String, select: false },

    lastSeenAt: Date,
    lastSyncAt: Date,
    /**
     * Per-entity pull cursors, e.g. { FISHERMAN: '<cursor>', BOAT: '<cursor>' }.
     *
     * A single shared cursor was a data-loss bug: entities drain at different
     * rates, so one cursor advanced past records of another entity that had
     * never been sent, and they were skipped permanently.
     */
    lastSyncCursors: { type: Map, of: String, default: () => new Map() },
    /** Running totals, useful for spotting an unusually prolific device. */
    stats: {
      recordsPushed: { type: Number, default: 0 },
      recordsPulled: { type: Number, default: 0 },
      batchesProcessed: { type: Number, default: 0 },
      lastBatchAt: Date,
    },

    registeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    revokedAt: Date,
    revokedReason: String,

    notes: String,
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        delete ret.secretHash;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

deviceSchema.index({ lga: 1, status: 1 });

/** Issues a sync secret, returning the plaintext exactly once. */
deviceSchema.methods.issueSecret = function issueSecret() {
  const secret = crypto.randomBytes(32).toString('base64url');
  this.secretHash = crypto.createHash('sha256').update(secret).digest('hex');
  return secret;
};

deviceSchema.methods.verifySecret = function verifySecret(secret) {
  if (!this.secretHash || !secret) return false;
  const candidate = crypto.createHash('sha256').update(String(secret)).digest('hex');
  const a = Buffer.from(candidate);
  const b = Buffer.from(this.secretHash);
  // timingSafeEqual throws on a length mismatch, which would itself leak.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

deviceSchema.virtual('isUsable').get(function isUsable() {
  return this.status === DEVICE_STATUS.ACTIVE;
});

module.exports = mongoose.model('Device', deviceSchema);
