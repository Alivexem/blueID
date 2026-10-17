'use strict';

const auditRepository = require('../modules/audit/audit.repository');
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
          user: req.user.id || req.user._id,
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
async function record({ action, entity, changes, metadata, lga, outcome, failureReason, req, client }) {
  try {
    const { actor, context } = contextFrom(req);
    await auditRepository.record(
      {
        action,
        actor,
        entity,
        changes: changes || [],
        metadata,
        lga,
        succeeded: (outcome || 'SUCCESS') === 'SUCCESS',
        failureReason,
        context,
      },
      // Passing a transaction client makes the entry part of the change it
      // describes, so a rolled-back operation leaves no record of having
      // happened. Callers on the hot path omit it and stay fire-and-forget.
      { client }
    );
  } catch (err) {
    logger.error({ err, action, entity }, 'Failed to write audit log entry');
  }
}

/**
 * Convenience wrapper for a create, update or delete.
 *
 * `entityType` used to come from the Mongoose model name, which no longer
 * exists; it is now passed in. Callers that forget get 'Unknown' rather than
 * a crash, because a mislabelled audit entry is better than a failed write
 * on the path it is auditing.
 */
async function recordChange({ action, doc, before, req, metadata, entityType, client }) {
  const after = typeof doc?.toObject === 'function' ? doc.toObject() : doc;

  return record({
    action,
    entity: {
      type: entityType || 'Unknown',
      id: doc?.id || doc?._id,
      blueId: after?.blueId,
      label: after?.fullName || after?.name || after?.code,
    },
    changes: action === AUDIT_ACTIONS.UPDATE ? diff(before, after) : undefined,
    metadata,
    lga: after?.lga,
    req,
    client,
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
function historyFor(entityType, entityId, { limit = 50 } = {}) {
  return auditRepository.forEntity(entityType, entityId, { limit });
}

/** Searches the trail. Scope is applied in SQL, not after loading. */
function search(query, { scope } = {}) {
  return auditRepository.search(query, { scope });
}

/** Enumerator activity for the dashboard panel. */
function actorActivity(options) {
  return auditRepository.actorActivity(options);
}

module.exports = {
  record,
  recordChange,
  recordFailure,
  historyFor,
  search,
  actorActivity,
  diff,
  contextFrom,
};
