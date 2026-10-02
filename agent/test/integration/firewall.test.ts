import { describe, expect, it } from 'vitest';
import { ModelRequestFirewall, SecretLeakError } from '../../src/security/firewall.js';
import { createTestSecurity } from '../../src/security/index.js';
import { createTestSubstrate } from '../../src/substrate/index.js';

const API_KEY = 'sk-live-9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c';
const PASS = 'a passphrase long enough';

describe('the model-request firewall', () => {
  it('refuses a request containing a secret rather than scrubbing it', () => {
    const fw = new ModelRequestFirewall();
    fw.register(API_KEY, 'openai_key');

    const request = {
      model: 'fake-1',
      messages: [
        { role: 'system', content: 'you are a helpful agent' },
        { role: 'user', content: `call the API with ${API_KEY} please` },
      ],
    };

    // Refusing, not scrubbing: a scrubbed request goes out and nobody ever
    // learns that something upstream is leaking credentials into prompts.
    expect(() => fw.assertClean(request)).toThrow(SecretLeakError);
    try {
      fw.assertClean(request);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('openai_key');
      expect(message).toContain('messages[1].content');
      expect(message).toContain('was not sent');
      expect(message).not.toContain(API_KEY); // names the label, never the value
    }
  });

  it('passes a clean request', () => {
    const fw = new ModelRequestFirewall();
    fw.register(API_KEY, 'openai_key');
    expect(() =>
      fw.assertClean({ messages: [{ role: 'user', content: 'what is the weather' }] }),
    ).not.toThrow();
  });

  it('reports where the leak is, not just that there is one', () => {
    const fw = new ModelRequestFirewall();
    fw.register(API_KEY, 'openai_key');
    const violations = fw.scan({
      tools: [{ name: 'http', lastResult: { headers: { authorization: API_KEY } } }],
    });
    expect(violations[0]?.path).toBe('tools[0].lastResult.headers.authorization');
  });

  it('catches a secret hidden by url-encoding or base64', () => {
    const fw = new ModelRequestFirewall();
    fw.register(API_KEY, 'openai_key');
    expect(fw.scan({ url: `https://x/?k=${encodeURIComponent(API_KEY)}` })).toHaveLength(1);
    expect(
      fw.scan({ dump: Buffer.from(API_KEY, 'utf8').toString('base64') })[0]?.path,
    ).toContain('base64');
  });

  it('catches a secret used as an object key', () => {
    const fw = new ModelRequestFirewall();
    fw.register(API_KEY, 'openai_key');
    expect(fw.scan({ [API_KEY]: 'value' })[0]?.path).toContain('<key>');
  });

  it('catches a secret inside a byte array', () => {
    const fw = new ModelRequestFirewall();
    fw.register(API_KEY, 'openai_key');
    expect(fw.scan({ blob: new TextEncoder().encode(`prefix ${API_KEY}`) })).toHaveLength(1);
  });

  it('does not watch values too short to match without false positives', () => {
    const fw = new ModelRequestFirewall();
    fw.register('abc', 'tiny');
    expect(fw.size()).toBe(0);
    // Stated as a known limit rather than discovered later: anything under
    // 8 characters is not firewalled, because redacting it would shred
    // unrelated text everywhere.
    expect(fw.scan({ text: 'abc appears here' })).toHaveLength(0);
  });

  it('is a no-op when nothing is registered', () => {
    expect(new ModelRequestFirewall().scan({ anything: 'at all' })).toEqual([]);
  });
});

describe('the leaky-tool test §13.2 asks for', () => {
  it('catches a secret that a deliberately leaky tool put into its output', async () => {
    const substrate = createTestSubstrate();
    const security = createTestSecurity(substrate);
    await security.keyring.initialize(PASS);
    await security.keyring.unlock(PASS);

    const ref = await security.vault.create('openai', API_KEY, { principal: 'user:ara' });

    // A tool that does exactly the wrong thing: echoes the credential it was
    // given back into its result, where it would land in the next context.
    const leakyResult = await security.vault.useSecret(ref, { principal: 'user:ara', tool: 'leaky' }, (v) => ({
      ok: true,
      debug: `called with ${new TextDecoder().decode(v)}`,
    }));

    // Using the secret registered it with the firewall automatically — the
    // wiring in createSecurity is what makes this work without the tool, the
    // runner or the provider adapter having to remember anything.
    expect(() => security.firewall.assertClean({ messages: [leakyResult] })).toThrow(
      SecretLeakError,
    );
    substrate.close();
  });
});
