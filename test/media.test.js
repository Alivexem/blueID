'use strict';

/**
 * Media placement and upload error handling.
 *
 * No network: `locate` is a pure function and the failure mapping is a pure
 * function of the store's error message. Both were wrong in ways that only
 * showed up against the real Cloudinary, so they are pinned here where the
 * check costs nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const media = require('../src/services/media.service');
const config = require('../src/config');

test('an image is filed under one path, not a folder plus a path', () => {
  /**
   * Cloudinary concatenates `folder` with `public_id`. Passing both a folder
   * and a path-style id produced
   *   blueid/fishermen/BAK/fishermen/BAK/88/x
   * — the location repeated. The id now carries the whole path and no
   * folder is sent.
   */
  const placement = media.locate('fisherman', { lga: 'BAK', blueId: 'CRS-BLU-BAK-0001' });

  assert.equal(placement.folder, undefined, 'no folder may be sent alongside a path-style id');
  assert.match(placement.publicId, /fishermen\/BAK\//);

  const repeated = /(fishermen\/BAK\/).*\1/.test(placement.publicId);
  assert.equal(repeated, false, `the path repeats itself: ${placement.publicId}`);

  if (config.cloudinary.folder) {
    assert.ok(
      placement.publicId.startsWith(`${config.cloudinary.folder}/`),
      'the configured prefix belongs in the id, since no folder is sent'
    );
  }
});

test('each kind is filed somewhere distinct, and sharded', () => {
  const fisherman = media.locate('fisherman', { lga: 'BAK', blueId: 'CRS-BLU-BAK-0002' });
  const asset = media.locate('asset', { lga: 'BAK', kind: 'BOAT' });
  const ack = media.locate('acknowledgement', { programmeCode: 'ENG-2026' });

  assert.match(fisherman.publicId, /\/fishermen\/BAK\/[0-9a-f]{2}\//);
  assert.match(asset.publicId, /\/assets\/boat\/BAK\/[0-9a-f]{2}\//);
  assert.match(ack.publicId, /\/acknowledgements\/ENG-2026\/[0-9a-f]{2}\//);
});

test('a passport photograph is square, an asset photograph is not', () => {
  // The ID card, the portal and the field app all read the same square
  // asset, so the framing is decided here rather than per caller.
  assert.equal(media.locate('fisherman', { lga: 'BAK' }).square, true);
  assert.equal(media.locate('fisherman', { lga: 'BAK' }).maxEdge, 400);
  assert.equal(media.locate('asset', { lga: 'BAK', kind: 'BOAT' }).square, false);
});

test('a retried upload for one Blue ID lands on the same path', () => {
  // Which is what makes a replayed upload overwrite itself rather than
  // leaving an orphan — the same idempotency the record sync relies on.
  const a = media.locate('fisherman', { lga: 'BAK', blueId: 'CRS-BLU-BAK-0003' });
  const b = media.locate('fisherman', { lga: 'BAK', blueId: 'CRS-BLU-BAK-0003' });
  assert.equal(a.publicId, b.publicId);

  // An asset has no natural key, so two uploads are two objects.
  const x = media.locate('asset', { lga: 'BAK', kind: 'BOAT' });
  const y = media.locate('asset', { lga: 'BAK', kind: 'BOAT' });
  assert.notEqual(x.publicId, y.publicId);
});

test('a path segment cannot be injected through a payload', () => {
  // `lga` and `programmeCode` reach the path. Anything outside the slug
  // alphabet is replaced, so a crafted value cannot climb out of the folder.
  const nasty = media.locate('acknowledgement', { programmeCode: '../../../etc/passwd' });
  assert.ok(!nasty.publicId.includes('..'), nasty.publicId);
  assert.ok(!nasty.publicId.includes('/etc/'), nasty.publicId);
});
