import { describe, expect, it } from "vitest";
import { interpretWithRules, localStamp } from "../src/fallback";
import { parseFieldChoice } from "../src/edit";
import { decodeRule, describeRule, encodeRule, parseRepeatText, ruleFromFields, ruleMatches } from "../src/recurring";
import { parseClock, parseReminderText } from "../src/reminders";
import { parseReviewAnswer, parseStuckAnswer } from "../src/review";
import { isFinishedSignal } from "../src/checkin";
import { friendlyDateTime, zonedTimeToUtc } from "../src/time";

const TZ = "America/Chicago";
// Thursday Oct 15, 2026, 10:00 PM Central (CDT, UTC-5)
const now = new Date("2026-10-16T03:00:00Z");

describe("repeating tasks", () => {
  it("parses common repeat phrases", () => {
    expect(parseRepeatText("gym every Mon, Wed and Fri")).toEqual({ rule: { kind: "weekly", days: [1, 3, 5] }, rest: "gym" });
    expect(parseRepeatText("water plants every day")?.rule).toEqual({ kind: "daily" });
    expect(parseRepeatText("stand-up every weekday")?.rule).toEqual({ kind: "weekly", days: [1, 2, 3, 4, 5] });
    expect(parseRepeatText("pay rent on the 1st of every month")).toEqual({ rule: { kind: "monthly", day: 1 }, rest: "pay rent" });
    expect(parseRepeatText("call mom on Friday")).toBeNull();
  });

  it("matches dates, using the last day for short months", () => {
    expect(ruleMatches({ kind: "weekly", days: [1, 3, 5] }, "2026-10-19")).toBe(true); // Monday
    expect(ruleMatches({ kind: "weekly", days: [1, 3, 5] }, "2026-10-20")).toBe(false);
    expect(ruleMatches({ kind: "monthly", day: 31 }, "2026-11-30")).toBe(true);
    expect(ruleMatches({ kind: "monthly", day: 31 }, "2026-10-30")).toBe(false);
  });

  it("round-trips and describes rules", () => {
    const rule = ruleFromFields(["fri", "mon"], null)!;
    expect(decodeRule(encodeRule(rule))).toEqual({ kind: "weekly", days: [1, 5] });
    expect(describeRule(rule)).toBe("every Mon, Fri");
    expect(describeRule({ kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6] })).toBe("every day");
    expect(describeRule({ kind: "monthly", day: 22 })).toBe("on the 22nd of each month");
  });

  it("falls back to rules for 'add ... every ...'", () => {
    const { actions } = interpretWithRules("add gym every Mon and Thu, rank 2", []);
    expect(actions[0]).toMatchObject({ type: "repeat", title: "gym", rank: 2, repeat_days: ["mon", "thu"] });
  });
});

describe("reminders", () => {
  it("reads clock times", () => {
    expect(parseClock("2pm")).toEqual({ hour: 14, minute: 0 });
    expect(parseClock("12:30 am")).toEqual({ hour: 0, minute: 30 });
    expect(parseClock("14:05")).toEqual({ hour: 14, minute: 5 });
    expect(parseClock("2")).toBeNull();
  });

  it("converts local time to UTC across daylight saving", () => {
    expect(zonedTimeToUtc("2026-10-16", 14, 0, TZ).toISOString()).toBe("2026-10-16T19:00:00.000Z"); // CDT
    expect(zonedTimeToUtc("2026-11-10", 14, 0, TZ).toISOString()).toBe("2026-11-10T20:00:00.000Z"); // CST
  });

  it("parses reminder phrases", () => {
    const a = parseReminderText("remind me to call the bank at 2pm", now, TZ)!;
    expect(a.text).toBe("call the bank");
    // 2 PM already passed tonight, so it means tomorrow.
    expect(friendlyDateTime(a.at, TZ)).toBe("Fri 10/16, 2:00 PM");

    const b = parseReminderText("remind me in 20 minutes to stretch", now, TZ)!;
    expect(b.text).toBe("stretch");
    expect(b.at.toISOString()).toBe("2026-10-16T03:20:00.000Z");

    const c = parseReminderText("remind me Monday at 9:30am to send the deck", now, TZ)!;
    expect(c.text).toBe("send the deck");
    expect(friendlyDateTime(c.at, TZ)).toBe("Mon 10/19, 9:30 AM");

    expect(parseReminderText("remind me to call the bank", now, TZ)).toBeNull();
  });

  it("falls back to rules for reminders", () => {
    const { actions } = interpretWithRules("remind me at 11pm to take vitamins", [], { now, timeZone: TZ });
    expect(actions[0]).toMatchObject({ type: "remind", title: "take vitamins", remind_at: "2026-10-15 23:00" });
    expect(localStamp(now, TZ)).toBe("2026-10-15 22:00");
  });
});

describe("buttons", () => {
  it("reads tapped buttons as answers", () => {
    expect(parseReviewAnswer("✅ Done", "2026-10-16")).toEqual({ kind: "yes" });
    expect(parseReviewAnswer("➡️ Tomorrow", "2026-10-16")).toEqual({ kind: "move", date: "2026-10-17" });
    expect(parseReviewAnswer("🗑 Drop", "2026-10-16")).toEqual({ kind: "drop" });
    expect(parseStuckAnswer("✂️ Split")).toBe("split");
    expect(parseStuckAnswer("🗓 Month")).toBe("month");
    expect(parseStuckAnswer("👍 Keep")).toBe("keep");
    expect(parseFieldChoice("Latest day")).toBe("due");
    expect(parseFieldChoice("6")).toBe("category");
    expect(isFinishedSignal("Done")).toBe(true);
  });
});
