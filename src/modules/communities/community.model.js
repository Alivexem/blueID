'use strict';

const mongoose = require('mongoose');
const { LGA_CODES, COMMUNITY_TYPES } = require('../../config/constants');
const { normalizeText } = require('../../utils/normalize');

/**
 * A fishing community and its infrastructure.
 *
 * This is the backbone of the GIS layer (concept note §8) and of the
 * "which communities lack cold storage / landing sites / boat repair"
 * questions the dashboard must answer (§7, §14). The `facilities` flags are
 * therefore first-class fields rather than free text.
 */

const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], default: undefined }, // [lng, lat]
  },
  { _id: false }
);

const landingSiteSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    location: pointSchema,
    hasJetty: { type: Boolean, default: false },
    hasColdStorage: { type: Boolean, default: false },
    condition: { type: String, enum: ['GOOD', 'FAIR', 'POOR', 'NONE'], default: 'FAIR' },
    notes: String,
  },
  { _id: true }
);

const communitySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    normalizedName: { type: String, index: true },
    code: { type: String, trim: true, uppercase: true },

    lga: { type: String, enum: LGA_CODES, required: true, uppercase: true, index: true },
    ward: { type: String, trim: true },
    type: { type: String, enum: Object.values(COMMUNITY_TYPES), default: COMMUNITY_TYPES.RIVERINE },

    location: pointSchema,
    landingSites: { type: [landingSiteSchema], default: [] },

    /** Drives the infrastructure-gap reports. */
    facilities: {
      landingSite: { type: Boolean, default: false },
      coldStorage: { type: Boolean, default: false },
      iceplant: { type: Boolean, default: false },
      processingFacility: { type: Boolean, default: false },
      boatRepair: { type: Boolean, default: false },
      jetty: { type: Boolean, default: false },
      market: { type: Boolean, default: false },
    },

    accessibility: {
      roadAccess: { type: Boolean, default: false },
      boatOnlyAccess: { type: Boolean, default: false },
      mobileNetwork: { type: String, enum: ['NONE', 'POOR', 'FAIR', 'GOOD'], default: 'POOR' },
      electricity: { type: Boolean, default: false },
    },

    estimatedPopulation: { type: Number, min: 0 },
    estimatedFishermen: { type: Number, min: 0 },

    /** Denormalised counters refreshed by the dashboard service. */
    stats: {
      registeredFishermen: { type: Number, default: 0 },
      registeredBoats: { type: Number, default: 0 },
      registeredEngines: { type: Number, default: 0 },
      lastRecalculatedAt: Date,
    },

    contactPerson: {
      name: String,
      phone: String,
      title: String,
    },

    developmentNeeds: [{ type: String, trim: true }],
    notes: String,

    isActive: { type: Boolean, default: true, index: true },
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
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

communitySchema.index({ lga: 1, name: 1 }, { unique: true });
communitySchema.index({ location: '2dsphere' });
communitySchema.index({ name: 'text', ward: 'text' }, { name: 'community_search' });
communitySchema.index({ updatedAt: 1, _id: 1 }); // offline reference-data pull

communitySchema.pre('validate', function deriveName(next) {
  if (this.isModified('name')) this.normalizedName = normalizeText(this.name);
  // A named landing site implies the facility flag.
  if (this.landingSites?.length) this.facilities.landingSite = true;
  next();
});

/** Facilities this community does NOT have — the "gap list" for planning. */
communitySchema.virtual('missingFacilities').get(function missingFacilities() {
  return Object.entries(this.facilities?.toObject?.() ?? this.facilities ?? {})
    .filter(([, present]) => present === false)
    .map(([key]) => key);
});


/**
 * Unique identifiers use a PARTIAL index keyed on the value's type rather
 * than `sparse`: a sparse unique index skips MISSING fields but still indexes
 * an explicit `null`, so a second document written with `field: null` would
 * collide with the first.
 */
communitySchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { code: { $type: 'string' } }, name: 'community_code' }
);

module.exports = mongoose.model('Community', communitySchema);
