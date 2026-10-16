/**
 * Time-zone helpers. Cloudflare cron triggers run in UTC, so the Worker runs
 * every minute and uses these helpers to decide whether it is time to send
 * something in the owner's local time zone (daylight saving included).
 */

export interface LocalTime {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** Local hour, 0-23. */
  hour: number;
  /** Local weekday name in English, e.g. "Sunday". */
  weekday: string;
}

export function localTime(now: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "long",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    weekday: get("weekday"),
  };
}

/**
 * How many hours after the target hour a missed send may still go out.
 * If Cloudflare skips or delays a run, the next run catches up,
 * but a message never arrives hours late.
 */
export const CATCH_UP_HOURS = 2;

export function inSendWindow(hour: number, targetHour: number): boolean {
  return hour >= targetHour && hour <= targetHour + CATCH_UP_HOURS;
}

export function isDailyDue(now: LocalTime, dailyHour: number, lastSentDate: string | null): boolean {
  return inSendWindow(now.hour, dailyHour) && lastSentDate !== now.date;
}

export function isWeeklyDue(
  now: LocalTime,
  weeklyDay: string,
  weeklyHour: number,
  lastSentDate: string | null,
): boolean {
  return (
    now.weekday.toLowerCase() === weeklyDay.trim().toLowerCase() &&
    inSendWindow(now.hour, weeklyHour) &&
    lastSentDate !== now.date
  );
}

/** "Friday, Oct 16" in the owner's time zone. */
export function friendlyDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(now);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 86_400_000;

/** Date labels for the day, week (Monday to Sunday) and month lists. */
export interface PeriodLabels {
  /** "Mon, Oct 19" */
  day: string;
  /** "Mon, Oct 19 – Sun, Oct 25" */
  week: string;
  /** "October 2026" */
  month: string;
  /** The same periods as YYYY-MM-DD dates, for comparisons. */
  iso: { day: string; weekStart: string; weekEnd: string; monthEnd: string };
}

/**
 * Weeks run Monday 12:00 AM to Sunday 11:59 PM in the owner's time zone.
 * With planAhead (used by the weekly check-in), Sunday looks ahead to the
 * week that starts the next day.
 */
export function periodLabels(now: Date, timeZone: string, planAhead = false): PeriodLabels {
  const { date, weekday } = localTime(now, timeZone);
  const [y, m, d] = date.split("-").map(Number);
  // Work on the local calendar date as a UTC timestamp, so daylight saving can't shift it.
  let day = Date.UTC(y, m - 1, d);
  let mondayOffset = (WEEKDAYS.indexOf(weekday) + 6) % 7; // Monday = 0 ... Sunday = 6
  if (planAhead && mondayOffset === 6) {
    day += DAY_MS;
    mondayOffset = 0;
  }
  const monday = day - mondayOffset * DAY_MS;
  const sunday = monday + 6 * DAY_MS;
  const fmt = (t: number, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(new Date(t));
  const short: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  const dayDate = new Date(day);
  const monthEnd = Date.UTC(dayDate.getUTCFullYear(), dayDate.getUTCMonth() + 1, 0);
  return {
    day: fmt(day, short),
    week: `${fmt(monday, short)} – ${fmt(sunday, short)}`,
    month: fmt(day, { month: "long", year: "numeric" }),
    iso: { day: isoDate(day), weekStart: isoDate(monday), weekEnd: isoDate(sunday), monthEnd: isoDate(monthEnd) },
  };
}

function isoDate(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function parseIso(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(iso: string, days: number): string {
  return isoDate(parseIso(iso) + days * DAY_MS);
}

/** "Wed 10/21" */
export function shortDate(iso: string): string {
  const t = new Date(parseIso(iso));
  return `${WEEKDAYS[t.getUTCDay()].slice(0, 3)} ${t.getUTCMonth() + 1}/${t.getUTCDate()}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export type DayAnswer = { kind: "date"; date: string } | { kind: "skip" } | { kind: "same" } | { kind: "invalid" };

/**
 * Reads a day from a check-in reply, relative to the planning day `fromIso`:
 * "Fri", "next friday", "today", "tomorrow", "Oct 28", "10/28", "28th",
 * "end of week", "end of month", "skip", or "same" (same as the preferred day).
 * Weekdays mean the next one on or after `weekdayFromIso` (the planning day
 * unless given, e.g. the preferred day when asking for the latest day); a date
 * without a year that has already passed this year means next year.
 */
export function parseDayAnswer(text: string, fromIso: string, weekdayFromIso: string = fromIso): DayAnswer {
  const t = text.trim().toLowerCase().replace(/[.!,]+$/, "").replace(/\s+/g, " ");
  if (/^(skip|none|no|n\/a|-|no date|no deadline|whenever|any ?day)$/.test(t)) return { kind: "skip" };
  if (/^(same|same day|same as preferred)$/.test(t)) return { kind: "same" };
  if (t === "today") return { kind: "date", date: fromIso };
  if (t === "tomorrow") return { kind: "date", date: addDays(fromIso, 1) };

  const from = new Date(parseIso(fromIso));
  if (/^(end of (the )?week|eow|this weekend|weekend)$/.test(t)) {
    const toSunday = (7 - from.getUTCDay()) % 7;
    return { kind: "date", date: addDays(fromIso, toSunday) };
  }
  if (/^(end of (the )?month|eom)$/.test(t)) {
    return { kind: "date", date: isoDate(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0)) };
  }

  const weekday = t.match(/^(next |this )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/);
  if (weekday) {
    const target = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(weekday[2]);
    const start = new Date(parseIso(weekdayFromIso));
    let ahead = (target - start.getUTCDay() + 7) % 7;
    if (weekday[1] === "next ") ahead += 7;
    return { kind: "date", date: addDays(weekdayFromIso, ahead) };
  }

  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/))) {
    month = Number(m[1]) - 1;
    day = Number(m[2]);
    if (m[3]) year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  } else if ((m = t.match(/^(?:the )?(\d{1,2})(?:st|nd|rd|th)$/))) {
    month = from.getUTCMonth();
    day = Number(m[1]);
    const candidate = Date.UTC(from.getUTCFullYear(), month, day);
    if (candidate < from.getTime()) month++;
  } else if ((m = t.match(/^(?:[a-z]+ )?([a-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/))) {
    month = MONTHS.indexOf(m[1]);
    day = Number(m[2]);
    if (m[3]) year = Number(m[3]);
  } else if ((m = t.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3})[a-z]*(?: (\d{4}))?$/))) {
    month = MONTHS.indexOf(m[2]);
    day = Number(m[1]);
    if (m[3]) year = Number(m[3]);
  }
  if (month == null || month < 0 || day == null || day < 1 || day > 31) return { kind: "invalid" };

  let y = year ?? from.getUTCFullYear();
  let candidate = Date.UTC(y, month, day);
  if (new Date(candidate).getUTCDate() !== day && month < 12) return { kind: "invalid" };
  if (year == null && candidate < from.getTime()) candidate = Date.UTC(++y, month, day);
  return { kind: "date", date: isoDate(candidate) };
}

/** 0 = Sunday ... 6 = Saturday, for a YYYY-MM-DD date. */
export function weekdayIndex(iso: string): number {
  return new Date(parseIso(iso)).getUTCDay();
}

/** Last day of the month that `iso` falls in, as a day number (28-31). */
export function daysInMonth(iso: string): number {
  const t = new Date(parseIso(iso));
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * The UTC instant for a wall-clock time in a time zone, e.g. 2:00 PM on
 * 2026-10-16 in America/Chicago. Daylight saving is handled by measuring
 * the zone's offset at that moment.
 */
export function zonedTimeToUtc(dateIso: string, hour: number, minute: number, timeZone: string): Date {
  const [y, m, d] = dateIso.split("-").map(Number);
  const wanted = Date.UTC(y, m - 1, d, hour, minute);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
    const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    guess += wanted - shown;
  }
  return new Date(guess);
}

/** "Fri 10/16, 2:00 PM" in the owner's time zone. */
export function friendlyDateTime(when: Date, timeZone: string): string {
  const { date } = localTime(when, timeZone);
  const clock = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(when);
  return `${shortDate(date)}, ${clock}`;
}

/** "2:05 PM" in the owner's time zone. */
export function clockTime(when: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(when);
}
