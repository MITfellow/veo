import { ItemCipher } from './cipher.js';
import { PRODUCTION_ARGON2, TEST_ARGON2, WebCrypto, seededRandomSource } from './crypto.js';
import { Audit } from './audit.js';
import { ModelRequestFirewall } from './firewall.js';
import { Keyring } from './keyring.js';
import { ShreddingCipher, Shredder } from './shred.js';
import { Vault } from './vault.js';
import type { Argon2Params, RandomSource } from './crypto.js';
import type { Substrate } from '../substrate/index.js';

/**
 * L2 composition root.
 *
 * `createSecurity(substrate)` and you have the whole layer. The wiring order
 * matters in exactly one place: the vault must be able to tell both the
 * `Redactor` (so leaked secrets are stripped at append) and the firewall (so
 * they are caught on the way out) about every value it unwraps. That is done
 * here, once, rather than left to each call site to remember.
 */
export interface Security {
  crypto: WebCrypto;
  keyring: Keyring;
  vault: Vault;
  cipher: ShreddingCipher;
  shredder: Shredder;
  firewall: ModelRequestFirewall;
  audit: Audit;
}

export interface SecurityOptions {
  argon2?: Argon2Params;
  random?: RandomSource;
}

export function createSecurity(substrate: Substrate, options: SecurityOptions = {}): Security {
  const crypto = new WebCrypto(options.random, options.argon2 ?? PRODUCTION_ARGON2);
  const keyring = new Keyring(substrate.storage, crypto, substrate.clock);
  const firewall = new ModelRequestFirewall();

  // The redactor the vault registers values with is M0's — the same instance
  // the event log uses at append time. One registration protects every event
  // written for the rest of the process.
  const redactor = substrate.redactor;

  // A thin façade so a registration reaches *both* nets. Without this, a
  // secret could be stripped from events but still sail into a model request,
  // which is precisely the gap §13.2 asks the firewall to close.
  const dualRegister = {
    register(value: string, label: string): void {
      redactor.register(value, label);
      firewall.register(value, label);
    },
    redact: redactor.redact.bind(redactor),
    redactString: redactor.redactString.bind(redactor),
    unregister: redactor.unregister.bind(redactor),
    addRule: redactor.addRule.bind(redactor),
    knownCount: redactor.knownCount.bind(redactor),
    leaks: redactor.leaks.bind(redactor),
  } as typeof redactor;

  const vault = new Vault(
    substrate.storage,
    keyring,
    crypto,
    substrate.events,
    dualRegister,
    substrate.clock,
  );

  const shredder = new Shredder(substrate.storage, substrate.events, substrate.clock);
  const cipher = new ShreddingCipher(new ItemCipher(keyring, crypto), shredder);

  const audit = new Audit(substrate.events);

  return { crypto, keyring, vault, cipher, shredder, firewall, audit };
}

/** The same layer at a cost the test suite can afford (D-010). */
export function createTestSecurity(substrate: Substrate, seed = 1): Security {
  return createSecurity(substrate, { argon2: TEST_ARGON2, random: seededRandomSource(seed) });
}

export { WebCrypto, DecryptionError, zeroize, timingSafeEqual, seededRandomSource } from './crypto.js';
export { PRODUCTION_ARGON2, TEST_ARGON2, KEY_BYTES, NONCE_BYTES } from './crypto.js';
export type { Argon2Params, RandomSource } from './crypto.js';
export { Keyring, KeyringError, LockedError, normalizeRecoveryCode } from './keyring.js';
export type { KeyringState, InitResult } from './keyring.js';
export { Vault, VaultError, parseSecretRef, makeSecretRef } from './vault.js';
export type { SecretRef, SecretMetadata, UseSecretContext } from './vault.js';
export { ItemCipher } from './cipher.js';
export { Shredder, ShreddingCipher } from './shred.js';
export type { Tombstone } from './shred.js';
export { Audit, PRIVILEGED_EVENT_TYPES } from './audit.js';
export type { AuditQuery, ForgottenItem, SecretUsage } from './audit.js';
export { ModelRequestFirewall, SecretLeakError } from './firewall.js';
export type { FirewallViolation } from './firewall.js';
export * from './trust.js';
