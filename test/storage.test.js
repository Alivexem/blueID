'use strict';

/**
 * Local media storage tests.
 *
 * The register's photographs now live on the server's own disk, which moves
 * four things from a vendor's problem to ours: framing, metadata stripping,
 * access control, and not letting a caller-supplied path escape the root.
 *
 * Synthetic images generated in-process; no real photographs, no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MEDIA_ROOT = path.join(os.tmpdir(), `blueid-media-test-${crypto.randomBytes(6).toString('hex')}`);

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'disabled';
process.env.MEDIA_DRIVER = 'local';
process.env.MEDIA_ROOT = MEDIA_ROOT;
process.env.MEDIA_URL_SECRET = 'a-media-url-signing-secret-of-32-chars-min';

const sharp = require('sharp');
const storage = require('../src/services/storage');
const mediaService = require('../src/services/media.service');

test.after(async () => {
  await fs.rm(MEDIA_ROOT, { recursive: true, force: true });
});

/** A red rectangle, deliberately not square, carrying EXIF with GPS. */
async function syntheticPhoto({ width = 1600, height = 1200 } = {}) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .withExifMerge({
      IFD0: { Make: 'TestCam', Model: 'Synthetic' },
      GPS: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
    })
    .jpeg()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Storing
// ---------------------------------------------------------------------------

test('a fisherman photograph is stored square and face-framed at 400px', async () => {
  const record = await mediaService.uploadFishermanPhoto(await syntheticPhoto(), {
    lga: 'BAK',
    blueId: 'CRS-BLU-BAK-000001',
  });

  assert.equal(record.width, 400);
  assert.equal(record.height, 400);
  assert.equal(record.format, 'jpg');
  assert.ok(record.bytes > 0);
  assert.match(record.publicId, /^fishermen\/BAK\/[0-9a-f]{2}\/CRS-BLU-BAK-000001$/);

  // It is really on disk, at the path the record names.
  assert.ok(await storage.exists(record.publicId));
});

test('EXIF, and the GPS inside it, does not survive storage', async () => {
  const original = await syntheticPhoto();
  const before = await sharp(original).metadata();
  assert.ok(before.exif, 'the fixture must actually carry EXIF, or this proves nothing');

  const record = await mediaService.uploadFishermanPhoto(original, {
    lga: 'BAK',
    blueId: 'CRS-BLU-BAK-000002',
  });

  const stored = await sharp(storage.absolutePathFor(record.publicId)).metadata();
  assert.equal(stored.exif, undefined, 'a stored photograph must carry no EXIF block');
});

test('an asset photograph keeps its aspect ratio within the long edge', async () => {
  const record = await mediaService.uploadAssetPhoto(await syntheticPhoto({ width: 2400, height: 1200 }), {
    kind: 'BOAT',
    lga: 'AKP',
  });

  assert.equal(record.width, 1024);
  assert.equal(record.height, 512, 'aspect ratio must be preserved, not cropped');
  assert.match(record.publicId, /^assets\/boat\/AKP\/[0-9a-f]{2}\/[0-9a-f]{24}$/);
});

test('a retried upload for the same Blue ID overwrites rather than orphaning', async () => {
  const parts = { lga: 'BAK', blueId: 'CRS-BLU-BAK-000003' };
  const first = await mediaService.uploadFishermanPhoto(await syntheticPhoto(), parts);
  const second = await mediaService.uploadFishermanPhoto(await syntheticPhoto({ width: 800, height: 800 }), parts);

  assert.equal(first.publicId, second.publicId, 'the path is derived from the Blue ID');

  const entries = [];
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else entries.push(full);
    }
  }
  await walk(path.join(MEDIA_ROOT, 'fishermen', 'BAK'));
  const forThisId = entries.filter((f) => f.includes('CRS-BLU-BAK-000003'));
  assert.equal(forThisId.length, 1, 'a retry must not leave a second file behind');
});

test('a file that is not a decodable image is refused, not written', async () => {
  await assert.rejects(
    () => mediaService.uploadFishermanPhoto(Buffer.from('this is not an image'), { lga: 'BAK', blueId: 'X1' }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'MEDIA_UNREADABLE');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Signed delivery
// ---------------------------------------------------------------------------

test('a delivery URL is signed, and the signature is checked', () => {
  const publicId = 'fishermen/BAK/aa/CRS-BLU-BAK-000009';
  const url = mediaService.signedUrl(publicId, { expiresInSeconds: 600 });

  const parsed = new URL(url, 'http://localhost');
  const e = parsed.searchParams.get('e');
  const s = parsed.searchParams.get('s');

  assert.ok(e && s, 'the URL must carry an expiry and a signature');
  assert.equal(mediaService.verifySignature(publicId, e, s), true);

  // Tampering with any of the three parts invalidates it.
  assert.equal(mediaService.verifySignature(publicId, e, `${s.slice(0, -1)}X`), false, 'altered signature');
  assert.equal(mediaService.verifySignature(publicId, Number(e) + 3600, s), false, 'extended expiry');
  assert.equal(
    mediaService.verifySignature('fishermen/BAK/aa/CRS-BLU-BAK-000010', e, s),
    false,
    'signature reused for another image'
  );
});

test('an expired signature is refused', () => {
  const publicId = 'fishermen/BAK/aa/CRS-BLU-BAK-000011';
  const expired = Math.floor(Date.now() / 1000) - 1;
  const signature = require('node:crypto')
    .createHmac('sha256', process.env.MEDIA_URL_SECRET)
    .update(`${publicId}:${expired}`)
    .digest('base64url');

  // The signature itself is genuine — only the clock has moved on.
  assert.equal(mediaService.verifySignature(publicId, expired, signature), false);
});

test('an unsigned path grants nothing', () => {
  assert.equal(mediaService.verifySignature('fishermen/BAK/aa/x', undefined, undefined), false);
  assert.equal(mediaService.verifySignature('fishermen/BAK/aa/x', Date.now() / 1000 + 600, ''), false);
});

// ---------------------------------------------------------------------------
// Path traversal
// ---------------------------------------------------------------------------

test('a public id cannot escape the media root', () => {
  const escapes = [
    '../../../../etc/passwd',
    'fishermen/../../../etc/shadow',
    '/etc/passwd',
    'fishermen//../../root/.ssh/id_rsa',
    './../../.env',
    'fishermen/BAK/aa/../../../../../../tmp/evil',
  ];

  for (const attempt of escapes) {
    assert.throws(
      () => storage.absolutePathFor(attempt),
      (err) => err.code === 'MEDIA_ID_INVALID',
      `must refuse: ${attempt}`
    );
    assert.equal(mediaService.verifySignature(attempt, Date.now() / 1000 + 600, 'x'), false);
  }
});

test('a resolved path always stays under the configured root', () => {
  const resolved = storage.absolutePathFor('fishermen/BAK/aa/CRS-BLU-BAK-000001');
  assert.ok(
    resolved.startsWith(path.resolve(MEDIA_ROOT) + path.sep),
    `${resolved} escaped ${MEDIA_ROOT}`
  );
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

test('deleting removes the file and is safe to repeat', async () => {
  const record = await mediaService.uploadFishermanPhoto(await syntheticPhoto(), {
    lga: 'BAK',
    blueId: 'CRS-BLU-BAK-000099',
  });

  assert.equal(await mediaService.destroy(record.publicId), true);
  assert.equal(await storage.exists(record.publicId), false);
  assert.equal(await mediaService.destroy(record.publicId), false, 'a second delete is a no-op');
});

test('readiness reports whether the media root is writable', async () => {
  const health = await mediaService.healthCheck();
  assert.equal(health.ok, true);
  assert.equal(health.root, path.resolve(MEDIA_ROOT));
});

test('the local driver tells clients to upload through the API', () => {
  const credentials = mediaService.createUploadSignature({});
  assert.equal(credentials.strategy, 'api-upload');
  assert.match(credentials.uploadUrl, /\/media\/upload$/);
  assert.ok(!('signature' in credentials), 'there is no third-party signature to hand out');
});

// ---------------------------------------------------------------------------
// The delivery endpoint, over real HTTP
// ---------------------------------------------------------------------------

/**
 * `/media/file/*` is the only unauthenticated route this feature adds, so it
 * is exercised through an actual server rather than by calling the signature
 * helper. The helper being correct does not prove the route consults it.
 */
const http = require('node:http');

let server;
let origin;

async function startServer() {
  if (server) return origin;
  const app = require('../src/app');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return origin;
}

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('a correctly signed URL returns the image bytes', async () => {
  const base = await startServer();
  const record = await mediaService.uploadFishermanPhoto(await syntheticPhoto(), {
    lga: 'BAK',
    blueId: 'CRS-BLU-BAK-000777',
  });

  const signed = mediaService.signedUrl(record.publicId, { expiresInSeconds: 600 });
  const query = signed.slice(signed.indexOf('?'));
  const response = await fetch(`${base}${record.url}${query}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.match(response.headers.get('cache-control'), /private/);

  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.length, record.bytes);
  // Really a JPEG: SOI marker.
  assert.equal(body[0], 0xff);
  assert.equal(body[1], 0xd8);
});

test('the delivery endpoint refuses an unsigned, altered or expired request', async () => {
  const base = await startServer();
  const record = await mediaService.uploadFishermanPhoto(await syntheticPhoto(), {
    lga: 'BAK',
    blueId: 'CRS-BLU-BAK-000778',
  });

  const signed = mediaService.signedUrl(record.publicId, { expiresInSeconds: 600 });
  const params = new URL(signed, 'http://x').searchParams;
  const e = params.get('e');
  const s = params.get('s');

  const cases = [
    ['no signature at all', `${record.url}`],
    ['expiry without signature', `${record.url}?e=${e}`],
    ['signature without expiry', `${record.url}?s=${s}`],
    ['altered signature', `${record.url}?e=${e}&s=${s.slice(0, -2)}AA`],
    ['expiry pushed out', `${record.url}?e=${Number(e) + 86400}&s=${s}`],
    ['already expired', `${record.url}?e=${Math.floor(Date.now() / 1000) - 10}&s=${s}`],
  ];

  for (const [name, pathAndQuery] of cases) {
    const response = await fetch(`${base}${pathAndQuery}`);
    assert.equal(response.status, 404, `${name} must be refused`);
  }
});

test('a signature for one image does not open another', async () => {
  const base = await startServer();
  const mine = await mediaService.uploadFishermanPhoto(await syntheticPhoto(), {
    lga: 'BAK',
    blueId: 'CRS-BLU-BAK-000779',
  });
  const theirs = await mediaService.uploadFishermanPhoto(await syntheticPhoto(), {
    lga: 'ODK',
    blueId: 'CRS-BLU-ODK-000001',
  });

  const signed = mediaService.signedUrl(mine.publicId, { expiresInSeconds: 600 });
  const query = signed.slice(signed.indexOf('?'));

  // The same signature aimed at someone else's photograph in another LGA.
  const response = await fetch(`${base}${theirs.url}${query}`);
  assert.equal(response.status, 404);
});

test('the delivery endpoint cannot be walked out of the media root', async () => {
  const base = await startServer();
  const future = Math.floor(Date.now() / 1000) + 600;

  for (const attempt of [
    '/api/v1/media/file/../../../../etc/passwd',
    '/api/v1/media/file/..%2f..%2f..%2f..%2fetc%2fpasswd',
    '/api/v1/media/file/fishermen/../../../.env',
  ]) {
    const response = await fetch(`${base}${attempt}?e=${future}&s=anything`);
    assert.ok(
      response.status === 404 || response.status === 400,
      `${attempt} returned ${response.status}`
    );
    const body = await response.text();
    assert.ok(!body.includes('root:'), 'must never return /etc/passwd');
    assert.ok(!body.includes('MONGODB_URI'), 'must never return .env');
  }
});
