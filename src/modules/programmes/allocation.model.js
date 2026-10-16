'use strict';

const mongoose = require('mongoose');
const { ALLOCATION_STATUS, LGA_CODES } = require('../../config/constants');

/**
 * A benefit issued to one fisherman under one programme — the record that
 * answers "who received what, when, and under which intervention?" (§6).
 *
 * The compound unique index on (programme, fisherman) is the structural
 * guarantee behind the concept note's duplicate-benefit requirement: the
 * database itself refuses to record the same person twice under the same
 * programme, regardless of which officer or device submits it.
 */
const allocationSchema = new mongoose.Schema(
  {
    programme: { type: mongoose.Schema.Types.ObjectId, ref: 'Programme', required: true, index: true },
    programmeCode: { type: String, trim: true, uppercase: true, index: true },
    programmeType: { type: String, trim: true, index: true },

    fisherman: { type: mongoose.Schema.Types.ObjectId, ref: 'Fisherman', required: true, index: true },
    /** Denormalised so a benefit history can be printed without a join. */
    blueId: { type: String, trim: true, uppercase: true, required: true, index: true },
    fishermanName: { type: String, trim: true },

    lga: { type: String, enum: LGA_CODES, required: true, uppercase: true, index: true },
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', index: true },

    itemDescription: { type: String, trim: true },
    quantity: { type: Number, default: 1, min: 0 },
    value: { type: Number, min: 0 },
    currency: { type: String, default: 'NGN' },
    /** Links the benefit to the asset it created, where one was registered. */
    assetType: { type: String, enum: ['BOAT', 'ENGINE', 'EQUIPMENT', 'NONE'], default: 'NONE' },
    assetRef: { type: mongoose.Schema.Types.ObjectId, refPath: 'assetModel', sparse: true },
    assetModel: { type: String, enum: ['Boat', 'Engine', 'Equipment'] },

    status: {
      type: String,
      enum: Object.values(ALLOCATION_STATUS),
      default: ALLOCATION_STATUS.PENDING,
      index: true,
    },

    allocatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    allocatedAt: { type: Date, default: Date.now, index: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    deliveredAt: Date,
    deliveredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    /** Proof of collection: signature or photograph captured at handover. */
    acknowledgement: {
      url: String,
      publicId: String,
      signedAt: Date,
      receivedByName: String,
      receivedByPhone: String,
    },

    rejectionReason: String,
    revokedReason: String,
    notes: String,

    clientRecordId: { type: String, trim: true },
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', sparse: true },

    /**
     * Derived from `status`: true while this allocation occupies the
     * fisherman's slot for the programme.
     *
     * It exists so the uniqueness index can use a plain equality filter.
     * Expressing the same rule as `status: { $in: [...] }` inside a
     * partialFilterExpression requires MongoDB 6.3+, and on an older server
     * the index build fails silently — taking the only structural guarantee
     * against duplicate benefits with it.
     */
    isActiveAllocation: { type: Boolean, default: true, index: true },
    capturedAt: Date,
    syncedAt: Date,

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: Date,
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
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

/** Statuses that occupy a fisherman's slot for a programme. */
const ACTIVE_STATUSES = Object.freeze([
  ALLOCATION_STATUS.PENDING,
  ALLOCATION_STATUS.APPROVED,
  ALLOCATION_STATUS.DELIVERED,
]);

/**
 * One active benefit per fisherman per programme.
 *
 * The partial filter is a plain equality on a derived boolean, which every
 * MongoDB version supports. A revoked or rejected allocation sets the flag
 * false and leaves the index, so a corrected allocation can be re-issued.
 */
allocationSchema.index(
  { programme: 1, fisherman: 1 },
  {
    unique: true,
    partialFilterExpression: { isActiveAllocation: true },
    name: 'one_active_allocation_per_programme',
  }
);

/**
 * Idempotency for allocations captured offline. A partial index on the type
 * rather than `sparse`, because a sparse unique index still indexes an
 * explicit null — so a second document written with `clientRecordId: null`
 * would collide.
 */
allocationSchema.index(
  { clientRecordId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientRecordId: { $type: 'string' } },
    name: 'allocation_client_record_id',
  }
);

allocationSchema.index({ lga: 1, programmeType: 1, allocatedAt: -1 });
allocationSchema.index({ fisherman: 1, allocatedAt: -1 });
allocationSchema.index({ updatedAt: 1, _id: 1 });

/** Keeps the derived flag in step on every write path. */
function deriveActiveFlag(status) {
  return ACTIVE_STATUSES.includes(status);
}

allocationSchema.pre('validate', function setActiveFlag(next) {
  this.isActiveAllocation = deriveActiveFlag(this.status);
  next();
});

/**
 * `findOneAndUpdate` and friends bypass document middleware, so the flag is
 * recomputed here too. Without this, a status change made through an update
 * operator would leave the slot occupied (or free) incorrectly.
 */
allocationSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function syncActiveFlag(next) {
  const update = this.getUpdate() || {};
  const nextStatus = update.$set?.status ?? update.status;

  if (nextStatus !== undefined) {
    this.setUpdate({
      ...update,
      $set: { ...(update.$set || {}), isActiveAllocation: deriveActiveFlag(nextStatus) },
    });
  }
  next();
});

allocationSchema.statics.ACTIVE_STATUSES = ACTIVE_STATUSES;

/**
 * Benefit history is not erasable.
 *
 * An allocation records that public money or equipment was issued to a named
 * person under a named programme. It is evidence, and it has to survive the
 * administrative convenience of wanting it gone. A mistake is corrected by
 * REVOKING the allocation — which frees the slot for a re-issue and leaves
 * the original visible — never by deleting the row.
 *
 * The soft-delete field remains for administrative hiding, but a hard delete
 * through the ODM is refused outright.
 */
function blockHardDelete(next) {
  next(
    new Error(
      'Benefit allocations cannot be deleted — revoke the allocation instead, which preserves the record'
    )
  );
}

allocationSchema.pre('deleteOne', { document: false, query: true }, blockHardDelete);
allocationSchema.pre('deleteMany', blockHardDelete);
allocationSchema.pre('findOneAndDelete', blockHardDelete);

/**
 * The beneficiary and the programme are the identity of the record. Changing
 * either would silently re-attribute a disbursement to a different person —
 * so they are write-once, with one exception: a duplicate merge re-points the
 * history onto the surviving record, which is a correction of WHO the person
 * is, not of who was paid.
 */
allocationSchema.post('init', function rememberIdentity() {
  Object.defineProperty(this, '$issuedTo', {
    value: { fisherman: String(this.fisherman), programme: String(this.programme) },
    writable: true,
    enumerable: false,
    configurable: true,
  });
});

allocationSchema.pre('save', function protectIdentity(next) {
  const issued = this.$issuedTo;
  if (!issued) return next();

  if (this.isModified('programme') && String(this.programme) !== issued.programme) {
    return next(new Error('An allocation cannot be moved to a different programme'));
  }
  next();
});

module.exports = mongoose.model('Allocation', allocationSchema);
