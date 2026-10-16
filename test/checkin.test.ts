import { describe, expect, it } from "vitest";
import { isFinishedSignal, parseRank, splitItems } from "../src/checkin";
import { parseReviewAnswer } from "../src/review";

describe("splitItems", () => {
  it("splits lines and removes bullets and numbering", () => {
    expect(splitItems("- Finish deck\n2) Call bank\n• Plan trip\n\n  Gym  ")).toEqual([
      "Finish deck",
      "Call bank",
      "Plan trip",
      "Gym",
    ]);
  });
});

describe("parseRank", () => {
  it("reads 1-5 in a few formats", () => {
    expect(parseRank("2")).toBe(2);
    expect(parseRank("rank 4")).toBe(4);
    expect(parseRank("1 - urgent")).toBe(1);
  });

  it("rejects anything else", () => {
    expect(parseRank("7")).toBeNull();
    expect(parseRank("high")).toBeNull();
  });
});

describe("isFinishedSignal", () => {
  it("recognizes common ways to finish", () => {
    expect(isFinishedSignal("Done")).toBe(true);
    expect(isFinishedSignal("that's all!")).toBe(true);
    expect(isFinishedSignal("done with the deck")).toBe(false);
  });
});


describe("parseReviewAnswer", () => {
  const today = "2026-10-15"; // Thursday
  it("reads yes, no and drop", () => {
    expect(parseReviewAnswer("Yes!", today)).toEqual({ kind: "yes" });
    expect(parseReviewAnswer("done", today)).toEqual({ kind: "yes" });
    expect(parseReviewAnswer("not yet", today)).toEqual({ kind: "no" });
    expect(parseReviewAnswer("drop", today)).toEqual({ kind: "drop" });
  });

  it("reads a day to move the task to", () => {
    expect(parseReviewAnswer("Fri", today)).toEqual({ kind: "move", date: "2026-10-16" });
    expect(parseReviewAnswer("move to Oct 28", today)).toEqual({ kind: "move", date: "2026-10-28" });
    expect(parseReviewAnswer("tomorrow", today)).toEqual({ kind: "move", date: "2026-10-16" });
  });

  it("rejects anything else", () => {
    expect(parseReviewAnswer("maybe", today)).toEqual({ kind: "invalid" });
  });
});
