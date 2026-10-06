import type { Substrate } from '../substrate/index.js';
import type { Config } from '../substrate/config.js';
import { MemoryStore, MemoryError, type Fact } from '../capability/memory/store.js';
import { EntityRegistry } from '../capability/memory/entities.js';
import { recall } from '../capability/memory/recall.js';
import { ingest } from '../cognition/memory/ingest.js';
import { consolidate } from '../cognition/memory/consolidate.js';
import { Quarantine } from '../security/quarantine.js';

/**
 * `arish memory …` (§53, M2's runnable demo).
 *
 * The milestone's claims are only believable if you can exercise them by
 * hand: say something, see what was extracted, ask for it back, watch a
 * correction change the belief without changing the history. A green suite
 * proves it to me; a command proves it to the user.
 */

export type MemoryCommand = 'add' | 'list' | 'recall' | 'forget' | 'entities' | 'conflicts' | 'history' | 'consolidate';

const COMMANDS: readonly MemoryCommand[] = [
  'add', 'list', 'recall', 'forget', 'entities', 'conflicts', 'history', 'consolidate',
];

export interface MemoryCliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface MemoryCliDeps {
  substrate: Substrate;
  config: Config;
}

export const MEMORY_USAGE = `arish memory — what the agent remembers

Usage: arish memory <command> [options]

  add "<text>"          extract facts from a sentence and store them
                        --source user_message|note|web_page|document
  list                  everything currently believed
                        --subject, --predicate, --all (include secret)
  recall "<query>"      the most relevant facts, with the score explained
                        --limit N
  history <subject> <predicate>
                        every belief ever held about one thing, in order
  forget <factId>       retract a fact; the history stays, the belief goes
                        --reason "<why>"
  entities              who and what is known, with their former names
  conflicts             subject+predicate pairs holding two live values
  consolidate           collapse restatements, raise contradictions
                        --dry-run

Options:
  --json                machine-readable output on stdout
`;

export function isMemoryCommand(value: string): value is MemoryCommand {
  return (COMMANDS as readonly string[]).includes(value);
}

interface Options {
  json: boolean;
  flag(name: string): string | undefined;
  has(name: string): boolean;
  positional(index: number): string | undefined;
}

function options(argv: readonly string[]): Options {
  const positionals = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1]?.startsWith('--') === true && !FLAGLESS.has(argv[i - 1] ?? '')));
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

/** Flags that take no value, so the token after them is still a positional. */
const FLAGLESS = new Set(['--json', '--all', '--dry-run']);

function build(deps: MemoryCliDeps): { memory: MemoryStore; entities: EntityRegistry; quarantine: Quarantine; now: () => number } {
  const s = deps.substrate;
  const shared = { storage: s.storage, events: s.events, now: () => s.clock.now(), nextId: () => s.ids.ulid() };
  return {
    memory: new MemoryStore(shared),
    entities: new EntityRegistry(shared),
    quarantine: new Quarantine({
      storage: s.storage,
      clock: s.clock,
      ids: s.ids,
      // The quarantine's own audit trail is M4's; here it is enough that
      // the bytes land in the side table rather than in a fact.
      events: { entered: () => {}, extracted: () => {}, released: () => {} },
    }),
    now: () => s.clock.now(),
  };
}

function line(fact: Fact): string {
  const flags = [fact.pinned ? 'pinned' : '', fact.status === 'active' ? '' : fact.status].filter((f) => f !== '');
  return `${fact.id.slice(-8)}  ${fact.subject} ${fact.predicate} = ${fact.object}` +
    `  [${fact.trust.toLowerCase()} ${fact.confidence.toFixed(2)}${flags.length > 0 ? ' ' + flags.join(' ') : ''}]`;
}

function emit(io: MemoryCliIo, json: boolean, payload: unknown, text: string[]): void {
  if (json) io.out(JSON.stringify(payload, null, 2));
  else for (const l of text) io.out(l);
}

async function cmdAdd(deps: MemoryCliDeps, io: MemoryCliIo, o: Options): Promise<number> {
  const text = o.positional(1);
  if (text === undefined || text.trim() === '') {
    io.err('arish memory add needs something to remember. Try: arish memory add "I live in Berlin"');
    return 2;
  }
  const ctx = build(deps);
  const source = (o.flag('source') ?? 'user_message') as 'user_message';
  const result = await ingest({ text, source }, { ...ctx, options: { config: deps.config } });

  emit(io, o.json, result, [
    ...result.stored.map((f) => `stored   ${f.factId.slice(-8)}  ${f.predicate} = ${f.object}  [${f.trust.toLowerCase()} ${f.confidence}]`),
    ...result.skipped.map((f) => `skipped  ${f.predicate} = ${f.object}  (${f.why})`),
    result.stored.length === 0 && result.skipped.length === 0
      ? 'nothing extracted — the baseline only fires on explicit statements, and it does not guess'
      : `${result.stored.length} stored via ${result.strategy} (${result.reason})`,
  ]);
  return 0;
}

function cmdList(deps: MemoryCliDeps, io: MemoryCliIo, o: Options): number {
  const { memory } = build(deps);
  const facts = memory.asOf({
    ...(o.flag('subject') === undefined ? {} : { subject: o.flag('subject') }),
    ...(o.flag('predicate') === undefined ? {} : { predicate: o.flag('predicate') }),
    ...(o.has('all') ? { maxSensitivity: 'secret' as const } : {}),
  });
  emit(io, o.json, facts, facts.length === 0 ? ['memory is empty'] : facts.map(line));
  return 0;
}

function cmdRecall(deps: MemoryCliDeps, io: MemoryCliIo, o: Options): number {
  const query = o.positional(1) ?? '';
  const ctx = build(deps);
  const hits = recall(ctx.memory, ctx.now(), {
    query,
    limit: Number(o.flag('limit') ?? 10),
    ...(o.has('all') ? { maxSensitivity: 'secret' as const } : {}),
  });
  emit(io, o.json, hits, hits.length === 0
    ? ['nothing relevant']
    : hits.map((h) => `${h.score.toFixed(3)}  ${line(h.fact)}  (lex ${h.because.lexical}, conf ${h.because.confidence}, rec ${h.because.recency})`));
  return 0;
}

function cmdHistory(deps: MemoryCliDeps, io: MemoryCliIo, o: Options): number {
  const subject = o.positional(1);
  const predicate = o.positional(2);
  if (subject === undefined || predicate === undefined) {
    io.err('arish memory history needs a subject and a predicate.');
    return 2;
  }
  const facts = build(deps).memory.history(subject, predicate);
  emit(io, o.json, facts, facts.length === 0
    ? ['nothing was ever believed about that']
    : facts.map((f) => `${new Date(f.recordedAt).toISOString()}  ${f.object}  [${f.status}]`));
  return 0;
}

function cmdForget(deps: MemoryCliDeps, io: MemoryCliIo, o: Options): number {
  const factId = o.positional(1);
  if (factId === undefined) {
    io.err('arish memory forget needs a fact id. Run: arish memory list');
    return 2;
  }
  const { memory } = build(deps);
  memory.retract(factId, o.flag('reason') ?? 'asked to forget', 'USER', 'user');
  emit(io, o.json, { factId, forgotten: true }, [
    `forgotten: ${factId}`,
    'The belief is closed. The history stays, because a log that can erase',
    'its own corrections can erase anything else too.',
  ]);
  return 0;
}

function cmdEntities(deps: MemoryCliDeps, io: MemoryCliIo, o: Options): number {
  const all = build(deps).entities.all();
  emit(io, o.json, all, all.length === 0
    ? ['nobody is known yet']
    : all.map((e) => `${e.id.slice(-8)}  ${e.kind.padEnd(7)} ${e.name}` +
        (e.aliases.length > 0 ? `  (also: ${e.aliases.join(', ')})` : '') +
        (e.canonicalId === null ? '' : `  → merged into ${e.canonicalId.slice(-8)}`)));
  return 0;
}

function cmdConflicts(deps: MemoryCliDeps, io: MemoryCliIo, o: Options): number {
  const conflicts = build(deps).memory.conflicts();
  emit(io, o.json, conflicts, conflicts.length === 0
    ? ['no conflicts']
    : conflicts.flatMap((c) => [`${c.subject} ${c.predicate}:`, ...c.facts.map((f) => `    ${line(f)}`)]));
  return 0;
}

async function cmdConsolidate(deps: MemoryCliDeps, io: MemoryCliIo, o: Options): Promise<number> {
  const ctx = build(deps);
  if (o.has('dry-run')) {
    const conflicts = ctx.memory.conflicts();
    emit(io, o.json, { conflicts }, [`${conflicts.length} conflict(s) would be raised; nothing written`]);
    return 0;
  }
  const report = await consolidate({ memory: ctx.memory, now: ctx.now, options: { config: deps.config } });
  emit(io, o.json, report, [
    `${report.superseded.length} restatement(s) collapsed`,
    `${report.conflicts.length} contradiction(s) raised for you to settle`,
    ...report.refused.map((r) => `refused  ${r.factId.slice(-8)}  ${r.why}`),
  ]);
  return 0;
}

/**
 * One table, one lookup. A switch over eight commands is eight branches
 * the complexity rule counts and a reader has to hold at once; a table is
 * a list anyone can scan.
 */
const HANDLERS: Record<MemoryCommand, (deps: MemoryCliDeps, io: MemoryCliIo, o: Options) => number | Promise<number>> = {
  add: cmdAdd,
  list: cmdList,
  recall: cmdRecall,
  history: cmdHistory,
  forget: cmdForget,
  entities: cmdEntities,
  conflicts: cmdConflicts,
  consolidate: cmdConsolidate,
};

export async function runMemory(
  argv: readonly string[],
  deps: MemoryCliDeps,
  io: MemoryCliIo,
): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === 'help') {
    io.out(MEMORY_USAGE);
    return command === undefined ? 1 : 0;
  }
  if (!isMemoryCommand(command)) {
    io.err(`Unknown memory command: ${command}`);
    io.err(MEMORY_USAGE);
    return 1;
  }

  const o = options(argv);
  try {
    return await HANDLERS[command](deps, io, o);
  } catch (error) {
    if (error instanceof MemoryError) {
      io.err(`${error.kind}: ${error.message}`);
      return error.kind === 'not_found' || error.kind === 'invalid' ? 1 : 2;
    }
    throw error;
  }
}
