/**
 * Block templates (§21, L4).
 *
 * > "Every block renders through a named, versioned template file. No prompt
 * > strings scattered in logic."
 *
 * The rule is enforced by shape: the assembler never contains a prompt
 * string. It asks a template for **items**, measures them, decides what
 * fits, and joins the survivors. Templates never see the budget; the
 * assembler never sees the words. That split is what lets eviction drop
 * *whole items* without knowing what an item means.
 *
 * Versions are per template and per set. A golden-file diff tells you
 * something changed; the version tells you whether it was meant to.
 */
import type { StateSnapshot, BlockName } from '../types.js';
import type { ContextPolicy } from '../policy.js';
import { KERNEL, CONSTITUTION, IDENTITY, CONSTRAINTS } from './kernel.js';
import { SITUATION, COMMITMENTS, CALIBRATION } from './situation.js';
import { PINNED, MEMORIES } from './memory.js';
import { WORKING, CONVERSATION, COMPACTED } from './working.js';
import { TOOLS } from './tools.js';
import { FOREIGN } from './foreign.js';

/**
 * One droppable unit.
 *
 * `id` is stable and meaningful (an event id, a fact id, a tool name) so an
 * eviction report points at something a human can go look up.
 */
export interface RenderedItem {
  id: string;
  text: string;
  /** Turn role, for the conversation block. Everything else is system text. */
  role?: 'user' | 'assistant';
  /** Carried through so the model message keeps the provenance it arrived with. */
  trust?: import('../../../substrate/events/types.js').TrustLevel;
}

export interface RenderContext {
  policy: ContextPolicy;
  now: number;
  /** Effective trust of the step being assembled for. Filters tools. */
  trust: import('../../../substrate/events/types.js').TrustLevel;
  countTokens: (text: string) => number;
}

export interface Template {
  name: BlockName;
  version: string;
  /**
   * `system` blocks are joined into one system message under `header`.
   * `turns` blocks become one model message per item, in order.
   */
  kind: 'system' | 'turns';
  /** Prepended when the block renders at least one item. */
  header?: string;
  /**
   * Rendered when the block lost items to the budget, so the *model* knows
   * something is missing. A drop the caller can see but the model cannot is
   * still a lie, just a better-documented one.
   */
  elision?: (dropped: number) => string;
  render(snapshot: StateSnapshot, ctx: RenderContext): RenderedItem[];
}

export const TEMPLATES: Readonly<Record<BlockName, Template>> = Object.freeze({
  kernel: KERNEL,
  constitution: CONSTITUTION,
  identity: IDENTITY,
  constraints: CONSTRAINTS,
  situation: SITUATION,
  commitments: COMMITMENTS,
  calibration: CALIBRATION,
  pinned: PINNED,
  memories: MEMORIES,
  working: WORKING,
  conversation: CONVERSATION,
  compacted: COMPACTED,
  tools: TOOLS,
  foreign: FOREIGN,
});

/** Bumped when any template changes. Travels in `context.assembled`. */
export const TEMPLATE_SET_VERSION = 'tpl-1';
