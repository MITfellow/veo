/**
 * `unit.convert` — the other half of the arithmetic problem (S2).
 *
 * `math.eval` fixed "the model cannot add". This fixes "the model
 * cannot convert", which fails the same way: 4 oz becomes 113.4 g or
 * 113.39800000000001 g or, occasionally, 120 g, and all three look
 * equally like an answer.
 *
 * No currency. A currency conversion needs a rate, a rate needs a
 * network call, and a *stale* rate is worse than no answer because it
 * looks like a good one. The tool refuses it by name and says why,
 * rather than letting a model think "usd" is a unit it does not know.
 */
import { z } from 'zod';
import type { Tool } from '../capability/tool.js';

/** Every unit as a factor relative to the dimension's base unit. */
interface UnitDef {
  dimension: string;
  /** value_in_base = value * factor + offset */
  factor: number;
  offset?: number;
  /** What to call it when rendering. */
  label: string;
}

const UNITS: Record<string, UnitDef> = {
  /* length — base metre */
  nm: { dimension: 'length', factor: 1e-9, label: 'nm' },
  mm: { dimension: 'length', factor: 0.001, label: 'mm' },
  cm: { dimension: 'length', factor: 0.01, label: 'cm' },
  m: { dimension: 'length', factor: 1, label: 'm' },
  km: { dimension: 'length', factor: 1000, label: 'km' },
  // The spelled-out forms. "convert 42 kilometres into miles" was
  // answered with "not a unit I know" until S3 ran the app and asked
  // it — nobody types "km" when they are talking to a person.
  metre: { dimension: 'length', factor: 1, label: 'm' },
  metres: { dimension: 'length', factor: 1, label: 'm' },
  meter: { dimension: 'length', factor: 1, label: 'm' },
  meters: { dimension: 'length', factor: 1, label: 'm' },
  kilometre: { dimension: 'length', factor: 1000, label: 'km' },
  kilometres: { dimension: 'length', factor: 1000, label: 'km' },
  kilometer: { dimension: 'length', factor: 1000, label: 'km' },
  kilometers: { dimension: 'length', factor: 1000, label: 'km' },
  centimetre: { dimension: 'length', factor: 0.01, label: 'cm' },
  centimetres: { dimension: 'length', factor: 0.01, label: 'cm' },
  centimeter: { dimension: 'length', factor: 0.01, label: 'cm' },
  centimeters: { dimension: 'length', factor: 0.01, label: 'cm' },
  millimetre: { dimension: 'length', factor: 0.001, label: 'mm' },
  millimetres: { dimension: 'length', factor: 0.001, label: 'mm' },
  millimeter: { dimension: 'length', factor: 0.001, label: 'mm' },
  millimeters: { dimension: 'length', factor: 0.001, label: 'mm' },
  in: { dimension: 'length', factor: 0.0254, label: 'in' },
  inch: { dimension: 'length', factor: 0.0254, label: 'in' },
  inches: { dimension: 'length', factor: 0.0254, label: 'in' },
  ft: { dimension: 'length', factor: 0.3048, label: 'ft' },
  foot: { dimension: 'length', factor: 0.3048, label: 'ft' },
  feet: { dimension: 'length', factor: 0.3048, label: 'ft' },
  yd: { dimension: 'length', factor: 0.9144, label: 'yd' },
  yard: { dimension: 'length', factor: 0.9144, label: 'yd' },
  mi: { dimension: 'length', factor: 1609.344, label: 'mi' },
  mile: { dimension: 'length', factor: 1609.344, label: 'mi' },
  miles: { dimension: 'length', factor: 1609.344, label: 'mi' },
  nmi: { dimension: 'length', factor: 1852, label: 'nmi' },

  /* mass — base kilogram */
  mg: { dimension: 'mass', factor: 1e-6, label: 'mg' },
  g: { dimension: 'mass', factor: 0.001, label: 'g' },
  gram: { dimension: 'mass', factor: 0.001, label: 'g' },
  grams: { dimension: 'mass', factor: 0.001, label: 'g' },
  kg: { dimension: 'mass', factor: 1, label: 'kg' },
  kilogram: { dimension: 'mass', factor: 1, label: 'kg' },
  kilograms: { dimension: 'mass', factor: 1, label: 'kg' },
  kilo: { dimension: 'mass', factor: 1, label: 'kg' },
  kilos: { dimension: 'mass', factor: 1, label: 'kg' },
  t: { dimension: 'mass', factor: 1000, label: 't' },
  oz: { dimension: 'mass', factor: 0.028349523125, label: 'oz' },
  ounce: { dimension: 'mass', factor: 0.028349523125, label: 'oz' },
  ounces: { dimension: 'mass', factor: 0.028349523125, label: 'oz' },
  lb: { dimension: 'mass', factor: 0.45359237, label: 'lb' },
  lbs: { dimension: 'mass', factor: 0.45359237, label: 'lb' },
  pound: { dimension: 'mass', factor: 0.45359237, label: 'lb' },
  pounds: { dimension: 'mass', factor: 0.45359237, label: 'lb' },
  stone: { dimension: 'mass', factor: 6.35029318, label: 'st' },
  st: { dimension: 'mass', factor: 6.35029318, label: 'st' },

  /* volume — base litre */
  ml: { dimension: 'volume', factor: 0.001, label: 'ml' },
  l: { dimension: 'volume', factor: 1, label: 'l' },
  litre: { dimension: 'volume', factor: 1, label: 'l' },
  liter: { dimension: 'volume', factor: 1, label: 'l' },
  litres: { dimension: 'volume', factor: 1, label: 'l' },
  liters: { dimension: 'volume', factor: 1, label: 'l' },
  tsp: { dimension: 'volume', factor: 0.00492892159375, label: 'tsp' },
  tbsp: { dimension: 'volume', factor: 0.01478676478125, label: 'tbsp' },
  // US customary, stated: a UK cup is 284ml and the difference ruins a
  // recipe. If someone wants Imperial they have to say so.
  cup: { dimension: 'volume', factor: 0.2365882365, label: 'cup (US)' },
  cups: { dimension: 'volume', factor: 0.2365882365, label: 'cup (US)' },
  pint: { dimension: 'volume', factor: 0.473176473, label: 'pt (US)' },
  pt: { dimension: 'volume', factor: 0.473176473, label: 'pt (US)' },
  quart: { dimension: 'volume', factor: 0.946352946, label: 'qt (US)' },
  qt: { dimension: 'volume', factor: 0.946352946, label: 'qt (US)' },
  gal: { dimension: 'volume', factor: 3.785411784, label: 'gal (US)' },
  gallon: { dimension: 'volume', factor: 3.785411784, label: 'gal (US)' },
  floz: { dimension: 'volume', factor: 0.0295735295625, label: 'fl oz (US)' },

  /* temperature — base celsius, the one dimension with an offset */
  c: { dimension: 'temperature', factor: 1, offset: 0, label: '°C' },
  celsius: { dimension: 'temperature', factor: 1, offset: 0, label: '°C' },
  f: { dimension: 'temperature', factor: 5 / 9, offset: -32 * (5 / 9), label: '°F' },
  fahrenheit: { dimension: 'temperature', factor: 5 / 9, offset: -32 * (5 / 9), label: '°F' },
  k: { dimension: 'temperature', factor: 1, offset: -273.15, label: 'K' },
  kelvin: { dimension: 'temperature', factor: 1, offset: -273.15, label: 'K' },

  /* data — base byte. GB and GiB are different and the difference is 7%. */
  b: { dimension: 'data', factor: 1, label: 'B' },
  byte: { dimension: 'data', factor: 1, label: 'B' },
  bytes: { dimension: 'data', factor: 1, label: 'B' },
  kb: { dimension: 'data', factor: 1e3, label: 'kB' },
  mb: { dimension: 'data', factor: 1e6, label: 'MB' },
  gb: { dimension: 'data', factor: 1e9, label: 'GB' },
  tb: { dimension: 'data', factor: 1e12, label: 'TB' },
  kib: { dimension: 'data', factor: 1024, label: 'KiB' },
  mib: { dimension: 'data', factor: 1024 ** 2, label: 'MiB' },
  gib: { dimension: 'data', factor: 1024 ** 3, label: 'GiB' },
  tib: { dimension: 'data', factor: 1024 ** 4, label: 'TiB' },

  /* duration — base second */
  ms: { dimension: 'duration', factor: 0.001, label: 'ms' },
  s: { dimension: 'duration', factor: 1, label: 's' },
  sec: { dimension: 'duration', factor: 1, label: 's' },
  second: { dimension: 'duration', factor: 1, label: 's' },
  seconds: { dimension: 'duration', factor: 1, label: 's' },
  min: { dimension: 'duration', factor: 60, label: 'min' },
  minute: { dimension: 'duration', factor: 60, label: 'min' },
  minutes: { dimension: 'duration', factor: 60, label: 'min' },
  h: { dimension: 'duration', factor: 3600, label: 'h' },
  hr: { dimension: 'duration', factor: 3600, label: 'h' },
  hour: { dimension: 'duration', factor: 3600, label: 'h' },
  hours: { dimension: 'duration', factor: 3600, label: 'h' },
  day: { dimension: 'duration', factor: 86_400, label: 'day' },
  days: { dimension: 'duration', factor: 86_400, label: 'day' },
  week: { dimension: 'duration', factor: 604_800, label: 'week' },
  weeks: { dimension: 'duration', factor: 604_800, label: 'week' },

  /* speed — base metres per second */
  mps: { dimension: 'speed', factor: 1, label: 'm/s' },
  kph: { dimension: 'speed', factor: 1000 / 3600, label: 'km/h' },
  kmh: { dimension: 'speed', factor: 1000 / 3600, label: 'km/h' },
  mph: { dimension: 'speed', factor: 1609.344 / 3600, label: 'mph' },
  knot: { dimension: 'speed', factor: 1852 / 3600, label: 'kn' },
  knots: { dimension: 'speed', factor: 1852 / 3600, label: 'kn' },
};

/** Currencies, listed so the refusal can be specific instead of "unknown unit". */
const CURRENCIES = new Set([
  'usd', 'eur', 'gbp', 'inr', 'jpy', 'cny', 'chf', 'cad', 'aud', 'brl', 'zar',
  'dollar', 'dollars', 'euro', 'euros', 'pound sterling', 'rupee', 'rupees', 'yen',
  '$', '€', '£', '₹', '¥',
]);

const normalise = (unit: string): string =>
  unit
    .trim()
    .toLowerCase()
    .replace(/^°/, '')
    .replace(/\s+/g, '')
    .replace(/^degrees?/, '')
    .replace(/\/s$/, 'ps');

export class UnitError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'UnitError';
  }
}

/**
 * Trim floating-point noise without lying about precision.
 *
 * 12 significant digits is well inside a double's 15–17, so this
 * removes the `0.000000000001` tails that come out of a ratio
 * conversion while never inventing a digit that was not there.
 */
function render(value: number): string {
  if (!Number.isFinite(value)) throw new UnitError('that is not a finite number');
  const rounded = Number.parseFloat(value.toPrecision(12));
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded);
}

export function convert(value: number, fromUnit: string, toUnit: string): {
  value: number;
  text: string;
  dimension: string;
  from: string;
  to: string;
} {
  const fromKey = normalise(fromUnit);
  const toKey = normalise(toUnit);

  for (const [key, original] of [
    [fromKey, fromUnit],
    [toKey, toUnit],
  ] as const) {
    if (CURRENCIES.has(key)) {
      throw new UnitError(
        `I cannot convert ${original.trim()} — a currency needs an exchange rate, and ` +
          'fetching one would mean a network call this agent does not make.',
        'A stale rate looks like a good answer, which is why there is no built-in one.',
      );
    }
  }

  const from = UNITS[fromKey];
  const to = UNITS[toKey];
  if (from === undefined) {
    throw new UnitError(`'${fromUnit.trim()}' is not a unit I know`, 'Try cm, kg, oz, ml, °F, GiB.');
  }
  if (to === undefined) {
    throw new UnitError(`'${toUnit.trim()}' is not a unit I know`, 'Try cm, kg, oz, ml, °F, GiB.');
  }
  if (from.dimension !== to.dimension) {
    throw new UnitError(
      `${from.label} measures ${from.dimension} and ${to.label} measures ${to.dimension}, ` +
        'so there is no conversion between them.',
    );
  }

  const inBase = value * from.factor + (from.offset ?? 0);
  const result = (inBase - (to.offset ?? 0)) / to.factor;
  return {
    value: result,
    text: render(result),
    dimension: from.dimension,
    from: from.label,
    to: to.label,
  };
}

/**
 * The units, in the schema rather than only in the prose.
 *
 * §36 calls the schema the single definition of a tool's arguments,
 * and this set is genuinely closed — `convert` rejects anything not in
 * `UNITS`. Leaving it out of the schema meant a caller had to guess
 * from two examples in a description, which is how the offline
 * provider ended up passing the string "convert kilometres miles" as
 * a unit. A model gets the same benefit.
 *
 * Derived from `UNITS` rather than written out again: a second list
 * would drift from the first the moment anyone adds a unit.
 */
const UNIT_NAMES = Object.keys(UNITS) as [string, ...string[]];

const Input = z.object({
  value: z.number().finite(),
  from: z
    .enum(UNIT_NAMES)
    .describe('The unit to convert from, e.g. "oz", "°F", "GiB", "kilometres".'),
  to: z.enum(UNIT_NAMES).describe('The unit to convert to, e.g. "g", "°C", "MiB", "miles".'),
});

const Output = z.object({
  value: z.number(),
  text: z.string(),
  dimension: z.string(),
  from: z.string(),
  to: z.string(),
});

export const unitConvert: Tool<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: 'unit.convert',
  version: '1',
  description:
    'Converts between units of length, mass, volume, temperature, data, duration and speed — ' +
    'oz to g, °F to °C, GiB to MB, miles to km. Use this instead of converting yourself; you ' +
    'are not reliable at it. It cannot do currency, which would need a live exchange rate.',
  input: Input,
  output: Output,
  capabilities: [],
  // Pure arithmetic on numbers. Converting a figure out of a web page
  // cannot hurt anyone, so it is reachable at the floor.
  minTrust: 'FOREIGN',
  risk: 'safe',
  effect: 'pure',
  idempotent: true,
  timeoutMs: 1000,

  async execute(input) {
    try {
      return { ok: true, value: convert(input.value, input.from, input.to), trust: 'SYSTEM' };
    } catch (error) {
      if (error instanceof UnitError) {
        return {
          ok: false,
          error: {
            kind: 'invalid_input',
            message: error.message,
            retryable: false,
            ...(error.hint === undefined ? {} : { hint: error.hint }),
          },
        };
      }
      throw error;
    }
  },

  renderForModel(result) {
    if (!result.ok) return { text: result.error.message, truncated: false };
    const { value } = result;
    return { text: `${value.text} ${value.to}`, truncated: false };
  },
};
