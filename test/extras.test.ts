import { describe, expect, it } from "vitest";
import { interpretWithRules } from "../src/fallback";
import { addedText, areaFromZipResponse, parseZip, photonToOsm, splitGroceryItems, storeQuestion, storeRows, storesFromOsm } from "../src/grocery";
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
    expect(storeQuestion([], true)).toBe("🛒 Which store would you like to add? Tap one, or type a new store's name.");
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

describe("stores near a ZIP code", () => {
  it("reads a ZIP code from a message", () => {
    expect(parseZip("60601")).toBe("60601");
    expect(parseZip("my zip is 77002-1234")).toBe("77002");
    expect(parseZip("6060")).toBeNull();
  });

  it("reads the place from Zippopotam.us", () => {
    const sample = {
      "post code": "60601",
      country: "United States",
      places: [{ "place name": "Chicago", longitude: "-87.6181", state: "Illinois", "state abbreviation": "IL", latitude: "41.8858" }],
    };
    expect(areaFromZipResponse("60601", sample)).toEqual({ zip: "60601", name: "Chicago, IL", lat: 41.8858, lon: -87.6181 });
    expect(areaFromZipResponse("00000", {})).toBeNull();
  });

  it("lists nearby stores closest first, one button per chain", () => {
    const sample = {
      elements: [
        { type: "node", lat: 41.9, lon: -87.62, tags: { shop: "supermarket", name: "Jewel-Osco", brand: "Jewel-Osco" } },
        { type: "way", center: { lat: 41.886, lon: -87.619 }, tags: { shop: "supermarket", name: "Mariano's" } },
        { type: "node", lat: 41.95, lon: -87.65, tags: { shop: "supermarket", name: "Jewel-Osco #3345", brand: "Jewel-Osco" } },
        { type: "node", lat: 41.87, lon: -87.63, tags: { shop: "supermarket", name: "ALDI", brand: "Aldi" } },
        { type: "node", lat: 41.88, lon: -87.62, tags: { shop: "supermarket" } },
      ],
    };
    expect(storesFromOsm(sample, 41.8858, -87.6181)).toEqual(["Mariano's", "Jewel-Osco", "Aldi"]);
    expect(storesFromOsm({}, 0, 0)).toEqual([]);
    // Stores past the distance limit are left out.
    expect(storesFromOsm(sample, 41.8858, -87.6181, 0.5)).toEqual(["Mariano's"]);
  });

  it("reads Photon results the same way", () => {
    const photon = {
      features: [
        { geometry: { coordinates: [-87.63, 41.87] }, properties: { name: "Aldi", osm_value: "supermarket" } },
        { geometry: { coordinates: [-88.9, 42.9] }, properties: { name: "Far Away Foods" } },
      ],
    };
    expect(storesFromOsm(photonToOsm(photon), 41.8858, -87.6181, 10)).toEqual(["Aldi"]);
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
