'use strict';

/**
 * Blue ID, QR, field-encryption and duplicate-matching tests.
 *
 * These guard the parts of the system that produce permanent, printed or
 * irreversible artefacts — an ID number on a card, an encrypted NIN, a
 * duplicate decision — where a silent regression is expensive to undo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/blueid-test';
process.env.AUTH_MODE = 'disabled';
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'test-qr-secret-value';
process.env.FIELD_ENCRYPTION_KEY =
  process.env.FIELD_ENCRYPTION_KEY || 'test-field-encryption-key-at-least-32-chars';

const blueId = require('../src/services/blueId.service');
const fieldCrypto = require('../src/utils/fieldCrypto');
const duplicates = require('../src/services/duplicate.service');
const normalize = require('../src/utils/normalize');
const similarity = require('../src/utils/similarity');
const { detectImageType } = require('../src/middleware/upload');

// ---------------------------------------------------------------------------
// Blue ID
// ---------------------------------------------------------------------------

test('Blue ID formats to the documented pattern', () => {
  assert.equal(blueId.format('BAK', 1), 'CRS-BLU-BAK-0001');
  assert.equal(blueId.format('BAK', 4321), 'CRS-BLU-BAK-4321');
  // Beyond the padding the number grows rather than wrapping or truncating.
  assert.equal(blueId.format('BAK', 12345), 'CRS-BLU-BAK-12345');
});

test('Blue ID parses and validates', () => {
  const parsed = blueId.parse('CRS-BLU-BAK-0001');
  assert.deepEqual(
    { lga: parsed.lga, sequence: parsed.sequence },
    { lga: 'BAK', sequence: 1 }
  );

  assert.equal(blueId.isWellFormed('CRS-BLU-BAK-0001'), true);
  assert.equal(blueId.isWellFormed('crs-blu-bak-0001'), true, 'case must not matter');
  // An unknown LGA code must be rejected even though the shape is right.
  assert.equal(blueId.isWellFormed('CRS-BLU-ZZZ-0001'), false);
  assert.equal(blueId.isWellFormed('NOT-AN-ID'), false);
  assert.equal(blueId.isWellFormed(''), false);
});

test('temporary field references are distinguishable from real Blue IDs', () => {
  const temp = blueId.temporaryReference('BAK-07', 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
  assert.match(temp, /^TMP-BAK-07-/);
  assert.equal(blueId.isTemporaryReference(temp), true);
  // Critically: a temporary reference must never pass as a Blue ID.
  assert.equal(blueId.isWellFormed(temp), false);
});

// ---------------------------------------------------------------------------
// QR payloads
// ---------------------------------------------------------------------------

test('QR payload carries an opaque token, never the Blue ID or a name', () => {
  const token = 'abcdefghijklmnopqrstuvwx';
  const payload = blueId.qrPayload(token, 1);

  assert.match(payload.url, /t=abcdefghijklmnopqrstuvwx/);
  assert.doesNotMatch(payload.url, /CRS-BLU/, 'the Blue ID must not appear in the QR');
  assert.ok(payload.signature, 'payload must be signed');
});

test('QR signatures verify and reject tampering', () => {
  const token = 'abcdefghijklmnopqrstuvwx';
  const signature = blueId.sign(token, 1);

  assert.equal(blueId.verifySignature(token, 1, signature), true);
  // A different token, version or signature must all fail.
  assert.equal(blueId.verifySignature('другой-token-value-here', 1, signature), false);
  assert.equal(blueId.verifySignature(token, 2, signature), false);
  assert.equal(blueId.verifySignature(token, 1, 'forged-signature'), false);
  assert.equal(blueId.verifySignature(token, 1, ''), false);
});

test('a scanned QR URL round-trips', () => {
  const token = 'abcdefghijklmnopqrstuvwx';
  const { url } = blueId.qrPayload(token, 3);
  const parsed = blueId.parseQrPayload(url);

  assert.equal(parsed.token, token);
  assert.equal(parsed.version, 3);
  assert.equal(blueId.verifySignature(parsed.token, parsed.version, parsed.signature), true);
});

// ---------------------------------------------------------------------------
// Field encryption
// ---------------------------------------------------------------------------

test('NIN encryption round-trips and is non-deterministic', () => {
  const nin = '12345678901';
  const a = fieldCrypto.encrypt(nin);
  const b = fieldCrypto.encrypt(nin);

  assert.notEqual(a, nin, 'ciphertext must not equal plaintext');
  assert.notEqual(a, b, 'AES-GCM must use a fresh IV each time');
  assert.equal(fieldCrypto.decrypt(a), nin);
  assert.equal(fieldCrypto.decrypt(b), nin);
});

test('the blind index is deterministic so equality search still works', () => {
  const nin = '12345678901';
  assert.equal(fieldCrypto.blindIndex(nin), fieldCrypto.blindIndex(nin));
  assert.notEqual(fieldCrypto.blindIndex(nin), fieldCrypto.blindIndex('10987654321'));
  // The index must not be the plaintext.
  assert.notEqual(fieldCrypto.blindIndex(nin), nin);
});

test('tampered ciphertext fails authentication rather than decrypting', () => {
  const encrypted = fieldCrypto.encrypt('12345678901');
  const parts = encrypted.split(':');
  // Corrupt the ciphertext body; GCM's auth tag must reject it.
  parts[3] = Buffer.from('tampered-value').toString('base64');
  assert.equal(fieldCrypto.decrypt(parts.join(':')), null);
});

test('NIN masking keeps only the last four digits', () => {
  assert.equal(fieldCrypto.mask('12345678901'), '*******8901');
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

test('Nigerian phone numbers normalise to E.164', () => {
  const expected = '+2348031234567';
  for (const input of [
    '08031234567',
    '8031234567',
    '2348031234567',
    '+234 803 123 4567',
    '0803-123-4567',
  ]) {
    assert.equal(normalize.normalizePhone(input), expected, `failed for ${input}`);
  }
  assert.equal(normalize.normalizePhone('12345'), null);
  assert.equal(normalize.normalizePhone(''), null);
});

test('names normalise for matching without losing the original', () => {
  // Titles are dropped and tokens sorted, so word order cannot hide a match.
  assert.equal(normalize.normalizeName('Chief Effiom Okon'), normalize.normalizeName('Okon Effiom'));
  // Punctuation is folded: the apostrophe is dropped, the hyphen becomes a
  // token break, and the tokens are sorted.
  assert.equal(normalize.normalizeName("O'Brien-Effiom"), 'effiom obrien');
  // Accents are stripped, so "Efiòm" and "Efiom" match.
  assert.equal(normalize.normalizeName('Efiòm'), normalize.normalizeName('Efiom'));
  assert.equal(normalize.toTitleCase('effiom  okon'), 'Effiom Okon');
});

test('NIN normalisation accepts only 11 digits', () => {
  assert.equal(normalize.normalizeNin('123 456 789 01'), '12345678901');
  assert.equal(normalize.normalizeNin('1234'), null);
});

test('an estimated birth year substitutes for an unknown date of birth', () => {
  assert.equal(normalize.resolveBirthYear({ estimatedYearOfBirth: 1980 }), 1980);
  assert.equal(normalize.resolveBirthYear({ dateOfBirth: new Date('1975-06-01') }), 1975);
  assert.equal(normalize.resolveBirthYear({}), null);
});

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

test('name similarity tolerates field-entry variation', () => {
  assert.ok(similarity.nameSimilarity('effiom okon', 'efiom okon') > 0.85, 'one-letter typo');
  assert.ok(similarity.nameSimilarity('effiom okon', 'okon effiom') > 0.9, 'reordered tokens');
  assert.ok(similarity.nameSimilarity('effiom okon', 'bassey asuquo') < 0.6, 'unrelated names');
});

test('phonetic keys collapse common spelling variants', () => {
  assert.equal(similarity.phoneticKey('effiom'), similarity.phoneticKey('efiom'));
  assert.equal(similarity.phoneticKey('bassey'), similarity.phoneticKey('basey'));
});

test('an identical NIN alone is treated as a duplicate', () => {
  const subject = duplicates.extractIdentity({
    firstName: 'Effiom',
    lastName: 'Okon',
    nin: '12345678901',
    lga: 'BAK',
  });

  const scored = duplicates.scoreCandidate(subject, {
    _id: 'x',
    fullName: 'Completely Different Name',
    lga: 'ODU',
    match: { ninIndex: fieldCrypto.blindIndex('12345678901'), normalizedName: 'different name' },
  });

  assert.ok(scored.score >= 0.72, `NIN match should exceed the threshold, got ${scored.score}`);
  assert.match(scored.reasons.join(' '), /National Identification Number/);
});

/**
 * Shared handsets are common in fishing communities, so a phone match alone
 * must not condemn a record — otherwise siblings sharing a phone are
 * permanently flagged.
 */
test('a shared phone number alone does not reach the duplicate threshold', () => {
  const subject = duplicates.extractIdentity({
    firstName: 'Effiom',
    lastName: 'Okon',
    phone: '08031234567',
    lga: 'BAK',
  });

  const scored = duplicates.scoreCandidate(subject, {
    _id: 'y',
    fullName: 'Bassey Asuquo',
    lga: 'BAK',
    match: { normalizedPhone: '+2348031234567', normalizedName: 'asuquo bassey' },
  });

  assert.ok(scored.score < 0.72, `phone alone should stay below the threshold, got ${scored.score}`);
  assert.match(scored.reasons.join(' '), /Same phone number/);
});

test('same name, same phone and same birth year is a duplicate', () => {
  const subject = duplicates.extractIdentity({
    firstName: 'Effiom',
    lastName: 'Okon',
    phone: '08031234567',
    estimatedYearOfBirth: 1980,
    lga: 'BAK',
  });

  const scored = duplicates.scoreCandidate(subject, {
    _id: 'z',
    fullName: 'Effiom Okon',
    lga: 'BAK',
    match: {
      normalizedPhone: '+2348031234567',
      normalizedName: 'effiom okon',
      birthYear: 1980,
    },
  });

  assert.ok(scored.score >= 0.72, `expected a duplicate, got ${scored.score}`);
});

// ---------------------------------------------------------------------------
// Upload signature checks
// ---------------------------------------------------------------------------

test('image signatures are detected from content, not the declared type', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]);
  // A PHP payload renamed to .jpg — the classic upload bypass.
  const script = Buffer.concat([Buffer.from('<?php system($_GET[0]); ?>'), Buffer.alloc(16)]);

  assert.equal(detectImageType(jpeg), 'image/jpeg');
  assert.equal(detectImageType(png), 'image/png');
  assert.equal(detectImageType(script), null);
});
