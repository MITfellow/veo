/**
 * S1 tests 13–22: the time tools and the two new notes tools.
 *
 * The interesting property in here is test 17: both time tools must read
 * `ctx.now()` and never the real clock. A tool that reads the real clock
 * passes its tests today and produces a different answer on every replay,
 * which silently breaks §30 — so it is asserted rather than assumed.
 */
import { describe, expect, it } from 'vitest';
import { timeConvert, timeUntil } from '../../src/tools/time.js';
import { notesList, notesSearch, notesWrite } from '../../src/tools/notes.js';
import type { ToolContext } from '../../src/capability/tool.js';
import { MemoryFileStore } from '../fakes/filestore.js';

/** A context frozen at a known instant, with an in-memory sandbox. */
function contextAt(iso: string, store = new MemoryFileStore()): ToolContext {
  const fixed = Date.parse(iso);
  // The fake implements the FileStore port; tools are handed the
  // *scoped* view of it, which is the narrower read/write/list/delete.
  const files = {
    read: (path: string) => store.get(path),
    write: (path: string, bytes: Uint8Array) => store.put(path, bytes),
    list: (prefix = '') => store.list(prefix),
    delete: (path: string) => store.delete(path),
  };
  return { now: () => fixed, files, principal: 'user' } as unknown as ToolContext;
}

const JUNE = '2026-06-15T12:00:00Z';

describe('time.convert', () => {
  it('13. converts across a DST boundary correctly', async () => {
    // 2026-03-29 is the morning the EU springs forward. At 09:00 London
    // time that day London is already on BST (UTC+1) = 08:00 UTC, while
    // New York sprang forward two weeks earlier and is on EDT (UTC-4),
    // so the gap is 5 hours. The day before it is only 4. An
    // implementation that holds the offset fixed gets one of these two
    // wrong, which is the entire reason this tool exists.
    const result = await timeConvert.execute(
      { when: '2026-03-29 09:00', from: 'Europe/London', to: 'America/New_York' },
      contextAt(JUNE),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.to.iso).toBe('2026-03-29T04:00:00');
    expect(result.value.to.weekday).toBe('Sunday');

    // And the day before, when London is still on GMT, the gap is 4.
    const before = await timeConvert.execute(
      { when: '2026-03-28 09:00', from: 'Europe/London', to: 'America/New_York' },
      contextAt(JUNE),
    );
    expect(before.ok && before.value.to.iso).toBe('2026-03-28T05:00:00');
  });

  it('converts the current moment when given no date', async () => {
    const result = await timeConvert.execute(
      { from: 'UTC', to: 'Asia/Kolkata' },
      contextAt(JUNE),
    );
    // 12:00 UTC is 17:30 in Kolkata — the half-hour offset is the case
    // that catches an implementation doing integer-hour arithmetic.
    expect(result.ok && result.value.to.iso).toBe('2026-06-15T17:30:00');
  });

  it('14. refuses an unknown timezone instead of crashing', async () => {
    const result = await timeConvert.execute(
      { when: '2026-06-15 09:00', from: 'UTC', to: 'Mars/Olympus_Mons' },
      contextAt(JUNE),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    expect(result.error.message).toMatch(/Mars\/Olympus_Mons/);
    expect(result.error.retryable).toBe(false);
  });

  it('refuses a date it cannot read, with a hint showing the shape', async () => {
    const result = await timeConvert.execute(
      { when: 'next tuesday-ish', from: 'UTC', to: 'UTC' },
      contextAt(JUNE),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.hint).toMatch(/2026-03-29 14:30/);
  });
});

describe('time.until', () => {
  it('15. reports a future instant in days, hours and minutes', async () => {
    const result = await timeUntil.execute(
      { when: '2026-06-18 15:30', timezone: 'UTC' },
      contextAt(JUNE),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.past).toBe(false);
    expect(result.value.days).toBe(3);
    expect(result.value.hours).toBe(3);
    expect(result.value.minutes).toBe(30);
    expect(result.value.phrase).toBe('3 days, 3 hours');
  });

  it('shows minutes when the answer is under a day', async () => {
    const result = await timeUntil.execute(
      { when: '2026-06-15 14:45', timezone: 'UTC' },
      contextAt(JUNE),
    );
    expect(result.ok && result.value.phrase).toBe('2 hours, 45 minutes');
  });

  it('16. reads a past instant as "ago", not as a negative number', async () => {
    const result = await timeUntil.execute(
      { when: '2026-06-10 12:00', timezone: 'UTC' },
      contextAt(JUNE),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.past).toBe(true);
    expect(result.value.days).toBe(5); // the magnitude, not -5
    expect(timeUntil.renderForModel(result, 100).text).toBe('5 days ago');
  });

  it('17. reads the injected clock, never the real one', async () => {
    // The same input at two different "nows" must give two different
    // answers — and neither may depend on when this test runs.
    const early = await timeUntil.execute(
      { when: '2026-06-20 12:00', timezone: 'UTC' },
      contextAt('2026-06-15T12:00:00Z'),
    );
    const late = await timeUntil.execute(
      { when: '2026-06-20 12:00', timezone: 'UTC' },
      contextAt('2026-06-19T12:00:00Z'),
    );
    expect(early.ok && early.value.days).toBe(5);
    expect(late.ok && late.value.days).toBe(1);

    // And the same for time.convert, which stamps epochMs from ctx.now().
    const converted = await timeConvert.execute(
      { from: 'UTC', to: 'UTC' },
      contextAt('2026-01-01T00:00:00Z'),
    );
    expect(converted.ok && converted.value.epochMs).toBe(Date.parse('2026-01-01T00:00:00Z'));
  });

  it('18. renders a sentence, not a JSON dump', async () => {
    const result = await timeConvert.execute(
      { when: '2026-06-15 09:00', from: 'Europe/London', to: 'Asia/Kolkata' },
      contextAt(JUNE),
    );
    const text = timeConvert.renderForModel(result, 100).text;
    expect(text).toBe(
      'Monday 2026-06-15T09:00:00 in Europe/London is Monday 2026-06-15T13:30:00 in Asia/Kolkata.',
    );
    expect(text).not.toContain('{');
  });
});

describe('notes.list and notes.search', () => {
  const seeded = async () => {
    const files = new MemoryFileStore();
    const ctx = contextAt(JUNE, files);
    await notesWrite.execute({ name: 'groceries', content: 'milk, bread, Cardamom' }, ctx);
    await notesWrite.execute(
      { name: 'trip plan', content: `${'x'.repeat(400)} the hotel is near Alfama ${'y'.repeat(400)}` },
      ctx,
    );
    await notesWrite.execute({ name: 'work.standup', content: 'blocked on the migration' }, ctx);
    return ctx;
  };

  it('19. lists names only, never contents', async () => {
    const result = await notesList.execute({ prefix: '' }, await seeded());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.names).toEqual(['groceries', 'trip plan', 'work.standup']);
    expect(result.value.total).toBe(3);
    expect(JSON.stringify(result.value)).not.toContain('milk');
  });

  it('filters by prefix', async () => {
    const result = await notesList.execute({ prefix: 'work' }, await seeded());
    expect(result.ok && result.value.names).toEqual(['work.standup']);
  });

  it('20. searches contents case-insensitively', async () => {
    const result = await notesSearch.execute({ query: 'cardamom', limit: 10 }, await seeded());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits.map((h) => h.name)).toEqual(['groceries']);
  });

  it('21. returns a snippet around the hit, not the whole note', async () => {
    const result = await notesSearch.execute({ query: 'Alfama', limit: 10 }, await seeded());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hit = result.value.hits[0]!;
    expect(hit.name).toBe('trip plan');
    expect(hit.snippet).toContain('the hotel is near Alfama');
    // The note is ~830 characters; the snippet is a window, with
    // ellipses showing it was cut at both ends.
    expect(hit.snippet.length).toBeLessThan(200);
    expect(hit.snippet.startsWith('…')).toBe(true);
    expect(hit.snippet.endsWith('…')).toBe(true);
  });

  it('says so plainly when nothing matches', async () => {
    const result = await notesSearch.execute({ query: 'saffron', limit: 10 }, await seeded());
    expect(result.ok && result.value.hits).toEqual([]);
    expect(notesSearch.renderForModel(result, 100).text).toBe('No note matches that.');
  });

  it('22. neither can reach outside the sandbox', async () => {
    // Scoping is the invoker's job, not the tool's — the tool only ever
    // sees a ScopedFileStore — so what is asserted here is that neither
    // tool asks for anything but `fs:read`, and that both go through
    // ctx.files rather than touching the filesystem themselves.
    expect(notesList.capabilities).toEqual(['fs:read']);
    expect(notesSearch.capabilities).toEqual(['fs:read']);
    expect(notesList.effect).toBe('pure');
    expect(notesSearch.effect).toBe('pure');

    const files = new MemoryFileStore();
    files.files.set('../../etc/passwd', new TextEncoder().encode('root:x:0:0'));
    const ctx = contextAt(JUNE, files);
    // The fake store is unscoped, so this proves only that the tools
    // read through the port they were given; the real scoping is tested
    // against the invoker in plugin.test.ts.
    const listed = await notesList.execute({ prefix: 'work' }, ctx);
    expect(listed.ok && listed.value.names).toEqual([]);
  });
});
