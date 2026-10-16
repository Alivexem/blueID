'use strict';

/**
 * String-similarity primitives for duplicate detection.
 *
 * Implemented in-repo rather than pulled from a package: the scoring is part
 * of a government record-matching rule that gets audited and tuned, so it
 * should be readable and version-controlled next to the code that uses it.
 */

/** Classic Levenshtein distance, two-row variant (O(min(a,b)) memory). */
function levenshtein(a = '', b = '') {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  // Keep the shorter string on the row axis.
  if (a.length > b.length) [a, b] = [b, a];

  let previous = Array.from({ length: a.length + 1 }, (_, i) => i);
  let current = new Array(a.length + 1);

  for (let j = 1; j <= b.length; j += 1) {
    current[0] = j;
    for (let i = 1; i <= a.length; i += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[i] = Math.min(current[i - 1] + 1, previous[i] + 1, previous[i - 1] + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[a.length];
}

/** 1 = identical, 0 = nothing in common. */
function levenshteinRatio(a = '', b = '') {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/**
 * Jaro–Winkler. Better than raw edit distance for personal names because it
 * rewards a shared prefix, which survives most field-entry typos.
 */
function jaro(a = '', b = '') {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array(a.length).fill(false);
  const bMatches = new Array(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j += 1) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  transpositions /= 2;

  return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}

function jaroWinkler(a = '', b = '', scalingFactor = 0.1) {
  const score = jaro(a, b);
  if (score < 0.7) return score; // Winkler boost only applies to close pairs.

  let prefix = 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix += 1;

  return score + prefix * scalingFactor * (1 - score);
}

/**
 * Token-set similarity: compares two names as bags of words, so word order and
 * a dropped middle name do not sink the score.
 * "effiom okon asuquo" vs "okon effiom" -> high.
 */
function tokenSetRatio(a = '', b = '') {
  const tokensA = new Set(a.split(' ').filter(Boolean));
  const tokensB = new Set(b.split(' ').filter(Boolean));
  if (!tokensA.size || !tokensB.size) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }

  // Also credit near-matching tokens (one-character typos).
  let fuzzy = 0;
  for (const tokenA of tokensA) {
    if (tokensB.has(tokenA)) continue;
    let best = 0;
    for (const tokenB of tokensB) {
      if (tokensA.has(tokenB)) continue; // already counted in the intersection
      best = Math.max(best, jaroWinkler(tokenA, tokenB));
    }
    if (best >= 0.9) fuzzy += best;
  }

  return (intersection + fuzzy) / Math.max(tokensA.size, tokensB.size);
}

/**
 * Blended name score used by the duplicate engine: the stronger of
 * token-set and Jaro–Winkler, so neither reordering nor typos alone
 * produce a false negative.
 */
function nameSimilarity(a = '', b = '') {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return Math.max(tokenSetRatio(a, b), jaroWinkler(a, b));
}

/**
 * Double-metaphone-lite phonetic key. Collapses the spelling variants that
 * dominate this dataset (Effiom/Efiom, Okon/Okun, Bassey/Basey) to one key,
 * which is what the duplicate candidate query blocks on.
 */
function phoneticKey(input = '') {
  if (!input) return '';
  return input
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/qu?/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/v/g, 'f')
    .replace(/[aeiou]+/g, 'a') // collapse vowel runs
    .replace(/(.)\1+/g, '$1') // collapse doubled consonants
    .slice(0, 8);
}

/** Phonetic key for a whole name, token-sorted for order independence. */
function phoneticNameKey(normalizedName = '') {
  return normalizedName
    .split(' ')
    .filter(Boolean)
    .map(phoneticKey)
    .filter(Boolean)
    .sort()
    .join('-');
}

module.exports = {
  levenshtein,
  levenshteinRatio,
  jaro,
  jaroWinkler,
  tokenSetRatio,
  nameSimilarity,
  phoneticKey,
  phoneticNameKey,
};
