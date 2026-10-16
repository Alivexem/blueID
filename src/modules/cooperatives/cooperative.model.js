'use strict';

const mongoose = require('mongoose');
const { LGA_CODES } = require('../../config/constants');
const { normalizeText, normalizePhone } = require('../../utils/normalize');

/**
 * Fishing cooperative societies. Membership is one of the eligibility criteria
 * a government programme can filter on, and cooperative officers are scoped to
 * their own society (see middleware/authorize.js).
 */
const officerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    role: {
      type: String,
      enum: ['CHAIRMAN', 'SECRETARY', 'TREASURER', 'MEMBER', 'OTHER'],
      default: 'MEMBER',
    },
    phone: { type: String, trim: true },
    normalizedPhone: String,
    /** Set when the officer is also a registered fisherman. */
    fisherman: { type: mongoose.Schema.Types.ObjectId, ref: 'Fisherman', sparse: true },
  },
  { _id: true }
);

const cooperativeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    normalizedName: { type: String, index: true },
    registrationNumber: { type: String, trim: true, uppercase: true },

    lga: { type: String, enum: LGA_CODES, required: true, uppercase: true, index: true },
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', index: true },
    communityName: { type: String, trim: true },
    address: { type: String, trim: true },

    registeredAt: Date,
    officers: { type: [officerSchema], default: [] },

    contactPhone: { type: String, trim: true },
    contactEmail: { type: String, trim: true, lowercase: true },

    bankDetails: {
      bankName: String,
      accountName: String,
      /** Last 4 digits only — full account numbers are out of scope here. */
      accountNumberLast4: String,
    },

    /** Maintained by the cooperative service on member add/remove. */
    memberCount: { type: Number, default: 0, min: 0 },

    isActive: { type: Boolean, default: true, index: true },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: Date,
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
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

cooperativeSchema.index({ lga: 1, name: 1 }, { unique: true });
cooperativeSchema.index({ name: 'text', communityName: 'text' }, { name: 'cooperative_search' });
cooperativeSchema.index({ updatedAt: 1, _id: 1 });

cooperativeSchema.pre('validate', function derive(next) {
  if (this.isModified('name')) this.normalizedName = normalizeText(this.name);
  for (const officer of this.officers || []) {
    if (officer.phone) officer.normalizedPhone = normalizePhone(officer.phone) || undefined;
  }
  next();
});


/**
 * Unique identifiers use a PARTIAL index keyed on the value's type rather
 * than `sparse`: a sparse unique index skips MISSING fields but still indexes
 * an explicit `null`, so a second document written with `field: null` would
 * collide with the first.
 */
cooperativeSchema.index(
  { registrationNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { registrationNumber: { $type: 'string' } },
    name: 'cooperative_registration_number',
  }
);

module.exports = mongoose.model('Cooperative', cooperativeSchema);
