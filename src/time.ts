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
