'use strict';

const service = require('./fisherman.service');
const duplicateService = require('../../services/duplicate.service');
const qrService = require('../../services/qr.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created, paginated, noContent } = require('../../utils/response');
const ApiError = require('../../utils/ApiError');
const { REGISTRATION_CHANNEL } = require('../../config/constants');

/** Field app requests carry a device header; that decides the channel. */
function channelFor(req) {
  if (req.get('x-device-id')) return REGISTRATION_CHANNEL.MOBILE_ONLINE;
  return REGISTRATION_CHANNEL.WEB_PORTAL;
}

const create = asyncHandler(async (req, res) => {
  const { fisherman, duplicates } = await service.create(req.body, req.user, {
    req,
    channel: channelFor(req),
  });

  const message = duplicates.hasDuplicate
    ? 'Registration saved and held for duplicate review — no Blue ID has been issued yet'
    : 'Registration saved. It is awaiting verification.';

  return created(res, {
    fisherman,
    duplicateReview: duplicates.hasDuplicate
      ? { held: true, matches: duplicates.matches, threshold: duplicates.threshold }
      : null,
  }, { message });
});

const list = asyncHandler(async (req, res) => {
  const { items, pagination } = await service.list(req.query, req.user);
  return paginated(res, items, pagination);
});

const getOne = asyncHandler(async (req, res) => {
  const fisherman = await service.getById(req.params.id, req.user, {
    includeAssets: req.query.includeAssets !== false,
    // Disclosing a NIN additionally needs the sensitive grant and is audited.
    includeNin: Boolean(req.query.includeNin),
    req,
  });
  return ok(res, fisherman);
});

const getByBlueId = asyncHandler(async (req, res) => {
  const fisherman = await service.getByBlueId(req.params.blueId, req.user, {
    includeAssets: true,
    req,
  });
  return ok(res, fisherman);
});

const update = asyncHandler(async (req, res) => {
  const { fisherman, duplicates } = await service.update(req.params.id, req.body, req.user, { req });
  return ok(res, {
    fisherman,
    duplicateReview: duplicates?.hasDuplicate ? { matches: duplicates.matches } : null,
  }, { message: 'Record updated' });
});

const verify = asyncHandler(async (req, res) => {
  const fisherman = await service.verify(req.params.id, req.user, { req, notes: req.body.notes });
  return ok(res, fisherman, {
    message: `Verified. Blue ID ${fisherman.blueId} has been issued.`,
  });
});

const changeStatus = asyncHandler(async (req, res) => {
  const fisherman = await service.changeStatus(req.params.id, req.body, req.user, { req });
  return ok(res, fisherman, { message: `Status changed to ${fisherman.status}` });
});

const checkDuplicates = asyncHandler(async (req, res) => {
  const result = await service.checkDuplicates(req.params.id, req.user);
  return ok(res, result);
});

/**
 * Pre-submission probe. The portal and field app call this as the enumerator
 * types, so a likely duplicate surfaces while the fisherman is still standing
 * there — far cheaper to resolve then than in an administrative review later.
 */
const probeDuplicates = asyncHandler(async (req, res) => {
  const result = await duplicateService.findDuplicates(req.body);
  return ok(res, result);
});

const resolveDuplicate = asyncHandler(async (req, res) => {
  const fisherman = await service.resolveDuplicate(req.params.id, req.body, req.user, { req });
  return ok(res, fisherman, { message: 'Duplicate review recorded' });
});

const remove = asyncHandler(async (req, res) => {
  await service.softDelete(req.params.id, req.user, { req, reason: req.body.reason });
  return noContent(res);
});

const uploadPhoto = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Attach an image in the `photo` field');
  const fisherman = await service.setPhoto(req.params.id, req.file.buffer, req.user, { req });
  return ok(res, { photo: fisherman.photo }, { message: 'Photograph uploaded' });
});

/**
 * QR code for the printed Blue ID card.
 *
 * Reads the record through the service so scope is enforced, then fetches the
 * verification token separately — the token is stripped from serialised output
 * on purpose and is only ever released here, to print a card.
 */
const getQrCode = asyncHandler(async (req, res) => {
  // Enforces object-level authorization before anything is generated.
  await service.getById(req.params.id, req.user, { signPhoto: false, includeAssets: false });

  const card = await service.getCardToken(req.params.id, req.user, { req });
  const format = req.query.format || 'png';

  if (format === 'svg') {
    res.type('image/svg+xml');
    return res.send(await qrService.toSvg(card));
  }
  if (format === 'json') {
    return ok(res, {
      blueId: card.blueId,
      qrVersion: card.qrVersion,
      dataUrl: await qrService.toDataUrl(card),
    });
  }

  const buffer = await qrService.toBuffer(card);
  res.type('image/png');
  res.setHeader('content-disposition', `inline; filename="${card.blueId}.png"`);
  return res.send(buffer);
});

/** Rotates the card token so a lost card stops validating. */
const reissueCard = asyncHandler(async (req, res) => {
  const fisherman = await service.reissueCard(req.params.id, req.user, {
    req,
    reason: req.body.reason,
  });
  return ok(res, { qrVersion: fisherman.qrVersion }, {
    message: 'Card reissued — the previous card is no longer valid',
  });
});

module.exports = {
  create,
  reissueCard,
  list,
  getOne,
  getByBlueId,
  update,
  verify,
  changeStatus,
  checkDuplicates,
  probeDuplicates,
  resolveDuplicate,
  remove,
  uploadPhoto,
  getQrCode,
};
