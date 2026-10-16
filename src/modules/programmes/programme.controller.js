'use strict';

const service = require('./programme.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created, paginated, noContent } = require('../../utils/response');

const create = asyncHandler(async (req, res) => {
  const programme = await service.create(req.body, req.user, { req });
  return created(res, programme, { message: 'Programme created' });
});

const list = asyncHandler(async (req, res) => {
  const { items, pagination } = await service.list(req.query);
  return paginated(res, items, pagination);
});

const getOne = asyncHandler(async (req, res) => {
  const programme = await service.getById(req.params.id);
  return ok(res, programme);
});

const update = asyncHandler(async (req, res) => {
  const programme = await service.update(req.params.id, req.body, req.user, { req });
  return ok(res, programme, { message: 'Programme updated' });
});

const changeStatus = asyncHandler(async (req, res) => {
  const programme = await service.changeStatus(req.params.id, req.body, req.user, { req });
  return ok(res, programme, { message: `Programme ${programme.status.toLowerCase()}` });
});

const remove = asyncHandler(async (req, res) => {
  await service.softDelete(req.params.id, req.user, { req, reason: req.body.reason });
  return noContent(res);
});

/** Pre-screened beneficiary list — the core planning view for §6. */
const listEligible = asyncHandler(async (req, res) => {
  const { programme, items, pagination, excludedCount } = await service.listEligible(
    req.params.id,
    req.query,
    req.user
  );
  return paginated(res, items, pagination, {
    programme: { id: programme._id, name: programme.name, code: programme.code },
    excludedCount,
  });
});

const checkEligibility = asyncHandler(async (req, res) => {
  const result = await service.checkEligibility(req.params.id, req.params.fishermanId);
  return ok(res, result);
});

const allocate = asyncHandler(async (req, res) => {
  const allocation = await service.allocate(req.params.id, req.body, req.user, { req });
  return created(res, allocation, {
    message: `Allocation recorded against ${allocation.blueId}`,
  });
});

const listAllocations = asyncHandler(async (req, res) => {
  const { items, pagination } = await service.listAllocations(req.query, req.user);
  return paginated(res, items, pagination);
});

const markDelivered = asyncHandler(async (req, res) => {
  const allocation = await service.markDelivered(req.params.allocationId, req.body, req.user, {
    req,
    acknowledgementBuffer: req.file?.buffer,
  });
  return ok(res, allocation, { message: 'Allocation marked as delivered' });
});

const changeAllocationStatus = asyncHandler(async (req, res) => {
  const allocation = await service.changeAllocationStatus(
    req.params.allocationId,
    req.body,
    req.user,
    { req }
  );
  return ok(res, allocation, { message: `Allocation ${allocation.status.toLowerCase()}` });
});

const benefitHistory = asyncHandler(async (req, res) => {
  const history = await service.benefitHistory(req.params.fishermanId, req.user);
  return ok(res, history);
});

module.exports = {
  create,
  list,
  getOne,
  update,
  changeStatus,
  remove,
  listEligible,
  checkEligibility,
  allocate,
  listAllocations,
  markDelivered,
  changeAllocationStatus,
  benefitHistory,
};
