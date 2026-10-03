/**
 * S2 tests 1–10: `unit.convert`.
 *
 * Same failure mode as the arithmetic tool: the wrong answer and the
 * right answer look identical, so the tests concentrate on the cases
 * where a plausible implementation is quietly wrong — temperature
 * offsets, the GB/GiB split, and dimensional nonsense.
 */
import { describe, expect, it } from 'vitest';
import { convert, UnitError, unitConvert } from '../../src/tools/unit-convert.js';
import type { ToolContext } from '../../src/capability/tool.js';
import { jsonSchemaOf } from '../../src/capability/schema-json.js';

const ctx = null as unknown as ToolContext; // pure: touches nothing

const text = async (value: number, from: string, to: string): Promise<string> => {
  const result = await unitConvert.execute({ value, from, to }, ctx);
  if (!result.ok) throw new Error(`refused: ${result.error.message}`);
  return result.value.text;
};

const refusal = async (value: number, from: string, to: string) => {
  const result = await unitConvert.execute({ value, from, to }, ctx);
  if (result.ok) throw new Error(`expected a refusal, got ${result.value.text}`);
  return result.error;
};

describe('unit.convert gets it right', () => {
  it('1. length, without a floating-point tail', async () => {
    expect(await text(4, 'in', 'cm')).toBe('10.16');
    expect(await text(1, 'mi', 'km')).toBe('1.609344');
    expect(await text(100, 'cm', 'm')).toBe('1');
  });

  it('2. mass: 4 oz is 113.398 g, not 113.39800000000001', async () => {
    // The exact definition is 28.349523125 g/oz, so the answer has a
    // real tail — but not the one a double produces.
    expect(await text(4, 'oz', 'g')).toBe('113.3980925');
    expect(await text(1, 'kg', 'lb')).toBe('2.20462262185');
    expect(await text(70, 'kg', 'stone')).toBe('11.0231131092');
  });

  it('3. temperature applies the offset, not just a ratio', async () => {
    // A ratio-only implementation gives 55.6 here, which is the single
    // most common way to get this wrong.
    expect(await text(100, 'f', 'c')).toBe('37.7777777778');
    expect(await text(0, 'c', 'f')).toBe('32');
    expect(await text(100, 'c', 'k')).toBe('373.15');
  });

  it('4. −40 °C is −40 °F, the fixed point', async () => {
    // The one temperature where the two scales agree. An implementation
    // that drops the offset gets −40 °C → −40 °F right by accident only
    // if it also drops the ratio, so this pins both at once.
    expect(await text(-40, 'c', 'f')).toBe('-40');
    expect(await text(-40, 'f', 'c')).toBe('-40');
    expect(await text(-273.15, 'c', 'k')).toBe('0');
  });

  it('5. volume, with the US cup stated rather than assumed', async () => {
    expect(await text(1, 'cup', 'ml')).toBe('236.5882365');
    expect(await text(1, 'gal', 'l')).toBe('3.785411784');
    const result = await unitConvert.execute({ value: 1, from: 'cup', to: 'ml' }, ctx);
    // A UK cup is 284ml and the difference ruins a recipe, so the
    // rendered unit says which one was used.
    expect(result.ok && result.value.from).toBe('cup (US)');
  });

  it('6. data: GB and GiB are not the same, and the gap is 7%', async () => {
    expect(await text(1, 'gib', 'mib')).toBe('1024');
    expect(await text(1, 'gb', 'mb')).toBe('1000');
    // 1 GiB is 1.073741824 GB. An implementation that treats them as
    // synonyms returns 1 here.
    expect(await text(1, 'gib', 'gb')).toBe('1.073741824');
  });

  it('7. round-trips return the original', async () => {
    for (const [value, a, b] of [
      [37.5, 'c', 'f'],
      [12.25, 'kg', 'lb'],
      [3, 'mi', 'km'],
      [1.5, 'gib', 'kb'],
    ] as const) {
      const there = convert(value, a, b).value;
      const back = convert(there, b, a).value;
      expect(back, `${value} ${a}→${b}→${a}`).toBeCloseTo(value, 9);
    }
  });
});

describe('unit.convert refuses rather than guessing', () => {
  it('8. incompatible dimensions are refused, naming both', async () => {
    const error = await refusal(3, 'kg', 'm');
    expect(error.kind).toBe('invalid_input');
    expect(error.message).toMatch(/mass/);
    expect(error.message).toMatch(/length/);
    expect(error.retryable).toBe(false);
  });

  it('9. an unknown unit is refused and nothing is guessed', async () => {
    const error = await refusal(3, 'smoot', 'm');
    expect(error.message).toMatch(/smoot/);
    expect(error.message).toMatch(/not a unit/);
    expect(error.hint).toMatch(/cm|kg/);
  });

  it('10. currency is refused by name, saying why', async () => {
    // Not "unknown unit" — the model has to learn that this is a thing
    // the agent deliberately will not do, not a gap in a table.
    for (const currency of ['usd', 'EUR', '₹', 'rupees']) {
      const error = await refusal(100, currency, 'gbp');
      expect(error.message, currency).toMatch(/currency/i);
      expect(error.message, currency).toMatch(/network|rate/i);
    }
  });

  it('throws UnitError from the bare function, so callers can tell why', () => {
    expect(() => convert(1, 'kg', 'litre')).toThrow(UnitError);
  });
});

describe('unit.convert reports itself honestly', () => {
  it('renders the number and the unit, not a JSON dump', async () => {
    const result = await unitConvert.execute({ value: 4, from: 'oz', to: 'g' }, ctx);
    expect(unitConvert.renderForModel(result, 100).text).toBe('113.3980925 g');
  });

  it('is pure and safe, so it never needs an approval', () => {
    expect(unitConvert.effect).toBe('pure');
    expect(unitConvert.risk).toBe('safe');
    expect(unitConvert.capabilities).toEqual([]);
    expect(unitConvert.minTrust).toBe('FOREIGN');
  });
});

/**
 * S3: found by running the app, not by a test.
 *
 * "convert 42 kilometres into miles" came back "'convert kilometres
 * miles' is not a unit I know" — two bugs in one answer. The second
 * was that `kilometres` was not a unit the tool knew at all, which
 * would have failed with a real model too.
 */
describe('the units people actually type', () => {
  it('knows the spelled-out forms, not only the symbols', () => {
    expect(convert(42, 'kilometres', 'miles').value).toBeCloseTo(26.0976, 3);
    expect(convert(1, 'kilometre', 'metres').value).toBe(1000);
    expect(convert(2, 'kilograms', 'pounds').value).toBeCloseTo(4.4092, 3);
    expect(convert(100, 'centimeters', 'meter').value).toBe(1);
    expect(convert(5, 'millimetres', 'cm').value).toBe(0.5);
    expect(convert(3, 'kilos', 'g').value).toBe(3000);
  });

  it('offers the whole closed set in its schema', () => {
    // §36: the schema is the single definition. A caller should not
    // have to guess the vocabulary from two examples in a sentence.
    const schema = jsonSchemaOf(unitConvert.input) as {
      properties?: Record<string, { enum?: string[] }>;
    };
    const from = schema.properties?.['from']?.enum ?? [];
    expect(from).toContain('kilometres');
    expect(from).toContain('celsius');
    expect(from).toContain('fahrenheit');
    expect(from.length).toBeGreaterThan(50);
    // And it is derived from the table, not a second copy of it.
    expect(from).toEqual(schema.properties?.['to']?.enum);
  });
});
