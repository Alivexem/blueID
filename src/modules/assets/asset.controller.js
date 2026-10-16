'use strict';

const service = require('./asset.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created, paginated, noContent } = require('../../utils/response');
const ApiError = require('../../utils/ApiError');

/**
 * Thin controllers over the shared asset service — `kind` is bound by the
 * route, so /boats, /engines and /equipment all reuse one implementation.
 */
const handlersFor = (kind) => ({
  create: asyncHandler(async (req, res) => {
    const doc = await service.create(kind, req.body, req.user, { req });
    return created(res, doc, { message: `${kind.toLowerCase()} registered` });
  }),

  list: asyncHandler(async (req, res) => {
    const { items, pagination } = await service.list(kind, req.query, req.user);
    return paginated(res, items, pagination);
  }),

  getOne: asyncHandler(async (req, res) => {
    const doc = await service.getById(kind, req.params.id, req.user);
    return ok(res, doc);
  }),

  update: asyncHandler(async (req, res) => {
    const doc = await service.update(kind, req.params.id, req.body, req.user, { req });
    return ok(res, doc, { message: 'Record updated' });
  }),

  transfer: asyncHandler(async (req, res) => {
    const doc = await service.transfer(kind, req.params.id, req.body, req.user, { req });
    return ok(res, doc, { message: 'Ownership transferred' });
  }),

  remove: asyncHandler(async (req, res) => {
    await service.softDelete(kind, req.params.id, req.user, { req, reason: req.body.reason });
    return noContent(res);
  }),

  uploadPhoto: asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Attach an image in the `photo` field');
    const doc = await service.setPhoto(kind, req.params.id, req.file.buffer, req.user, { req });
    return ok(res, { photo: doc.photo }, { message: 'Photograph uploaded' });
  }),
});

/** Every asset owned by one fisherman, for the profile view. */
const listForOwner = asyncHandler(async (req, res) => {
  const result = await service.listForOwner(req.params.ownerId, req.user);
  return ok(res, result);
});

module.exports = { handlersFor, listForOwner };
