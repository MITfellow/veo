import { Outbox, type OutboxEntry, type Probe } from '../capability/outbox.js';
import type { Substrate } from '../substrate/index.js';

/**
 * `arish effects` — the human end of §13.
 *
 * Four subcommands, and the fourth is the only one that changes anything:
 *
 *   list        every effect we ever intended
 *   pending     intended, never settled — the post-crash question
 *   attention   nobody can prove it either way; a person must decide
 *   reconcile   ask each provider, where a provider can be asked
 *
 * There is deliberately **no `retry`**. Retrying is the caller's business
 * and only from `absent`; a CLI verb that resent an email because a human
 * typed it in a hurry would undo the whole mechanism.
 */

export interface EffectsIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `arish effects — external effects (§13)

  effects list        every effect, newest first
  effects pending     intended but never settled
  effects attention   waiting on a human decision
  effects reconcile   ask each provider what really happened

There is no 'retry'. An effect is only safe to repeat once a provider has
confirmed it never happened, and that is a decision for the code that
owns the tool, not for this command.`;

function age(entry: OutboxEntry, now: number): string {
  const minutes = Math.max(0, Math.round((now - entry.intendedAt) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function line(entry: OutboxEntry, now: number): string {
  const ref = entry.remoteRef === null ? '' : ` → ${entry.remoteRef}`;
  const why = entry.detail === '' ? '' : `  (${entry.detail})`;
  const label = entry.summary === '' ? entry.stepId : entry.summary;
  return `  ${entry.status.padEnd(15)} ${entry.tool.padEnd(18)} ${label}${ref}  ${age(entry, now)}${why}`;
}

function show(io: EffectsIo, title: string, rows: readonly OutboxEntry[], now: number, json: boolean): number {
  if (json) {
    io.out(JSON.stringify({ ok: true, count: rows.length, effects: rows }, null, 2));
    return 0;
  }
  io.out(`${title}: ${rows.length}`);
  for (const entry of rows) io.out(line(entry, now));
  if (rows.length === 0) io.out('  (nothing)');
  return 0;
}

/**
 * The probe table.
 *
 * Empty, and honestly so: no connector implements a probe yet, so every
 * pending effect reconciles to `needs_attention`. That is the correct
 * conservative answer rather than a gap being papered over — a probe that
 * guessed would be worse than no probe at all.
 */
function probes(): ReadonlyMap<string, Probe> {
  return new Map<string, Probe>();
}

/** Every effect ever intended, newest first. */
function listAll(outbox: Outbox, storage: Substrate['storage']): OutboxEntry[] {
  const rows = storage.prepare('SELECT key FROM outbox ORDER BY intended_at DESC').all<{ key: string }>();
  return rows.flatMap((r) => {
    const entry = outbox.get(r.key);
    return entry === undefined ? [] : [entry];
  });
}

async function reconcile(outbox: Outbox, io: EffectsIo, json: boolean): Promise<number> {
  const before = outbox.pending().length;
  const tally = await outbox.reconcile(probes());
  if (json) {
    io.out(JSON.stringify({ ok: true, examined: before, ...tally }, null, 2));
    return 0;
  }
  io.out(`Reconciled ${before} pending effect${before === 1 ? '' : 's'}.`);
  io.out(`  confirmed as done:      ${tally.committed}`);
  io.out(`  confirmed as never run: ${tally.absent}`);
  io.out(`  need you to decide:     ${tally.needsAttention}`);
  if (tally.needsAttention > 0) {
    io.out('');
    io.out("Run 'arish effects attention' to see them. Nothing was retried.");
  }
  return 0;
}

export async function runEffects(
  argv: readonly string[],
  deps: { substrate: Substrate },
  io: EffectsIo,
  json = false,
): Promise<number> {
  const { storage, events, clock, crypto } = deps.substrate;
  const outbox = new Outbox({ storage, events, crypto });
  const now = clock.now();

  const views: Record<string, () => readonly OutboxEntry[]> = {
    list: () => listAll(outbox, storage),
    pending: () => outbox.pending(),
    attention: () => outbox.needsAttention(),
  };
  const titles: Record<string, string> = {
    list: 'Effects',
    pending: 'Intended, not settled',
    attention: 'Waiting on you',
  };

  const command = argv[0] ?? 'list';
  if (command === 'help' || command === '--help') {
    io.out(USAGE);
    return 0;
  }
  if (command === 'reconcile') return reconcile(outbox, io, json);

  const view = views[command];
  if (view === undefined) {
    io.err(`arish effects: unknown subcommand '${command}'.`);
    io.err(USAGE);
    return 2;
  }
  return show(io, titles[command] ?? 'Effects', view(), now, json);
}
