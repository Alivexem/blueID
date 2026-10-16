'use strict';

const mongoose = require('mongoose');
const { ASSET_CONDITION, ACQUISITION_SOURCE, LGA_CODES } = require('../../config/constants');
const { normalizeCode } = require('../../utils/normalize');

/**
 * An outboard/inboard engine.
 *
 * Kept separate from the boat because engines are the single most distributed
 * government item (concept note §6) and are routinely moved between boats or
 * sold on. `serialNumber` is the asset's true identity and is unique across the
 * state — that is what lets the ministry answer "was this engine already given
 * to someone else?".
 */

const mediaSchema = new mongoose.Schema(
  {
    url: String,
    publicId: String,
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const engineSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'Fisherman', required: true, index: true },
    blueId: { type: String, trim: true, uppercase: true, index: true },
    lga: { type: String, enum: LGA_CODES, required: true, uppercase: true, index: true },

    /** Optional: an engine may be owned without being fitted to a boat. */
    boat: { type: mongoose.Schema.Types.ObjectId, ref: 'Boat', index: true, sparse: true },

    manufacturer: { type: String, trim: true, required: true },
    model: { type: String, trim: true },
    horsepower: { type: Number, min: 0, max: 1000 },
    /** State-wide unique so the same engine cannot be registered twice. */
    serialNumber: { type: String, trim: true, uppercase: true },
    engineType: { type: String, enum: ['OUTBOARD', 'INBOARD'], default: 'OUTBOARD' },
    fuelType: { type: String, enum: ['PETROL', 'DIESEL', 'ELECTRIC', 'OTHER'], default: 'PETROL' },

    condition: { type: String, enum: Object.values(ASSET_CONDITION), default: ASSET_CONDITION.GOOD },
    yearAcquired: { type: Number, min: 1900, max: new Date().getFullYear() },
    acquisitionSource: {
      type: String,
      enum: Object.values(ACQUISITION_SOURCE),
      default: ACQUISITION_SOURCE.PERSONAL,
    },
    allocation: { type: mongoose.Schema.Types.ObjectId, ref: 'Allocation', sparse: true },

    lastServicedAt: Date,
    photo: mediaSchema,
    estimatedValue: { type: Number, min: 0 },

    isActive: { type: Boolean, default: true, index: true },

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

engineSchema.index({ lga: 1, manufacturer: 1 });
engineSchema.index({ owner: 1, isDeleted: 1 });
engineSchema.index({ updatedAt: 1, _id: 1 });

engineSchema.pre('validate', function normalizeSerial(next) {
  if (this.isModified('serialNumber')) {
    this.serialNumber = normalizeCode(this.serialNumber) || undefined;
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
engineSchema.index(
  { serialNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { serialNumber: { $type: 'string' } },
    name: 'engine_serial_number',
  }
);
engineSchema.index(
  { clientRecordId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientRecordId: { $type: 'string' } },
    name: 'engine_client_record_id',
  }
);

module.exports = mongoose.model('Engine', engineSchema);
