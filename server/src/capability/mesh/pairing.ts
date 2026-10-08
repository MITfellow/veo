import type { CryptoPort } from '../../substrate/ports.js';
import { MeshError, PROTOCOL_VERSION } from './types.js';

// Key derivation lives in `security/link.ts`: nothing outside
// `src/security` may touch the raw-bytes layer (containment.test.ts).
export { deriveLinkKeys, type LinkKeys } from '../../security/link.js';

/**
 * How two agents come to know each other.
 *
 * Pairing is **out of band and human-carried**: one device shows a code,
 * the person reads it to the other. That is a deliberate rejection of
 * the convenient alternatives:
 *
 *   - *Discover peers on the LAN and trust them.* Anything on the café
 *     wifi is then a peer.
 *   - *Trust anything holding the same account.* That makes the account
 *     provider the root of trust for the user's private machine, which
 *     is the thing this whole build exists to avoid.
 *   - *Trust on first use.* The first use is exactly when an attacker
 *     would like to be present.
 *
 * A person reading six groups of letters aloud is slow, and slow is the
 * point: pairing happens once per device pair, and the cost of the
 * ceremony is what makes the resulting link worth something.
 *
 * The code *is* the secret. Everything else in an invite — device id,
 * label, address — is routing information and is not confidential.
 */

/** Crockford base32, minus I, L, O, U: no character pair a human confuses. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 128 bits. Twenty-six characters is about the limit of what gets typed. */
export const SECRET_BYTES = 16;

export interface Invite {
  deviceId: string;
  label: string;
  /** Empty for an in-device link: there is nothing to dial. */
  address: string;
  /** The shared secret, base32, grouped for reading aloud. */
  code: string;
}

export interface DeviceIdentity {
  id: string;
  label: string;
  address: string;
}

export function encodeSecret(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function decodeSecret(code: string): Uint8Array {
  const clean = code.toUpperCase().replace(/[^0-9A-Z]/g, '')
    .replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new MeshError('bad_code', `'${char}' is not part of a pairing code.`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bytes.length !== SECRET_BYTES) {
    throw new MeshError('bad_code', `A pairing code is ${SECRET_BYTES * 8} bits; this one is ${bytes.length * 8}.`);
  }
  return new Uint8Array(bytes);
}

/** Groups of four, which is how people read strings aloud without losing place. */
export function groupCode(code: string): string {
  return (code.match(/.{1,4}/g) ?? []).join('-');
}

export function createInvite(identity: DeviceIdentity, crypto: CryptoPort): Invite {
  return {
    deviceId: identity.id,
    label: identity.label,
    address: identity.address,
    code: groupCode(encodeSecret(crypto.randomBytes(SECRET_BYTES))),
  };
}

/**
 * The transferable form.
 *
 * One line, so it survives being pasted into a chat, printed as a QR
 * code, or read down a phone. The code is in it, so this whole string is
 * as secret as the code.
 */
export function encodeInvite(invite: Invite): string {
  const parts = [String(PROTOCOL_VERSION), invite.deviceId, invite.label, invite.address, invite.code];
  return `arish-pair:${parts.map((p) => encodeURIComponent(p)).join(':')}`;
}

export function decodeInvite(raw: string): Invite {
  const [scheme, ...rest] = raw.trim().split(':');
  if (scheme !== 'arish-pair' || rest.length !== 5) {
    throw new MeshError('bad_code', 'That is not an ARISH pairing invite.');
  }
  const [version, deviceId, label, address, code] = rest.map((p) => decodeURIComponent(p));
  if (version !== String(PROTOCOL_VERSION)) {
    throw new MeshError('bad_code', `This invite speaks protocol ${String(version)}; this build speaks ${PROTOCOL_VERSION}.`);
  }
  if (deviceId === undefined || code === undefined) throw new MeshError('bad_code', 'The invite is incomplete.');
  decodeSecret(code); // throws now rather than at the first frame
  return { deviceId, label: label ?? deviceId, address: address ?? '', code };
}

/**
 * A short digest both devices can show the user after pairing.
 *
 * If the two screens show different words, someone sat in the middle of
 * the exchange. It costs one glance and it is the only defence against a
 * code read aloud in a room with an attacker in it.
 */
export function confirmationWords(secret: Uint8Array, crypto: CryptoPort, aId: string, bId: string): string {
  const [first, second] = aId < bId ? [aId, bId] : [bId, aId];
  const digest = crypto.sha256(`arish/mesh/confirm/${first}/${second}/${encodeSecret(secret)}`);
  return groupCode(encodeSecret(hexToBytes(digest.slice(0, 10))).slice(0, 8));
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
