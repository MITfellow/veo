import { isIP } from 'node:net';

/**
 * Which addresses are inside the trust boundary.
 *
 * In the substrate, not in `security/`, for one reason: both the policy
 * layer (which refuses a URL before a request is built) and the transport
 * (which refuses an address after resolution) need exactly this answer, and
 * two copies of a security table is one copy that will be updated.
 *
 * Each row names the range and what reaching it would mean. Adding a range
 * is adding a line, and the whole policy can be read at once instead of
 * traced through an `if` chain where a missing `else` permits a network.
 */

interface RangeRule {
  readonly why: string;
  readonly hit: (parts: readonly number[]) => boolean;
}

const V4_RULES: readonly RangeRule[] = [
  { why: 'private 10/8', hit: ([a]) => a === 10 },
  { why: 'loopback 127/8', hit: ([a]) => a === 127 },
  { why: 'this-network 0/8', hit: ([a]) => a === 0 },
  { why: 'private 172.16/12', hit: ([a, b = 0]) => a === 172 && b >= 16 && b <= 31 },
  { why: 'private 192.168/16', hit: ([a, b]) => a === 192 && b === 168 },
  { why: 'link-local 169.254/16, including cloud metadata', hit: ([a, b]) => a === 169 && b === 254 },
  { why: 'carrier-grade NAT 100.64/10', hit: ([a, b = 0]) => a === 100 && b >= 64 && b <= 127 },
  { why: 'multicast and reserved 224/3', hit: ([a = 0]) => a >= 224 },
];

const V6_PREFIXES: readonly { why: string; prefix: string }[] = [
  { why: 'unique local fc00::/7', prefix: 'fc' },
  { why: 'unique local fc00::/7', prefix: 'fd' },
  { why: 'link-local fe80::/10', prefix: 'fe80' },
  { why: 'IPv4-mapped, which would bypass the v4 rules', prefix: '::ffff:' },
];

/**
 * Why this host is unreachable, or `null` if it is a public address.
 *
 * A hostname that is not a literal address returns `null` here: it cannot
 * be judged until it resolves, and judging it twice — once by name, once
 * by address — is the TOCTOU hole that DNS rebinding walks through.
 */
export function privateReason(host: string): string | null {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost') return 'loopback by name';

  const version = isIP(bare);
  if (version === 4) {
    const parts = bare.split('.').map(Number);
    return V4_RULES.find((rule) => rule.hit(parts))?.why ?? null;
  }
  if (version === 6) {
    if (bare === '::1') return 'loopback ::1';
    if (bare === '::') return 'unspecified ::';
    return V6_PREFIXES.find((rule) => bare.startsWith(rule.prefix))?.why ?? null;
  }
  return null;
}

/** Cloud metadata endpoints, refused whatever any allow-list says. */
export const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'fd00:ec2::254',
]);
