import { describe, expect, it } from "vitest";
import { interpretWithRules } from "../src/fallback";
import { addedText, splitGroceryItems, storeQuestion, storeRows } from "../src/grocery";
import { finishButtons } from "../src/views";
import { describeWeather, weatherLine } from "../src/weather";
import type { Task } from "../src/env";

describe("grocery list", () => {
  it("splits several items in one message", () => {
    expect(splitGroceryItems("milk, eggs and bread")).toEqual(["milk", "eggs", "bread"]);
    expect(splitGroceryItems("milk and eggs")).toEqual(["milk", "eggs"]);
    expect(splitGroceryItems("mac and cheese, rice")).toEqual(["mac and cheese", "rice"]);
    expect(splitGroceryItems("- apples\n- bananas\n1. coffee")).toEqual(["apples", "bananas", "coffee"]);
    expect(splitGroceryItems("   ")).toEqual([]);
  });

  it("offers saved stores as buttons, plus Any store", () => {
    expect(storeRows([])).toEqual([["Any store"]]);
    expect(storeRows(["Walmart", "H-E-B", "Costco"])).toEqual([["Walmart", "H-E-B", "Costco"], ["Any store"]]);
  });

  it("asks which store, and says what was added", () => {
    expect(storeQuestion(["milk"], true)).toContain("<b>milk</b>");
    expect(storeQuestion([], false)).toContain("Type the store's name");
    expect(addedText([{ id: 0, item: "milk", store: "Walmart" }, { id: 0, item: "eggs", store: "Walmart" }])).toBe(
      "➕ Added milk, eggs → <b>Walmart</b>",
    );
    expect(addedText([])).toBe("");
  });

  it("understands grocery messages without Claude", () => {
    expect(interpretWithRules("groceries: milk, eggs", []).actions[0]).toMatchObject({ type: "grocery", title: "milk, eggs", category: null });
    expect(interpretWithRules("add bread to my grocery list at Walmart", []).actions[0]).toMatchObject({
      type: "grocery",
      title: "bread",
      category: "Walmart",
    });
  });
});

describe("tap to finish", () => {
  const task = (id: number, title: string) => ({ id, title }) as Task;
  it("gives one ✅ button per task, tagged with the view", () => {
    expect(finishButtons([task(4, "Call the bank"), task(9, "Gym")], "t")).toEqual([
      [{ text: "✅ Call the bank", data: "d:4:t" }],
      [{ text: "✅ Gym", data: "d:9:t" }],
    ]);
  });
  it("keeps button data under Telegram's 64-byte limit", () => {
    const [[button]] = finishButtons([task(123456789, "x".repeat(100))], "m");
    expect(new TextEncoder().encode(button.data).length).toBeLessThanOrEqual(64);
  });
});

describe("weather", () => {
  it("names the weather from its code", () => {
    expect(describeWeather(0).text).toBe("clear");
    expect(describeWeather(63).text).toBe("rain");
    expect(describeWeather(95).text).toBe("thunderstorms");
  });
  it("writes one line for the morning message", () => {
    const place = { name: "Houston, Texas", lat: 29.76, lon: -95.36 };
    expect(weatherLine(place, { code: 2, high: 84.6, low: 68.2, rainChance: 40 })).toBe(
      "🌤 <b>Houston:</b> partly cloudy, 68° to 85°F, 40% chance of rain",
    );
    expect(weatherLine(place, { code: 0, high: 80, low: 60, rainChance: 5 })).toBe("☀️ <b>Houston:</b> clear, 60° to 80°F");
  });
});
