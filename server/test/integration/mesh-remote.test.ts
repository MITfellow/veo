import { afterAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createHttpServer, listen } from '../../src/interface/http.js';
import { RemotePeerLink, receiveMeshFrame, MESH_PATH } from '../../src/capability/mesh/remote.js';
import { MeshAgent } from '../../src/capability/mesh/agent.js';
import { PeerDirectory } from '../../src/capability/mesh/directory.js';
import { createInvite } from '../../src/capability/mesh/pairing.js';
import { allHandlers } from '../fakes/mesh.js';
import { MemoryStore } from '../../src/capability/memory/store.js';
import { vaultHarness } from '../fakes/vault.js';
import { FakeCrypto } from '../fakes/crypto.js';
import { RealNet } from '../../src/substrate/net.js';
import { must } from '../fakes/must.js';

/**
 * Two devices, two processes' worth of state, one real socket.
 *
 * This is the only test in the suite that opens a port. It is here
 * because "they talk over the network" is the claim, and a claim about
 * a socket cannot be proved by a fake that stands in for one. It stays
 * deterministic: loopback, an ephemeral port, no external name
 * resolution, and nothing timed.
 */

const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});

interface Device {
  id: string;
  harness: Awaited<ReturnType<typeof vaultHarness>>;
  agent: MeshAgent;
  directory: PeerDirectory;
  memory: MemoryStore;
  link: RemotePeerLink;
  close(): void;
}

async function device(id: string, label: string, address: string): Promise<Device> {
  const harness = await vaultHarness({ idleLockMinutes: 0 });
  const clock = harness.substrate.clock;
  let n = 0;
  const directory = new PeerDirectory({
    storage: harness.substrate.storage, vault: harness.vault, now: () => clock.now(), selfId: id,
  });
  const memory = new MemoryStore({
    storage: harness.substrate.storage, events: harness.substrate.events,
    now: () => clock.now(), nextId: () => `${id}-fact-${++n}`,
  });
  // A real transport: a real socket, with the loopback guard that
  // `RealNet` enforces for browsing deliberately not in the way — the
  // mesh is a different door (see `remote.ts`).
  const link = new RemotePeerLink({
    selfId: id,
    net: new RealNet({ allowLoopback: true }),
    directory,
  });
  const agent = new MeshAgent({
    selfId: id, directory, link,
    handlers: allHandlers({ label, memory, harness, now: () => clock.now(), newId: () => `${id}-msg-${++n}` }),
    events: harness.substrate.events, log: harness.substrate.fakeLog,
    now: () => clock.now(), newId: () => `${id}-msg-${++n}`,
  });
  void address;
  return { id, harness, agent, directory, memory, link, close: () => harness.close() };
}

async function serve(dev: Device): Promise<number> {
  const server = createHttpServer({
    storage: dev.harness.substrate.storage,
    config: { dataDir: '/tmp', modelAttached: false } as never,
    now: () => 0,
    eventCount: () => 0,
    mesh: (raw) => receiveMeshFrame(dev.agent, raw),
  });
  servers.push(server);
  const { port } = await listen(server, '127.0.0.1', 0);
  return port;
}

describe('two devices over a real socket', () => {
  it('pairs by code, then asks and answers across the network', async () => {
    const a = await device('device-a', 'Laptop', '');
    const b = await device('device-b', 'Phone', '');

    const portA = await serve(a);
    const portB = await serve(b);

    // The pairing code is carried by a human, not by the network.
    const invite = createInvite({ id: 'device-a', label: 'Laptop', address: `127.0.0.1:${portA}` }, new FakeCrypto(11));
    await b.directory.pair(invite, ['presence', 'availability']);
    await a.directory.pair({ ...invite, deviceId: 'device-b', label: 'Phone', address: `127.0.0.1:${portB}` }, ['presence']);

    const answer = await a.agent.ask('device-b', 'presence', {});
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect((answer.data as { label: string }).label).toBe('Phone');

    a.close();
    b.close();
  });

  it('refuses to send to a peer with no address', async () => {
    const a = await device('device-a', 'Laptop', '');
    const invite = createInvite({ id: 'device-x', label: 'Tablet', address: '' }, new FakeCrypto(12));
    await a.directory.pair(invite, ['presence']);

    const answer = await a.agent.ask('device-x', 'presence', {});
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.message).toMatch(/no address/);
    a.close();
  });

  it('accepts anything with the same 202, so the port is not an oracle', async () => {
    const b = await device('device-b', 'Phone', '');
    const port = await serve(b);

    const net = new RealNet({ allowLoopback: true });
    const nonsense = await net.fetch(`http://127.0.0.1:${port}${MESH_PATH}`, { method: 'POST', body: 'not a frame' });
    const forged = await net.fetch(`http://127.0.0.1:${port}${MESH_PATH}`, {
      method: 'POST',
      body: '{"v":1,"from":"ghost","to":"device-b","seq":1,"sealed":"AAAA"}',
    });

    expect(nonsense.status).toBe(202);
    expect(forged.status).toBe(202);
    // Identical, so neither tells the sender whether 'ghost' is paired.
    expect(nonsense.body).toBe(forged.body);
    b.close();
  });

  it('closes the mesh port entirely when no peers are configured', async () => {
    const quiet = await device('device-q', 'Quiet', '');
    const server = createHttpServer({
      storage: quiet.harness.substrate.storage,
      config: { dataDir: '/tmp', modelAttached: false } as never,
      now: () => 0, eventCount: () => 0,
    });
    servers.push(server);
    const { port } = await listen(server, '127.0.0.1', 0);

    const response = await new RealNet({ allowLoopback: true })
      .fetch(`http://127.0.0.1:${port}${MESH_PATH}`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
    quiet.close();
  });
});

describe('the frame that crossed the socket is the sealed one', () => {
  it('never puts the question on the wire in the clear', async () => {
    const a = await device('device-a', 'Laptop', '');
    const b = await device('device-b', 'Phone', '');
    const portA = await serve(a);
    const portB = await serve(b);

    // Watch what leaves A, between the agent and the socket.
    const seen: string[] = [];
    const real = new RealNet({ allowLoopback: true });
    a.link.watch((body) => seen.push(body));
    void real;

    const invite = createInvite({ id: 'device-b', label: 'Phone', address: `127.0.0.1:${portB}` }, new FakeCrypto(13));
    await a.directory.pair(invite, ['presence']);
    await b.directory.pair(
      { ...invite, deviceId: 'device-a', label: 'Laptop', address: `127.0.0.1:${portA}` },
      ['presence'],
    );

    const answer = await a.agent.ask('device-b', 'memory.recall', { query: 'salary negotiation' });
    // B does not grant recall, so the answer is a refusal — and that is
    // beside the point. The point is what the socket carried.
    expect(answer.ok).toBe(false);

    const body = must(seen[0], 'frame');
    expect(body).not.toContain('salary');
    expect(body).not.toContain('memory.recall');
    expect(body).toContain('"sealed"');
    expect(JSON.parse(body)).toMatchObject({ from: 'device-a', to: 'device-b' });

    a.close();
    b.close();
  });
});
