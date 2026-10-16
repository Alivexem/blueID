'use strict';

const mongoose = require('mongoose');
const {
  PROGRAMME_TYPES,
  PROGRAMME_STATUS,
  FISHERMAN_TYPES,
  FISHING_TYPES,
  LGA_CODES,
} = require('../../config/constants');

/**
 * A government intervention: engine distribution, net distribution, grants,
 * training, insurance and so on (concept note §6).
 *
 * `eligibility` is machine-readable on purpose. Encoding the criteria as data
 * rather than as a written policy is what allows the portal to answer "which
 * fishermen qualify for this intervention?" (§14) and to pre-screen a
 * beneficiary list instead of compiling it by hand.
 */

const eligibilitySchema = new mongoose.Schema(
  {
    lgas: [{ type: String, enum: LGA_CODES, uppercase: true }],
    communities: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Community' }],
    fishermanTypes: [{ type: String, enum: Object.values(FISHERMAN_TYPES) }],
    fishingTypes: [{ type: String, enum: Object.values(FISHING_TYPES) }],
    genders: [{ type: String, enum: ['MALE', 'FEMALE', 'OTHER'] }],

    minYearsFishing: { type: Number, min: 0 },
    minAge: { type: Number, min: 0 },
    maxAge: { type: Number, min: 0 },

    requiresCooperativeMembership: { type: Boolean, default: false },
    requiresBoatOwnership: { type: Boolean, default: false },
    requiresVerifiedBlueId: { type: Boolean, default: true },

    /**
     * Blocks a fisherman who already received this programme type within the
     * last N months — the main defence against the same person collecting the
     * same intervention twice (§6).
     */
    excludeIfReceivedWithinMonths: { type: Number, min: 0 },
    notes: String,
  },
  { _id: false }
);

const programmeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true, unique: true, index: true },
    type: { type: String, enum: Object.values(PROGRAMME_TYPES), required: true, index: true },
    description: { type: String, trim: true },

    year: { type: Number, required: true, min: 2000, index: true },
    implementingAgency: { type: String, trim: true, default: 'Department of Blue Economy' },
    fundingSource: { type: String, trim: true },

    status: {
      type: String,
      enum: Object.values(PROGRAMME_STATUS),
      default: PROGRAMME_STATUS.DRAFT,
      index: true,
    },
    startDate: Date,
    endDate: Date,

    /** What a single beneficiary receives. */
    itemDescription: { type: String, trim: true },
    unitValue: { type: Number, min: 0 },
    currency: { type: String, default: 'NGN' },

    targetBeneficiaries: { type: Number, min: 0 },
    /** Maintained by the allocation service; never written directly. */
    allocatedCount: { type: Number, default: 0, min: 0 },
    deliveredCount: { type: Number, default: 0, min: 0 },
    totalBudget: { type: Number, min: 0 },

    eligibility: { type: eligibilitySchema, default: () => ({}) },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,

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

programmeSchema.index({ status: 1, year: -1 });
programmeSchema.index({ name: 'text', description: 'text' }, { name: 'programme_search' });
programmeSchema.index({ updatedAt: 1, _id: 1 });

programmeSchema.virtual('remainingSlots').get(function remainingSlots() {
  if (this.targetBeneficiaries == null) return null;
  return Math.max(0, this.targetBeneficiaries - this.allocatedCount);
});

programmeSchema.virtual('isOpen').get(function isOpen() {
  if (this.status !== PROGRAMME_STATUS.OPEN) return false;
  const now = Date.now();
  if (this.startDate && this.startDate.getTime() > now) return false;
  if (this.endDate && this.endDate.getTime() < now) return false;
  return true;
});

module.exports = mongoose.model('Programme', programmeSchema);
