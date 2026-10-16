import { describe, expect, it } from "vitest";
import type { Task } from "../src/env";
import { formatAllLists, formatDailyMessage } from "../src/format";
import type { PeriodLabels } from "../src/time";

const labels: PeriodLabels = { day: "Fri, Oct 16", week: "Mon, Oct 12 – Sun, Oct 18", month: "October 2026" };

const tasks: Task[] = [
  { id: 1, title: "Finish <deck>", horizon: "day", rank: 1, status: "doing" },
  { id: 2, title: "Call bank", horizon: "day", rank: 2, status: "open" },
  { id: 3, title: "Plan Q1", horizon: "week", rank: 3, status: "open" },
  { id: 4, title: "Clean garage", horizon: "month", rank: 5, status: "open" },
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
