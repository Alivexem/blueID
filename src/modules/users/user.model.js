'use strict';

const mongoose = require('mongoose');
const { ROLES, ROLE_VALUES, USER_STATUS, LGA_CODES } = require('../../config/constants');

/**
 * A portal/field-app operator: state staff, LGA administrators, enumerators,
 * cooperative officers.
 *
 * Credentials are NOT stored here. The client application owns sign-in; this
 * record exists so the API can attach a role and a geographic scope to a
 * verified token subject (`authUid`).
 */
const scopeSchema = new mongoose.Schema(
  {
    /** LGA codes this user may operate in. Empty + state-wide role = all. */
    lgas: [{ type: String, enum: LGA_CODES, uppercase: true, trim: true }],
    /** Optional narrower posting for enumerators. */
    communities: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Community' }],
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    /**
     * Subject from an external identity provider, when one is in use.
     * Unused in `local` auth mode, where this service owns the credential.
     */
    authUid: { type: String, trim: true, index: true },

    // ---- Local credentials -------------------------------------------------
    /**
     * Argon2id hash. `select: false` so it is never loaded — and therefore
     * never serialised — unless a caller explicitly asks for it.
     */
    passwordHash: { type: String, select: false },
    passwordChangedAt: { type: Date },
    /**
     * Set on an account issued a temporary password. The holder may
     * authenticate and reach only the handful of endpoints that let them
     * change it or sign out — every other route is refused. Enforced in
     * middleware/requirePasswordChange.js, not left to the client.
     */
    mustChangePassword: { type: Boolean, default: false },

    /**
     * Single-use password-reset token, stored hashed with an expiry.
     * Consuming it clears both fields, so a link cannot be replayed.
     */
    resetTokenHash: { type: String, select: false },
    resetTokenExpiresAt: { type: Date, select: false },

    /**
     * Progressive lockout. Counts consecutive failures and holds the account
     * shut for a spell once the threshold is crossed, so an attacker with a
     * password list is slowed to a crawl without a successful user ever
     * being locked out by someone else's guessing.
     */
    failedLoginAttempts: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, select: false },
    lastLoginAt: { type: Date },
    lastLoginIp: { type: String },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'Enter a valid email address'],
    },
    phone: { type: String, trim: true },

    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },

    role: { type: String, enum: ROLE_VALUES, default: ROLES.ENUMERATOR, index: true },
    status: {
      type: String,
      enum: Object.values(USER_STATUS),
      default: USER_STATUS.PENDING,
      index: true,
    },

    scope: { type: scopeSchema, default: () => ({ lgas: [], communities: [] }) },

    /** Set when role is COOPERATIVE_OFFICER — limits the user to one society. */
    cooperative: { type: mongoose.Schema.Types.ObjectId, ref: 'Cooperative', index: true, sparse: true },

    staffId: { type: String, trim: true },
    designation: { type: String, trim: true },

    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    invitedAt: Date,
    activatedAt: Date,
    lastSeenAt: Date,
    lastDeviceId: { type: String, trim: true },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: Date,
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        // Defence in depth: these are `select: false`, but a document built
        // in memory could still carry them.
        delete ret.passwordHash;
        delete ret.resetTokenHash;
        delete ret.resetTokenExpiresAt;
        delete ret.failedLoginAttempts;
        delete ret.lockedUntil;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

userSchema.virtual('fullName').get(function fullName() {
  return [this.firstName, this.lastName].filter(Boolean).join(' ');
});

userSchema.index({ role: 1, 'scope.lgas': 1 });
userSchema.index({ lastName: 1, firstName: 1 });

userSchema.pre('save', function setActivatedAt(next) {
  if (this.isModified('status') && this.status === USER_STATUS.ACTIVE && !this.activatedAt) {
    this.activatedAt = new Date();
  }
  next();
});


/**
 * Unique identifiers are enforced with PARTIAL indexes keyed on the value's
 * type, not with `sparse`. A sparse unique index skips documents where the
 * field is MISSING but still indexes an explicit `null` — so the second
 * document written with `field: null` collides with the first. Keying on
 * `$type: 'string'` indexes only real values.
 */
userSchema.index(
  { authUid: 1 },
  { unique: true, partialFilterExpression: { authUid: { $type: 'string' } }, name: 'user_auth_uid' }
);
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } }, name: 'user_email' }
);

module.exports = mongoose.model('User', userSchema);
