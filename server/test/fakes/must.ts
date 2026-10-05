/**
 * Assert presence, loudly.
 *
 * `x!` tells the type checker to be quiet and tells a failing test nothing.
 * This throws with a message naming what was missing, so a test that breaks
 * because an element vanished says so instead of reporting
 * "cannot read property of undefined".
 */
export function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`Expected ${what} to be present, got ${String(value)}.`);
  return value;
}

/** `must` for a lookup in a list, with the predicate's description. */
export function one<T>(items: readonly T[], predicate: (item: T) => boolean, what: string): T {
  const found = items.find(predicate);
  return must(found, what);
}
