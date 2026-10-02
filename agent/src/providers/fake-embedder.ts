/**
 * A deterministic, offline embedder (§22.6: "deterministic fake embedder
 * (hash-based) so the suite runs offline").
 *
 * Hashed bag-of-tokens projected onto a fixed number of dimensions. It is
 * not semantic in any real sense — "car" and "automobile" are orthogonal —
 * but it has the two properties the tests need: identical text embeds
 * identically forever, and texts that share words are closer than texts that
 * do not. That is enough to prove the *plumbing* of hybrid retrieval, which
 * is what a test of hybrid retrieval should be proving. A test that depends
 * on a real model's notion of similarity is a test of the model.
 *
 * Shipping it is deliberate too: with no API key the agent still gets
 * lexical + hashed-semantic recall rather than no recall at all.
 */
import type { Embedder } from '../substrate/ports.js';

const DIMENSIONS = 256;

export class HashEmbedder implements Embedder {
  readonly id = 'hash-256';
  readonly dimensions = DIMENSIONS;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => embedOne(text, this.dimensions));
  }
}

export function embedOne(text: string, dimensions = DIMENSIONS): Float32Array {
  const vector = new Float32Array(dimensions);
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];

  for (const token of tokens) {
    // Two hashes per token: one picks the dimension, one picks the sign.
    // The sign is what keeps unrelated documents from drifting toward a
    // single positive corner of the space, which would make every pair of
    // texts look similar.
    const h = fnv1a(token);
    const index = h % dimensions;
    const sign = (fnv1a(`${token}#`) & 1) === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }

  // Bigrams carry a little word order, which matters for "no calls before
  // ten" versus "calls before ten".
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const h = fnv1a(`${tokens[i] ?? ''}_${tokens[i + 1] ?? ''}`);
    vector[h % dimensions] = (vector[h % dimensions] ?? 0) + 0.5;
  }

  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
