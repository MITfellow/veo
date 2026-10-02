/**
 * `vault.list` — the secret-touching tool (§20).
 *
 * It proves the vault boundary holds *through a tool*: the agent can find out
 * which credentials exist, so it can reason about what it is able to do, and
 * it cannot learn a single byte of any of them.
 *
 * Note what the output schema does **not** have: any field a value could fit
 * in. The guarantee is structural, not a matter of remembering to redact.
 */
import { z } from 'zod';
import type { Tool } from '../capability/tool.js';
import type { Vault } from '../security/vault.js';

const Input = z.object({});

const Output = z.object({
  secrets: z.array(
    z.object({
      name: z.string(),
      version: z.number().int(),
      label: z.string().nullable(),
      createdAt: z.number().int(),
      lastReadAt: z.number().int().nullable(),
      readCount: z.number().int(),
    }),
  ),
});

export function makeVaultList(vault: Vault): Tool<z.infer<typeof Input>, z.infer<typeof Output>> {
  return {
    name: 'vault.list',
    version: '1',
    description:
      'Lists the names of the credentials available to you, with no values. Use it to check ' +
      'whether a credential exists before attempting something that needs one.',
    input: Input,
    output: Output,
    capabilities: ['vault:list'],
    minTrust: 'USER',
    risk: 'safe',
    effect: 'local',
    idempotent: true,
    timeoutMs: 2000,

    async execute() {
      const rows = vault.list();
      return {
        ok: true,
        value: {
          secrets: rows.map((row) => ({
            name: row.name,
            version: row.version,
            label: row.label ?? null,
            createdAt: row.createdAt,
            lastReadAt: row.lastReadAt ?? null,
            readCount: row.readCount,
          })),
        },
        trust: 'SYSTEM',
      };
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      if (result.value.secrets.length === 0) {
        return { text: 'No credentials are stored.', truncated: false };
      }
      const lines = result.value.secrets.map(
        (s) => `- ${s.name} (v${s.version}${s.label !== null ? `, ${s.label}` : ''})`,
      );
      return {
        text: `Credentials available (names only, values are never readable):\n${lines.join('\n')}`,
        truncated: false,
      };
    },
  };
}
