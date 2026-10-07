import { z } from 'zod';
import type { Substrate } from '../substrate/index.js';
import type { Config } from '../substrate/config.js';
import { MemoryStore } from '../capability/memory/store.js';
import { ItemStore } from '../capability/memory/items.js';
import { RealFileStore } from '../substrate/files.js';
import { builtinTools } from '../capability/tools/builtin.js';
import { ToolRegistry } from '../capability/tools/registry.js';
import { Executor } from '../orchestration/executor.js';
import { ApprovalError, type Approvals, type ApprovalRow } from '../orchestration/approvals.js';
import type { PlanSpec } from '../orchestration/plan.js';
import { RUNGS, type Rung } from '../orchestration/autonomy.js';
import type { Capability } from '../security/trust.js';
import type { Vault } from '../security/vault.js';
import type { RunResult, StepResult } from '../orchestration/types.js';

/**
 * `arish tools`, `arish run`, `arish approvals` — M3's runnable surface (§53).
 *
 * The milestone's claim is that **one** gate chain decides every action and
 * that a human can see it working. These commands exist so that claim is
 * checkable by hand: list what the agent can do, ask it to do something,
 * watch it stop and ask, answer, watch it continue.
 *
 * `run` takes a plan rather than a sentence, because there is no model in
 * this build (§2) and nothing here will pretend to have planned for you.
 * When a model is attached, `turn.generate` produces exactly this JSON and
 * nothing below changes.
 */

export type RunCommand = 'tools' | 'run' | 'approvals';

export interface RunCliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface RunCliDeps {
  substrate: Substrate;
  config: Config;
  /** Present only once unlocked; `item.*` tools need it. */
  vault: Vault;
}

export const RUN_USAGE = `arish run — plan, gate, execute

Usage:
  arish tools                    every tool, with its tier, effect and capabilities
                                 --json
  arish run <plan.json>          execute a sealed plan through the gate chain
                                 --dry-run     report what would happen, change nothing
                                 --autonomy N  the rung to run at (0-4, default 1)
                                 --trust T     trust of what seeded the run (default USER)
  arish approvals                what the agent is waiting to be told
    approvals grant <id>         allow one step of one plan
    approvals deny <id>          refuse it; the run ends as cancelled
                                 --reason "<why>"

A plan file is JSON:
  {
    "goal": "what this is for",
    "steps": [{ "tool": "time.now", "input": {}, "why": "the user asked" }],
    "allowedTools": ["time.now"],
    "maxSteps": 5,
    "carriesPrivateData": false
  }

Autonomy L0 proposes and runs nothing. L1 observes. L2 interacts.
L3 changes the world. L4 does so irreversibly. Untrusted content
anywhere in scope caps the run at L1, whatever you ask for (§20).
`;

const COMMANDS: readonly RunCommand[] = ['tools', 'run', 'approvals'];

export function isRunCommand(value: string): value is RunCommand {
  return (COMMANDS as readonly string[]).includes(value);
}

interface Options {
  json: boolean;
  flag(name: string): string | undefined;
  has(name: string): boolean;
  positional(index: number): string | undefined;
}

const FLAGLESS = new Set(['--json', '--dry-run']);

function options(argv: readonly string[]): Options {
  const positionals = argv.filter(
    (a, i) => !a.startsWith('--') && !(argv[i - 1]?.startsWith('--') === true && !FLAGLESS.has(argv[i - 1] ?? '')),
  );
  return {
    json: argv.includes('--json'),
    flag: (name) => {
      const at = argv.indexOf(`--${name}`);
      return at >= 0 ? argv[at + 1] : undefined;
    },
    has: (name) => argv.includes(`--${name}`),
    positional: (index) => positionals[index],
  };
}

function emit(io: RunCliIo, json: boolean, payload: unknown, text: string[]): void {
  if (json) io.out(JSON.stringify(payload, null, 2));
  else for (const line of text) io.out(line);
}

/** Everything M3 needs, built once per command. */
function build(deps: RunCliDeps): { registry: ToolRegistry; executor: Executor } {
  const s = deps.substrate;
  const shared = { storage: s.storage, events: s.events, now: () => s.clock.now(), nextId: () => s.ids.ulid() };
  const registry = new ToolRegistry();
  for (const tool of builtinTools({
    memory: new MemoryStore(shared),
    items: new ItemStore({ storage: s.storage, events: s.events, vault: deps.vault, nextId: shared.nextId }),
    files: new RealFileStore(),
    fileRoots: [deps.config.dataDir],
  })) {
    registry.register(tool);
  }
  const executor = new Executor({
    storage: s.storage, events: s.events, crypto: s.crypto, registry,
    now: shared.now, nextId: shared.nextId,
  });
  return { registry, executor };
}

// ─────────────────────────────────────────────────────────────── arish tools

function cmdTools(deps: RunCliDeps, io: RunCliIo, o: Options): number {
  const { registry } = build(deps);
  const rows = registry.all().map((tool) => ({
    name: tool.name,
    summary: tool.summary,
    tier: tool.tier,
    effect: tool.effect,
    sensitivity: tool.sensitivity,
    irreversible: tool.irreversible === true,
    idempotent: tool.idempotent,
    capabilities: [...tool.capabilities],
    minAutonomy: tool.irreversible === true ? 4 : { observe: 1, interact: 2, effect: 3 }[tool.tier],
  }));

  emit(io, o.json, { tools: rows }, [
    ...rows.map((t) =>
      `${t.name.padEnd(16)} L${t.minAutonomy}  ${t.tier.padEnd(9)} ${t.effect.padEnd(8)}` +
      `${t.irreversible ? ' irreversible' : ''}\n` +
      `                     ${t.summary}` +
      (t.capabilities.length > 0 ? `\n                     needs: ${t.capabilities.join(', ')}` : ''),
    ),
    '',
    `${rows.length} tools. L<n> is the rung each needs before it runs without asking.`,
  ]);
  return 0;
}

// ───────────────────────────────────────────────────────────────── arish run

/**
 * A plan file, validated by schema rather than by a staircase of ifs.
 *
 * zod is already how every tool validates its input, and a plan is input
 * too: the error messages come out naming the field and the problem,
 * which is what someone hand-writing a plan file actually needs.
 */
const PlanFile = z.object({
  goal: z.string().min(1, 'one line saying what this run is for'),
  steps: z.array(z.object({
    tool: z.string().min(1),
    input: z.unknown().optional(),
    why: z.string().min(1, 'what you will be shown when it asks'),
  }).strict()).min(1, 'a plan needs at least one step'),
  allowedTools: z.array(z.string()).optional(),
  maxSteps: z.number().int().positive().optional(),
  carriesPrivateData: z.boolean().optional(),
}).strict();

function parsePlan(raw: string, rung: Rung): PlanSpec | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return `that file is not JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  const result = PlanFile.safeParse(parsed);
  if (!result.success) {
    return result.error.issues
      .map((i) => `${i.path.join('.') || '(the plan)'}: ${i.message}`)
      .join('\n');
  }
  const file = result.data;
  const steps = file.steps.map((s) => ({ tool: s.tool, input: s.input ?? {}, why: s.why }));
  return {
    goal: file.goal,
    steps,
    // Default the allow-list to exactly the tools the plan names: a plan
    // that forgot the field should not thereby be allowed everything.
    allowedTools: file.allowedTools ?? steps.map((s) => s.tool),
    maxSteps: file.maxSteps ?? steps.length,
    rung,
    carriesPrivateData: file.carriesPrivateData === true,
  };
}

function stepLine(step: StepResult): string {
  const mark = { succeeded: 'ok  ', failed: 'FAIL', denied: 'no  ', skipped: '--  ', 'awaiting-approval': 'ask ', proposed: 'plan' }[step.status];
  return `${mark} ${String(step.index).padStart(2)}. ${step.tool.padEnd(14)} ${step.detail}` +
    (step.approvalId === undefined ? '' : `\n          approval ${step.approvalId} — arish approvals grant ${step.approvalId}`);
}

/** Everything a local CLI user holds. Over HTTP this is a narrower set. */
const CLI_CAPABILITIES: readonly Capability[] = [
  'vault:read', 'memory:read', 'memory:write', 'memory:promote',
  'effect:external', 'effect:local', 'egress:new-host', 'file:write', 'autonomy:raise',
];

async function cmdRun(deps: RunCliDeps, io: RunCliIo, o: Options, readFile: (path: string) => string): Promise<number> {
  const path = o.positional(1);
  if (path === undefined) {
    io.err('arish run needs a plan file. See `arish run --help` for its shape.');
    return 2;
  }
  const asked = Number(o.flag('autonomy') ?? 1);
  if (!(RUNGS as readonly number[]).includes(asked)) {
    io.err(`autonomy must be one of ${RUNGS.join(', ')} — got ${String(o.flag('autonomy'))}`);
    return 2;
  }

  let raw: string;
  try {
    raw = readFile(path);
  } catch {
    io.err(`cannot read ${path}`);
    return 2;
  }

  const plan = parsePlan(raw, asked as Rung);
  if (typeof plan === 'string') {
    io.err(plan);
    return 2;
  }

  const { executor } = build(deps);
  const result = await executor.run(plan, {
    inputTrust: (o.flag('trust') ?? 'USER') as 'USER',
    granted: CLI_CAPABILITIES,
    earnedAutonomy: asked,
    dryRun: o.has('dry-run'),
  });
  return report(io, o, result);
}

function report(io: RunCliIo, o: Options, result: RunResult): number {
  emit(io, o.json, result, [
    `run ${result.runId}`,
    `goal: ${result.plan.goal}`,
    `plan sealed ${result.plan.seal.slice(0, 16)}… at L${result.plan.rung}` +
      (result.autonomyCapped ? ` — capped to L${result.effectiveRung}: untrusted content is in scope` : ''),
    '',
    ...result.steps.map(stepLine),
    '',
    `${result.status}: ${result.stopReason}`,
  ]);
  // A pause is not a failure: 0 so a script can tell "it asked" from "it broke".
  return result.status === 'failed' ? 1 : 0;
}

// ─────────────────────────────────────────────────────────── arish approvals

function approvalLine(row: ApprovalRow, now: number): string {
  const left = Math.max(0, Math.round((row.expires_at - now) / 60_000));
  return `${row.id}  ${row.status.padEnd(8)} ${row.tool.padEnd(14)} ${row.action}` +
    (row.status === 'pending' ? `\n    needs L${row.needs}, expires in ${left} min — grant | deny` : '');
}

function settle(approvals: Approvals, io: RunCliIo, o: Options, verb: 'grant' | 'deny'): number {
  const id = o.positional(2);
  if (id === undefined) {
    io.err(`arish approvals ${verb} needs an approval id. Run 'arish approvals' to see them.`);
    return 2;
  }
  try {
    const reason = o.flag('reason') ?? '';
    if (verb === 'grant') approvals.grant(id, 'user:cli', 'USER', reason);
    else approvals.deny(id, 'user:cli', 'USER', reason);
  } catch (error) {
    if (error instanceof ApprovalError) {
      io.err(`${error.kind}: ${error.message}`);
      return 1;
    }
    throw error;
  }
  emit(io, o.json, { approvalId: id, status: verb === 'grant' ? 'granted' : 'denied' }, [
    verb === 'grant'
      ? 'granted. Re-run the plan and that step will proceed — once.'
      : 'denied. The run ends as cancelled, which is an answer, not a failure.',
  ]);
  return 0;
}

function cmdApprovals(deps: RunCliDeps, io: RunCliIo, o: Options): number {
  const { executor } = build(deps);
  const approvals = executor.approvalService();
  const now = deps.substrate.clock.now();
  const sub = o.positional(1);

  if (sub === 'grant' || sub === 'deny') return settle(approvals, io, o, sub);

  // Expiry is lazy, so listing is also when stale requests are swept.
  const swept = approvals.expireStale();
  const rows = approvals.all();
  const pending = rows.filter((r) => r.status === 'pending');
  emit(io, o.json, { pending, all: rows, expired: swept }, [
    ...rows.map((row) => approvalLine(row, now)),
    '',
    rows.length === 0
      ? 'nothing to approve — the agent has not needed to ask.'
      : `${pending.length} waiting on you, ${rows.length} in all${swept > 0 ? `, ${swept} expired just now` : ''}.`,
  ]);
  return 0;
}

// ───────────────────────────────────────────────────────────────── dispatch

export async function runRun(
  argv: readonly string[],
  deps: RunCliDeps,
  io: RunCliIo,
  readFile: (path: string) => string,
): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === 'help' || argv.includes('--help')) {
    io.out(RUN_USAGE);
    return command === undefined ? 1 : 0;
  }
  if (!isRunCommand(command)) {
    io.err(`Unknown command: ${command}`);
    io.err(RUN_USAGE);
    return 1;
  }
  const o = options(argv);
  if (command === 'tools') return cmdTools(deps, io, o);
  if (command === 'approvals') return cmdApprovals(deps, io, o);
  return cmdRun(deps, io, o, readFile);
}
