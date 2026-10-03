/**
 * Context assembly (§21, L4) — the single highest-value artifact in the
 * system, and a **pure function**.
 *
 *   pure          no clock, no storage, no I/O; everything arrives in the input
 *   deterministic same input, byte-identical output, forever
 *   budgeted      given a ceiling, never exceeds it
 *   logged        returns a digest and a block/eviction report for
 *                 `context.assembled`, which is how "why did it say that?"
 *                 gets answered months later
 *
 * That is invariant 4, and it is the reason twelve golden scenarios are a
 * checked-in snapshot object and a text file rather than a running system.
 *
 * ## The shape of the algorithm
 *
 *   1. render every block through its template → items with stable ids
 *   2. price every item (memoized by content, §33's 100ms bar)
 *   3. prove the unevictable four fit, or refuse outright
 *   4. fill in **survival order**, each block capped by its share, with
 *      unspent share flowing down to lower-priority blocks
 *   5. re-render the survivors in **render order** into messages
 *
 * Steps 4 and 5 use different orders, which is the whole trick: what dies
 * last and what is read first are different questions.
 *
 * ## What changed from M2, and why the signature moved
 *
 * M2's header claimed this signature would survive to M5. It did not, and
 * pretending otherwise would have meant bending §21 to fit an interim
 * convenience (§36 says say so instead). §21 specifies a gathered
 * `snapshot` plus a `policy`; M2 took loose `system`/`situation`/`history`
 * with no policy and no principal. Three blocks fit through that hole and
 * fourteen do not — per-block budgets, per-model shares and sensitivity
 * rules all need the policy the old signature had nowhere to put.
 */
import {
  RENDER_ORDER,
  SURVIVAL_ORDER,
  UNEVICTABLE,
  type AssembledBlock,
  type AssembledContext,
  type BlockName,
  type Eviction,
  type StateSnapshot,
} from './types.js';
import { assertUnevictableFits, resolveBudgets, type ContextPolicy } from './policy.js';
import { TEMPLATES, TEMPLATE_SET_VERSION, type RenderedItem } from './templates/index.js';
import { digestOf, estimateTokens } from '../tokens.js';
import type { ModelMessage } from '../../substrate/model/types.js';
import type { TrustLevel } from '../../substrate/events/types.js';

export { ContextTooSmallError } from './types.js';
export type {
  StateSnapshot,
  AssembledContext,
  AssembledBlock,
  Eviction,
  BlockName,
  Turn,
  MemoryItem,
} from './types.js';
export {
  FENCE_OPEN,
  FENCE_CLOSE,
  FENCE_NOTE,
  fenceText,
  fenceTurn,
  defang,
} from './templates/foreign.js';

export interface AssemblyInput {
  principal: string;
  sessionId: string;
  snapshot: StateSnapshot;
  policy: ContextPolicy;
  /** Effective trust of the step this context is for. Filters tools (§21 #13). */
  trust: TrustLevel;
  now: number;
  /**
   * Token counter. Injected, not imported: models count differently, and a
   * module-level tokenizer would make assembly stateful. Pass a `TokenCache`
   * bound method for the 100ms path — output is identical either way.
   */
  countTokens?: (text: string) => number;
}

interface PricedItem extends RenderedItem {
  tokens: number;
}

interface PricedBlock {
  name: BlockName;
  items: PricedItem[];
  /** Fixed overhead for the header, charged only if the block renders. */
  headerTokens: number;
}

export function assembleContext(input: AssemblyInput): AssembledContext {
  const countTokens = input.countTokens ?? estimateTokens;
  const { policy, snapshot } = input;
  const budgets = resolveBudgets(policy);
  const ctx = { policy, now: input.now, trust: input.trust, countTokens };

  /* ── 1 & 2: render and price ──────────────────────────────────────────── */

  const priced = new Map<BlockName, PricedBlock>();
  const cost: Record<BlockName, number> = {} as Record<BlockName, number>;

  for (const name of SURVIVAL_ORDER) {
    const template = TEMPLATES[name];
    const items = template
      .render(snapshot, ctx)
      .map((item): PricedItem => ({ ...item, tokens: countTokens(item.text) }));
    const headerTokens = template.header === undefined ? 0 : countTokens(template.header);
    priced.set(name, { name, items, headerTokens });
    cost[name] =
      items.length === 0 ? 0 : headerTokens + items.reduce((sum, item) => sum + item.tokens, 0);
  }

  /* ── 3: the four that may never be dropped ────────────────────────────── */

  assertUnevictableFits(cost, budgets.total);

  /* ── 4: allocate, then fill ───────────────────────────────────────────── */

  const allowance = allocate(cost, budgets);
  const kept = new Map<BlockName, PricedItem[]>();
  const evictions: Eviction[] = [];

  for (const name of SURVIVAL_ORDER) {
    const block = priced.get(name);
    if (block === undefined || block.items.length === 0) {
      kept.set(name, []);
      continue;
    }
    const result = fill(block, allowance[name], countTokens);
    kept.set(name, result.kept);
    for (const item of result.dropped) {
      evictions.push({ block: name, id: item.id, reason: 'budget', tokens: item.tokens });
    }
  }

  /* ── 5: render the survivors, in reading order ────────────────────────── */

  const messages: ModelMessage[] = [];
  const blocks: AssembledBlock[] = [];

  for (const name of RENDER_ORDER) {
    const template = TEMPLATES[name];
    const items = kept.get(name) ?? [];
    const droppedHere = evictions.filter((e) => e.block === name).length;
    if (items.length === 0 && droppedHere === 0) continue;

    const elision =
      droppedHere > 0 && template.elision !== undefined ? template.elision(droppedHere) : null;

    if (template.kind === 'turns') {
      // The elision note leads the turns it replaces, where a reader (and a
      // model) expects to find out that something is missing: before the
      // gap, not after it.
      if (elision !== null) {
        messages.push({ role: 'system', content: elision, trust: 'SYSTEM' });
      }
      for (const item of items) {
        messages.push({
          role: item.role ?? 'user',
          content: item.text,
          trust: item.trust ?? 'USER',
        });
      }
    } else {
      if (items.length === 0 && elision === null) continue;
      const parts: string[] = [];
      if (template.header !== undefined && items.length > 0) parts.push(template.header);
      for (const item of items) parts.push(item.text);
      if (elision !== null) parts.push(elision);
      const content = parts.join('\n');
      if (content.trim() === '') continue;
      messages.push({ role: 'system', content, trust: 'SYSTEM' });
    }

    blocks.push({
      name,
      tokens: blockTokens(template.kind, items, template, countTokens, elision),
      items: items.length,
    });
  }

  const totalTokens = blocks.reduce((sum, block) => sum + block.tokens, 0);

  return {
    messages,
    tools: toolSpecs(snapshot, kept.get('tools') ?? []),
    blocks,
    totalTokens,
    evictions,
    truncated: evictions.length > 0,
    digest: digestOf([
      policy.version,
      TEMPLATE_SET_VERSION,
      input.principal,
      input.sessionId,
      ...messages.map((message) => `${message.role}:${message.content}`),
    ]),
    policyVersion: `${policy.version}/${TEMPLATE_SET_VERSION}`,
  };
}

/* ──────────────────────────────── helpers ───────────────────────────────── */

/**
 * Turn shares into actual allowances.
 *
 *   pass 1 — everyone gets up to their declared share, and no more
 *   pass 2 — the surplus nobody claimed is split **in proportion to share**
 *            among the blocks that still want more
 *   pass 3 — any rounding remainder goes down survival order
 *
 * Pass 2 is the part a golden file argued me out of. The first version
 * walked survival order and let each block take everything the blocks below
 * it did not strictly need. At a 2,400-token window that gave retrieved
 * memories 1,003 tokens — 42% of the window against a declared share of 16%
 * — while eleven live conversation turns were evicted to pay for it. Both
 * the number and the eviction were invisible in the config.
 *
 * The fix separates two things that are not the same question:
 *
 *   *who dies when there is not enough room* — survival priority (§21), and
 *   *who gets the slack when there is room to spare* — the declared shares.
 *
 * §21's table ranks memories above conversation for **survival**, and that
 * is still exactly what happens under pressure. But it does not say a
 * higher-priority block should get a bigger allowance than its own declared
 * share while a lower one goes unmet; that would make the share decorative,
 * and a budget nobody can predict from the config is not a budget.
 *
 * A block that is empty or small still releases its share — that is the
 * whole point, and it is why a cold start spends the memory share on
 * conversation instead of holding it open for memories that do not exist.
 */
function allocate(
  cost: Record<BlockName, number>,
  budgets: ReturnType<typeof resolveBudgets>,
): Record<BlockName, number> {
  const allowance = {} as Record<BlockName, number>;
  let spent = 0;

  for (const name of SURVIVAL_ORDER) {
    // The four unevictable blocks take what they need; `assertUnevictableFits`
    // has already proven the total is affordable.
    const cap = UNEVICTABLE.has(name) ? cost[name] : budgets.byBlock[name].tokens;
    const give = Math.min(cost[name], cap);
    allowance[name] = give;
    spent += give;
  }

  let surplus = Math.max(0, budgets.total - spent);
  if (surplus === 0) return allowance;

  const wanting = SURVIVAL_ORDER.filter((name) => cost[name] > allowance[name]);
  const shareTotal = wanting.reduce((sum, name) => sum + budgets.byBlock[name].share, 0);

  if (shareTotal > 0) {
    for (const name of wanting) {
      const entitlement = Math.floor((surplus * budgets.byBlock[name].share) / shareTotal);
      const take = Math.min(cost[name] - allowance[name], entitlement);
      allowance[name] += take;
    }
    spent = SURVIVAL_ORDER.reduce((sum, name) => sum + allowance[name], 0);
    surplus = Math.max(0, budgets.total - spent);
  }

  // Rounding crumbs, and anything released because a block's proportional
  // entitlement exceeded what it actually wanted. Survival order here is
  // right: this is the leftover nobody had a claim on.
  for (const name of SURVIVAL_ORDER) {
    if (surplus <= 0) break;
    const unmet = cost[name] - allowance[name];
    if (unmet <= 0) continue;
    const take = Math.min(unmet, surplus);
    allowance[name] += take;
    surplus -= take;
  }

  return allowance;
}

interface FillResult {
  kept: PricedItem[];
  dropped: PricedItem[];
  spent: number;
}

/**
 * Fit items into an allowance, dropping **whole items** (§21: never truncate
 * mid-structure).
 *
 * Direction matters and differs by block, so it is derived from the template
 * kind rather than configured: conversations drop their *oldest* turns and
 * scored lists drop their *lowest-scoring* tail. Both reduce to "drop from
 * the far end", where "far" means away from the live turn.
 *
 * The elision note costs tokens too, and it is charged *before* deciding
 * what fits — otherwise explaining the overflow is what causes it. M2 had
 * exactly that bug and a test caught it; the reserve is kept here.
 */
function fill(
  block: PricedBlock,
  allowance: number,
  countTokens: (text: string) => number,
): FillResult {
  const template = TEMPLATES[block.name];
  const total = block.items.reduce((sum, item) => sum + item.tokens, 0) + block.headerTokens;
  if (total <= allowance) {
    return { kept: block.items, dropped: [], spent: total };
  }

  const elisionReserve =
    template.elision === undefined
      ? 0
      : countTokens(template.elision(block.items.length)) + 1;

  let budget = allowance - block.headerTokens - elisionReserve;
  const kept: PricedItem[] = [];
  const dropped: PricedItem[] = [];

  // Walk from the newest/highest-value end backwards.
  for (let i = block.items.length - 1; i >= 0; i--) {
    const item = block.items[i]!;
    if (budget - item.tokens < 0) {
      // Everything beyond this point goes too: a conversation with a hole in
      // the middle is worse than a shorter conversation, and a scored list
      // that skips rank 4 but keeps rank 9 misrepresents the scoring.
      for (let j = i; j >= 0; j--) dropped.push(block.items[j]!);
      break;
    }
    budget -= item.tokens;
    kept.push(item);
  }

  kept.reverse();
  dropped.reverse();
  const spent =
    kept.length === 0
      ? 0
      : block.headerTokens + elisionReserve + kept.reduce((sum, item) => sum + item.tokens, 0);
  return { kept, dropped, spent };
}

function blockTokens(
  kind: 'system' | 'turns',
  items: readonly PricedItem[],
  template: { header?: string },
  countTokens: (text: string) => number,
  elision: string | null,
): number {
  let tokens = items.reduce((sum, item) => sum + item.tokens, 0);
  if (kind === 'system' && template.header !== undefined && items.length > 0) {
    tokens += countTokens(template.header);
  }
  if (elision !== null) tokens += countTokens(elision);
  return tokens;
}

function toolSpecs(
  snapshot: StateSnapshot,
  kept: readonly PricedItem[],
): AssembledContext['tools'] {
  // The provider is offered exactly the tools the context described. A model
  // handed a schema for a tool that was evicted from its own listing is
  // being set up to call something it was never told about.
  const names = new Set(kept.map((item) => item.id));
  return snapshot.tools
    .filter((tool) => names.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      risk: tool.risk,
      effect: tool.effect,
    }));
}

/** An empty snapshot, for cold starts and for tests that only care about one block. */
export function emptySnapshot(now: number): StateSnapshot {
  return {
    kernel: '',
    constitution: '',
    constitutionDoc: null,
    identity: null,
    constraints: [],
    situation: {
      now,
      timezone: 'UTC',
      locale: 'en',
      device: 'unknown',
      trigger: 'user',
      degradation: 'L0',
    },
    commitments: [],
    calibration: [],
    pinned: [],
    memories: [],
    working: [],
    conversation: [],
    compacted: [],
    tools: [],
    foreign: [],
    profile: { factCount: 0, meanConfidence: 0, sessionsObserved: 0 },
  };
}
