'use strict';

const AuditLog = require('../modules/audit/audit.model');
const logger = require('../config/logger');
const { AUDIT_ACTIONS } = require('../config/constants');

/**
 * Writes the audit trail.
 *
 * Auditing must not be able to fail a legitimate operation, so `record` never
 * throws — a failed write is logged at error level for the operations team to
 * pick up. The trade-off is deliberate: refusing to register a fisherman
 * because a log write timed out would be worse than a gap in the log, which is
 * independently detectable.
 */

/** Fields never written to the audit log, even in a diff. */
const SENSITIVE_FIELDS = new Set(['nin', 'match', 'secretHash', '__v', 'updatedAt', 'createdAt']);

/**
 * Field-level diff between two plain objects. Only scalar comparisons are made;
 * nested objects are compared by JSON value, which is sufficient for the
 * subdocuments in this schema and keeps the log readable.
 */
function diff(before = {}, after = {}, { prefix = '' } = {}) {
  const changes = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);

  for (const key of keys) {
    if (SENSITIVE_FIELDS.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const from = before?.[key];
    const to = after?.[key];

    if (from instanceof Date || to instanceof Date) {
      if (String(from) !== String(to)) changes.push({ field: path, from, to });
      continue;
    }
    if (
      from &&
      to &&
      typeof from === 'object' &&
      typeof to === 'object' &&
      !Array.isArray(from) &&
      !Array.isArray(to)
    ) {
      changes.push(...diff(from, to, { prefix: path }));
      continue;
    }
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      changes.push({ field: path, from, to });
    }
  }
  return changes;
}

/** Pulls the actor/context block off an Express request. */
function contextFrom(req) {
  if (!req) return { actor: { service: 'system' }, context: { channel: 'SYSTEM' } };

  return {
    actor: req.user
      ? {
          user: req.user._id,
          name: req.user.fullName,
          email: req.user.email,
          role: req.user.role,
        }
      : { service: req.service?.name || 'anonymous' },
    context: {
      requestId: req.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      deviceCode: req.get('x-device-id'),
      channel: req.service ? 'API' : req.get('x-device-id') ? 'MOBILE' : 'WEB',
    },
  };
}

/**
 * Records one audit entry. Fire-and-forget by default — callers should not
 * await it on the hot path unless ordering matters.
 */
async function record({ action, entity, changes, metadata, lga, outcome, failureReason, req }) {
  try {
    const { actor, context } = contextFrom(req);
    await AuditLog.create({
      action,
      actor,
      entity,
      changes: changes || [],
      metadata,
      lga,
      outcome: outcome || 'SUCCESS',
      failureReason,
      context,
    });
  } catch (err) {
    logger.error({ err, action, entity }, 'Failed to write audit log entry');
  }
}

/** Convenience wrapper for create/update/delete of a Mongoose document. */
async function recordChange({ action, doc, before, req, metadata }) {
  const entityType = doc?.constructor?.modelName || 'Unknown';
  const after = typeof doc?.toObject === 'function' ? doc.toObject() : doc;

  return record({
    action,
    entity: {
      type: entityType,
      id: doc?._id,
      blueId: after?.blueId,
      label: after?.fullName || after?.name || after?.code,
    },
    changes: action === AUDIT_ACTIONS.UPDATE ? diff(before, after) : undefined,
    metadata,
    lga: after?.lga,
    req,
  });
}

/** Records a refused action — a forbidden read attempt is worth keeping. */
async function recordFailure({ action, entity, reason, req, metadata }) {
  return record({
    action,
    entity,
    outcome: 'FAILURE',
    failureReason: reason,
    metadata,
    req,
  });
}

/** Reads the history of one record, newest first. */
async function historyFor(entityType, entityId, { limit = 50 } = {}) {
  return AuditLog.find({ 'entity.type': entityType, 'entity.id': entityId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('actor.user', 'firstName lastName email role')
    .lean();
}

module.exports = { record, recordChange, recordFailure, historyFor, diff, contextFrom };
