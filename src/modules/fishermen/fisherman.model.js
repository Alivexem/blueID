'use strict';

const mongoose = require('mongoose');
const {
  FISHERMAN_STATUS,
  FISHERMAN_TYPES,
  FISHING_TYPES,
  GENDERS,
  LGA_CODES,
  REGISTRATION_CHANNEL,
} = require('../../config/constants');
const crypto = require('node:crypto');
const {
  normalizePhone,
  normalizeNin,
  normalizeName,
  buildFullName,
  toTitleCase,
  resolveBirthYear,
} = require('../../utils/normalize');
const { phoneticNameKey } = require('../../utils/similarity');
const fieldCrypto = require('../../utils/fieldCrypto');

/**
 * The central fishermen register — the authoritative record behind every
 * Blue ID.
 *
 * Three design points worth knowing before editing this file:
 *
 * 1. MATCH FIELDS. `match.*` holds normalised copies of the identity fields
 *    (phone, NIN, name, phonetic key, birth year). They are derived in a
 *    pre-validate hook and exist solely so duplicate detection can query an
 *    index instead of scanning. Never write them by hand.
 *
 * 2. OFFLINE ORIGIN. `clientRecordId` is a UUID minted on the field device
 *    before the record ever reaches the server. It is the idempotency key for
 *    synchronisation: a device that retries a push after a dropped connection
 *    upserts the same row rather than creating a second fisherman.
 *
 * 3. NOTHING IS DELETED. Records are soft-deleted and suspected duplicates are
 *    flagged for human review (concept note §10), never removed automatically.
 */

const mediaSchema = new mongoose.Schema(
  {
    url: { type: String, trim: true },
    publicId: { type: String, trim: true },
    width: Number,
    height: Number,
    format: { type: String, trim: true },
    bytes: Number,
    capturedAt: Date,
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const nextOfKinSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    normalizedPhone: { type: String, trim: true },
    relationship: { type: String, trim: true },
    address: { type: String, trim: true },
  },
  { _id: false }
);

/** GeoJSON Point — powers the GIS map in concept note §8. */
const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: {
      type: [Number], // [longitude, latitude]
      validate: {
        validator: (v) =>
          !v ||
          v.length === 0 ||
          (v.length === 2 && v[0] >= -180 && v[0] <= 180 && v[1] >= -90 && v[1] <= 90),
        message: 'coordinates must be [longitude, latitude] within valid ranges',
      },
    },
    accuracy: Number,
    capturedAt: Date,
  },
  { _id: false }
);

const duplicateFlagSchema = new mongoose.Schema(
  {
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: 'Fisherman', required: true },
    candidateBlueId: String,
    score: { type: Number, required: true },
    reasons: [String],
    detectedAt: { type: Date, default: Date.now },
    detectedDuring: { type: String, enum: ['REGISTRATION', 'SYNC', 'AUDIT_SWEEP'], default: 'REGISTRATION' },
    resolution: {
      type: String,
      enum: ['PENDING', 'NOT_DUPLICATE', 'MERGED', 'MARKED_DUPLICATE'],
      default: 'PENDING',
    },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: Date,
    resolutionNote: String,
  },
  { _id: true }
);

const fishermanSchema = new mongoose.Schema(
  {
    // ---- Identification ----------------------------------------------------
    blueId: {
      type: String,
      trim: true,
      uppercase: true,
      // Uniqueness is enforced by a partial index declared below.
      index: true,
    },
    /** Reference printed on the paper slip handed over in the field. */
    tempReference: { type: String, trim: true, uppercase: true, index: true, sparse: true },

    // ---- Personal details --------------------------------------------------
    firstName: { type: String, required: [true, 'First name is required'], trim: true },
    middleName: { type: String, trim: true },
    lastName: { type: String, required: [true, 'Surname is required'], trim: true },
    fullName: { type: String, trim: true, index: true },
    alias: { type: String, trim: true },

    gender: { type: String, enum: Object.values(GENDERS), required: true },
    dateOfBirth: Date,
    /** Used where an exact date of birth is unknown — common in the field. */
    estimatedYearOfBirth: {
      type: Number,
      min: 1900,
      max: new Date().getFullYear(),
    },

    photo: mediaSchema,

    phone: { type: String, trim: true },
    altPhone: { type: String, trim: true },
    /**
     * Stored ENCRYPTED (AES-256-GCM, see utils/fieldCrypto.js). Never read
     * this field directly — use `getNin()`, which decrypts, and gate it on the
     * `fisherman:read_sensitive` permission. Matching uses `match.ninIndex`.
     */
    nin: { type: String, trim: true, select: false },

    nextOfKin: nextOfKinSchema,

    // ---- Location ----------------------------------------------------------
    lga: { type: String, enum: LGA_CODES, required: true, uppercase: true, trim: true, index: true },
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', index: true },
    communityName: { type: String, trim: true },
    landingSite: { type: String, trim: true },
    address: { type: String, trim: true },
    ward: { type: String, trim: true },
    location: pointSchema,

    // ---- Fisheries information (concept note §4b) --------------------------
    fishermanTypes: {
      type: [{ type: String, enum: Object.values(FISHERMAN_TYPES) }],
      default: [],
      validate: {
        validator: (v) => v.length > 0,
        message: 'Select at least one type of fisherman',
      },
    },
    fishingTypes: {
      type: [{ type: String, enum: Object.values(FISHING_TYPES) }],
      default: [],
    },
    yearsFishing: { type: Number, min: 0, max: 100 },
    isFullTime: { type: Boolean, default: true },
    secondaryOccupation: { type: String, trim: true },
    estimatedMonthlyCatchKg: { type: Number, min: 0 },

    cooperative: {
      id: { type: mongoose.Schema.Types.ObjectId, ref: 'Cooperative', index: true, sparse: true },
      name: { type: String, trim: true },
      membershipNumber: { type: String, trim: true },
      joinedAt: Date,
    },

    // ---- Lifecycle ---------------------------------------------------------
    status: {
      type: String,
      enum: Object.values(FISHERMAN_STATUS),
      default: FISHERMAN_STATUS.PENDING_VERIFICATION,
      index: true,
    },
    statusReason: { type: String, trim: true },
    statusChangedAt: Date,
    statusChangedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    verification: {
      verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      verifiedAt: Date,
      notes: String,
    },

    duplicateFlags: { type: [duplicateFlagSchema], default: [] },
    /** Set when this record was merged into another; points at the survivor. */
    mergedInto: { type: mongoose.Schema.Types.ObjectId, ref: 'Fisherman', sparse: true },

    // ---- Provenance & sync -------------------------------------------------
    /** UUID generated on the device — the sync idempotency key. */
    clientRecordId: { type: String, trim: true, index: true },
    registrationChannel: {
      type: String,
      enum: Object.values(REGISTRATION_CHANNEL),
      default: REGISTRATION_CHANNEL.WEB_PORTAL,
    },
    registeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', sparse: true },
    /** When the enumerator captured it offline, as opposed to when it synced. */
    capturedAt: Date,
    syncedAt: Date,
    /** Bumped on every device-originated write; used for conflict detection. */
    clientRevision: { type: Number, default: 0 },

    // ---- Derived match keys (see note 1 at the top) ------------------------
    match: {
      normalizedPhone: { type: String, index: true, sparse: true },
      normalizedAltPhone: { type: String, index: true, sparse: true },
      /** Keyed HMAC of the NIN — searchable, but not reversible. */
      ninIndex: { type: String, index: true, sparse: true },
      normalizedName: { type: String, index: true },
      phoneticName: { type: String, index: true },
      birthYear: { type: Number, index: true, sparse: true },
    },

    /**
     * Opaque, random reference encoded into the printed QR code.
     *
     * The QR deliberately does NOT carry the Blue ID or any personal detail:
     * a card photographed by a stranger would otherwise hand over a real
     * identifier. This token is meaningless on its own, is rotated whenever a
     * card is reissued, and resolves to a record only through the verification
     * endpoint, which decides how much to disclose.
     */
    verificationToken: { type: String, trim: true, index: true },
    qrVersion: { type: Number, default: 1 },
    idCardIssuedAt: Date,
    idCardIssuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    notes: { type: String, trim: true },
    tags: [{ type: String, trim: true, lowercase: true }],

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: Date,
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    /**
     * Two officers acting on the same record must not silently overwrite each
     * other. A save against a stale copy now raises a VersionError, which the
     * error handler surfaces as a 409 rather than losing one of the edits.
     */
    optimisticConcurrency: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        delete ret.match; // internal matching keys are never exposed
        // The NIN is `select: false`, but strip it defensively: a serialised
        // document must never carry ciphertext or a plaintext NIN by accident.
        delete ret.nin;
        // The QR token is a lookup credential for the printed card; it is
        // released only by the endpoint that issues the card.
        delete ret.verificationToken;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

// Portal list view: "active fishermen in Bakassi, newest first".
fishermanSchema.index({ lga: 1, status: 1, createdAt: -1 });
fishermanSchema.index({ community: 1, status: 1 });
// Duplicate-candidate lookup blocks on LGA + phonetic name.
fishermanSchema.index({ lga: 1, 'match.phoneticName': 1 });
fishermanSchema.index({ 'match.normalizedName': 1, 'match.birthYear': 1 });
// Free-text search across the portal search box.
fishermanSchema.index(
  { fullName: 'text', blueId: 'text', communityName: 'text', landingSite: 'text' },
  { name: 'fisherman_search', weights: { blueId: 10, fullName: 5, communityName: 2, landingSite: 1 } }
);
// GIS map queries.
fishermanSchema.index({ location: '2dsphere' });
// Sync pull cursor (see utils/pagination.js).
fishermanSchema.index({ updatedAt: 1, _id: 1 });
// Review queue.
fishermanSchema.index({ 'duplicateFlags.resolution': 1, status: 1 });

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Derives display and match fields. Keeps them in step with the raw inputs. */
fishermanSchema.pre('validate', function deriveFields(next) {
  if (this.isModified('firstName')) this.firstName = toTitleCase(this.firstName);
  if (this.isModified('middleName') && this.middleName) this.middleName = toTitleCase(this.middleName);
  if (this.isModified('lastName')) this.lastName = toTitleCase(this.lastName);

  if (this.isModified('firstName') || this.isModified('middleName') || this.isModified('lastName')) {
    this.fullName = buildFullName(this);
  }

  this.match = this.match || {};

  if (this.isModified('phone') || !this.match.normalizedPhone) {
    this.match.normalizedPhone = normalizePhone(this.phone) || undefined;
  }
  if (this.isModified('altPhone')) {
    this.match.normalizedAltPhone = normalizePhone(this.altPhone) || undefined;
  }
  // The NIN is normalised, indexed for matching, then encrypted in place.
  // The guard stops a second validate pass from encrypting the ciphertext.
  if (this.isModified('nin') && !fieldCrypto.isCiphertext(this.nin)) {
    const normalized = normalizeNin(this.nin);
    this.match.ninIndex = normalized ? fieldCrypto.blindIndex(normalized) : undefined;
    this.nin = normalized ? fieldCrypto.encrypt(normalized) : undefined;
  }
  if (this.isModified('nextOfKin') && this.nextOfKin?.phone) {
    this.nextOfKin.normalizedPhone = normalizePhone(this.nextOfKin.phone) || undefined;
  }
  if (this.isModified('fullName') || !this.match.normalizedName) {
    this.match.normalizedName = normalizeName(this.fullName);
    this.match.phoneticName = phoneticNameKey(this.match.normalizedName);
  }
  if (this.isModified('dateOfBirth') || this.isModified('estimatedYearOfBirth')) {
    this.match.birthYear = resolveBirthYear(this) || undefined;
  }

  if (this.isModified('status')) {
    this.statusChangedAt = new Date();
  }

  next();
});

/**
 * The Blue ID is write-once.
 *
 * Service code strips it from update payloads, but that is one layer and it
 * is reachable from several callers. This is the floor: once a number has
 * been issued it is printed on a card and is the person's permanent reference
 * for every future intervention, so nothing may quietly rewrite it. A
 * reissued CARD rotates the QR token instead — the number never changes.
 */
fishermanSchema.post('init', function rememberIssuedBlueId() {
  // Snapshot taken when the document is loaded; the guard below compares
  // against it. Non-enumerable so it never reaches a response or a diff.
  Object.defineProperty(this, '$issuedBlueId', {
    value: this.blueId,
    writable: true,
    enumerable: false,
    configurable: true,
  });
});

fishermanSchema.pre('save', function protectBlueId(next) {
  // Only an assignment ONTO an already-issued number is refused; the first
  // issuance (undefined -> value) is how a Blue ID comes into existence.
  const issued = this.$issuedBlueId;

  if (issued && this.isModified('blueId') && this.blueId !== issued) {
    return next(
      new Error(`A Blue ID is permanent and cannot be changed (${issued} -> ${this.blueId})`)
    );
  }
  next();
});

/** Blocks the same rewrite through update operators, which skip `save`. */
fishermanSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function guardBlueId(next) {
  const update = this.getUpdate() || {};
  const assigned = update.$set?.blueId ?? update.blueId;
  const unset = update.$unset?.blueId !== undefined;

  if (unset) {
    return next(new Error('A Blue ID cannot be removed once issued'));
  }

  /**
   * An assignment is allowed only when the filter restricts it to records
   * that do not yet hold one — which is exactly how `verify()` claims a
   * record atomically. Anything broader is a rewrite.
   */
  if (assigned !== undefined) {
    const filter = this.getFilter() || {};
    const claimsUnissued =
      filter.blueId &&
      (Array.isArray(filter.blueId.$in)
        ? filter.blueId.$in.every((v) => v === null || v === undefined)
        : filter.blueId.$exists === false);

    if (!claimsUnissued) {
      return next(
        new Error('A Blue ID may only be assigned to a record that does not already hold one')
      );
    }
  }
  next();
});

/** A record with an unresolved duplicate flag must not sit in ACTIVE. */
fishermanSchema.methods.hasOpenDuplicateFlag = function hasOpenDuplicateFlag() {
  return this.duplicateFlags.some((f) => f.resolution === 'PENDING');
};

/**
 * Decrypts the NIN. Callers MUST check the `fisherman:read_sensitive`
 * permission first and record the access in the audit trail — this is the
 * most sensitive field in the register.
 */
fishermanSchema.methods.getNin = function getNin() {
  if (!this.nin) return null;
  return fieldCrypto.decrypt(this.nin);
};

/** Masked form for users without the sensitive grant: *******1234. */
fishermanSchema.methods.getMaskedNin = function getMaskedNin() {
  const nin = this.getNin();
  return nin ? fieldCrypto.mask(nin) : null;
};

/**
 * Issues a fresh opaque QR token, invalidating any previously printed card.
 * Called when a Blue ID is first issued and on every card reprint.
 */
fishermanSchema.methods.rotateVerificationToken = function rotateVerificationToken() {
  this.verificationToken = crypto.randomBytes(24).toString('base64url');
  this.qrVersion = (this.qrVersion || 0) + 1;
  return this.verificationToken;
};

fishermanSchema.virtual('age').get(function age() {
  const year = resolveBirthYear(this);
  return year ? new Date().getUTCFullYear() - year : null;
});

fishermanSchema.virtual('isVerified').get(function isVerified() {
  return Boolean(this.verification?.verifiedAt) && Boolean(this.blueId);
});


/**
 * Unique identifiers are enforced with PARTIAL indexes keyed on the value's
 * type, not with `sparse`. A sparse unique index skips documents where the
 * field is MISSING but still indexes an explicit `null` — so the second
 * document written with `field: null` collides with the first. Keying on
 * `$type: 'string'` indexes only real values.
 */
fishermanSchema.index(
  { blueId: 1 },
  { unique: true, partialFilterExpression: { blueId: { $type: 'string' } }, name: 'fisherman_blue_id' }
);
fishermanSchema.index(
  { clientRecordId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientRecordId: { $type: 'string' } },
    name: 'fisherman_client_record_id',
  }
);
fishermanSchema.index(
  { verificationToken: 1 },
  {
    unique: true,
    partialFilterExpression: { verificationToken: { $type: 'string' } },
    name: 'fisherman_verification_token',
  }
);

module.exports = mongoose.model('Fisherman', fishermanSchema);
