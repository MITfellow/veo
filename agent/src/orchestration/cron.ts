/**
 * Cron, by the wall clock (§28, M8).
 *
 * Pure: a spec, an instant and an IANA timezone in; the next instant out.
 * No state, no clock, no storage — which is what lets the DST cases be
 * tested as a table rather than as a simulation.
 *
 * **The whole design is "resolve by the wall clock, never by the offset".**
 * "Every weekday at 9am" means the thing the person's kitchen clock says.
 * So the search walks forward in *local* minutes and asks `Intl` what
 * instant each local minute corresponds to, rather than computing an offset
 * once and adding it. Two consequences fall out for free:
 *
 * - **Spring forward.** 02:30 does not exist on the transition day; the
 *   local minute simply never matches, and the next match is the following
 *   day. A `02:30` daily alarm therefore skips that day rather than firing
 *   twice or at a surprise hour. Callers that need "fire at the first
 *   existing minute instead" get that from `nextFireAfter`'s `gapPolicy`.
 * - **Fall back.** 01:30 happens twice. Both occurrences are real instants
 *   and both match, but the second is only reachable by asking for a fire
 *   strictly after the first, and `ScheduleStore` always asks relative to
 *   `lastFiredAt`. One wall-clock 01:30, one fire.
 *
 * Five fields, standard order, no seconds field: `minute hour dom month dow`.
 * A seconds field would make `MIN_INTERVAL_MS` a lie and invites a personal
 * agent to wake up sixty times a minute.
 */

export interface CronSpec {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dayOfWeek: ReadonlySet<number>;
  /** True when the field was a bare `*`; crontab's dom/dow OR rule needs it. */
  domRestricted: boolean;
  dowRestricted: boolean;
  source: string;
}

export class CronParseError extends Error {
  constructor(spec: string, detail: string) {
    super(`cannot parse cron spec '${spec}': ${detail}`);
    this.name = 'CronParseError';
  }
}

/**
 * The shortest interval a schedule may repeat at.
 *
 * `* * * * *` is a loop that wakes a model up sixty times an hour forever,
 * which is how an agent denies service to itself and bills its owner for
 * the privilege. Rejected at the parser, not at the UI, because the UI is
 * not the only caller (§36: ports, not manners).
 */
export const MIN_INTERVAL_MS = 5 * 60_000;

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const FIELDS = [
  { name: 'minute', min: 0, max: 59, names: [] as readonly string[] },
  { name: 'hour', min: 0, max: 23, names: [] as readonly string[] },
  { name: 'day-of-month', min: 1, max: 31, names: [] as readonly string[] },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'day-of-week', min: 0, max: 7, names: DAY_NAMES },
] as const;

/** Friendly spellings people actually type. Expanded before parsing. */
const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@weekdays': '0 9 * * 1-5',
};

function parseField(raw: string, index: number): { values: Set<number>; restricted: boolean } {
  const field = FIELDS[index]!;
  const values = new Set<number>();
  const restricted = raw.trim() !== '*';

  for (const part of raw.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    if (rangePart === undefined || rangePart === '') {
      throw new CronParseError(raw, `empty term in the ${field.name} field`);
    }
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new CronParseError(raw, `'${stepPart ?? ''}' is not a step in the ${field.name} field`);
    }

    let from: number;
    let to: number;
    if (rangePart === '*') {
      from = field.min;
      to = field.max;
    } else {
      const [lo, hi] = rangePart.split('-');
      from = toNumber(lo ?? '', field.names, field.name);
      to = hi === undefined ? (stepPart === undefined ? from : field.max) : toNumber(hi, field.names, field.name);
    }

    if (from < field.min || to > field.max || from > to) {
      throw new CronParseError(raw, `${from}-${to} is outside ${field.min}-${field.max} for ${field.name}`);
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }

  // Cron's day-of-week accepts both 0 and 7 for Sunday. Normalising here
  // means nothing downstream has to remember it.
  if (index === 4 && values.has(7)) {
    values.delete(7);
    values.add(0);
  }

  return { values, restricted };
}

function toNumber(token: string, names: readonly string[], fieldName: string): number {
  const lowered = token.trim().toLowerCase();
  const named = names.indexOf(lowered);
  if (named !== -1) return fieldName === 'month' ? named + 1 : named;
  const n = Number(lowered);
  if (!Number.isInteger(n)) throw new CronParseError(token, `'${token}' is not a number in the ${fieldName} field`);
  return n;
}

export function parseCron(spec: string): CronSpec {
  const expanded = ALIASES[spec.trim().toLowerCase()] ?? spec;
  const parts = expanded.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(spec, `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, index) => parseField(part, index));

  return {
    minute: minute!.values,
    hour: hour!.values,
    dayOfMonth: dayOfMonth!.values,
    month: month!.values,
    dayOfWeek: dayOfWeek!.values,
    domRestricted: dayOfMonth!.restricted,
    dowRestricted: dayOfWeek!.restricted,
    source: expanded.trim(),
  };
}

/** Validation for the API edge: a parse error *and* the interval floor. */
export function validateCron(spec: string, timezone: string): CronSpec {
  const parsed = parseCron(spec);
  if (!isValidTimezone(timezone)) {
    throw new CronParseError(spec, `'${timezone}' is not a timezone this system knows`);
  }
  const first = nextFireAfter(parsed, Date.UTC(2026, 0, 1), timezone);
  const second = first === null ? null : nextFireAfter(parsed, first, timezone);
  if (first !== null && second !== null && second - first < MIN_INTERVAL_MS) {
    throw new CronParseError(
      spec,
      `that fires every ${Math.round((second - first) / 1000)}s; the floor is ${MIN_INTERVAL_MS / 60_000} minutes ` +
        `(an agent that wakes up constantly is a denial of service against its own owner)`,
    );
  }
  return parsed;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let cached = FORMATTERS.get(timezone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    FORMATTERS.set(timezone, cached);
  }
  return cached;
}

/** What a clock on the wall in `timezone` reads at instant `ts`. */
export function localPartsOf(ts: number, timezone: string): LocalParts {
  const parts = formatterFor(timezone).formatToParts(new Date(ts));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: DAY_NAMES.indexOf(get('weekday').toLowerCase()),
  };
}

/**
 * The instant at which `timezone`'s wall clock reads the given local time.
 *
 * Returns `null` when that local time does not exist (the spring-forward
 * gap). Two refinement passes rather than one: the first guess can be off
 * by the offset, and the offset itself can change across the guess — an
 * hour either side of a transition. Two passes converge for every zone on
 * earth, and the result is verified by reading the clock back, so a third
 * pass would only be a different way of being wrong.
 */
export function instantOfLocal(local: Omit<LocalParts, 'weekday'>, timezone: string): number | null {
  let guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  for (let pass = 0; pass < 2; pass += 1) {
    const read = localPartsOf(guess, timezone);
    const readAsUtc = Date.UTC(read.year, read.month - 1, read.day, read.hour, read.minute);
    const wanted = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    if (readAsUtc === wanted) return guess;
    guess += wanted - readAsUtc;
  }
  const final = localPartsOf(guess, timezone);
  const matches =
    final.year === local.year &&
    final.month === local.month &&
    final.day === local.day &&
    final.hour === local.hour &&
    final.minute === local.minute;
  return matches ? guess : null;
}

function matches(spec: CronSpec, parts: LocalParts): boolean {
  if (!spec.minute.has(parts.minute)) return false;
  if (!spec.hour.has(parts.hour)) return false;
  if (!spec.month.has(parts.month)) return false;

  // Crontab's oldest wart, kept because every other cron keeps it: when
  // *both* day fields are restricted the match is an OR, not an AND. So
  // "0 0 13 * 5" is the 13th **or** any Friday, which is how "Friday the
  // 13th" is famously *not* expressible.
  const domHit = spec.dayOfMonth.has(parts.day);
  const dowHit = spec.dayOfWeek.has(parts.weekday);
  if (spec.domRestricted && spec.dowRestricted) return domHit || dowHit;
  if (spec.domRestricted) return domHit;
  if (spec.dowRestricted) return dowHit;
  return true;
}

/** How far forward the search will look before giving up. */
const SEARCH_LIMIT_MINUTES = 366 * 24 * 60 + 60;

/**
 * The next instant strictly after `after` at which the wall clock in
 * `timezone` satisfies `spec`, or `null` if there is none within a year.
 *
 * Strictly after, always: a fire at exactly `after` would re-fire the slot
 * that just ran every time the scheduler asked what comes next.
 */
export function nextFireAfter(spec: CronSpec, after: number, timezone: string): number | null {
  const start = localPartsOf(after, timezone);
  let year = start.year;
  let month = start.month;
  let day = start.day;
  let hour = start.hour;
  let minute = start.minute;

  for (let step = 0; step < SEARCH_LIMIT_MINUTES; step += 1) {
    // Advance first: the slot we are standing on has already fired.
    minute += 1;
    if (minute > 59) {
      minute = 0;
      hour += 1;
    }
    if (hour > 23) {
      hour = 0;
      day += 1;
    }
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day > daysInMonth) {
      day = 1;
      month += 1;
    }
    if (month > 12) {
      month = 1;
      year += 1;
    }

    // Cheap rejections before the expensive `Intl` call: month and
    // minute-of-hour knock out the overwhelming majority of candidates.
    if (!spec.month.has(month)) continue;
    if (!spec.minute.has(minute)) continue;
    if (!spec.hour.has(hour)) continue;

    const instant = instantOfLocal({ year, month, day, hour, minute }, timezone);
    // `null` is the spring-forward gap: that wall-clock minute does not
    // exist today, so nothing can fire at it.
    if (instant === null) continue;
    if (instant <= after) continue;

    if (matches(spec, localPartsOf(instant, timezone))) return instant;
  }

  return null;
}

/**
 * Every fire between two instants, exclusive of `from`, inclusive of `to`.
 *
 * This is what catch-up is computed from after an outage. Bounded by
 * `limit` so that a three-month outage cannot produce a hundred thousand
 * element array on the way to deciding to skip almost all of them.
 */
export function firesBetween(
  spec: CronSpec,
  from: number,
  to: number,
  timezone: string,
  limit = 1000,
): number[] {
  const fires: number[] = [];
  let cursor = from;
  while (fires.length < limit) {
    const next = nextFireAfter(spec, cursor, timezone);
    if (next === null || next > to) break;
    fires.push(next);
    cursor = next;
  }
  return fires;
}
