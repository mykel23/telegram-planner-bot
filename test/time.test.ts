import { describe, expect, it } from "vitest";
import { isDailyDue, isWeeklyDue, localTime } from "../src/time";

const TZ = "America/Chicago";

describe("localTime", () => {
  it("converts UTC to Central Daylight Time (UTC-5)", () => {
    const t = localTime(new Date("2026-10-16T12:00:00Z"), TZ);
    expect(t).toEqual({ date: "2026-10-16", hour: 7, weekday: "Friday" });
  });

  it("converts UTC to Central Standard Time (UTC-6) after daylight saving ends", () => {
    const t = localTime(new Date("2026-11-02T13:00:00Z"), TZ);
    expect(t).toEqual({ date: "2026-11-02", hour: 7, weekday: "Monday" });
  });

  it("handles the date rolling over in UTC before it does locally", () => {
    const t = localTime(new Date("2026-10-19T01:00:00Z"), TZ);
    expect(t).toEqual({ date: "2026-10-18", hour: 20, weekday: "Sunday" });
  });
});

describe("isDailyDue", () => {
  const at = (hour: number) => ({ date: "2026-10-16", hour, weekday: "Friday" });

  it("is due at the daily hour if not sent today", () => {
    expect(isDailyDue(at(7), 7, "2026-10-15")).toBe(true);
    expect(isDailyDue(at(7), 7, null)).toBe(true);
  });

  it("is not due twice on the same day", () => {
    expect(isDailyDue(at(8), 7, "2026-10-16")).toBe(false);
  });

  it("catches up for two hours after a missed run, then gives up", () => {
    expect(isDailyDue(at(9), 7, "2026-10-15")).toBe(true);
    expect(isDailyDue(at(10), 7, "2026-10-15")).toBe(false);
  });

  it("is not due before the daily hour", () => {
    expect(isDailyDue(at(6), 7, "2026-10-15")).toBe(false);
  });
});

describe("isWeeklyDue", () => {
  it("is due on the right day and hour", () => {
    expect(isWeeklyDue({ date: "2026-10-18", hour: 18, weekday: "Sunday" }, "Sunday", 18, null)).toBe(true);
  });

  it("is not due on other days", () => {
    expect(isWeeklyDue({ date: "2026-10-17", hour: 18, weekday: "Saturday" }, "Sunday", 18, null)).toBe(false);
  });

  it("is not due twice on the same day", () => {
    expect(isWeeklyDue({ date: "2026-10-18", hour: 19, weekday: "Sunday" }, "Sunday", 18, "2026-10-18")).toBe(false);
  });
});

describe("a full week of hourly cron runs", () => {
  it("sends exactly one daily message per day at 7 AM local, across the daylight saving change", () => {
    let last: string | null = null;
    const sentAt: string[] = [];
    const start = Date.parse("2026-10-28T00:00:00Z");
    for (let h = 0; h < 24 * 8; h++) {
      const now = new Date(start + h * 3_600_000);
      const local = localTime(now, TZ);
      if (isDailyDue(local, 7, last)) {
        last = local.date;
        sentAt.push(`${local.date} ${local.hour}:00`);
      }
    }
    expect(sentAt).toEqual([
      "2026-10-28 7:00",
      "2026-10-29 7:00",
      "2026-10-30 7:00",
      "2026-10-31 7:00",
      "2026-11-01 7:00",
      "2026-11-02 7:00",
      "2026-11-03 7:00",
      "2026-11-04 7:00",
    ]);
  });
});
