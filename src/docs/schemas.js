'use strict';

const {
  ROLE_VALUES,
  USER_STATUS,
  FISHERMAN_STATUS,
  FISHERMAN_TYPES,
  FISHING_TYPES,
  GENDERS,
  BOAT_TYPES,
  PROPULSION_TYPES,
  EQUIPMENT_TYPES,
  ASSET_CONDITION,
  ACQUISITION_SOURCE,
  PROGRAMME_TYPES,
  PROGRAMME_STATUS,
  ALLOCATION_STATUS,
  COMMUNITY_TYPES,
  REGISTRATION_CHANNEL,
  DEVICE_STATUS,
  SYNC_BATCH_STATUS,
  SYNC_RECORD_RESULT,
  SYNC_ENTITIES,
  AUDIT_ACTIONS,
  LGA_CODES,
  PERMISSIONS,
} = require('../config/constants');

const enumOf = (o) => Object.values(o);

/**
 * OpenAPI component schemas.
 *
 * Enumerations are generated from config/constants.js rather than restated
 * here, so the published contract cannot drift from what the API validates.
 */
const schemas = {
  // ---- Envelopes ---------------------------------------------------------
  SuccessEnvelope: {
    type: 'object',
    description: 'Every successful response uses this shape.',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', enum: [true] },
      message: { type: 'string', description: 'Human-readable note for the operator.' },
      data: { description: 'The payload. Shape depends on the endpoint.' },
      meta: { type: 'object', description: 'Pagination and other envelope metadata.' },
      requestId: { type: 'string', format: 'uuid' },
    },
  },

  ErrorEnvelope: {
    type: 'object',
    description:
      'Every failure uses this shape. Clients MUST branch on `error.code`, never on the message text, which is written for humans and may change.',
    required: ['success', 'error'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: {
            type: 'string',
            example: 'VALIDATION_ERROR',
            description:
              'Stable machine-readable code. Examples: UNAUTHENTICATED, TOKEN_EXPIRED, TOKEN_REVOKED, ACCOUNT_PENDING, ACCOUNT_INACTIVE, MISSING_PERMISSION, PASSWORD_CHANGE_REQUIRED, NOT_FOUND, VALIDATION_ERROR, CONFLICT, DUPLICATE_KEY, STALE_UPDATE, INVALID_STATUS_TRANSITION, DUPLICATE_REVIEW_PENDING, ALREADY_ALLOCATED, PROGRAMME_FULL, BENEFICIARY_NOT_ELIGIBLE, RATE_LIMITED, DATABASE_UNAVAILABLE.',
          },
          message: { type: 'string' },
          details: { description: 'Field-level errors or contextual data.' },
        },
      },
      requestId: {
        type: 'string',
        description: 'Echoes the x-request-id header. Quote it when reporting a problem — it ties the response to the audit trail.',
      },
    },
  },

  Pagination: {
    type: 'object',
    properties: {
      page: { type: 'integer', example: 1 },
      limit: { type: 'integer', example: 25, description: 'Capped at 200.' },
      total: {
        type: 'integer',
        nullable: true,
        description: 'Null when counting would have been too slow; `hasNextPage` is still accurate.',
      },
      totalPages: { type: 'integer', nullable: true },
      hasNextPage: { type: 'boolean' },
      hasPrevPage: { type: 'boolean' },
      countUnavailable: { type: 'boolean', description: 'Present only when the total was skipped.' },
    },
  },

  // ---- Shared value objects ---------------------------------------------
  GeoPoint: {
    type: 'object',
    description: 'GeoJSON Point. Coordinates are [longitude, latitude] — in that order.',
    properties: {
      type: { type: 'string', enum: ['Point'] },
      coordinates: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
        example: [8.3417, 4.9757],
      },
      accuracy: { type: 'number', description: 'Metres, as reported by the device.' },
      capturedAt: { type: 'string', format: 'date-time' },
    },
  },

  Media: {
    type: 'object',
    description:
      'An image stored in Cloudinary with `authenticated` delivery. `url` is a SHORT-LIVED SIGNED URL and expires — re-request it rather than caching it.',
    properties: {
      url: { type: 'string', format: 'uri' },
      publicId: { type: 'string' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      format: { type: 'string' },
      bytes: { type: 'integer' },
      uploadedAt: { type: 'string', format: 'date-time' },
    },
  },

  NextOfKin: {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 120 },
      phone: { type: 'string', description: 'Nigerian mobile number in any common format.' },
      relationship: { type: 'string', maxLength: 60 },
      address: { type: 'string', maxLength: 200 },
    },
  },

  // ---- Fisherman ---------------------------------------------------------
  Fisherman: {
    type: 'object',
    description:
      'A person in the register. `nin` and the internal matching keys are never serialised; `ninMasked` appears only for callers holding `fisherman:read_sensitive`.',
    properties: {
      id: { type: 'string', format: 'objectid' },
      blueId: {
        type: 'string',
        nullable: true,
        example: 'CRS-BLU-BAK-0001',
        description:
          'Permanent identifier, issued ONLY on verification. Absent while the record is pending. Format: <state>-<segment>-<LGA>-<sequence>.',
      },
      tempReference: {
        type: 'string',
        nullable: true,
        example: 'TMP-BAK-07-A1B2C3',
        description: 'Printed on the paper slip given in the field before a Blue ID exists.',
      },
      firstName: { type: 'string' },
      middleName: { type: 'string' },
      lastName: { type: 'string' },
      fullName: { type: 'string', readOnly: true },
      gender: { type: 'string', enum: enumOf(GENDERS) },
      dateOfBirth: { type: 'string', format: 'date', nullable: true },
      estimatedYearOfBirth: {
        type: 'integer',
        nullable: true,
        description: 'Used where an exact date is unknown, which is common in the field.',
      },
      age: { type: 'integer', nullable: true, readOnly: true },
      photo: { $ref: '#/components/schemas/Media' },
      phone: { type: 'string', nullable: true },
      altPhone: { type: 'string', nullable: true },
      ninMasked: {
        type: 'string',
        nullable: true,
        example: '*******8901',
        description: 'Only for `fisherman:read_sensitive` holders. The full value needs `?includeNin=true` and is audited.',
      },
      nextOfKin: { $ref: '#/components/schemas/NextOfKin' },
      lga: { type: 'string', enum: LGA_CODES },
      community: { type: 'string', format: 'objectid', nullable: true },
      communityName: { type: 'string', nullable: true },
      landingSite: { type: 'string', nullable: true },
      ward: { type: 'string', nullable: true },
      address: { type: 'string', nullable: true },
      location: { $ref: '#/components/schemas/GeoPoint' },
      fishermanTypes: {
        type: 'array',
        items: { type: 'string', enum: enumOf(FISHERMAN_TYPES) },
        description: 'A person may hold several at once, e.g. boat owner AND artisanal fisher.',
      },
      fishingTypes: { type: 'array', items: { type: 'string', enum: enumOf(FISHING_TYPES) } },
      yearsFishing: { type: 'integer', nullable: true },
      isFullTime: { type: 'boolean' },
      secondaryOccupation: { type: 'string', nullable: true },
      estimatedMonthlyCatchKg: { type: 'number', nullable: true },
      cooperative: {
        type: 'object',
        nullable: true,
        properties: {
          id: { type: 'string', format: 'objectid' },
          name: { type: 'string' },
          membershipNumber: { type: 'string' },
          joinedAt: { type: 'string', format: 'date-time' },
        },
      },
      status: { type: 'string', enum: enumOf(FISHERMAN_STATUS) },
      statusReason: { type: 'string', nullable: true },
      verification: {
        type: 'object',
        nullable: true,
        properties: {
          verifiedBy: { type: 'string', format: 'objectid' },
          verifiedAt: { type: 'string', format: 'date-time' },
          notes: { type: 'string' },
        },
      },
      duplicateFlags: { type: 'array', items: { $ref: '#/components/schemas/DuplicateFlag' } },
      mergedInto: { type: 'string', format: 'objectid', nullable: true },
      registrationChannel: { type: 'string', enum: enumOf(REGISTRATION_CHANNEL) },
      registeredBy: { type: 'string', format: 'objectid' },
      capturedAt: { type: 'string', format: 'date-time', description: 'When the enumerator captured it, which may be days before it synced.' },
      syncedAt: { type: 'string', format: 'date-time', nullable: true },
      qrVersion: { type: 'integer', description: 'Incremented on every card reissue; an older card stops validating.' },
      isDeleted: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  FishermanCreate: {
    type: 'object',
    required: ['firstName', 'lastName', 'gender', 'lga', 'fishermanTypes'],
    description:
      'Authority fields (blueId, status, verification, duplicateFlags) are STRIPPED if sent — they cannot be assigned by a client. One of `dateOfBirth` or `estimatedYearOfBirth` is required.',
    properties: {
      firstName: { type: 'string', minLength: 2, maxLength: 60 },
      middleName: { type: 'string', maxLength: 60 },
      lastName: { type: 'string', minLength: 2, maxLength: 60 },
      alias: { type: 'string', maxLength: 60 },
      gender: { type: 'string', enum: enumOf(GENDERS) },
      dateOfBirth: { type: 'string', format: 'date' },
      estimatedYearOfBirth: { type: 'integer', minimum: 1900 },
      phone: { type: 'string', example: '08031234567' },
      altPhone: { type: 'string' },
      nin: { type: 'string', pattern: '^\\d{11}$', description: 'Optional. Stored encrypted; never returned in full without the sensitive grant.' },
      nextOfKin: { $ref: '#/components/schemas/NextOfKin' },
      lga: { type: 'string', enum: LGA_CODES },
      community: { type: 'string', format: 'objectid' },
      communityName: { type: 'string' },
      landingSite: { type: 'string' },
      address: { type: 'string' },
      ward: { type: 'string' },
      location: { $ref: '#/components/schemas/GeoPoint' },
      fishermanTypes: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', enum: enumOf(FISHERMAN_TYPES) },
      },
      fishingTypes: { type: 'array', items: { type: 'string', enum: enumOf(FISHING_TYPES) } },
      yearsFishing: { type: 'integer', minimum: 0, maximum: 100 },
      isFullTime: { type: 'boolean' },
      secondaryOccupation: { type: 'string' },
      estimatedMonthlyCatchKg: { type: 'number', minimum: 0 },
      cooperative: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'objectid' },
          membershipNumber: { type: 'string' },
        },
      },
      notes: { type: 'string', maxLength: 1000 },
    },
  },

  DuplicateFlag: {
    type: 'object',
    description: 'A suspected duplicate held for human review. Records are NEVER merged or deleted automatically.',
    properties: {
      id: { type: 'string', format: 'objectid' },
      candidate: { type: 'string', format: 'objectid' },
      candidateBlueId: { type: 'string', nullable: true },
      score: { type: 'number', minimum: 0, maximum: 1, example: 0.86 },
      reasons: {
        type: 'array',
        items: { type: 'string' },
        example: ['Identical National Identification Number', 'Same fishing community'],
      },
      detectedDuring: { type: 'string', enum: ['REGISTRATION', 'SYNC', 'AUDIT_SWEEP'] },
      resolution: { type: 'string', enum: ['PENDING', 'NOT_DUPLICATE', 'MERGED', 'MARKED_DUPLICATE'] },
      resolvedBy: { type: 'string', format: 'objectid', nullable: true },
      resolvedAt: { type: 'string', format: 'date-time', nullable: true },
      resolutionNote: { type: 'string', nullable: true },
    },
  },

  DuplicateMatchResult: {
    type: 'object',
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            candidateId: { type: 'string', format: 'objectid' },
            blueId: { type: 'string', nullable: true },
            fullName: { type: 'string' },
            lga: { type: 'string' },
            score: { type: 'number' },
            nameSimilarity: { type: 'number' },
            reasons: { type: 'array', items: { type: 'string' } },
            isDuplicate: { type: 'boolean', description: 'True when the score meets the configured threshold.' },
          },
        },
      },
      highestScore: { type: 'number' },
      hasDuplicate: { type: 'boolean' },
      threshold: { type: 'number', example: 0.72 },
    },
  },

  // ---- Assets ------------------------------------------------------------
  Boat: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'objectid' },
      owner: { type: 'string', format: 'objectid' },
      blueId: { type: 'string', nullable: true, description: 'Denormalised from the owner.' },
      lga: { type: 'string', enum: LGA_CODES },
      registrationNumber: { type: 'string', nullable: true, description: 'Unique state-wide when present.' },
      name: { type: 'string', nullable: true },
      boatType: { type: 'string', enum: enumOf(BOAT_TYPES) },
      canoeType: { type: 'string', nullable: true, description: 'Local classification, which varies by community.' },
      material: { type: 'string', enum: ['WOOD', 'FIBREGLASS', 'ALUMINIUM', 'STEEL', 'OTHER'] },
      lengthMeters: { type: 'number' },
      widthMeters: { type: 'number' },
      crewCapacity: { type: 'integer' },
      cargoCapacityKg: { type: 'number' },
      propulsion: { type: 'string', enum: enumOf(PROPULSION_TYPES) },
      condition: { type: 'string', enum: enumOf(ASSET_CONDITION) },
      yearAcquired: { type: 'integer' },
      acquisitionSource: { type: 'string', enum: enumOf(ACQUISITION_SOURCE) },
      allocation: { type: 'string', format: 'objectid', nullable: true, description: 'Set when the boat arrived through a government programme.' },
      photo: { $ref: '#/components/schemas/Media' },
      estimatedValue: { type: 'number' },
      isActive: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },

  Engine: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'objectid' },
      owner: { type: 'string', format: 'objectid' },
      blueId: { type: 'string', nullable: true },
      lga: { type: 'string', enum: LGA_CODES },
      boat: { type: 'string', format: 'objectid', nullable: true, description: 'Optional: an engine may be owned without being fitted.' },
      manufacturer: { type: 'string' },
      model: { type: 'string' },
      horsepower: { type: 'number' },
      serialNumber: {
        type: 'string',
        nullable: true,
        description: 'Unique state-wide. This is what lets the ministry answer "was this engine already issued to someone else?".',
      },
      engineType: { type: 'string', enum: ['OUTBOARD', 'INBOARD'] },
      fuelType: { type: 'string', enum: ['PETROL', 'DIESEL', 'ELECTRIC', 'OTHER'] },
      condition: { type: 'string', enum: enumOf(ASSET_CONDITION) },
      yearAcquired: { type: 'integer' },
      acquisitionSource: { type: 'string', enum: enumOf(ACQUISITION_SOURCE) },
      photo: { $ref: '#/components/schemas/Media' },
      isActive: { type: 'boolean' },
    },
  },

  Equipment: {
    type: 'object',
    description: 'Nets, cold boxes, ice boxes, safety kit, GPS units and smoking kilns. Counted rather than individually identified.',
    properties: {
      id: { type: 'string', format: 'objectid' },
      owner: { type: 'string', format: 'objectid' },
      blueId: { type: 'string', nullable: true },
      lga: { type: 'string', enum: LGA_CODES },
      type: { type: 'string', enum: enumOf(EQUIPMENT_TYPES) },
      description: { type: 'string', example: 'gill net, 3 inch mesh' },
      quantity: { type: 'number' },
      unit: { type: 'string' },
      specification: {
        type: 'object',
        properties: {
          meshSizeInches: { type: 'number' },
          lengthMeters: { type: 'number' },
          capacityLitres: { type: 'number' },
          brand: { type: 'string' },
        },
      },
      condition: { type: 'string', enum: enumOf(ASSET_CONDITION) },
      acquisitionSource: { type: 'string', enum: enumOf(ACQUISITION_SOURCE) },
      photo: { $ref: '#/components/schemas/Media' },
      isActive: { type: 'boolean' },
    },
  },

  // ---- Reference data ----------------------------------------------------
  Community: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'objectid' },
      name: { type: 'string' },
      code: { type: 'string', nullable: true },
      lga: { type: 'string', enum: LGA_CODES },
      ward: { type: 'string', nullable: true },
      type: { type: 'string', enum: enumOf(COMMUNITY_TYPES) },
      location: { $ref: '#/components/schemas/GeoPoint' },
      landingSites: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'objectid' },
            name: { type: 'string' },
            location: { $ref: '#/components/schemas/GeoPoint' },
            hasJetty: { type: 'boolean' },
            hasColdStorage: { type: 'boolean' },
            condition: { type: 'string', enum: ['GOOD', 'FAIR', 'POOR', 'NONE'] },
          },
        },
      },
      facilities: {
        type: 'object',
        description: 'Drives the "which communities lack cold storage / landing sites / boat repair" reports.',
        properties: {
          landingSite: { type: 'boolean' },
          coldStorage: { type: 'boolean' },
          iceplant: { type: 'boolean' },
          processingFacility: { type: 'boolean' },
          boatRepair: { type: 'boolean' },
          jetty: { type: 'boolean' },
          market: { type: 'boolean' },
        },
      },
      accessibility: {
        type: 'object',
        properties: {
          roadAccess: { type: 'boolean' },
          boatOnlyAccess: { type: 'boolean' },
          mobileNetwork: { type: 'string', enum: ['NONE', 'POOR', 'FAIR', 'GOOD'] },
          electricity: { type: 'boolean' },
        },
      },
      estimatedPopulation: { type: 'integer' },
      estimatedFishermen: { type: 'integer' },
      stats: {
        type: 'object',
        properties: {
          registeredFishermen: { type: 'integer' },
          registeredBoats: { type: 'integer' },
          lastRecalculatedAt: { type: 'string', format: 'date-time' },
        },
      },
      developmentNeeds: { type: 'array', items: { type: 'string' } },
      isActive: { type: 'boolean' },
    },
  },

  Cooperative: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'objectid' },
      name: { type: 'string' },
      registrationNumber: { type: 'string', nullable: true },
      lga: { type: 'string', enum: LGA_CODES },
      community: { type: 'string', format: 'objectid', nullable: true },
      communityName: { type: 'string', nullable: true },
      address: { type: 'string' },
      registeredAt: { type: 'string', format: 'date' },
      officers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            role: { type: 'string', enum: ['CHAIRMAN', 'SECRETARY', 'TREASURER', 'MEMBER', 'OTHER'] },
            phone: { type: 'string' },
            fisherman: { type: 'string', format: 'objectid', nullable: true },
          },
        },
      },
      contactPhone: { type: 'string' },
      contactEmail: { type: 'string', format: 'email' },
      memberCount: { type: 'integer', readOnly: true },
      isActive: { type: 'boolean' },
    },
  },

  // ---- Programmes --------------------------------------------------------
  Programme: {
    type: 'object',
    description: 'A government intervention. Eligibility is machine-readable so beneficiary lists can be pre-screened rather than compiled by hand.',
    properties: {
      id: { type: 'string', format: 'objectid' },
      name: { type: 'string' },
      code: { type: 'string', example: 'OED-2026' },
      type: { type: 'string', enum: enumOf(PROGRAMME_TYPES) },
      description: { type: 'string' },
      year: { type: 'integer' },
      implementingAgency: { type: 'string' },
      fundingSource: { type: 'string' },
      status: { type: 'string', enum: enumOf(PROGRAMME_STATUS) },
      startDate: { type: 'string', format: 'date' },
      endDate: { type: 'string', format: 'date' },
      itemDescription: { type: 'string', example: '15HP outboard engine' },
      unitValue: { type: 'number', description: 'Value of one unit, for budgeting and reporting. NOT a payment instruction — this API moves no money.' },
      currency: { type: 'string', default: 'NGN' },
      targetBeneficiaries: { type: 'integer' },
      allocatedCount: { type: 'integer', readOnly: true },
      deliveredCount: { type: 'integer', readOnly: true },
      remainingSlots: { type: 'integer', nullable: true, readOnly: true },
      totalBudget: { type: 'number' },
      isOpen: { type: 'boolean', readOnly: true },
      eligibility: { $ref: '#/components/schemas/Eligibility' },
    },
  },

  Eligibility: {
    type: 'object',
    description: 'Criteria evaluated server-side. Encoding them as data is what allows "who qualifies?" to be answered as a query.',
    properties: {
      lgas: { type: 'array', items: { type: 'string', enum: LGA_CODES } },
      communities: { type: 'array', items: { type: 'string', format: 'objectid' } },
      fishermanTypes: { type: 'array', items: { type: 'string', enum: enumOf(FISHERMAN_TYPES) } },
      fishingTypes: { type: 'array', items: { type: 'string', enum: enumOf(FISHING_TYPES) } },
      genders: { type: 'array', items: { type: 'string', enum: enumOf(GENDERS) } },
      minYearsFishing: { type: 'integer' },
      minAge: { type: 'integer' },
      maxAge: { type: 'integer' },
      requiresCooperativeMembership: { type: 'boolean' },
      requiresBoatOwnership: { type: 'boolean' },
      requiresVerifiedBlueId: { type: 'boolean', default: true },
      excludeIfReceivedWithinMonths: {
        type: 'integer',
        description: 'Blocks a person who received the same PROGRAMME TYPE within this window. The main defence against collecting one intervention twice.',
      },
    },
  },

  Allocation: {
    type: 'object',
    description:
      'A benefit issued to one Blue ID holder under one programme. One ACTIVE allocation per person per programme is enforced by a database index.',
    properties: {
      id: { type: 'string', format: 'objectid' },
      programme: { type: 'string', format: 'objectid' },
      programmeCode: { type: 'string' },
      programmeType: { type: 'string', enum: enumOf(PROGRAMME_TYPES) },
      fisherman: { type: 'string', format: 'objectid' },
      blueId: { type: 'string' },
      fishermanName: { type: 'string' },
      lga: { type: 'string', enum: LGA_CODES },
      itemDescription: { type: 'string' },
      quantity: { type: 'number' },
      value: { type: 'number', description: 'Recorded value of the item issued. Informational — no funds are transferred by this API.' },
      currency: { type: 'string' },
      status: { type: 'string', enum: enumOf(ALLOCATION_STATUS) },
      isActiveAllocation: { type: 'boolean', readOnly: true, description: 'Derived from status; the uniqueness index filters on it.' },
      allocatedBy: { type: 'string', format: 'objectid' },
      allocatedAt: { type: 'string', format: 'date-time' },
      approvedBy: { type: 'string', format: 'objectid', nullable: true },
      deliveredAt: { type: 'string', format: 'date-time', nullable: true },
      acknowledgement: {
        type: 'object',
        nullable: true,
        description: 'Proof of collection captured at handover.',
        properties: {
          url: { type: 'string' },
          signedAt: { type: 'string', format: 'date-time' },
          receivedByName: { type: 'string' },
          receivedByPhone: { type: 'string' },
        },
      },
      rejectionReason: { type: 'string', nullable: true },
      revokedReason: { type: 'string', nullable: true },
    },
  },

  // ---- Users and devices -------------------------------------------------
  User: {
    type: 'object',
    description:
      'A portal/field-app OPERATOR — not a fisherman. Fishermen have no accounts. Credentials live in Firebase; this record carries role and geographic scope.',
    properties: {
      id: { type: 'string', format: 'objectid' },
      authUid: { type: 'string', nullable: true, description: 'Firebase subject. Null until the invited person first signs in.' },
      email: { type: 'string', format: 'email' },
      phone: { type: 'string' },
      firstName: { type: 'string' },
      lastName: { type: 'string' },
      fullName: { type: 'string', readOnly: true },
      role: { type: 'string', enum: ROLE_VALUES },
      status: { type: 'string', enum: enumOf(USER_STATUS) },
      scope: {
        type: 'object',
        description: 'Which LGAs and communities this operator may act in. Empty LGAs on a state-wide role means all.',
        properties: {
          lgas: { type: 'array', items: { type: 'string', enum: LGA_CODES } },
          communities: { type: 'array', items: { type: 'string', format: 'objectid' } },
        },
      },
      cooperative: { type: 'string', format: 'objectid', nullable: true },
      staffId: { type: 'string' },
      designation: { type: 'string' },
      lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  Me: {
    allOf: [
      { $ref: '#/components/schemas/User' },
      {
        type: 'object',
        properties: {
          permissions: {
            type: 'object',
            description: 'Resolved capabilities, so the portal can render menus without a second call.',
            properties: {
              isStateWide: { type: 'boolean' },
              canVerify: { type: 'boolean' },
              canManageUsers: { type: 'boolean' },
              canManageProgrammes: { type: 'boolean' },
              canExport: { type: 'boolean' },
              canRegisterDevices: { type: 'boolean' },
            },
          },
          lgas: {
            type: 'array',
            items: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' } } },
          },
        },
      },
    ],
  },

  Device: {
    type: 'object',
    description: 'An enrolled field device. Every offline record carries the device it was captured on.',
    properties: {
      id: { type: 'string', format: 'objectid' },
      deviceCode: { type: 'string', example: 'BAK-07' },
      label: { type: 'string' },
      platform: { type: 'string', enum: ['ANDROID', 'IOS', 'WEB', 'OTHER'] },
      model: { type: 'string' },
      osVersion: { type: 'string' },
      appVersion: { type: 'string' },
      assignedTo: { type: 'string', format: 'objectid' },
      lga: { type: 'string', enum: LGA_CODES },
      status: { type: 'string', enum: enumOf(DEVICE_STATUS) },
      lastSeenAt: { type: 'string', format: 'date-time' },
      lastSyncAt: { type: 'string', format: 'date-time' },
      stats: {
        type: 'object',
        properties: {
          recordsPushed: { type: 'integer' },
          recordsPulled: { type: 'integer' },
          batchesProcessed: { type: 'integer' },
        },
      },
    },
  },

  // ---- Sync --------------------------------------------------------------
  SyncRecord: {
    type: 'object',
    required: ['clientRecordId', 'entity', 'data'],
    properties: {
      clientRecordId: {
        type: 'string',
        format: 'uuid',
        description:
          'Generated ON THE DEVICE when the enumerator saves, before the server has ever seen the record. This is the idempotency key: a replayed batch updates the same row instead of creating a second person.',
      },
      entity: { type: 'string', enum: enumOf(SYNC_ENTITIES) },
      operation: { type: 'string', enum: ['CREATE', 'UPDATE', 'DELETE'], default: 'CREATE' },
      data: {
        type: 'object',
        description:
          'The record payload. Validated per entity at apply time; authority fields (blueId, status, verification) are stripped. Assets may reference their owner by `ownerClientRecordId` when the server id is not yet known.',
      },
      capturedAt: { type: 'string', format: 'date-time' },
      clientRevision: { type: 'integer', description: 'Incremented by the device on each local edit; used to detect conflicts.' },
      baseUpdatedAt: { type: 'string', format: 'date-time', description: 'The server `updatedAt` the device last saw.' },
    },
  },

  SyncPushRequest: {
    type: 'object',
    required: ['clientBatchId', 'records'],
    properties: {
      clientBatchId: {
        type: 'string',
        format: 'uuid',
        description: 'Identifies the push. Re-sending the same id returns the ORIGINAL outcome rather than reprocessing.',
      },
      deviceCode: { type: 'string', description: 'May also be sent as the x-device-id header.' },
      deviceSecret: { type: 'string', description: 'May also be sent as the x-device-secret header. Required.' },
      appVersion: { type: 'string' },
      networkType: { type: 'string' },
      capturedFrom: { type: 'string', format: 'date-time' },
      capturedTo: { type: 'string', format: 'date-time' },
      records: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/SyncRecord' } },
    },
  },

  SyncPushResponse: {
    type: 'object',
    properties: {
      batchId: { type: 'string', format: 'objectid' },
      clientBatchId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: enumOf(SYNC_BATCH_STATUS) },
      replayed: { type: 'boolean', description: 'True when this batch was already processed and the stored result is being returned.' },
      counts: {
        type: 'object',
        properties: {
          submitted: { type: 'integer' },
          created: { type: 'integer' },
          updated: { type: 'integer' },
          duplicatesIgnored: { type: 'integer' },
          flaggedDuplicates: { type: 'integer' },
          conflicts: { type: 'integer' },
          rejected: { type: 'integer' },
        },
      },
      results: {
        type: 'array',
        description: 'Per-record outcome. The device uses this to mark records synced, show a correction, or retry.',
        items: {
          type: 'object',
          properties: {
            clientRecordId: { type: 'string', format: 'uuid' },
            entity: { type: 'string', enum: enumOf(SYNC_ENTITIES) },
            result: { type: 'string', enum: enumOf(SYNC_RECORD_RESULT) },
            serverId: { type: 'string', format: 'objectid', nullable: true },
            blueId: { type: 'string', nullable: true },
            tempReference: { type: 'string', nullable: true },
            message: { type: 'string' },
            validationErrors: {
              type: 'array',
              items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } },
            },
            duplicateOf: { type: 'string', format: 'objectid', nullable: true },
            duplicateScore: { type: 'number', nullable: true },
          },
        },
      },
      serverTime: { type: 'string', format: 'date-time' },
    },
  },

  SyncPullResponse: {
    type: 'object',
    properties: {
      changes: {
        type: 'object',
        description: 'Records changed since the supplied cursors, keyed by entity.',
        additionalProperties: { type: 'array', items: { type: 'object' } },
      },
      deletions: {
        type: 'object',
        description: 'Tombstones, so a device stops showing a withdrawn registration.',
        additionalProperties: { type: 'array', items: { type: 'object' } },
      },
      cursors: {
        type: 'object',
        description:
          'PER-ENTITY cursors. Send these back on the next pull. A single shared cursor would skip records, because entities drain at different rates.',
        additionalProperties: { type: 'string' },
      },
      hasMore: { type: 'object', additionalProperties: { type: 'boolean' } },
      moreAvailable: { type: 'boolean' },
      serverTime: { type: 'string', format: 'date-time' },
    },
  },

  // ---- Verification ------------------------------------------------------
  VerificationResult: {
    type: 'object',
    description:
      'Disclosure is tiered. Without a session: identity and status only. A signed-in officer may request `detailed=true` for assets, cooperative and benefit history.',
    properties: {
      found: { type: 'boolean' },
      valid: { type: 'boolean' },
      status: { type: 'string', example: 'ACTIVE' },
      statusLabel: { type: 'string', example: 'Active' },
      message: { type: 'string', example: 'This Blue ID is valid and active.' },
      signatureValid: { type: 'boolean', nullable: true },
      fisherman: {
        type: 'object',
        properties: {
          blueId: { type: 'string' },
          fullName: { type: 'string' },
          gender: { type: 'string' },
          photo: { type: 'string', nullable: true, description: 'Signed URL. Released only to a signed-in officer.' },
          community: { type: 'string' },
          lga: { type: 'string' },
          lgaName: { type: 'string' },
          registeredAt: { type: 'string', format: 'date-time' },
          verifiedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      cooperative: { type: 'object', nullable: true },
      assets: { type: 'object', nullable: true },
      benefits: { type: 'object', nullable: true },
      eligibility: { type: 'object', nullable: true },
    },
  },

  // ---- Audit -------------------------------------------------------------
  AuditEntry: {
    type: 'object',
    description: 'Append-only. Updates and deletes are rejected by the data layer.',
    properties: {
      id: { type: 'string', format: 'objectid' },
      action: { type: 'string', enum: enumOf(AUDIT_ACTIONS) },
      actor: {
        type: 'object',
        properties: {
          user: { type: 'string', format: 'objectid', nullable: true },
          name: { type: 'string' },
          email: { type: 'string' },
          role: { type: 'string' },
          service: { type: 'string', nullable: true },
        },
      },
      entity: {
        type: 'object',
        properties: {
          type: { type: 'string', example: 'Fisherman' },
          id: { type: 'string', format: 'objectid' },
          blueId: { type: 'string', nullable: true },
          label: { type: 'string' },
        },
      },
      changes: {
        type: 'array',
        description: 'Field-level diff. Whole snapshots are deliberately not stored — they would multiply copies of personal data.',
        items: { type: 'object', properties: { field: { type: 'string' }, from: {}, to: {} } },
      },
      metadata: { type: 'object' },
      lga: { type: 'string', nullable: true },
      outcome: { type: 'string', enum: ['SUCCESS', 'FAILURE'] },
      failureReason: { type: 'string', nullable: true },
      context: {
        type: 'object',
        properties: {
          requestId: { type: 'string' },
          ipAddress: { type: 'string' },
          userAgent: { type: 'string' },
          deviceCode: { type: 'string' },
          channel: { type: 'string', enum: ['WEB', 'MOBILE', 'SYNC', 'SYSTEM', 'API'] },
        },
      },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },

  PermissionList: {
    type: 'string',
    enum: Object.values(PERMISSIONS),
    description: 'Capability names used by the authorization layer.',
  },
};

module.exports = schemas;
