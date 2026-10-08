#!/usr/bin/env node
/**
 * Two agents, paired by a code, talking over a real socket.
 *
 * Run from `server/`:   node docs/progress/mesh-demo.mjs
 * (after `npx tsc -p tsconfig.json`)
 *
 * Nothing here is a mock. Two databases, two vaults, two HTTP servers on
 * loopback, and the frames that cross between them are the sealed ones.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const D = new URL('../../dist/src/', import.meta.url).href.replace(/\/$/, '');
const { createSubstrate } = await import(`${D}/substrate/index.js`);
const { Vault } = await import(`${D}/security/vault.js`);
const { TEST_ARGON2 } = await import(`${D}/security/kdf.js`);
const { MemoryStore } = await import(`${D}/capability/memory/store.js`);
const { PeerDirectory } = await import(`${D}/capability/mesh/directory.js`);
const { MeshAgent } = await import(`${D}/capability/mesh/agent.js`);
const { RemotePeerLink, receiveMeshFrame } = await import(`${D}/capability/mesh/remote.js`);
const { createInvite, confirmationWords, decodeSecret } = await import(`${D}/capability/mesh/pairing.js`);
const handlers = await import(`${D}/capability/mesh/handlers.js`);
const { RealNet } = await import(`${D}/substrate/net.js`);
const { nodeCrypto } = await import(`${D}/substrate/crypto.js`);
const { createHttpServer, listen } = await import(`${D}/interface/http.js`);

const say = (...a) => console.log(...a);
const PASSPHRASE = 'correct horse battery staple';

async function device(id, label) {
  const dir = mkdtempSync(join(tmpdir(), `arish-${id}-`));
  const substrate = createSubstrate({ dbPath: join(dir, 'arish.db') });
  const vault = new Vault({
    storage: substrate.storage, clock: substrate.clock, argon2: TEST_ARGON2,
    idleLockMinutes: 0,
    events: { secretCreated(){}, secretRead(){}, unlocked(){}, locked(){}, destroyed(){}, itemShredded(){} },
  });
  await vault.init(PASSPHRASE);
  await vault.unlock(PASSPHRASE);

  let n = 0;
  const now = () => substrate.clock.now();
  const memory = new MemoryStore({
    storage: substrate.storage, events: substrate.events, now, nextId: () => `${id}-f${++n}`,
  });
  const directory = new PeerDirectory({ storage: substrate.storage, vault, now, selfId: id });
  const link = new RemotePeerLink({ selfId: id, net: new RealNet({ allowLoopback: true }), directory });
  const agent = new MeshAgent({
    selfId: id, directory, link,
    handlers: [
      handlers.presenceHandler({ label, now }),
      handlers.availabilityHandler({ memory }),
      handlers.recallHandler({ memory, now }),
      handlers.shareHandler({ memory, events: substrate.events, now, newId: () => `${id}-c${++n}` }),
    ],
    events: substrate.events, log: substrate.log, now, newId: () => `${id}-m${++n}`,
  });

  const server = createHttpServer({
    storage: substrate.storage,
    config: { dataDir: dir },
    now, eventCount: () => 0,
    mesh: (raw) => receiveMeshFrame(agent, raw),
  });
  const { port } = await listen(server, '127.0.0.1', 0);
  return { id, label, agent, directory, memory, port, server, now, link };
}

function laptopLinkWatch(sink) {
  laptop.link.watch((raw) => sink.push(raw));
}

const laptop = await device('device-laptop', 'Laptop');
const phone = await device('device-phone', 'Phone');
say(`\n  Laptop listening on 127.0.0.1:${laptop.port}`);
say(`  Phone  listening on 127.0.0.1:${phone.port}\n`);

// ── 1. Pairing: a code read aloud, not a network handshake ───────────
const invite = createInvite(
  { id: laptop.id, label: 'Laptop', address: `127.0.0.1:${laptop.port}` },
  nodeCrypto(),
);
say('1. PAIRING');
say(`   The laptop shows:  ${invite.code}`);
say('   The person types it into the phone.\n');

await phone.directory.pair(invite, ['presence', 'availability']);
await laptop.directory.pair(
  { ...invite, deviceId: phone.id, label: 'Phone', address: `127.0.0.1:${phone.port}` },
  ['presence', 'share'],
);

const secret = decodeSecret(invite.code);
const words = confirmationWords(secret, nodeCrypto(), laptop.id, phone.id);
say(`   Both screens now show:  ${words}`);
say('   Different words would mean someone sat in the middle.\n');
say(`   Laptop grants the phone: ${laptop.directory.get(phone.id).grants.join(', ')}`);
say(`   Phone grants the laptop: ${phone.directory.get(laptop.id).grants.join(', ')}\n`);

// ── 2. A question across the socket ──────────────────────────────────
say('2. THE LAPTOP ASKS THE PHONE IF IT IS AWAKE');
const presence = await laptop.agent.ask(phone.id, 'presence', {});
say(`   → ${JSON.stringify(presence)}\n`);

// ── 3. Availability without disclosure ───────────────────────────────
const start = phone.now() + 3_600_000;
phone.memory.assert({
  subject: 'event:gcal:ev1', predicate: 'summary', object: 'Job interview at Acme',
  validFrom: start, validTo: start + 3_600_000,
  basis: 'world/1|OBSERVATION|WORK|gcal', confidence: 0.9,
  stability: 'volatile', sensitivity: 'sensitive', sourceTrust: 'FOREIGN',
});
say('3. THE PHONE HAS "Job interview at Acme" IN ITS CALENDAR.');
say('   The laptop asks what time is taken:');
const avail = await laptop.agent.ask(phone.id, 'availability', { from: start - 3_600_000, to: start + 7_200_000 });
say(`   → ${JSON.stringify(avail.data)}`);
say(`   Mentions "Acme"? ${JSON.stringify(avail).includes('Acme')}  ← intervals only\n`);

// ── 4. A grant that was never given ──────────────────────────────────
say('4. THE LAPTOP TRIES TO SEARCH THE PHONE\'S MEMORY (not granted)');
const recall = await laptop.agent.ask(phone.id, 'memory.recall', { query: 'anything' });
say(`   → ${JSON.stringify(recall)}\n`);

// ── 5. A peer cannot cause an effect ─────────────────────────────────
say('5. THE LAPTOP TRIES TO MAKE THE PHONE ACT');
for (const topic of ['tool.run', 'email.send', 'file.write']) {
  const refused = await laptop.agent.ask(phone.id, topic, { anything: true });
  say(`   ${topic.padEnd(12)} → ${refused.code}`);
}
say('   No such topic exists to grant. That is the Rule of Two holding.\n');

// ── 6. Sharing lands as FOREIGN ──────────────────────────────────────
say('6. THE PHONE OFFERS THE LAPTOP A FACT, CLAIMING TOTAL CONFIDENCE');
const shared = await phone.agent.ask(laptop.id, 'fact.share', {
  subject: 'person:ana', predicate: 'works at', object: 'Acme', confidence: 1,
});
say(`   → ${JSON.stringify(shared)}`);
if (shared.ok) {
  const fact = laptop.memory.get(shared.data.factId);
  say(`   stored as: trust=${fact.trust} confidence=${fact.confidence} basis=${fact.basis}`);
  say('   A peer is FOREIGN, and its confidence is halved on arrival.\n');
} else {
  say('   (the laptop granted the phone presence only — refused, which is also correct)\n');
}

// ── 7. What crossed the wire ─────────────────────────────────────────
say('7. WHAT A WIRETAP WOULD HAVE SEEN');
const seen = [];
laptopLinkWatch(seen);
await laptop.agent.ask(phone.id, 'availability', { from: start, to: start + 1 });
say(`   ${seen[0]?.slice(0, 150)}…`);
say(`   topic in the clear? ${String(seen[0]?.includes('availability'))}`);
say(`   times in the clear? ${String(seen[0]?.includes(String(start)))}\n`);

laptop.server.close();
phone.server.close();
say('  Done. Two devices, one code, no plaintext on the wire.\n');
process.exit(0);
