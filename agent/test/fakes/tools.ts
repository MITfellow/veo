/**
 * Test tools, including the deliberately external one used to prove the
 * outbox. It lives here rather than in `src/tools/` because §20 says only
 * nine tools ship as built-ins — and because a fake remote is a better test
 * subject: it can be made to crash at the exact instruction that matters.
 */
import { z } from 'zod';
import type { EffectStatus, Tool, ToolResult } from '../../src/capability/tool.js';

/** A remote that records what it was actually asked to do. */
export class FakeRemote {
  readonly sends: Array<{ key: string; to: string; body: string }> = [];
  /** Set to throw at the moment of sending, simulating a crash mid-effect. */
  crashOnSend: ((key: string) => void) | null = null;
  /** When false, the remote cannot answer "did this already happen?". */
  queryable = true;

  send(key: string, to: string, body: string): string {
    this.crashOnSend?.(key);
    this.sends.push({ key, to, body });
    return `remote-${this.sends.length}`;
  }

  status(key: string): EffectStatus {
    if (!this.queryable) return { happened: 'unknown' };
    const index = this.sends.findIndex((s) => s.key === key);
    return index === -1 ? { happened: false } : { happened: true, remoteRef: `remote-${index + 1}` };
  }

  get count(): number {
    return this.sends.length;
  }
}

const SendInput = z.object({ to: z.string(), body: z.string() });
const SendOutput = z.object({ remoteRef: z.string() });

/**
 * An external, NON-idempotent effect — the dangerous shape. Sending twice
 * means the recipient gets two messages, which is the failure the outbox
 * exists to prevent.
 */
export function makeSendTool(
  remote: FakeRemote,
  options: { queryable?: boolean; idempotent?: boolean } = {},
): Tool<z.infer<typeof SendInput>, z.infer<typeof SendOutput>> {
  const tool: Tool<z.infer<typeof SendInput>, z.infer<typeof SendOutput>> = {
    name: 'test.send',
    version: '1',
    description: 'Sends a message to a recipient. This leaves the building and cannot be undone.',
    input: SendInput,
    output: SendOutput,
    capabilities: ['send'],
    minTrust: 'USER',
    risk: 'caution',
    effect: 'external',
    idempotent: options.idempotent ?? false,
    timeoutMs: 2000,

    async execute(input, ctx) {
      // The key comes from the context, which is what lets the remote
      // deduplicate authoritatively rather than us guessing afterwards.
      const ref = remote.send(ctx.idempotencyKey ?? 'unkeyed', input.to, input.body);
      return { ok: true, value: { remoteRef: ref }, trust: 'TOOL' };
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      return { text: `Sent (ref ${result.value.remoteRef}).`, truncated: false };
    },

    async compensate(result) {
      if (result.ok) remote.sends.pop();
    },
  };

  if (options.queryable ?? true) {
    tool.queryEffect = async (key): Promise<EffectStatus> => remote.status(key);
  }
  return tool;
}

/* ───────────────────────────── misc test tools ───────────────────────────── */

export const echoTool: Tool<{ text: string }, { echoed: string }> = {
  name: 'test.echo',
  version: '1',
  description: 'Echoes back the text it is given, for testing the pipeline.',
  input: z.object({ text: z.string() }),
  output: z.object({ echoed: z.string() }),
  capabilities: [],
  minTrust: 'FOREIGN',
  risk: 'safe',
  effect: 'pure',
  idempotent: true,
  timeoutMs: 1000,
  async execute(input) {
    return { ok: true, value: { echoed: input.text }, trust: 'SYSTEM' };
  },
  renderForModel(result) {
    return {
      text: result.ok ? result.value.echoed : result.error.message,
      truncated: false,
    };
  },
};

/** Returns something its own output schema rejects. */
export const liarTool: Tool<Record<string, never>, { n: number }> = {
  name: 'test.liar',
  version: '1',
  description: 'Claims to return a number but returns a string, to test output validation.',
  input: z.object({}),
  output: z.object({ n: z.number() }),
  capabilities: [],
  minTrust: 'FOREIGN',
  risk: 'safe',
  effect: 'pure',
  idempotent: true,
  timeoutMs: 1000,
  async execute() {
    return { ok: true, value: { n: 'not a number' } as unknown as { n: number }, trust: 'SYSTEM' };
  },
  renderForModel() {
    return { text: 'should never be rendered', truncated: false };
  },
};

export const throwerTool: Tool<Record<string, never>, Record<string, never>> = {
  name: 'test.thrower',
  version: '1',
  description: 'Throws an exception instead of returning a result, to test the contract break.',
  input: z.object({}),
  output: z.object({}),
  capabilities: [],
  minTrust: 'FOREIGN',
  risk: 'safe',
  effect: 'pure',
  idempotent: true,
  timeoutMs: 1000,
  async execute() {
    throw new Error('I am a badly written tool');
  },
  renderForModel() {
    return { text: '', truncated: false };
  },
};

/** Never resolves, and ignores its abort signal. */
export const hangingTool: Tool<Record<string, never>, Record<string, never>> = {
  name: 'test.hangs',
  version: '1',
  description: 'Never returns and ignores its abort signal, to test the timeout bound.',
  input: z.object({}),
  output: z.object({}),
  capabilities: [],
  minTrust: 'FOREIGN',
  risk: 'safe',
  effect: 'pure',
  idempotent: true,
  timeoutMs: 40,
  async execute() {
    return new Promise(() => {
      /* deliberately never settles, and never checks ctx.signal */
    });
  },
  renderForModel() {
    return { text: '', truncated: false };
  },
};

/** Needs a capability FOREIGN does not have. */
export const spenderTool: Tool<{ amount: number }, { paid: boolean }> = {
  name: 'test.spend',
  version: '1',
  description: 'Spends money, to test that the capability gate actually refuses.',
  input: z.object({ amount: z.number() }),
  output: z.object({ paid: z.boolean() }),
  capabilities: ['spend'],
  minTrust: 'USER',
  risk: 'caution',
  effect: 'local',
  idempotent: false,
  timeoutMs: 1000,
  async execute() {
    return { ok: true, value: { paid: true }, trust: 'SYSTEM' };
  },
  renderForModel() {
    return { text: 'paid', truncated: false };
  },
};

/** Returns a result far too large for any context. */
export const firehoseTool: Tool<{ size: number }, { blob: string }> = {
  name: 'test.firehose',
  version: '1',
  description: 'Returns a very large string, to test that artifacts absorb oversized results.',
  input: z.object({ size: z.number().int().positive() }),
  output: z.object({ blob: z.string() }),
  capabilities: [],
  minTrust: 'FOREIGN',
  risk: 'safe',
  effect: 'pure',
  idempotent: true,
  timeoutMs: 5000,
  async execute(input) {
    return { ok: true, value: { blob: 'x'.repeat(input.size) }, trust: 'FOREIGN' };
  },
  renderForModel(result, budget) {
    if (!result.ok) return { text: result.error.message, truncated: false };
    const limit = budget * 4;
    // The tool truncates, because the tool knows what matters.
    return {
      text: `${result.value.blob.length} bytes of data: ${result.value.blob.slice(0, limit)}…`,
      truncated: result.value.blob.length > limit,
    };
  },
};

export type AnyResult = ToolResult<unknown>;

/**
 * A tool that returns attacker-controlled text and *claims* it is trusted.
 *
 * This is the shape of every real prompt-injection: the content arrives
 * through a channel that cannot vouch for it, carrying instructions aimed
 * at the model. The tool asserting `SYSTEM` is part of the test — trust is
 * a property of the channel, not a field the payload gets to set.
 */
export const foreignTool: Tool<{ claim: string }, { content: string }> = {
  name: 'test.foreign',
  version: '1',
  description: 'Fetches text from an untrusted external source.',
  input: z.object({ claim: z.string() }),
  output: z.object({ content: z.string() }),
  capabilities: [],
  minTrust: 'FOREIGN',
  risk: 'safe',
  effect: 'external',
  idempotent: true,
  timeoutMs: 1000,
  async execute(input) {
    return { ok: true, value: { content: input.claim }, trust: 'FOREIGN' };
  },
  renderForModel(result) {
    return result.ok
      ? { text: result.value.content, truncated: false }
      : { text: 'fetch failed', truncated: false };
  },
};
