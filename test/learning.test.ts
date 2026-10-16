import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../src/db";
import type { Task } from "../src/env";
import { formatDailyMessage, morningScript } from "../src/format";
import { computeInsights, formatInsights, patternSummary, weeklyScorecard } from "../src/insights";
import { parseCapacity, parseVoice, toSpeech } from "../src/settings";
import { periodLabels } from "../src/time";

const ev = (kind: TaskEvent["kind"], local_date: string, title = "x", category: string | null = null): TaskEvent => ({
  kind,
  title,
  category,
  local_date,
});

// Mondays Oct 5 and 12 go well; Fridays Oct 9 and 16 don't.
const history: TaskEvent[] = [
  ev("done", "2026-10-05"),
  ev("done", "2026-10-05"),
  ev("done", "2026-10-12"),
  ev("done", "2026-10-12"),
  ev("pushed", "2026-10-09", "Call insurance", "Admin"),
  ev("pushed", "2026-10-09", "File taxes", "Admin"),
  ev("done", "2026-10-09"),
  ev("pushed", "2026-10-16", "Call insurance", "Admin"),
  ev("dropped", "2026-10-16"),
];

describe("pattern learning", () => {
  it("finds strong and weak days and what slips", () => {
    const i = computeInsights(history);
    expect(i.done).toBe(5);
    expect(i.pushed).toBe(3);
    expect(i.bestDay).toBe("Monday");
    expect(i.weakDay).toBe("Friday");
    expect(i.slippingCategories).toEqual(["Admin"]);
    expect(i.slippingTasks).toEqual(["Call insurance"]);
    expect(patternSummary(i)).toContain("Weakest day: Friday");
    expect(formatInsights(i)).toContain("strongest day is <b>Monday</b>");
  });

  it("waits for enough history before claiming patterns", () => {
    const i = computeInsights(history.slice(0, 3));
    expect(patternSummary(i)).toBe("");
    expect(formatInsights(i)).toContain("Still learning");
  });

  it("summarizes last week", () => {
    expect(weeklyScorecard(history)).toContain("✅ 5 done · ➡️ 3 pushed · 🗑 1 dropped (63% done)");
    expect(weeklyScorecard([])).toBe("");
  });
});

describe("capacity and voice", () => {
  it("reads capacity answers and buttons", () => {
    expect(parseCapacity("😮‍💨 Light")).toBe("light");
    expect(parseCapacity("normal")).toBe("normal");
    expect(parseCapacity("💪 Full")).toBe("full");
    expect(parseCapacity("maybe")).toBeNull();
  });

  it("reads voice choices", () => {
    expect(parseVoice("Draco")).toBe("draco");
    expect(parseVoice("🔇 Off")).toBe("off");
    expect(parseVoice("jarvis")).toBeNull();
  });

  it("turns a message into speech without markup or emoji", () => {
    const spoken = toSpeech("☀️ <b>Good morning!</b>\n1. Call &lt;bank&gt; <i>(rank 2 · by Wed 10/21)</i>\n• Done 10/21");
    expect(spoken).toBe("Good morning! Call <bank>. Done October 21.");
  });
});

const labels = periodLabels(new Date("2026-10-16T12:00:00Z"), "America/Chicago");
const t = (id: number, title: string, rank: number): Task => ({
  id,
  title,
  rank,
  horizon: "day",
  status: "open",
  preferred_date: null,
  due_date: null,
  category: null,
  rollovers: 0,
  recurring_id: null,
});
const day = [t(1, "Deck", 1), t(2, "Bank", 2), t(3, "Gym", 3), t(4, "Laundry", 4)];

describe("daily capacity in the morning message", () => {
  it("keeps today to the capacity and lists the rest as extra", () => {
    const msg = formatDailyMessage(day, "Friday, Oct 16", labels, 3);
    expect(msg).toContain("3. Gym");
    expect(msg).toContain("If you have extra time</b>\n4. Laundry");
  });

  it("reads the plan aloud", () => {
    expect(morningScript(day, "Friday, Oct 16", labels, 2)).toBe(
      "Good morning. Here's your plan for Friday, Oct 16. You have 2 things today. First, Deck. Second, Bank. Have a great day.",
    );
  });
});
