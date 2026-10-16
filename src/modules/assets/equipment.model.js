'use strict';

const mongoose = require('mongoose');
const {
  EQUIPMENT_TYPES,
  ASSET_CONDITION,
  ACQUISITION_SOURCE,
  LGA_CODES,
} = require('../../config/constants');

/**
 * Fishing gear and ancillary equipment: nets, cold boxes, ice boxes, safety
 * kit, GPS units, smoking kilns (concept note §4c).
 *
 * Unlike boats and engines these are usually counted rather than individually
 * identified, hence `quantity` instead of a serial number.
 */
const equipmentSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'Fisherman', required: true, index: true },
    blueId: { type: String, trim: true, uppercase: true, index: true },
    lga: { type: String, enum: LGA_CODES, required: true, uppercase: true, index: true },

    type: { type: String, enum: Object.values(EQUIPMENT_TYPES), required: true, index: true },
    /** e.g. "gill net, 3 inch mesh" — the detail behind the enum. */
    description: { type: String, trim: true },
    quantity: { type: Number, default: 1, min: 0 },
    unit: { type: String, trim: true, default: 'unit' },

    specification: {
      meshSizeInches: Number,
      lengthMeters: Number,
      capacityLitres: Number,
      brand: String,
    },

    condition: { type: String, enum: Object.values(ASSET_CONDITION), default: ASSET_CONDITION.GOOD },
    yearAcquired: { type: Number, min: 1900, max: new Date().getFullYear() },
    acquisitionSource: {
      type: String,
      enum: Object.values(ACQUISITION_SOURCE),
      default: ACQUISITION_SOURCE.PERSONAL,
    },
    allocation: { type: mongoose.Schema.Types.ObjectId, ref: 'Allocation', sparse: true },

    photo: {
      url: String,
      publicId: String,
      uploadedAt: Date,
    },
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

equipmentSchema.index({ lga: 1, type: 1 });
equipmentSchema.index({ owner: 1, isDeleted: 1 });
equipmentSchema.index({ updatedAt: 1, _id: 1 });


/**
 * Unique identifiers are enforced with PARTIAL indexes keyed on the value's
 * type, not with `sparse`. A sparse unique index skips documents where the
 * field is MISSING but still indexes an explicit `null` — so the second
 * document written with `field: null` collides with the first. Keying on
 * `$type: 'string'` indexes only real values.
 */
equipmentSchema.index(
  { clientRecordId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientRecordId: { $type: 'string' } },
    name: 'equipment_client_record_id',
  }
);

module.exports = mongoose.model('Equipment', equipmentSchema);
