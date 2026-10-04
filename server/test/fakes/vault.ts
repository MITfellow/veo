import { Vault, type VaultEvents } from '../../src/security/vault.js';
import { TEST_ARGON2 } from '../../src/security/kdf.js';
import { createTestSubstrate, type TestSubstrate } from './substrate.js';

export interface RecordedVaultEvent {
  kind: string;
  detail: Record<string, unknown>;
}

/** Captures what the vault reports, so tests can assert no value ever appears. */
export function recordingEvents(): { events: VaultEvents; recorded: RecordedVaultEvent[] } {
  const recorded: RecordedVaultEvent[] = [];
  const push = (kind: string, detail: Record<string, unknown>): void => void recorded.push({ kind, detail });
  return {
    recorded,
    events: {
      secretCreated: (ref, at) => push('secret.created', { reference: ref.uri, at }),
      secretRead: (ref, ctx, at) => push('secret.read', { reference: ref.uri, ...ctx, at }),
      unlocked: (at) => push('unlocked', { at }),
      locked: (at, reason) => push('locked', { at, reason }),
      destroyed: (at) => push('destroyed', { at }),
      itemShredded: (keyId, at) => push('item.shredded', { keyId, at }),
    },
  };
}

export interface VaultHarness {
  substrate: TestSubstrate;
  vault: Vault;
  recorded: RecordedVaultEvent[];
  close(): void;
}

/**
 * A vault on an in-memory database with cheap Argon2 parameters.
 *
 * Cheap parameters are not a weakened test (decision 005): the subject is the
 * key hierarchy, and one shipping-strength derivation costs ~330 ms against a
 * 60 s budget for the whole suite. `kdf.test.ts` asserts the shipping values.
 */
export async function vaultHarness(options: { idleLockMinutes?: number; dbPath?: string; init?: boolean } = {}): Promise<VaultHarness & { recoveryCode: string }> {
  const substrate = createTestSubstrate(options.dbPath === undefined ? {} : { dbPath: options.dbPath });
  const { events, recorded } = recordingEvents();
  const vault = new Vault({
    storage: substrate.storage,
    clock: substrate.clock,
    argon2: TEST_ARGON2,
    idleLockMinutes: options.idleLockMinutes ?? 60,
    events,
  });
  let recoveryCode = '';
  if (options.init !== false) {
    recoveryCode = (await vault.init('correct horse battery staple')).recoveryCode;
    await vault.unlock('correct horse battery staple');
  }
  return { substrate, vault, recorded, recoveryCode, close: () => substrate.close() };
}
