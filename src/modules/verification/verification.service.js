'use strict';

const Fisherman = require('../fishermen/fisherman.model');
const Boat = require('../assets/boat.model');
const Engine = require('../assets/engine.model');
const Allocation = require('../programmes/allocation.model');

const blueIdService = require('../../services/blueId.service');
const qrService = require('../../services/qr.service');
const mediaService = require('../../services/media.service');
const auditService = require('../../services/audit.service');
const cache = require('../../services/cache.service');

const ApiError = require('../../utils/ApiError');
const { FISHERMAN_STATUS, ALLOCATION_STATUS, LGA_BY_CODE, AUDIT_ACTIONS } =
  require('../../config/constants');

/**
 * Blue ID verification (concept note §5).
 *
 * "When the ID number or QR code is entered or scanned, authorized users
 * should be able to verify: identity, photograph, community, registration
 * status, boat information, cooperative, programme eligibility, benefits
 * received."
 *
 * Disclosure is tiered on purpose. A verification check happens at a jetty or
 * a distribution point, often on someone else's device, so the default
 * response proves identity and status and nothing more. Full operational
 * detail requires an authenticated officer. The register holds NINs, phone
 * numbers and next-of-kin details; none of that is ever part of a scan result.
 */

/** Status presented to the person doing the check, with a plain explanation. */
const STATUS_PRESENTATION = {
  [FISHERMAN_STATUS.ACTIVE]: {
    label: 'Active',
    valid: true,
    message: 'This Blue ID is valid and active.',
  },
  [FISHERMAN_STATUS.PENDING_VERIFICATION]: {
    label: 'Pending Verification',
    valid: false,
    message: 'This registration has not yet been verified. No Blue ID has been issued.',
  },
  [FISHERMAN_STATUS.SUSPENDED]: {
    label: 'Suspended',
    valid: false,
    message: 'This Blue ID has been suspended. Refer the holder to the Fisheries Department.',
  },
  [FISHERMAN_STATUS.DECEASED]: {
    label: 'Deceased',
    valid: false,
    message: 'This Blue ID belongs to a person recorded as deceased.',
  },
  [FISHERMAN_STATUS.INACTIVE]: {
    label: 'Inactive',
    valid: false,
    message: 'This Blue ID is no longer active.',
  },
  [FISHERMAN_STATUS.DUPLICATE_UNDER_REVIEW]: {
    label: 'Duplicate Record Under Review',
    valid: false,
    message: 'This record is under administrative review for a possible duplicate registration.',
  },
};

/**
 * Verifies a Blue ID typed in by an official.
 *
 * @param {string} blueId
 * @param {object} options { actor, detailed, req }
 */
async function verifyBlueId(blueId, options = {}) {
  const normalized = String(blueId || '').trim().toUpperCase();

  if (!blueIdService.isWellFormed(normalized)) {
    return {
      found: false,
      valid: false,
      status: 'NOT_RECOGNISED',
      message: 'That is not a valid Blue ID number.',
      blueId: normalized,
    };
  }

  return resolveAndPresent({ blueId: normalized, isDeleted: { $ne: true } }, normalized, options);
}

/**
 * Verifies a scanned card by its opaque token.
 *
 * The token is a random 24-byte value, so this lookup cannot be used to
 * enumerate the register the way a sequential Blue ID could.
 */
async function verifyByToken(token, options = {}) {
  if (!token || typeof token !== 'string' || token.length < 16) {
    return {
      found: false,
      valid: false,
      status: 'NOT_RECOGNISED',
      message: 'That card could not be read.',
    };
  }

  return resolveAndPresent({ verificationToken: token, isDeleted: { $ne: true } }, null, options);
}

/** Shared lookup + disclosure logic for both entry points. */
async function resolveAndPresent(query, normalizedBlueId, options = {}) {
  const { actor, detailed = false, req, scannedVersion } = options;

  const fisherman = await Fisherman.findOne(query)
    .select('+verificationToken')
    .populate('community', 'name lga type')
    .populate('cooperative.id', 'name registrationNumber')
    .lean();

  const normalized = normalizedBlueId || fisherman?.blueId;

  if (!fisherman) {
    // Audit failed lookups: repeated misses can indicate forged cards.
    auditService
      .recordFailure({
        action: AUDIT_ACTIONS.VERIFY,
        entity: { type: 'Fisherman', blueId: normalized },
        reason: 'Blue ID not found',
        req,
      })
      .catch(() => {});

    return {
      found: false,
      valid: false,
      status: 'NOT_FOUND',
      message: 'No record exists for that Blue ID.',
      blueId: normalized,
    };
  }

  /**
   * A scanned card carries its token version. If it is behind the record's
   * current version the card was reissued — the old one must stop working, or
   * a lost card would remain valid forever.
   */
  let signatureValid = null;
  if (scannedVersion != null) {
    signatureValid = Number(scannedVersion) === Number(fisherman.qrVersion || 1);
    if (!signatureValid) {
      return {
        found: true,
        valid: false,
        status: 'CARD_SUPERSEDED',
        message: 'This card has been replaced by a newer one and is no longer valid.',
        blueId: normalized,
      };
    }
  }

  const presentation = STATUS_PRESENTATION[fisherman.status] || {
    label: fisherman.status,
    valid: false,
    message: 'This Blue ID cannot be confirmed.',
  };

  // The token was selected only to resolve the record; it must never be
  // echoed back to a scanner.
  delete fisherman.verificationToken;

  // --- Public tier: identity and status only -------------------------------
  const result = {
    found: true,
    valid: presentation.valid,
    status: fisherman.status,
    statusLabel: presentation.label,
    message: presentation.message,
    signatureValid,
    fisherman: {
      blueId: fisherman.blueId,
      fullName: fisherman.fullName,
      gender: fisherman.gender,
      /**
       * A photograph is released only to a signed-in officer.
       *
       * This endpoint is reachable without a session so a card can be checked
       * at a landing site on an unsigned-in device, and Blue IDs are
       * sequential — so returning the photograph let anyone with a rate-limit
       * budget scrape names and faces out of the register. Identity and
       * status are enough to confirm a card; the face is not.
       */
      photo:
        actor && fisherman.photo?.publicId
          ? mediaService.signedUrl(fisherman.photo.publicId, { expiresInSeconds: 300 })
          : null,
      community: fisherman.community?.name || fisherman.communityName,
      lga: fisherman.lga,
      lgaName: LGA_BY_CODE[fisherman.lga]?.name,
      registeredAt: fisherman.createdAt,
      verifiedAt: fisherman.verification?.verifiedAt,
    },
  };

  // --- Authenticated tier: operational detail ------------------------------
  if (detailed && actor) {
    const [boats, engines, allocations] = await Promise.all([
      Boat.find({ owner: fisherman._id, isDeleted: { $ne: true } })
        .select('registrationNumber name boatType lengthMeters condition')
        .lean(),
      Engine.find({ owner: fisherman._id, isDeleted: { $ne: true } })
        .select('manufacturer model horsepower serialNumber condition')
        .lean(),
      Allocation.find({ fisherman: fisherman._id, isDeleted: { $ne: true } })
        .populate('programme', 'name code type year')
        .select('programmeCode itemDescription quantity status allocatedAt deliveredAt')
        .sort({ allocatedAt: -1 })
        .lean(),
    ]);

    result.fisherman.fishermanTypes = fisherman.fishermanTypes;
    result.fisherman.fishingTypes = fisherman.fishingTypes;
    result.fisherman.yearsFishing = fisherman.yearsFishing;
    result.fisherman.landingSite = fisherman.landingSite;

    result.cooperative = fisherman.cooperative?.id
      ? {
          name: fisherman.cooperative.id.name,
          registrationNumber: fisherman.cooperative.id.registrationNumber,
          membershipNumber: fisherman.cooperative.membershipNumber,
        }
      : null;

    result.assets = {
      boats,
      engines,
      boatCount: boats.length,
      engineCount: engines.length,
    };

    result.benefits = {
      total: allocations.length,
      delivered: allocations.filter((a) => a.status === ALLOCATION_STATUS.DELIVERED).length,
      history: allocations,
    };

    /**
     * Programme eligibility at a glance. The concept note lists this on the
     * verification screen so an officer at a distribution point can see
     * immediately whether this person should be receiving what is being handed
     * out — and whether they have already had it.
     */
    result.eligibility = {
      hasActiveBlueId: fisherman.status === FISHERMAN_STATUS.ACTIVE,
      isCooperativeMember: Boolean(fisherman.cooperative?.id),
      ownsBoat: boats.length > 0,
      receivedProgrammeTypes: [...new Set(allocations.map((a) => a.programmeType).filter(Boolean))],
    };
  }

  auditService
    .record({
      action: AUDIT_ACTIONS.VERIFY,
      entity: { type: 'Fisherman', id: fisherman._id, blueId: normalized, label: fisherman.fullName },
      lga: fisherman.lga,
      metadata: { detailed: Boolean(detailed && actor), viaQr: scannedVersion != null },
      req,
    })
    .catch(() => {});

  return result;
}

/**
 * Verifies a scanned QR payload.
 *
 * The HMAC is checked first, offline and without a database hit: a forged or
 * corrupted code is rejected before it can be used to probe the register.
 */
async function verifyScan(scanned, options = {}) {
  const scan = qrService.verifyScan(scanned);

  if (!scan.token) {
    return {
      found: false,
      valid: false,
      status: 'UNREADABLE',
      message: 'The scanned code could not be read as a Blue ID card.',
    };
  }
  if (!scan.valid) {
    return {
      found: false,
      valid: false,
      status: 'INVALID_CARD',
      message: 'This card failed its authenticity check.',
    };
  }

  return verifyByToken(scan.token, { ...options, scannedVersion: scan.version });
}

/**
 * Lightweight status probe for a future SMS/USSD gateway (concept note §4).
 * Returns one short line suitable for a 160-character message.
 */
async function statusLine(blueId) {
  const key = `verify:line:${String(blueId).toUpperCase()}`;

  return cache.wrap(key, 60, async () => {
    const result = await verifyBlueId(blueId);
    if (!result.found) return { text: `Blue ID ${blueId}: not found.`, valid: false };

    const f = result.fisherman;
    return {
      text: `${f.blueId}: ${f.fullName}, ${f.community || f.lgaName}. Status: ${result.statusLabel}.`,
      valid: result.valid,
    };
  });
}

module.exports = { verifyBlueId, verifyByToken, verifyScan, statusLine, STATUS_PRESENTATION };
