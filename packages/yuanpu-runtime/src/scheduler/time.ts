import type { ScheduleTiming } from '@yuanpu-agent/protocol';

interface CronField {
  values: ReadonlySet<number>;
  wildcard: boolean;
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const cronCache = new Map<string, ParsedCron>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    value.format(new Date(0));
    formatters.set(timeZone, value);
  }
  return value;
}

export function assertTimeZone(timeZone: string): void {
  if (!timeZone || timeZone.length > 128) throw new Error('timeZone must be an IANA time zone.');
  try {
    formatter(timeZone);
  } catch {
    throw new Error(`Unsupported IANA time zone: ${timeZone}.`);
  }
}

function parseField(source: string, minimum: number, maximum: number, sunday = false): CronField {
  const values = new Set<number>();
  const wildcard = source === '*' || source.startsWith('*/');
  for (const item of source.split(',')) {
    const [rangeSource, stepSource] = item.split('/');
    if (rangeSource === undefined || item.split('/').length > 2) throw new Error('Invalid cron field.');
    const step = stepSource === undefined ? 1 : Number(stepSource);
    if (!Number.isSafeInteger(step) || step < 1) throw new Error('Invalid cron step.');
    let start: number;
    let end: number;
    if (rangeSource === '*') {
      start = minimum;
      end = maximum;
    } else if (rangeSource.includes('-')) {
      const bounds = rangeSource.split('-').map(Number);
      if (bounds.length !== 2) throw new Error('Invalid cron range.');
      [start, end] = bounds as [number, number];
    } else {
      start = Number(rangeSource);
      end = start;
    }
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < minimum
      || end > maximum
      || start > end
    ) {
      throw new Error('Cron value is out of range.');
    }
    for (let value = start; value <= end; value += step) values.add(sunday && value === 7 ? 0 : value);
  }
  return { values, wildcard };
}

export function parseCron(expression: string): ParsedCron {
  const normalized = expression.trim().replace(/\s+/g, ' ');
  const cached = cronCache.get(normalized);
  if (cached) return cached;
  const fields = normalized.split(' ');
  if (fields.length !== 5) throw new Error('Cron expression must contain five fields.');
  const parsed: ParsedCron = {
    minute: parseField(fields[0]!, 0, 59),
    hour: parseField(fields[1]!, 0, 23),
    dayOfMonth: parseField(fields[2]!, 1, 31),
    month: parseField(fields[3]!, 1, 12),
    dayOfWeek: parseField(fields[4]!, 0, 7, true),
  };
  cronCache.set(normalized, parsed);
  return parsed;
}

function wallClock(date: Date, timeZone: string): WallClockParts {
  const parts = Object.fromEntries(
    formatter(timeZone).formatToParts(date).map((part) => [part.type, part.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '');
  if (weekday < 0) throw new Error('Unable to resolve weekday in selected time zone.');
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    dayOfWeek: weekday,
  };
}

function wallKey(parts: WallClockParts): string {
  return [parts.year, parts.month, parts.day, parts.hour, parts.minute].join('-');
}

function matches(cron: ParsedCron, parts: WallClockParts): boolean {
  if (!cron.month.values.has(parts.month)) return false;
  const dayOfMonth = cron.dayOfMonth.values.has(parts.day);
  const dayOfWeek = cron.dayOfWeek.values.has(parts.dayOfWeek);
  const dayMatches = cron.dayOfMonth.wildcard
    ? dayOfWeek
    : cron.dayOfWeek.wildcard
      ? dayOfMonth
      : dayOfMonth || dayOfWeek;
  return dayMatches && cron.hour.values.has(parts.hour) && cron.minute.values.has(parts.minute);
}

function matchesCalendarDay(cron: ParsedCron, parts: WallClockParts): boolean {
  if (!cron.month.values.has(parts.month)) return false;
  const dayOfMonth = cron.dayOfMonth.values.has(parts.day);
  const dayOfWeek = cron.dayOfWeek.values.has(parts.dayOfWeek);
  return cron.dayOfMonth.wildcard
    ? dayOfWeek
    : cron.dayOfWeek.wildcard
      ? dayOfMonth
      : dayOfMonth || dayOfWeek;
}

function isRepeatedWallMinute(date: Date, timeZone: string, key: string): boolean {
  for (let minutes = 1; minutes <= 180; minutes += 1) {
    const previous = new Date(date.getTime() - minutes * 60_000);
    if (wallKey(wallClock(previous, timeZone)) === key) return true;
  }
  return false;
}

export function nextCronOccurrence(expression: string, timeZone: string, after: Date): Date {
  assertTimeZone(timeZone);
  const cron = parseCron(expression);
  let timestamp = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const maximum = timestamp + 5 * 366 * 24 * 60 * 60_000;
  for (; timestamp <= maximum; timestamp += 60_000) {
    const date = new Date(timestamp);
    const parts = wallClock(date, timeZone);
    if (!matchesCalendarDay(cron, parts)) {
      // Jump near the next local day while retaining a three-hour cushion for DST/offset changes.
      const minutesUntilNextDay = 24 * 60 - (parts.hour * 60 + parts.minute);
      timestamp += Math.max(0, minutesUntilNextDay - 181) * 60_000;
      continue;
    }
    if (!matches(cron, parts)) continue;
    const key = wallKey(parts);
    // Ambiguous fall-back wall times run only at the first physical occurrence.
    if (isRepeatedWallMinute(date, timeZone, key)) continue;
    return date;
  }
  throw new Error('Cron expression has no occurrence within the next five years.');
}

export function firstOccurrence(timing: ScheduleTiming, timeZone: string, now: Date): Date {
  assertTimeZone(timeZone);
  if (timing.kind === 'once') {
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(timing.at)) {
      throw new Error('One-time schedules require an ISO timestamp with an explicit UTC offset.');
    }
    const timestamp = Date.parse(timing.at);
    if (!Number.isFinite(timestamp)) throw new Error('One-time schedule timestamp is invalid.');
    return new Date(timestamp);
  }
  return nextCronOccurrence(timing.expression, timeZone, now);
}

export function followingOccurrence(
  timing: ScheduleTiming,
  timeZone: string,
  occurrence: Date,
): Date | undefined {
  if (timing.kind === 'once') return undefined;
  return nextCronOccurrence(timing.expression, timeZone, occurrence);
}
