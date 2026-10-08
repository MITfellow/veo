import { MeshAgent } from '../../src/capability/mesh/agent.js';
import { PeerDirectory } from '../../src/capability/mesh/directory.js';
import { createInvite, type Invite } from '../../src/capability/mesh/pairing.js';
import { InProcessSwitch } from '../../src/capability/mesh/transport.js';
import {
  availabilityHandler, presenceHandler, recallHandler, shareHandler,
} from '../../src/capability/mesh/handlers.js';
import type { Grant, TopicHandler } from '../../src/capability/mesh/types.js';
import { MemoryStore } from '../../src/capability/memory/store.js';
import { vaultHarness, type VaultHarness } from './vault.js';
import { FakeCrypto } from './crypto.js';

/**
 * Two agents, one switch.
 *
 * Each has its own database, vault and clock — because that is what two
 * devices are. Sharing a database between them would make the tests
 * pass for reasons that do not exist in the field.
 */

export interface MeshNode {
  id: string;
  agent: MeshAgent;
  directory: PeerDirectory;
  memory: MemoryStore;
  harness: VaultHarness;
  invite: Invite;
  advance(ms: number): void;
  now(): number;
}

export interface MeshPair {
  a: MeshNode;
  b: MeshNode;
  wire: InProcessSwitch;
  close(): void;
}

async function node(
  id: string,
  label: string,
  wire: InProcessSwitch,
  handlersFor: (deps: NodeDeps) => TopicHandler[],
): Promise<MeshNode> {
  const harness = await vaultHarness({ idleLockMinutes: 0 });
  const clock = harness.substrate.clock;
  let seq = 0;
  const newId = (): string => `${id}-msg-${++seq}`;
  const memory = new MemoryStore({
    storage: harness.substrate.storage, events: harness.substrate.events,
    now: () => clock.now(), nextId: () => `${id}-fact-${++seq}`,
  });
  const directory = new PeerDirectory({
    storage: harness.substrate.storage, vault: harness.vault, now: () => clock.now(), selfId: id,
  });
  const agent = new MeshAgent({
    selfId: id,
    directory,
    link: wire.link(id),
    handlers: handlersFor({ label, memory, harness, now: () => clock.now(), newId }),
    events: harness.substrate.events,
    log: harness.substrate.fakeLog,
    now: () => clock.now(),
    newId,
  });
  return {
    id, agent, directory, memory, harness,
    invite: createInvite({ id, label, address: '' }, new FakeCrypto(id.length + 1)),
    advance: (ms) => clock.advance(ms),
    now: () => clock.now(),
  };
}

export interface NodeDeps {
  label: string;
  memory: MemoryStore;
  harness: VaultHarness;
  now: () => number;
  newId: () => string;
}

export function allHandlers(deps: NodeDeps): TopicHandler[] {
  return [
    presenceHandler({ label: deps.label, now: deps.now }),
    availabilityHandler({ memory: deps.memory }),
    recallHandler({ memory: deps.memory, now: deps.now }),
    shareHandler({
      memory: deps.memory, events: deps.harness.substrate.events,
      now: deps.now, newId: deps.newId,
    }),
  ];
}

/**
 * Two paired agents.
 *
 * `grantsOnB` is what **B** allows **A** to ask; `grantsOnA` the
 * reverse. They are separate on purpose: a grant is one device's
 * decision about one peer, and pairing is not symmetric consent.
 */
export async function meshPair(options: {
  grantsOnA?: readonly Grant[];
  grantsOnB?: readonly Grant[];
  handlers?: (deps: NodeDeps) => TopicHandler[];
} = {}): Promise<MeshPair> {
  const wire = new InProcessSwitch();
  const handlers = options.handlers ?? allHandlers;
  const a = await node('device-a', 'Laptop', wire, handlers);
  const b = await node('device-b', 'Phone', wire, handlers);

  // One invite, carried by hand: A shows the code, B types it. Both
  // sides then hold the same secret and derive the same two keys.
  await b.directory.pair(a.invite, options.grantsOnB ?? ['presence', 'availability', 'recall', 'share']);
  await a.directory.pair({ ...a.invite, deviceId: b.id, label: 'Phone' }, options.grantsOnA ?? ['presence', 'availability', 'recall', 'share']);

  return { a, b, wire, close: () => { a.harness.close(); b.harness.close(); } };
}
