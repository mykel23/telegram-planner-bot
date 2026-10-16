import { describe, expect, it } from "vitest";
import type { Task } from "../src/env";
import { effectiveHorizon, formatAllLists, formatDailyMessage } from "../src/format";
import { periodLabels } from "../src/time";

// Friday Oct 16, 7 AM Central
const labels = periodLabels(new Date("2026-10-16T12:00:00Z"), "America/Chicago");
const none = { preferred_date: null, due_date: null, category: null, rollovers: 0, recurring_id: null };

const tasks: Task[] = [
  { id: 1, title: "Finish <deck>", horizon: "day", rank: 1, status: "doing", ...none },
  { id: 2, title: "Call bank", horizon: "day", rank: 2, status: "open", ...none },
  { id: 3, title: "Plan Q1", horizon: "week", rank: 3, status: "open", ...none },
  { id: 4, title: "Clean garage", horizon: "month", rank: 5, status: "open", ...none },
];

describe("formatDailyMessage", () => {
  it("shows current work, today's ranked list and what's next", () => {
    const msg = formatDailyMessage(tasks, "Friday, Oct 16", labels);
    expect(msg).toContain("Week: Mon, Oct 12 – Sun, Oct 18 · Month: October 2026");
    expect(msg).toContain("Friday, Oct 16");
    expect(msg).toContain("Currently working on");
    expect(msg).toContain("1. Finish &lt;deck&gt;");
    expect(msg).toContain("2. Call bank");
    expect(msg).toContain("Up next this week");
    expect(msg).toContain("Plan Q1");
  });

  it("handles empty lists", () => {
    expect(formatDailyMessage([], "Friday, Oct 16", labels)).toContain("Your lists are empty");
  });
});

describe("formatAllLists", () => {
  it("returns month, week and day sections in that order", () => {
    const msg = formatAllLists(tasks, labels);
    expect(msg).toContain("Week: Mon, Oct 12 – Sun, Oct 18");
    expect(msg).toContain("Month: October 2026");
    expect(msg).toContain("Day: Fri, Oct 16");
    const order = ["Month:", "Week:", "Day:"].map((h) => msg.indexOf(h));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(msg).toContain("Clean garage");
  });
});

describe("dates", () => {
  const base: Task = { id: 9, title: "Report", horizon: "month", rank: 3, status: "open", preferred_date: null, due_date: null, category: null, rollovers: 0, recurring_id: null };

  it("moves a task to Day when it is preferred or due today, or overdue", () => {
    expect(effectiveHorizon({ ...base, preferred_date: "2026-10-16" }, labels)).toBe("day");
    expect(effectiveHorizon({ ...base, due_date: "2026-10-14" }, labels)).toBe("day");
  });

  it("moves a task to Week when its date is later this week", () => {
    expect(effectiveHorizon({ ...base, due_date: "2026-10-18" }, labels)).toBe("week");
  });

  it("keeps a task in its list when its dates are after this week", () => {
    expect(effectiveHorizon({ ...base, due_date: "2026-10-30" }, labels)).toBe("month");
  });

  it("shows the dates and flags overdue tasks", () => {
    const msg = formatDailyMessage(
      [{ ...base, preferred_date: "2026-10-14", due_date: "2026-10-15" }],
      "Friday, Oct 16",
      labels,
    );
    expect(msg).toContain("Report ⚠️ overdue");
    expect(msg).toContain("do Wed 10/14 · by Thu 10/15");
  });

  it("flags tasks due today", () => {
    const msg = formatDailyMessage([{ ...base, due_date: "2026-10-16" }], "Friday, Oct 16", labels);
    expect(msg).toContain("❗ due today");
  });
});
