'use strict';

const { z } = require('zod');
const {
  BOAT_TYPES,
  PROPULSION_TYPES,
  EQUIPMENT_TYPES,
  ASSET_CONDITION,
  ACQUISITION_SOURCE,
  LGA_CODES,
} = require('../../config/constants');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid identifier');
const currentYear = new Date().getFullYear();

const shared = {
  owner: objectId,
  community: objectId.optional(),
  condition: z.enum(Object.values(ASSET_CONDITION)).optional(),
  yearAcquired: z.coerce.number().int().min(1900).max(currentYear).optional(),
  acquisitionSource: z.enum(Object.values(ACQUISITION_SOURCE)).optional(),
  allocation: objectId.optional(),
  estimatedValue: z.coerce.number().min(0).optional(),
  notes: z.string().trim().max(500).optional(),
};

const createBoat = z.object({
  ...shared,
  registrationNumber: z.string().trim().max(40).optional(),
  name: z.string().trim().max(80).optional(),
  boatType: z.enum(Object.values(BOAT_TYPES)),
  canoeType: z.string().trim().max(60).optional(),
  material: z.enum(['WOOD', 'FIBREGLASS', 'ALUMINIUM', 'STEEL', 'OTHER']).optional(),
  lengthMeters: z.coerce.number().min(0).max(100).optional(),
  widthMeters: z.coerce.number().min(0).max(30).optional(),
  crewCapacity: z.coerce.number().int().min(0).max(200).optional(),
  cargoCapacityKg: z.coerce.number().min(0).optional(),
  propulsion: z.enum(Object.values(PROPULSION_TYPES)).optional(),
});

const createEngine = z.object({
  ...shared,
  boat: objectId.optional(),
  manufacturer: z.string().trim().min(2, 'Engine manufacturer is required').max(60),
  model: z.string().trim().max(60).optional(),
  horsepower: z.coerce.number().min(0).max(1000).optional(),
  serialNumber: z.string().trim().max(60).optional(),
  engineType: z.enum(['OUTBOARD', 'INBOARD']).optional(),
  fuelType: z.enum(['PETROL', 'DIESEL', 'ELECTRIC', 'OTHER']).optional(),
  lastServicedAt: z.coerce.date().optional(),
});

const createEquipment = z.object({
  ...shared,
  type: z.enum(Object.values(EQUIPMENT_TYPES)),
  description: z.string().trim().max(200).optional(),
  quantity: z.coerce.number().min(0).max(100000).optional(),
  unit: z.string().trim().max(20).optional(),
  specification: z
    .object({
      meshSizeInches: z.coerce.number().min(0).optional(),
      lengthMeters: z.coerce.number().min(0).optional(),
      capacityLitres: z.coerce.number().min(0).optional(),
      brand: z.string().trim().max(60).optional(),
    })
    .optional(),
});

const updateBoat = createBoat.partial().omit({ owner: true });
const updateEngine = createEngine.partial().omit({ owner: true });
const updateEquipment = createEquipment.partial().omit({ owner: true });

const listAssets = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  owner: objectId.optional(),
  blueId: z.string().trim().max(40).optional(),
  lga: z.enum(LGA_CODES).optional(),
  community: objectId.optional(),
  isActive: z.coerce.boolean().optional(),
  boatType: z.enum(Object.values(BOAT_TYPES)).optional(),
  manufacturer: z.string().trim().max(60).optional(),
  type: z.enum(Object.values(EQUIPMENT_TYPES)).optional(),
  acquisitionSource: z.enum(Object.values(ACQUISITION_SOURCE)).optional(),
});

const transferAsset = z.object({
  newOwnerId: objectId,
  reason: z.string().trim().min(3, 'Give a reason for the transfer').max(300),
});

const removeAsset = z.object({
  reason: z.string().trim().min(3).max(300),
});

const idParam = z.object({ id: objectId });
const ownerParam = z.object({ ownerId: objectId });

module.exports = {
  createBoat,
  createEngine,
  createEquipment,
  updateBoat,
  updateEngine,
  updateEquipment,
  listAssets,
  transferAsset,
  removeAsset,
  idParam,
  ownerParam,
};
