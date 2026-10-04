import type { Clock } from './ports.js';

/**
 * The only thing in the platform that reads the wall clock.
 *
 * The time zone is supplied rather than sniffed: the host's zone is a
 * property of the machine, but "the zone the user lives in" is a property of
 * the user, and §17 cares about the second one. The caller passes it in from
 * config; `resolvedOptions()` is the default only because it is usually right.
 */
export function systemClock(timeZone?: string): Clock {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    now: () => Date.now(),
    timeZone: () => zone,
  };
}
