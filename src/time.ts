/**
 * Time-zone helpers. Cloudflare cron triggers run in UTC, so the Worker runs
 * every hour and uses these helpers to decide whether it is time to send
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
 * If Cloudflare skips or delays one hourly run, the next run catches up,
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
  return {
    day: fmt(day, short),
    week: `${fmt(monday, short)} – ${fmt(sunday, short)}`,
    month: fmt(day, { month: "long", year: "numeric" }),
  };
}
