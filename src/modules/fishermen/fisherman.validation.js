'use strict';

const { z } = require('zod');
const {
  FISHERMAN_TYPES,
  FISHING_TYPES,
  FISHERMAN_STATUS,
  GENDERS,
  LGA_CODES,
} = require('../../config/constants');
const { isValidNigerianMobile } = require('../../utils/normalize');

/**
 * Request schemas for the fishermen module.
 *
 * Validation is deliberately forgiving about data that is genuinely hard to
 * collect in a riverine community — an exact date of birth, a NIN, an email —
 * and strict about anything the register's integrity depends on: the LGA, the
 * name, the type of fisherman. Rejecting a real registration because the
 * fisherman does not know his birth date would defeat the purpose of the
 * exercise.
 */

const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Not a valid identifier');

const phone = z
  .string()
  .trim()
  .refine((v) => !v || isValidNigerianMobile(v), 'Enter a valid Nigerian phone number');

const nin = z
  .string()
  .trim()
  .regex(/^\d{11}$/, 'A National Identification Number is 11 digits');

const coordinates = z
  .object({
    type: z.literal('Point').optional(),
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
    accuracy: z.number().min(0).optional(),
    capturedAt: z.coerce.date().optional(),
  })
  .optional();

const currentYear = new Date().getFullYear();

const baseFisherman = {
  firstName: z.string().trim().min(2, 'First name is too short').max(60),
  middleName: z.string().trim().max(60).optional(),
  lastName: z.string().trim().min(2, 'Surname is too short').max(60),
  alias: z.string().trim().max(60).optional(),

  gender: z.enum(Object.values(GENDERS)),

  dateOfBirth: z.coerce
    .date()
    .max(new Date(), 'Date of birth cannot be in the future')
    .optional(),
  estimatedYearOfBirth: z.coerce
    .number()
    .int()
    .min(1900)
    .max(currentYear)
    .optional(),

  phone: phone.optional(),
  altPhone: phone.optional(),
  nin: nin.optional(),

  nextOfKin: z
    .object({
      name: z.string().trim().max(120).optional(),
      phone: phone.optional(),
      relationship: z.string().trim().max(60).optional(),
      address: z.string().trim().max(200).optional(),
    })
    .optional(),

  lga: z.enum(LGA_CODES),
  community: objectId.optional(),
  communityName: z.string().trim().max(120).optional(),
  landingSite: z.string().trim().max(120).optional(),
  address: z.string().trim().max(240).optional(),
  ward: z.string().trim().max(80).optional(),
  location: coordinates,

  fishermanTypes: z
    .array(z.enum(Object.values(FISHERMAN_TYPES)))
    .min(1, 'Select at least one type of fisherman'),
  fishingTypes: z.array(z.enum(Object.values(FISHING_TYPES))).default([]),
  yearsFishing: z.coerce.number().int().min(0).max(100).optional(),
  isFullTime: z.boolean().optional(),
  secondaryOccupation: z.string().trim().max(120).optional(),
  estimatedMonthlyCatchKg: z.coerce.number().min(0).optional(),

  cooperative: z
    .object({
      id: objectId.optional(),
      name: z.string().trim().max(160).optional(),
      membershipNumber: z.string().trim().max(60).optional(),
      joinedAt: z.coerce.date().optional(),
    })
    .optional(),

  notes: z.string().trim().max(1000).optional(),
  tags: z.array(z.string().trim().max(32)).max(10).optional(),
};

/**
 * At least one way of placing the person's age must be present — otherwise
 * duplicate detection loses one of its strongest discriminators and the
 * age-based eligibility rules cannot be evaluated.
 */
const requireSomeBirthInfo = (data, ctx) => {
  if (!data.dateOfBirth && !data.estimatedYearOfBirth) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dateOfBirth'],
      message: 'Provide a date of birth or an estimated year of birth',
    });
  }
};

const createFisherman = z.object(baseFisherman).superRefine(requireSomeBirthInfo);

/** Every field optional on update; identity fields still validated. */
const updateFisherman = z
  .object(baseFisherman)
  .partial()
  .refine((data) => Object.keys(data).length > 0, 'Provide at least one field to update');

const listFishermen = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  search: z.string().trim().max(120).optional(),
  status: z
    .union([z.enum(Object.values(FISHERMAN_STATUS)), z.array(z.enum(Object.values(FISHERMAN_STATUS)))])
    .optional(),
  lga: z.enum(LGA_CODES).optional(),
  community: objectId.optional(),
  gender: z.enum(Object.values(GENDERS)).optional(),
  fishermanType: z.enum(Object.values(FISHERMAN_TYPES)).optional(),
  fishingType: z.enum(Object.values(FISHING_TYPES)).optional(),
  cooperative: objectId.optional(),
  registeredBy: objectId.optional(),
  hasBlueId: z.coerce.boolean().optional(),
  flagged: z.coerce.boolean().optional(),
  registeredFrom: z.coerce.date().optional(),
  registeredTo: z.coerce.date().optional(),
  sort: z
    .enum(['createdAt', '-createdAt', 'fullName', '-fullName', 'updatedAt', '-updatedAt'])
    .optional(),
});

const idParam = z.object({ id: objectId });

/**
 * `includeNin` must be asked for explicitly. It additionally requires the
 * `fisherman:read_sensitive` grant and is written to the audit trail, so the
 * NIN is never returned incidentally by an ordinary profile read.
 */
const getFisherman = z.object({
  includeNin: z.coerce.boolean().optional(),
  includeAssets: z.coerce.boolean().optional(),
});

const qrQuery = z.object({
  format: z.enum(['png', 'svg', 'json']).optional(),
});

const reissueCard = z.object({
  reason: z.string().trim().min(3, 'Give a reason for reissuing the card').max(300),
});

const blueIdParam = z.object({
  blueId: z.string().trim().toUpperCase().min(6).max(40),
});

const verifyFisherman = z.object({
  notes: z.string().trim().max(500).optional(),
});

const changeStatus = z.object({
  status: z.enum(Object.values(FISHERMAN_STATUS)),
  reason: z.string().trim().min(3, 'Give a reason for the status change').max(500),
});

const resolveDuplicate = z.object({
  flagId: objectId,
  resolution: z.enum(['NOT_DUPLICATE', 'MERGED', 'MARKED_DUPLICATE']),
  note: z.string().trim().max(500).optional(),
  survivorId: objectId.optional(),
});

const deleteFisherman = z.object({
  reason: z.string().trim().min(3, 'Give a reason for removing this record').max(500),
});

/** Pre-registration duplicate probe, used by the portal before submitting. */
const duplicateProbe = z
  .object({
    firstName: z.string().trim().min(2),
    lastName: z.string().trim().min(2),
    middleName: z.string().trim().optional(),
    phone: phone.optional(),
    nin: nin.optional(),
    lga: z.enum(LGA_CODES),
    community: objectId.optional(),
    dateOfBirth: z.coerce.date().optional(),
    estimatedYearOfBirth: z.coerce.number().int().min(1900).max(currentYear).optional(),
  })
  .passthrough();

module.exports = {
  objectId,
  createFisherman,
  updateFisherman,
  listFishermen,
  idParam,
  blueIdParam,
  verifyFisherman,
  changeStatus,
  resolveDuplicate,
  deleteFisherman,
  duplicateProbe,
  getFisherman,
  qrQuery,
  reissueCard,
};
