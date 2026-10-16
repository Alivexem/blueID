'use strict';

const mongoose = require('mongoose');
const {
  BOAT_TYPES,
  PROPULSION_TYPES,
  ASSET_CONDITION,
  ACQUISITION_SOURCE,
  LGA_CODES,
} = require('../../config/constants');
const { normalizeCode } = require('../../utils/normalize');

/**
 * A fishing vessel tied to a Blue ID. One fisherman may own several boats
 * (concept note §4c), so this is a separate collection rather than a subdocument.
 *
 * `blueId` and `lga` are denormalised from the owner so that boat listings,
 * dashboard counts and LGA scoping do not need a join on every query.
 */

const mediaSchema = new mongoose.Schema(
  {
    url: String,
    publicId: String,
    width: Number,
    height: Number,
    format: String,
    bytes: Number,
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const boatSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'Fisherman', required: true, index: true },
    blueId: { type: String, trim: true, uppercase: true, index: true },
    lga: { type: String, enum: LGA_CODES, required: true, uppercase: true, index: true },
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', index: true },

    /** Official registration/licence number where the boat carries one. */
    registrationNumber: { type: String, trim: true, uppercase: true },
    name: { type: String, trim: true },

    boatType: { type: String, enum: Object.values(BOAT_TYPES), required: true },
    /** Free text for the local canoe classification, which varies by community. */
    canoeType: { type: String, trim: true },
    material: { type: String, enum: ['WOOD', 'FIBREGLASS', 'ALUMINIUM', 'STEEL', 'OTHER'] },

    lengthMeters: { type: Number, min: 0, max: 100 },
    widthMeters: { type: Number, min: 0, max: 30 },
    crewCapacity: { type: Number, min: 0, max: 200 },
    cargoCapacityKg: { type: Number, min: 0 },

    propulsion: {
      type: String,
      enum: Object.values(PROPULSION_TYPES),
      default: PROPULSION_TYPES.PADDLE,
    },

    condition: { type: String, enum: Object.values(ASSET_CONDITION), default: ASSET_CONDITION.GOOD },
    yearAcquired: { type: Number, min: 1900, max: new Date().getFullYear() },
    acquisitionSource: {
      type: String,
      enum: Object.values(ACQUISITION_SOURCE),
      default: ACQUISITION_SOURCE.PERSONAL,
    },
    /** Set when the boat arrived through a government programme. */
    allocation: { type: mongoose.Schema.Types.ObjectId, ref: 'Allocation', sparse: true },

    photo: mediaSchema,
    estimatedValue: { type: Number, min: 0 },

    isActive: { type: Boolean, default: true, index: true },

    // ---- Sync provenance ---------------------------------------------------
    clientRecordId: { type: String, trim: true, index: true },
    registeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', sparse: true },
    capturedAt: Date,
    syncedAt: Date,
    clientRevision: { type: Number, default: 0 },

    notes: String,
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

boatSchema.index({ lga: 1, boatType: 1 });
boatSchema.index({ owner: 1, isDeleted: 1 });
boatSchema.index({ updatedAt: 1, _id: 1 });

/** Engines fitted to this boat, resolved on demand. */
boatSchema.virtual('engines', {
  ref: 'Engine',
  localField: '_id',
  foreignField: 'boat',
});

boatSchema.pre('validate', function normalizeRegistration(next) {
  if (this.isModified('registrationNumber')) {
    this.registrationNumber = normalizeCode(this.registrationNumber) || undefined;
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
boatSchema.index(
  { registrationNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { registrationNumber: { $type: 'string' } },
    name: 'boat_registration_number',
  }
);
boatSchema.index(
  { clientRecordId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientRecordId: { $type: 'string' } },
    name: 'boat_client_record_id',
  }
);

module.exports = mongoose.model('Boat', boatSchema);
