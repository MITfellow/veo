/**
 * S1 tests 1–12: `math.eval`.
 *
 * The reason this tool exists is that a language model asked to add two
 * numbers produces something that *looks* like arithmetic, and is wrong
 * often enough to matter but rarely enough that nobody checks. So these
 * tests care most about the cases where a plausible-looking wrong answer
 * is the failure mode: precedence, associativity, and decimals.
 */
import { describe, expect, it } from 'vitest';
import { evaluate, MathError, mathEval } from '../../src/tools/math-eval.js';
import type { ToolContext } from '../../src/capability/tool.js';

const ctx = null as unknown as ToolContext; // math.eval touches nothing

const value = async (expression: string): Promise<string> => {
  const result = await mathEval.execute({ expression }, ctx);
  if (!result.ok) throw new Error(`refused: ${result.error.message}`);
  return result.value.result;
};

const refusal = async (expression: string) => {
  const result = await mathEval.execute({ expression }, ctx);
  if (result.ok) throw new Error(`expected a refusal, got ${result.value.result}`);
  return result.error;
};

describe('math.eval gets the answer right', () => {
  it('1. multiplication binds tighter than addition', async () => {
    expect(await value('2 + 3 * 4')).toBe('14');
  });

  it('2. parentheses override precedence', async () => {
    expect(await value('(2 + 3) * 4')).toBe('20');
  });

  it('3. exponentiation is right-associative', async () => {
    // 2^(3^2) = 512, not (2^3)^2 = 64. Getting this wrong is the classic
    // silent arithmetic bug: both answers look like answers.
    expect(await value('2^3^2')).toBe('512');
  });

  it('4. unary minus binds looser than exponentiation', async () => {
    expect(await value('-2^2')).toBe('-4');
    expect(await value('(-2)^2')).toBe('4');
    expect(await value('--3')).toBe('3');
  });

  it('5. decimals are exact, not floating point', async () => {
    // The whole reason for scaled integers. In IEEE 754 this is
    // 0.30000000000000004, and an agent that tells a person their
    // invoice total in that form has failed at something basic.
    expect(await value('0.1 + 0.2')).toBe('0.3');
    expect(await value('1.1 * 1.1')).toBe('1.21');
    expect(await value('4.56 - 1.23')).toBe('3.33');
  });

  it('6. division by zero is a refusal, not Infinity', async () => {
    const error = await refusal('5 / 0');
    expect(error.kind).toBe('invalid_input');
    expect(error.message).toMatch(/zero/i);
    expect(error.retryable).toBe(false);
  });

  it('7. understands percentages the way people write them', async () => {
    expect(await value('17% of 250')).toBe('42.5');
    expect(await value('250 + 8%')).toBe('270');
    expect(await value('50%')).toBe('0.5');
  });

  it('8. supports the allowlisted functions', async () => {
    expect(await value('min(3, 1, 2)')).toBe('1');
    expect(await value('max(3, 1, 2)')).toBe('3');
    expect(await value('abs(-7.5)')).toBe('7.5');
    expect(await value('round(2.5)')).toBe('3');
    expect(await value('sqrt(144)')).toBe('12');
  });
});

describe('math.eval refuses rather than guesses', () => {
  it('9. a malformed expression says where it went wrong', async () => {
    const error = await refusal('2 + * 3');
    expect(error.kind).toBe('invalid_input');
    expect(error.message).toMatch(/position \d+/);
    expect(error.retryable).toBe(false);
  });

  it('10. cannot reach a JavaScript global', async () => {
    // This is the test that justifies writing a parser instead of
    // calling eval or new Function. If any of these ever resolves to
    // something, the tool has become a sandbox escape.
    for (const attack of [
      'process.exit(1)',
      'constructor.constructor("return 1")()',
      'globalThis',
      'Math.max(1,2)',
      'require("fs")',
      '[].constructor',
      'this',
    ]) {
      const error = await refusal(attack);
      expect(error.kind, attack).toBe('invalid_input');
    }
  });

  it('11. refuses an absurdly long expression instead of parsing it', async () => {
    const error = await refusal(Array.from({ length: 5_000 }, () => '1').join('+'));
    expect(error.message).toMatch(/too long/i);
  });

  it('12. refuses deep nesting instead of blowing the stack', async () => {
    // A recursive-descent parser handed 500 open parens will throw a
    // RangeError somewhere deep inside itself, which surfaces as a
    // crashed run rather than a refused tool call.
    // 200 deep: comfortably past MAX_DEPTH but still inside the length
    // limit, so this tests nesting and not the length check.
    const deep = `${'('.repeat(200)}1${')'.repeat(200)}`;
    const error = await refusal(deep);
    expect(error.kind).toBe('invalid_input');
    expect(error.message).toMatch(/nest|deep/i);
  });

  it('throws MathError from the bare evaluator, so callers can tell why', () => {
    expect(() => evaluate('1 +')).toThrow(MathError);
  });
});

describe('math.eval reports itself honestly', () => {
  it('renders the expression and its answer, not a JSON dump', async () => {
    const result = await mathEval.execute({ expression: '2 + 2' }, ctx);
    const rendered = mathEval.renderForModel(result, 100);
    expect(rendered.text).toBe('2 + 2 = 4');
    expect(rendered.truncated).toBe(false);
  });

  it('is pure and safe, so it never needs an approval', () => {
    expect(mathEval.effect).toBe('pure');
    expect(mathEval.risk).toBe('safe');
    expect(mathEval.capabilities).toEqual([]);
    // Reachable even from FOREIGN content: arithmetic on a number in a
    // web page cannot hurt anyone.
    expect(mathEval.minTrust).toBe('FOREIGN');
  });
});
