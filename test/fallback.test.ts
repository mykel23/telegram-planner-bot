import { describe, expect, it } from "vitest";
import type { Task } from "../src/env";
import { findTask, interpretWithRules, planWithRules } from "../src/fallback";

const task = (id: number, title: string, rank = 3, extra: Partial<Task> = {}): Task => ({
  id,
  title,
  rank,
  horizon: "week",
  status: "open",
  ...extra,
});

const tasks = [task(1, "Finish the quarterly deck"), task(2, "Call the bank"), task(3, "Book dentist appointment")];

describe("findTask", () => {
  it("matches by partial title", () => {
    expect(findTask("the deck", tasks)?.id).toBe(1);
    expect(findTask("call the bank", tasks)?.id).toBe(2);
  });

  it("matches by id", () => {
    expect(findTask("#3", tasks)?.id).toBe(3);
  });

  it("returns null when nothing is close", () => {
    expect(findTask("walk the dog", tasks)).toBeNull();
  });
});

describe("interpretWithRules", () => {
  it("parses add with a list and rank", () => {
    const result = interpretWithRules("add Email Sarah today, rank 1", tasks);
    expect(result.actions).toEqual([{ type: "add", title: "Email Sarah", horizon: "day", rank: 1, task_id: null }]);
  });

  it("parses a plain add", () => {
    const result = interpretWithRules("add pick up dry cleaning", tasks);
    expect(result.actions[0]).toMatchObject({ type: "add", title: "pick up dry cleaning", horizon: null, rank: null });
  });

  it("parses done with", () => {
    const result = interpretWithRules("done with the bank", tasks);
    expect(result.actions).toEqual([{ type: "done", task_id: 2, title: null, horizon: null, rank: null }]);
  });

  it("explains when a done task can't be found", () => {
    const result = interpretWithRules("done with taxes", tasks);
    expect(result.actions).toEqual([]);
    expect(result.reply).toContain("taxes");
  });

  it("parses what's on today", () => {
    const result = interpretWithRules("what's on today?", tasks);
    expect(result.actions[0]).toMatchObject({ type: "show", horizon: "day" });
  });
});

describe("planWithRules", () => {
  it("puts top-ranked and in-progress tasks on today, then week, then month", () => {
    const plan = planWithRules([
      task(1, "a", 1),
      task(2, "b", 3),
      task(3, "c", 5),
      task(4, "d", 4, { status: "doing" }),
    ]);
    expect(Object.fromEntries(plan)).toEqual({ 1: "day", 2: "week", 3: "month", 4: "day" });
  });

  it("caps today at five tasks", () => {
    const many = Array.from({ length: 7 }, (_, i) => task(i + 1, `t${i}`, 1));
    const days = [...planWithRules(many).values()].filter((h) => h === "day");
    expect(days).toHaveLength(5);
  });
});
