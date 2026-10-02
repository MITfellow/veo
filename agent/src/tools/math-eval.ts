/**
 * `math.eval` — arithmetic the agent gets right (S1).
 *
 * ## Why this is not three lines
 *
 * The three-line version is `return eval(expr)`, or its respectable
 * cousin `new Function('return ' + expr)`. Both are remote code
 * execution with a friendly name. The input to this tool comes from a
 * model, and the input to the model comes from whatever the user
 * pasted, which may have come from a web page. §13's threat model has
 * exactly this shape, so the parser is written out: a recursive-descent
 * evaluator over a fixed grammar that cannot reach a JavaScript scope
 * because it never produces JavaScript.
 *
 * ## Why not floats
 *
 * `0.1 + 0.2` is `0.30000000000000004` in IEEE 754. That is correct and
 * it is the wrong answer to the question a person asked. Addition,
 * subtraction, multiplication and division are done on integers scaled
 * by a power of ten and rendered back, so money behaves. `sqrt` and
 * fractional powers fall back to floating point and say so in the
 * output, because pretending otherwise would be the same lie one level
 * down.
 */
import { z } from 'zod';
import type { Tool } from '../capability/tool.js';

const MAX_LENGTH = 1_000;
const MAX_DEPTH = 32;
/** Beyond this the scaled integers stop fitting usefully in a bigint-free world. */
const MAX_SCALE = 12;

const Input = z.object({
  expression: z
    .string()
    .min(1)
    .max(MAX_LENGTH, `an expression longer than ${MAX_LENGTH} characters is not a calculation`),
});

const Output = z.object({
  expression: z.string(),
  result: z.string(),
  exact: z.boolean(),
});

export class MathError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'MathError';
  }
}

/* ────────────────────────── exact decimals ──────────────────────────── */

/** A decimal as an integer and a scale: 1.25 is { value: 125, scale: 2 }. */
interface Decimal {
  value: number;
  scale: number;
  /** False once a float operation has been involved. */
  exact: boolean;
}

const dec = (value: number, scale = 0, exact = true): Decimal => ({ value, scale, exact });

const toNumber = (d: Decimal): number => d.value / 10 ** d.scale;

/** Line both operands up on the larger scale so integer maths is valid. */
function align(a: Decimal, b: Decimal): { a: number; b: number; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return { a: a.value * 10 ** (scale - a.scale), b: b.value * 10 ** (scale - b.scale), scale };
}

function fromNumber(n: number, exact = false): Decimal {
  if (!Number.isFinite(n)) throw new MathError('that is not a finite number', 0);
  if (Number.isInteger(n)) return dec(n, 0, exact);
  // Keep the shortest representation JavaScript will admit to.
  const text = String(n);
  const dot = text.indexOf('.');
  if (dot === -1 || text.includes('e') || text.includes('E')) return dec(n, 0, false);
  const scale = Math.min(text.length - dot - 1, MAX_SCALE);
  return dec(Math.round(n * 10 ** scale), scale, exact);
}

function render(d: Decimal): string {
  if (!d.exact) {
    const n = toNumber(d);
    // Trim the float noise that makes an answer unreadable.
    return String(Number(n.toPrecision(12)));
  }
  if (d.scale === 0) return String(d.value);
  const negative = d.value < 0;
  const digits = String(Math.abs(d.value)).padStart(d.scale + 1, '0');
  const whole = digits.slice(0, digits.length - d.scale);
  const fraction = digits.slice(digits.length - d.scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/* ──────────────────────────── the parser ────────────────────────────── */

type Token =
  | { kind: 'number'; value: Decimal; at: number }
  | { kind: 'op'; value: string; at: number }
  | { kind: 'name'; value: string; at: number };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === ',') {
      i += 1;
      continue;
    }
    if (char >= '0' && char <= '9') {
      let j = i;
      while (j < input.length && ((input[j]! >= '0' && input[j]! <= '9') || input[j] === '_')) j += 1;
      let scale = 0;
      if (input[j] === '.') {
        j += 1;
        const start = j;
        while (j < input.length && input[j]! >= '0' && input[j]! <= '9') j += 1;
        scale = j - start;
      }
      const text = input.slice(i, j).replace(/_/g, '');
      const value = Number(text.replace('.', ''));
      if (!Number.isSafeInteger(value)) {
        throw new MathError('that number is too large to be exact', i);
      }
      if (scale > MAX_SCALE) throw new MathError(`more than ${MAX_SCALE} decimal places`, i);
      tokens.push({ kind: 'number', value: dec(value, scale), at: i });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(char)) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j).toLowerCase(), at: i });
      i = j;
      continue;
    }
    if ('+-*/%^()'.includes(char)) {
      tokens.push({ kind: 'op', value: char, at: i });
      i += 1;
      continue;
    }
    throw new MathError(`'${char}' is not something this calculator understands`, i);
  }
  return tokens;
}

/**
 * The function list, written out.
 *
 * An allowlist rather than a lookup on `Math`: `Math` carries
 * `constructor`, and a tool that resolves a model-supplied name against
 * a live object is one prototype hop from somewhere it should not be.
 */
const FUNCTIONS: Record<string, (args: number[]) => number> = {
  abs: ([a]) => Math.abs(a!),
  min: (args) => Math.min(...args),
  max: (args) => Math.max(...args),
  round: ([a, places]) => {
    const factor = 10 ** Math.trunc(places ?? 0);
    return Math.round(a! * factor) / factor;
  },
  floor: ([a]) => Math.floor(a!),
  ceil: ([a]) => Math.ceil(a!),
  sqrt: ([a]) => Math.sqrt(a!),
};

/** Functions whose result is not exact, so the answer says so. */
const INEXACT = new Set(['sqrt']);

class Parser {
  private at = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Decimal {
    const value = this.expression();
    if (this.at < this.tokens.length) {
      const token = this.tokens[this.at]!;
      throw new MathError(`unexpected '${String(token.value)}'`, token.at);
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private eat(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'op' && token.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  /** `+` and `-`, lowest precedence. */
  private expression(): Decimal {
    let left = this.term();
    for (;;) {
      const sign = this.eat('+') ? 1 : this.eat('-') ? -1 : 0;
      if (sign === 0) return left;

      const from = this.at;
      let right = this.term();
      // `250 + 8%` means 250 plus 8 percent *of 250* — the convention
      // every pocket calculator and spreadsheet uses, and the one a
      // person writing it has in mind. Decision 040. It applies only
      // when the right side is exactly a bare percent literal; in
      // `250 + 8% * 2` the percent is just a number again.
      if (this.isBarePercentSpan(from)) {
        right = fromNumber(toNumber(right) * toNumber(left), right.exact && left.exact);
      }
      const { a, b, scale } = align(left, right);
      left = dec(sign === 1 ? a + b : a - b, scale, left.exact && right.exact);
    }
  }

  /** Were the tokens from `from` to here exactly `<number> %`? */
  private isBarePercentSpan(from: number): boolean {
    if (this.at !== from + 2) return false;
    const number = this.tokens[from];
    const percent = this.tokens[from + 1];
    return (
      number?.kind === 'number' && percent?.kind === 'op' && percent.value === '%'
    );
  }

  /** `*`, `/` and `%`. */
  private term(): Decimal {
    let left = this.unary();
    for (;;) {
      if (this.eat('*')) {
        const right = this.unary();
        const scale = Math.min(left.scale + right.scale, MAX_SCALE);
        const raw = left.value * right.value;
        const dropped = left.scale + right.scale - scale;
        left = dec(
          Math.round(raw / 10 ** dropped),
          scale,
          left.exact && right.exact && Number.isSafeInteger(raw),
        );
      } else if (this.eat('/')) {
        const right = this.unary();
        if (toNumber(right) === 0) {
          throw new MathError('division by zero has no answer', this.tokens[this.at - 1]?.at ?? 0);
        }
        const quotient = toNumber(left) / toNumber(right);
        const exact =
          left.exact && right.exact && Number.isInteger(quotient * 10 ** MAX_SCALE);
        left = fromNumber(quotient, exact);
      } else if (this.eat('%')) {
        const right = this.unary();
        if (toNumber(right) === 0) throw new MathError('modulo by zero has no answer', 0);
        left = fromNumber(toNumber(left) % toNumber(right), left.exact && right.exact);
      } else return left;
    }
  }

  /** `^`, right-associative: 2^3^2 is 2^(3^2). Binds tighter than unary minus. */
  private power(): Decimal {
    const base = this.atom();
    if (this.eat('^')) {
      // `unary` on the right so `2^-1` parses, and right-associatively.
      const exponent = this.unary();
      const result = toNumber(base) ** toNumber(exponent);
      const whole = Number.isInteger(toNumber(exponent)) && toNumber(exponent) >= 0;
      return fromNumber(result, base.exact && exponent.exact && whole);
    }
    return base;
  }

  private unary(): Decimal {
    if (this.eat('-')) {
      const value = this.unary();
      return dec(-value.value, value.scale, value.exact);
    }
    if (this.eat('+')) return this.unary();
    return this.power();
  }

  private atom(): Decimal {
    if (this.depth > MAX_DEPTH) throw new MathError('that is nested too deeply', 0);

    const token = this.peek();
    if (token === undefined) throw new MathError('the expression stops early', 0);

    if (token.kind === 'number') {
      this.at += 1;
      // "17% of 250" and a trailing percent both mean "divide by 100".
      const next = this.peek();
      if (next?.kind === 'op' && next.value === '%' && this.isPercentSuffix()) {
        this.at += 1;
        const percent = dec(token.value.value, Math.min(token.value.scale + 2, MAX_SCALE));
        if (this.peek()?.kind === 'name' && this.peek()!.value === 'of') {
          this.at += 1;
          this.depth += 1;
          const whole = this.unary();
          this.depth -= 1;
          return fromNumber(toNumber(percent) * toNumber(whole), percent.exact && whole.exact);
        }
        return percent;
      }
      return token.value;
    }

    if (token.kind === 'name') {
      this.at += 1;
      const fn = FUNCTIONS[token.value];
      if (fn === undefined) {
        throw new MathError(`'${token.value}' is not a function this calculator has`, token.at);
      }
      if (!this.eat('(')) throw new MathError(`'${token.value}' needs brackets`, token.at);
      const args: Decimal[] = [];
      if (!this.eat(')')) {
        this.depth += 1;
        for (;;) {
          args.push(this.expression());
          if (this.eat(')')) break;
          if (this.at >= this.tokens.length) throw new MathError('a bracket is not closed', token.at);
        }
        this.depth -= 1;
      }
      const exact = args.every((a) => a.exact) && !INEXACT.has(token.value);
      return fromNumber(fn(args.map(toNumber)), exact);
    }

    if (token.value === '(') {
      this.at += 1;
      this.depth += 1;
      if (this.depth > MAX_DEPTH) throw new MathError('that is nested too deeply', token.at);
      const value = this.expression();
      this.depth -= 1;
      if (!this.eat(')')) throw new MathError('a bracket is not closed', token.at);
      return value;
    }

    throw new MathError(`unexpected '${token.value}'`, token.at);
  }

  /** A `%` is a suffix when nothing that could be a right operand follows. */
  private isPercentSuffix(): boolean {
    const after = this.tokens[this.at + 1];
    if (after === undefined) return true;
    if (after.kind === 'name') return after.value === 'of';
    if (after.kind === 'op') return after.value === ')' || '+-*/^'.includes(after.value);
    return false;
  }
}

export function evaluate(expression: string): { result: string; exact: boolean } {
  // Checked here and not only in the zod schema: `evaluate` is exported,
  // and a limit that only holds when someone remembered to validate
  // first is not a limit.
  if (expression.length > MAX_LENGTH) {
    throw new MathError(`that is too long to be a calculation (limit ${MAX_LENGTH} characters)`, 0);
  }
  const value = new Parser(tokenize(expression)).parse();
  return { result: render(value), exact: value.exact };
}

export const mathEval: Tool<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: 'math.eval',
  version: '1',
  description:
    'Calculates an arithmetic expression exactly. Supports + - * / % ^, brackets, percentages ' +
    "(\"17% of 250\"), and min, max, abs, round, floor, ceil, sqrt. Use this instead of doing " +
    'arithmetic yourself — you are not reliable at it and this is.',
  input: Input,
  output: Output,
  capabilities: [],
  minTrust: 'FOREIGN',
  risk: 'safe',
  effect: 'pure',
  idempotent: true,
  timeoutMs: 1000,

  async execute(input) {
    try {
      const { result, exact } = evaluate(input.expression);
      return { ok: true, value: { expression: input.expression, result, exact }, trust: 'SYSTEM' };
    } catch (error) {
      if (error instanceof MathError) {
        return {
          ok: false,
          error: {
            kind: 'invalid_input',
            message: `${error.message} (position ${error.position + 1})`,
            retryable: false,
            hint: 'Write it as plain arithmetic, for example (12 + 5) * 3.',
          },
        };
      }
      return {
        ok: false,
        error: {
          kind: 'invalid_input',
          message: error instanceof Error ? error.message : 'that is not a calculation',
          retryable: false,
        },
      };
    }
  },

  renderForModel(result) {
    if (!result.ok) return { text: result.error.message, truncated: false };
    return {
      text:
        `${result.value.expression} = ${result.value.result}` +
        (result.value.exact ? '' : ' (approximate)'),
      truncated: false,
    };
  },
};
