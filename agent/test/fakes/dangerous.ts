/**
 * A dangerous, non-idempotent, externally-visible tool.
 *
 * Everything about approvals is uninteresting unless the thing being
 * approved actually does something irreversible, so this one keeps a visible
 * tally that a test can count.
 */
import { z } from 'zod';
import type { Tool } from '../../src/capability/tool.js';

export class Ledger {
  readonly charges: Array<{ amount: number; key: string }> = [];
  get total(): number {
    return this.charges.reduce((sum, c) => sum + c.amount, 0);
  }
}

export function makeChargeTool(ledger: Ledger): Tool<{ amount: number; to: string }, { chargeId: string }> {
  return {
    name: 'payments.charge',
    version: '1',
    description: 'Charges the card on file. Irreversible without a refund.',
    input: z.object({ amount: z.number().positive(), to: z.string() }),
    output: z.object({ chargeId: z.string() }),
    capabilities: ['spend'],
    minTrust: 'USER',
    risk: 'dangerous',
    effect: 'external',
    idempotent: false,
    timeoutMs: 1000,
    async execute(input, ctx) {
      const key = ctx.idempotencyKey ?? 'no-key';
      ledger.charges.push({ amount: input.amount, key });
      return { ok: true, value: { chargeId: `ch_${key.slice(0, 6)}` }, trust: 'TOOL' };
    },
    renderForModel: (result) =>
      result.ok
        ? { text: `charged: ${result.value.chargeId}`, truncated: false }
        : { text: `charge failed: ${result.error.message}`, truncated: false },
    async dryRun(input) {
      return `would charge $${(input.amount / 100).toFixed(2)} to ${input.to}`;
    },
    async compensate() {
      ledger.charges.pop();
    },
    async queryEffect(key) {
      const found = ledger.charges.find((c) => c.key === key);
      return found === undefined ? { happened: false } : { happened: true, remoteRef: 'ch_x' };
    },
  };
}
