import { describe, expect, it } from 'vitest';
import { ConfigError, configFromEnv, loadConfig } from '../../src/substrate/config.js';

describe('config', () => {
  it('parses a valid object and applies defaults', () => {
    const config = loadConfig({ dataDir: '/tmp/x' });
    expect(config.dataDir).toBe('/tmp/x');
    expect(config.port).toBe(8787);
    expect(config.autonomy).toBe(0);
  });

  it('reports EVERY problem at once, not just the first', () => {
    // §54. A config tool that surfaces one error per run turns a two-minute
    // fix into a five-round guessing game.
    let caught: ConfigError | undefined;
    try {
      loadConfig({ port: 99_999, autonomy: 9, logLevel: 'chatty', dataDir: '' });
    } catch (error) {
      caught = error as ConfigError;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught?.problems).toHaveLength(4);
    expect(caught?.problems.join('\n')).toMatch(/port/);
    expect(caught?.problems.join('\n')).toMatch(/autonomy/);
    expect(caught?.problems.join('\n')).toMatch(/logLevel/);
  });

  it('rejects unknown keys instead of ignoring them', () => {
    // A typo that silently does nothing is worse than a crash.
    expect(() => loadConfig({ dataDirr: '/tmp' })).toThrow(ConfigError);
  });

  it('reads the environment only through an injected object', () => {
    const config = configFromEnv({ ARISH_PORT: '9000', ARISH_DATA_DIR: '/data' });
    expect(config.port).toBe(9000);
    expect(config.dataDir).toBe('/data');
  });

  it('ignores empty environment values rather than failing on them', () => {
    expect(configFromEnv({ ARISH_PORT: '' }).port).toBe(8787);
  });

  it('surfaces a non-numeric port as a typed problem', () => {
    expect(() => configFromEnv({ ARISH_PORT: 'eighty' })).toThrow(ConfigError);
  });
});
