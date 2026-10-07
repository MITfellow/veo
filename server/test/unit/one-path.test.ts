import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * M3 §10 — the single-path claim, checked structurally.
 *
 * Every assertion M3 makes about policy ("the budget is applied", "the Rule
 * of Two is applied", "nothing runs unapproved above the rung") is only true
 * if there is exactly **one** way to reach a tool. A second caller that
 * invokes `tool.run()` directly would not be a bug in the executor — it
 * would make the executor's tests irrelevant, silently, and no behavioural
 * test could see it. So this is checked by reading the source.
 */

const SRC = new URL('../../src/', import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const sources = files(SRC).map((path) => ({
  path: path.slice(SRC.length),
  text: readFileSync(path, 'utf8'),
}));

describe('there is one path to a tool', () => {
  it('finds the source tree, so an empty glob cannot pass this file', () => {
    expect(sources.length).toBeGreaterThan(30);
    expect(sources.map((f) => f.path)).toContain('orchestration/executor.ts');
  });

  it('calls tool.run() nowhere but the executor', () => {
    const callers = sources
      .filter((f) => /\btool\.run\s*\(/.test(f.text))
      .map((f) => f.path);
    expect(callers).toEqual(['orchestration/executor.ts']);
  });

  it('imports the built-in tools nowhere but the composition root and the registry', () => {
    const importers = sources
      .filter((f) => /from '.*capability\/tools\/builtin\.js'/.test(f.text))
      .map((f) => f.path)
      .sort();
    // The CLI and the HTTP interface build the registry; nothing else may
    // reach past the registry to a tool implementation.
    for (const path of importers) {
      expect(path.startsWith('interface/')).toBe(true);
    }
  });

  it('keeps the registry the only thing that hands out a tool', () => {
    const getters = sources
      .filter((f) => /registry\.get\s*\(/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(getters).toEqual(['orchestration/executor.ts', 'orchestration/policy.ts']);
  });

  it('writes run and tool events only from a dedicated audit writer', () => {
    // Appending, not merely naming: the event union declares these types
    // and the projector reads them, and neither is a writer.
    const emitters = sources
      .filter((f) => /'tool\.(invoked|succeeded|failed|denied|dryrun)'/.test(f.text))
      .filter((f) => /\.append\s*\(|\bappend\(\{/.test(f.text))
      .map((f) => f.path)
      .sort();
    /*
     * Two writers, both deliberate, both named here so a third cannot
     * appear quietly:
     *   - orchestration/audit.ts  — every tool call made by a run.
     *   - capability/browser/record.ts — the browser session's own calls,
     *     which cannot use the executor's writer without the capability
     *     layer importing the orchestration layer (decision 012 records
     *     this, and folding browsing into the executor is deferred).
     */
    const WRITERS = ['orchestration/audit.ts', 'capability/browser/record.ts'];
    expect(emitters.length).toBeGreaterThan(0);
    expect(emitters.filter((p) => !WRITERS.includes(p))).toEqual([]);
  });

  it('keeps the layer direction inward — orchestration is never imported by what it orchestrates', () => {
    const violations = sources
      .filter((f) => /^(capability|cognition|security|substrate)\//.test(f.path))
      .filter((f) => /from '.*orchestration\//.test(f.text))
      .map((f) => f.path);
    expect(violations).toEqual([]);
  });

  it('reaches ambient time, randomness and the filesystem only through the ports', () => {
    const ALLOWED = new Set([
      'substrate/ports.ts', 'substrate/clock.ts', 'substrate/ids.ts', 'substrate/crypto.ts',
      'substrate/config.ts', 'substrate/files.ts', 'substrate/storage/sqlite.ts',
      'interface/cli.ts', 'interface/http.ts',
    ]);
    const offenders = sources
      .filter((f) => !ALLOWED.has(f.path))
      .filter((f) => /\bDate\.now\s*\(|\bMath\.random\s*\(|crypto\.randomUUID|from 'node:fs'/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
