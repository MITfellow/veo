/**
 * Deterministic text utilities the baselines are built from.
 *
 * Nothing here is clever and that is the point. A baseline has one job: be
 * genuinely useful with no model, and be the *same* answer every time it is
 * asked. Every function here is pure and total.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from', 'had', 'has', 'have',
  'he', 'her', 'his', 'i', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 's', 'she',
  'so', 't', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'was',
  'we', 'were', 'what', 'when', 'which', 'who', 'will', 'with', 'you', 'your',
]);

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(text: string): string[] {
  const t = normalize(text);
  return t.length === 0 ? [] : t.split(' ');
}

export function contentTokens(text: string): string[] {
  return tokens(text).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Split into sentences.
 *
 * Abbreviation-naive on purpose: a sentence splitter that handles "Dr." and
 * "e.g." correctly is a model-sized problem, and getting it slightly wrong
 * costs an extractive summary one awkward boundary rather than a wrong
 * answer.
 */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])|\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Jaccard overlap of content tokens. 0 when either side is empty. */
export function similarity(a: string, b: string): number {
  const left = new Set(contentTokens(a));
  const right = new Set(contentTokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

/** Term frequencies over content tokens. */
export function termFrequency(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of contentTokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/**
 * Score every sentence by the summed frequency of the terms it contains,
 * normalised by length so a long sentence does not win by sheer mass.
 */
export function rankSentences(text: string): Array<{ sentence: string; score: number; index: number }> {
  const freq = termFrequency(text);
  return sentences(text).map((sentence, index) => {
    const words = contentTokens(sentence);
    const total = words.reduce((sum, w) => sum + (freq.get(w) ?? 0), 0);
    // The first sentence of a passage is usually load-bearing; a small
    // positional prior beats pure frequency on short inputs.
    const positional = index === 0 ? 1.15 : 1;
    return { sentence, index, score: words.length === 0 ? 0 : (total / words.length) * positional };
  });
}

/** Deterministic truncation that does not cut a word in half. */
export function truncateWords(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Rough token estimate. Four characters per token is the usual heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
