import type { Projector } from '../events/log.js';
import { capturesProjector, messagesProjector, runsProjector, sessionsProjector } from './core.js';
import { entitiesProjector, factsProjector } from './facts.js';

/**
 * Projectors are **registered, not discovered**.
 *
 * A filesystem scan would make the rebuild depend on the build output, and
 * the build output is not in the event log either — so a missing file would
 * silently produce a smaller, "successful" rebuild. An explicit list fails to
 * compile instead.
 */
export function allProjectors(): Projector[] {
  return [
    sessionsProjector(),
    messagesProjector(),
    runsProjector(),
    capturesProjector(),
    factsProjector(),
    entitiesProjector(),
  ];
}

export { PROJECTION_TABLES, snapshotDigest, tableDigests, diffSnapshots } from './snapshot.js';
export { validAt, believedAt } from './facts.js';
export type { FactRow } from './facts.js';
