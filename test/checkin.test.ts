import { describe, expect, it } from "vitest";
import { isFinishedSignal, parseRank, splitItems } from "../src/checkin";

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
