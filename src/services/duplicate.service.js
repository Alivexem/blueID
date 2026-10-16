'use strict';

const config = require('../config');
const { FISHERMAN_STATUS } = require('../config/constants');
const { nameSimilarity, phoneticNameKey } = require('../utils/similarity');
const {
  normalizePhone,
  normalizeNin,
  normalizeName,
  buildFullName,
  resolveBirthYear,
} = require('../utils/normalize');
const fieldCrypto = require('../utils/fieldCrypto');

/**
 * Duplicate-registration detection (concept note §10).
 *
 * The note is explicit that suspected duplicates are "flagged for
 * administrative review rather than automatically deleted", and the design
 * follows that literally: this service only ever produces a score and a
 * human-readable reason list. It never merges, deletes or rejects. The
 * decision belongs to an administrator, and their resolution is recorded on
 * the record and in the audit trail.
 *
 * Matching runs in two stages:
 *
 *   1. BLOCKING — a cheap indexed query narrows the register down to plausible
 *      candidates (same LGA + phonetic name, or an exact phone/NIN hit
 *      state-wide). Without this, every registration would scan the whole
 *      collection, which is unworkable once the register holds tens of
 *      thousands of fishermen.
 *
 *   2. SCORING — each candidate is scored on weighted identity signals. The
 *      weights below are tuned for this dataset: NIN is decisive on its own;
 *      a phone number is strong but shared handsets are common in fishing
 *      communities, so it cannot be decisive alone; names are fuzzy because
 *      spelling varies by enumerator.
 */

const WEIGHTS = Object.freeze({
  nin: 1.0, // a matching NIN is conclusive on its own
  phone: 0.45,
  name: 0.35,
  birthYear: 0.1,
  community: 0.08,
  nextOfKinPhone: 0.12,
  boatRegistration: 0.2,
  engineSerial: 0.25,
});

/**
 * Normalised view of whatever the caller has — a draft, a payload or a doc.
 *
 * The NIN is compared through its blind index, never in plaintext: the stored
 * value is encrypted, and matching on the keyed index gives exact-equality
 * detection without any code path needing to decrypt a candidate's NIN.
 */
function extractIdentity(input) {
  const fullName = input.fullName || buildFullName(input);
  const normalizedName = input.match?.normalizedName || normalizeName(fullName);

  // A raw payload carries a plaintext NIN; a loaded document carries only the
  // index. Derive the index from whichever is present.
  const rawNin = normalizeNin(input.nin);
  const ninIndex = input.match?.ninIndex || (rawNin ? fieldCrypto.blindIndex(rawNin) : null);

  return {
    id: input._id ? String(input._id) : null,
    fullName,
    normalizedName,
    phoneticName: input.match?.phoneticName || phoneticNameKey(normalizedName),
    phone: input.match?.normalizedPhone || normalizePhone(input.phone),
    altPhone: input.match?.normalizedAltPhone || normalizePhone(input.altPhone),
    ninIndex,
    nextOfKinPhone: normalizePhone(input.nextOfKin?.phone),
    birthYear: input.match?.birthYear ?? resolveBirthYear(input),
    lga: input.lga,
    community: input.community ? String(input.community) : null,
  };
}

/**
 * Stage 1 — candidate retrieval.
 *
 * An exact NIN or phone match is checked state-wide (people move between
 * LGAs); fuzzy name matching is confined to the same LGA, where a genuine
 * double registration is overwhelmingly likely to occur.
 */
function buildCandidateQuery(identity, excludeId) {
  const or = [];

  if (identity.ninIndex) or.push({ 'match.ninIndex': identity.ninIndex });

  if (identity.phone) {
    or.push({ 'match.normalizedPhone': identity.phone });
    or.push({ 'match.normalizedAltPhone': identity.phone });
  }
  if (identity.altPhone) {
    or.push({ 'match.normalizedPhone': identity.altPhone });
  }

  if (identity.phoneticName && identity.lga) {
    or.push({ lga: identity.lga, 'match.phoneticName': identity.phoneticName });
  }
  if (identity.normalizedName && identity.birthYear) {
    or.push({ 'match.normalizedName': identity.normalizedName, 'match.birthYear': identity.birthYear });
  }

  if (!or.length) return null;

  const query = {
    $or: or,
    isDeleted: { $ne: true },
    // A record already under review or merged away is not a new finding.
    status: { $nin: [FISHERMAN_STATUS.DUPLICATE_UNDER_REVIEW] },
    mergedInto: { $exists: false },
  };
  if (excludeId) query._id = { $ne: excludeId };

  return query;
}

/** Stage 2 — score one candidate against the subject. */
function scoreCandidate(subject, candidate) {
  const other = extractIdentity(candidate);
  const reasons = [];
  let score = 0;

  if (subject.ninIndex && other.ninIndex && subject.ninIndex === other.ninIndex) {
    score += WEIGHTS.nin;
    reasons.push('Identical National Identification Number');
  }

  const subjectPhones = [subject.phone, subject.altPhone].filter(Boolean);
  const otherPhones = [other.phone, other.altPhone].filter(Boolean);
  if (subjectPhones.some((p) => otherPhones.includes(p))) {
    score += WEIGHTS.phone;
    reasons.push('Same phone number');
  }

  const similarity = nameSimilarity(subject.normalizedName, other.normalizedName);
  if (similarity >= 0.85) {
    score += WEIGHTS.name * similarity;
    reasons.push(
      similarity === 1
        ? 'Identical name'
        : `Very similar name (${Math.round(similarity * 100)}% match)`
    );
  } else if (similarity >= 0.7) {
    score += WEIGHTS.name * similarity * 0.6;
    reasons.push(`Similar name (${Math.round(similarity * 100)}% match)`);
  }

  if (subject.birthYear && other.birthYear) {
    const gap = Math.abs(subject.birthYear - other.birthYear);
    if (gap === 0) {
      score += WEIGHTS.birthYear;
      reasons.push('Same year of birth');
    } else if (gap <= 2) {
      // Estimated years are routinely a year or two out.
      score += WEIGHTS.birthYear * 0.5;
      reasons.push(`Year of birth within ${gap} year(s)`);
    }
  }

  if (subject.community && other.community && subject.community === other.community) {
    score += WEIGHTS.community;
    reasons.push('Same fishing community');
  }

  if (
    subject.nextOfKinPhone &&
    other.nextOfKinPhone &&
    subject.nextOfKinPhone === other.nextOfKinPhone
  ) {
    score += WEIGHTS.nextOfKinPhone;
    reasons.push('Same next-of-kin phone number');
  }

  return {
    candidateId: candidate._id,
    blueId: candidate.blueId,
    fullName: candidate.fullName,
    lga: candidate.lga,
    communityName: candidate.communityName,
    status: candidate.status,
    photoUrl: candidate.photo?.url,
    score: Math.min(1, Number(score.toFixed(4))),
    nameSimilarity: Number(similarity.toFixed(4)),
    reasons,
  };
}

/**
 * Finds potential duplicates of `input`.
 * Returns matches sorted strongest first; `isDuplicate` marks those at or
 * above the configured threshold.
 */
async function findDuplicates(input, { excludeId, limit = 10, threshold } = {}) {
  // Required late to avoid a circular import (the model does not depend on
  // this service, but the service's callers are loaded from the model's module).
  const Fisherman = require('../modules/fishermen/fisherman.model');

  const subject = extractIdentity(input);
  const query = buildCandidateQuery(subject, excludeId);
  if (!query) return { matches: [], highestScore: 0, hasDuplicate: false };

  const candidates = await Fisherman.find(query)
    .select(
      'blueId fullName lga community communityName status photo match nextOfKin dateOfBirth estimatedYearOfBirth'
    )
    .limit(100) // blocking should keep this small; cap it defensively
    .lean();

  const effectiveThreshold = threshold ?? config.duplicates.threshold;

  const matches = candidates
    .map((candidate) => scoreCandidate(subject, candidate))
    .filter((m) => m.score > 0.3) // below this is noise, not a lead
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((m) => ({ ...m, isDuplicate: m.score >= effectiveThreshold }));

  const highestScore = matches.length ? matches[0].score : 0;

  return {
    matches,
    highestScore,
    hasDuplicate: highestScore >= effectiveThreshold,
    threshold: effectiveThreshold,
  };
}

/**
 * Builds the flag subdocuments to attach to a record when duplicates are
 * found. Returns [] when auto-flagging is disabled, in which case the finding
 * is reported to the caller but the record is left untouched.
 */
function buildFlags(matches, detectedDuring = 'REGISTRATION') {
  if (!config.duplicates.autoFlag) return [];
  return matches
    .filter((m) => m.isDuplicate)
    .map((m) => ({
      candidate: m.candidateId,
      candidateBlueId: m.blueId,
      score: m.score,
      reasons: m.reasons,
      detectedDuring,
      resolution: 'PENDING',
    }));
}

/**
 * Cross-checks an asset identifier that should be unique state-wide.
 * A boat registration or engine serial already on file against a different
 * owner is a strong signal of a re-registration attempt.
 */
async function findAssetConflicts({ boatRegistrationNumber, engineSerialNumber, excludeOwnerId }) {
  const conflicts = [];

  if (boatRegistrationNumber) {
    const Boat = require('../modules/assets/boat.model');
    const existing = await Boat.findOne({
      registrationNumber: boatRegistrationNumber.toUpperCase(),
      isDeleted: { $ne: true },
      ...(excludeOwnerId ? { owner: { $ne: excludeOwnerId } } : {}),
    })
      .select('owner blueId registrationNumber')
      .lean();
    if (existing) {
      conflicts.push({
        type: 'BOAT_REGISTRATION',
        value: existing.registrationNumber,
        existingOwner: existing.owner,
        existingBlueId: existing.blueId,
        weight: WEIGHTS.boatRegistration,
      });
    }
  }

  if (engineSerialNumber) {
    const Engine = require('../modules/assets/engine.model');
    const existing = await Engine.findOne({
      serialNumber: engineSerialNumber.toUpperCase(),
      isDeleted: { $ne: true },
      ...(excludeOwnerId ? { owner: { $ne: excludeOwnerId } } : {}),
    })
      .select('owner blueId serialNumber')
      .lean();
    if (existing) {
      conflicts.push({
        type: 'ENGINE_SERIAL',
        value: existing.serialNumber,
        existingOwner: existing.owner,
        existingBlueId: existing.blueId,
        weight: WEIGHTS.engineSerial,
      });
    }
  }

  return conflicts;
}

module.exports = {
  findDuplicates,
  findAssetConflicts,
  buildFlags,
  scoreCandidate,
  extractIdentity,
  WEIGHTS,
};
