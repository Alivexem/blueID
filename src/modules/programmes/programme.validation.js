'use strict';

const { z } = require('zod');
const {
  PROGRAMME_TYPES,
  PROGRAMME_STATUS,
  ALLOCATION_STATUS,
  FISHERMAN_TYPES,
  FISHING_TYPES,
  LGA_CODES,
} = require('../../config/constants');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid identifier');

const eligibility = z
  .object({
    lgas: z.array(z.enum(LGA_CODES)).optional(),
    communities: z.array(objectId).optional(),
    fishermanTypes: z.array(z.enum(Object.values(FISHERMAN_TYPES))).optional(),
    fishingTypes: z.array(z.enum(Object.values(FISHING_TYPES))).optional(),
    genders: z.array(z.enum(['MALE', 'FEMALE', 'OTHER'])).optional(),
    minYearsFishing: z.coerce.number().int().min(0).max(100).optional(),
    minAge: z.coerce.number().int().min(0).max(120).optional(),
    maxAge: z.coerce.number().int().min(0).max(120).optional(),
    requiresCooperativeMembership: z.boolean().optional(),
    requiresBoatOwnership: z.boolean().optional(),
    requiresVerifiedBlueId: z.boolean().optional(),
    excludeIfReceivedWithinMonths: z.coerce.number().int().min(0).max(240).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .refine(
    (e) => e.minAge == null || e.maxAge == null || e.minAge <= e.maxAge,
    { message: 'minAge cannot be greater than maxAge', path: ['minAge'] }
  );

/**
 * Kept as a plain object so both the create schema (which adds a cross-field
 * refinement) and the update schema (which needs `.partial()`) can derive from
 * it — a refined schema is a ZodEffects and no longer exposes `.partial()`.
 */
const programmeFields = z
  .object({
    name: z.string().trim().min(3).max(160),
    code: z
      .string()
      .trim()
      .min(2)
      .max(24)
      .regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers and dashes only'),
    type: z.enum(Object.values(PROGRAMME_TYPES)),
    description: z.string().trim().max(2000).optional(),
    year: z.coerce.number().int().min(2000).max(2100),
    implementingAgency: z.string().trim().max(160).optional(),
    fundingSource: z.string().trim().max(160).optional(),
    status: z.enum(Object.values(PROGRAMME_STATUS)).optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    itemDescription: z.string().trim().max(300).optional(),
    unitValue: z.coerce.number().min(0).optional(),
    currency: z.string().trim().max(8).optional(),
    targetBeneficiaries: z.coerce.number().int().min(0).optional(),
    totalBudget: z.coerce.number().min(0).optional(),
    eligibility: eligibility.optional(),
  });

const datesAreOrdered = (p) => !p.startDate || !p.endDate || p.startDate <= p.endDate;
const dateOrderMessage = {
  message: 'The end date must fall after the start date',
  path: ['endDate'],
};

const createProgramme = programmeFields.refine(datesAreOrdered, dateOrderMessage);
const updateProgramme = programmeFields.partial().refine(datesAreOrdered, dateOrderMessage);

const listProgrammes = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(Object.values(PROGRAMME_STATUS)).optional(),
  type: z.enum(Object.values(PROGRAMME_TYPES)).optional(),
  year: z.coerce.number().int().optional(),
  lga: z.enum(LGA_CODES).optional(),
  search: z.string().trim().max(120).optional(),
});

const changeProgrammeStatus = z.object({
  status: z.enum(Object.values(PROGRAMME_STATUS)),
  note: z.string().trim().max(500).optional(),
});

/**
 * `overrideEligibility` exists because field reality sometimes outruns the
 * rules — a genuine beneficiary may fail an automated check. It is allowed,
 * but it demands a written reason and is recorded in the audit trail as an
 * override, so the decision is attributable.
 */
const createAllocation = z
  .object({
    fisherman: objectId,
    itemDescription: z.string().trim().max(300).optional(),
    quantity: z.coerce.number().min(0).max(100000).optional(),
    value: z.coerce.number().min(0).optional(),
    status: z.enum(Object.values(ALLOCATION_STATUS)).optional(),
    notes: z.string().trim().max(500).optional(),
    clientRecordId: z.string().uuid().optional(),
    overrideEligibility: z.boolean().optional(),
    overrideReason: z.string().trim().max(500).optional(),
  })
  .refine(
    (a) => !a.overrideEligibility || (a.overrideReason && a.overrideReason.length >= 10),
    {
      message: 'Overriding the eligibility check requires a written reason',
      path: ['overrideReason'],
    }
  );

const markDelivered = z.object({
  deliveredAt: z.coerce.date().optional(),
  receivedByName: z.string().trim().max(120).optional(),
  receivedByPhone: z.string().trim().max(20).optional(),
  notes: z.string().trim().max(500).optional(),
});

const changeAllocationStatus = z
  .object({
    status: z.enum(Object.values(ALLOCATION_STATUS)),
    reason: z.string().trim().max(500).optional(),
  })
  .refine(
    (a) => !['REJECTED', 'REVOKED'].includes(a.status) || (a.reason && a.reason.length >= 3),
    { message: 'Give a reason when rejecting or revoking an allocation', path: ['reason'] }
  );

const listAllocations = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  programme: objectId.optional(),
  fisherman: objectId.optional(),
  blueId: z.string().trim().max(40).optional(),
  status: z.enum(Object.values(ALLOCATION_STATUS)).optional(),
  programmeType: z.enum(Object.values(PROGRAMME_TYPES)).optional(),
  lga: z.enum(LGA_CODES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const listEligible = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  lga: z.enum(LGA_CODES).optional(),
  community: objectId.optional(),
  search: z.string().trim().max(120).optional(),
});

const idParam = z.object({ id: objectId });
const allocationParam = z.object({ allocationId: objectId });
const eligibilityParams = z.object({ id: objectId, fishermanId: objectId });
const fishermanParam = z.object({ fishermanId: objectId });
const removeProgramme = z.object({ reason: z.string().trim().min(3).max(300) });

module.exports = {
  createProgramme,
  updateProgramme,
  listProgrammes,
  changeProgrammeStatus,
  createAllocation,
  markDelivered,
  changeAllocationStatus,
  listAllocations,
  listEligible,
  idParam,
  allocationParam,
  eligibilityParams,
  fishermanParam,
  removeProgramme,
};
