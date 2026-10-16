'use strict';

const mongoose = require('mongoose');
const { AUDIT_ACTIONS } = require('../../config/constants');

/**
 * Append-only audit trail (concept note §9: user activity logs, audit trails).
 *
 * Two rules govern this collection:
 *
 *   1. It is never updated or deleted by application code. Corrections are
 *      recorded as new entries.
 *   2. `changes` stores a field-level before/after diff, not the whole
 *      document. A full snapshot would multiply copies of citizens' personal
 *      data across the log for no auditing benefit; the diff is what an
 *      investigator actually needs.
 */

const changeSchema = new mongoose.Schema(
  {
    field: { type: String, required: true },
    from: mongoose.Schema.Types.Mixed,
    to: mongoose.Schema.Types.Mixed,
  },
  { _id: false }
);

const auditLogSchema = new mongoose.Schema(
  {
    action: { type: String, enum: Object.values(AUDIT_ACTIONS), required: true, index: true },

    actor: {
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
      name: String,
      email: String,
      role: { type: String, index: true },
      /** Present for machine-to-machine callers instead of a user. */
      service: String,
    },

    entity: {
      type: { type: String, required: true, index: true }, // 'Fisherman', 'Allocation', ...
      id: { type: mongoose.Schema.Types.ObjectId, index: true },
      blueId: { type: String, index: true, sparse: true },
      label: String,
    },

    changes: { type: [changeSchema], default: [] },
    /** Free-form context: duplicate scores, rejection reasons, export filters. */
    metadata: { type: mongoose.Schema.Types.Mixed },

    lga: { type: String, index: true, sparse: true },

    context: {
      requestId: String,
      ipAddress: String,
      userAgent: String,
      deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' },
      deviceCode: String,
      channel: { type: String, enum: ['WEB', 'MOBILE', 'SYNC', 'SYSTEM', 'API'], default: 'WEB' },
    },

    /** Set when an action failed — a rejected attempt is itself auditable. */
    outcome: { type: String, enum: ['SUCCESS', 'FAILURE'], default: 'SUCCESS', index: true },
    failureReason: String,
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Audit queries are almost always "what happened to this record" or
// "what did this officer do", both newest-first.
auditLogSchema.index({ 'entity.type': 1, 'entity.id': 1, createdAt: -1 });
auditLogSchema.index({ 'actor.user': 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ lga: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

/** Guard rails — the trail is append-only. */
function blockMutation(next) {
  next(new Error('Audit log entries are immutable'));
}
auditLogSchema.pre('findOneAndUpdate', blockMutation);
auditLogSchema.pre('updateOne', blockMutation);
auditLogSchema.pre('updateMany', blockMutation);
auditLogSchema.pre('deleteOne', blockMutation);
auditLogSchema.pre('deleteMany', blockMutation);
auditLogSchema.pre('findOneAndDelete', blockMutation);

module.exports = mongoose.model('AuditLog', auditLogSchema);
