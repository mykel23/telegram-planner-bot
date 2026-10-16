import { describe, expect, it } from "vitest";
import { isDailyDue, isWeeklyDue, localTime, parseDayAnswer, periodLabels } from "../src/time";

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

describe("periodLabels", () => {
  it("gives the Monday-to-Sunday week and month for a weekday", () => {
    // Thursday Oct 15, 9 PM Central
    expect(periodLabels(new Date("2026-10-16T02:00:00Z"), TZ)).toEqual({
      day: "Thu, Oct 15",
      week: "Mon, Oct 12 – Sun, Oct 18",
      month: "October 2026",
      iso: { day: "2026-10-15", weekStart: "2026-10-12", weekEnd: "2026-10-18", monthEnd: "2026-10-31" },
    });
  });

  it("treats Sunday as the end of the current week", () => {
    expect(periodLabels(new Date("2026-10-18T23:00:00Z"), TZ).week).toBe("Mon, Oct 12 – Sun, Oct 18");
  });

  it("looks ahead to next week on Sunday when planning", () => {
    expect(periodLabels(new Date("2026-10-18T23:00:00Z"), TZ, true)).toMatchObject({
      day: "Mon, Oct 19",
      week: "Mon, Oct 19 – Sun, Oct 25",
      month: "October 2026",
    });
  });

  it("handles a week that crosses months and the daylight saving change", () => {
    expect(periodLabels(new Date("2026-11-01T23:00:00Z"), TZ, true)).toMatchObject({
      day: "Mon, Nov 2",
      week: "Mon, Nov 2 – Sun, Nov 8",
      month: "November 2026",
    });
    expect(periodLabels(new Date("2026-10-30T15:00:00Z"), TZ).week).toBe("Mon, Oct 26 – Sun, Nov 1");
  });
});

describe("parseDayAnswer", () => {
  // Planning from Monday Oct 19
  const from = "2026-10-19";
  const date = (text: string) => {
    const a = parseDayAnswer(text, from);
    return a.kind === "date" ? a.date : a.kind;
  };

  it("reads weekdays as the next one on or after the planning day", () => {
    expect(date("Mon")).toBe("2026-10-19");
    expect(date("wednesday")).toBe("2026-10-21");
    expect(date("Fri")).toBe("2026-10-23");
    expect(date("sunday")).toBe("2026-10-25");
    expect(date("next friday")).toBe("2026-10-30");
  });

  it("reads weekdays after a given day, for the latest-day question", () => {
    const a = parseDayAnswer("Fri", "2026-10-15", "2026-10-21");
    expect(a).toEqual({ kind: "date", date: "2026-10-23" });
  });

  it("reads relative days", () => {
    expect(date("today")).toBe("2026-10-19");
    expect(date("Tomorrow")).toBe("2026-10-20");
    expect(date("end of week")).toBe("2026-10-25");
    expect(date("end of month")).toBe("2026-10-31");
  });

  it("reads dates in several formats", () => {
    expect(date("Oct 28")).toBe("2026-10-28");
    expect(date("October 28th")).toBe("2026-10-28");
    expect(date("28 oct")).toBe("2026-10-28");
    expect(date("10/28")).toBe("2026-10-28");
    expect(date("11/5/2026")).toBe("2026-11-05");
    expect(date("Nov 12")).toBe("2026-11-12");
    expect(date("the 30th")).toBe("2026-10-30");
  });

  it("rolls past dates into the future", () => {
    expect(date("the 5th")).toBe("2026-11-05");
    expect(date("Jan 3")).toBe("2027-01-03");
    expect(date("10/1")).toBe("2027-10-01");
  });

  it("recognizes skip and same, and rejects nonsense", () => {
    expect(date("skip")).toBe("skip");
    expect(date("none")).toBe("skip");
    expect(date("same")).toBe("same");
    expect(date("soonish")).toBe("invalid");
    expect(date("Feb 30")).toBe("invalid");
  });
});
