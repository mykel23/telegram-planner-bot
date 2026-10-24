import { describe, expect, it } from "vitest";
import type { Grocery, Ingredient } from "../src/db";
import { dishName, dishText, groceryPickText, recipeModeExpired, recipesText, removeText } from "../src/recipes";

const tacos = { id: 7, name: "Chicken Tacos" };
const item = (id: number, name: string, checked = 0): Ingredient => ({ id, recipe_id: 7, item: name, checked });

describe("recipes", () => {
  it("names a dish in title case", () => {
    expect(dishName("  chicken   tacos ")).toBe("Chicken Tacos");
  });

  it("shows a button per dish and one to add a dish", () => {
    expect(recipesText([]).inline).toEqual([[{ text: "➕ Add a dish", data: "rnew" }]]);
    const view = recipesText([tacos, { id: 8, name: "Pasta" }]);
    expect(view.inline[0].map((b) => b.data)).toEqual(["r:7", "r:8"]);
  });

  it("checks ingredients off without removing them", () => {
    const view = dishText(tacos, [item(1, "tortillas", 1), item(2, "ground beef")]);
    expect(view.text).toContain("1 of 2 checked");
    expect(view.text).toContain("✅ Tortillas");
    expect(view.text).toContain("⬜ Ground Beef");
    const data = view.inline.flat().map((b) => b.data);
    expect(data).toEqual(expect.arrayContaining(["rc:1", "rc:2", "rr:7", "rg:7", "ra:7", "rx:7", "rd:7", "rm"]));
  });

  it("offers Reset only once something is checked", () => {
    const data = dishText(tacos, [item(1, "tortillas")]).inline.flat().map((b) => b.data);
    expect(data).not.toContain("rr:7");
  });

  it("asks for ingredients when a dish has none", () => {
    const view = dishText(tacos, [], "", true);
    expect(view.text).toContain("No ingredients yet");
    expect(view.inline.flat().map((b) => b.data)).toEqual(["r:7"]);
  });

  it("removes ingredients with ❌ buttons", () => {
    expect(removeText(tacos, [item(1, "salt")]).inline[0][0]).toEqual({ text: "❌ Salt", data: "rxi:1" });
  });

  it("adds to one store's list only by tapping, and points out other lists", () => {
    const groceries: Grocery[] = [
      { id: 1, item: "Tortillas", store: "Kroger" },
      { id: 2, item: "Cheese", store: "Walmart" },
    ];
    const view = groceryPickText(tacos, [item(1, "tortillas"), item(2, "cheese"), item(3, "onion")], groceries, "Kroger", "0");
    expect(view.text).toContain("On the Kroger list: Tortillas");
    expect(view.text).toContain("Already on another list: Cheese (Walmart)");
    const data = view.inline.flat().map((b) => b.data);
    expect(data).toEqual(expect.arrayContaining(["rgi:2:0", "rgi:3:0", "rga:7:0", "rg:7", "r:7"]));
    expect(data).not.toContain("rgi:1:0");
  });

  it("keeps button data under Telegram's 64-byte limit", () => {
    const view = groceryPickText(tacos, [item(123456789, "x")], [], null, "x");
    for (const b of view.inline.flat()) expect(new TextEncoder().encode(b.data).length).toBeLessThanOrEqual(64);
  });

  it("stops typing ingredients after 20 minutes", () => {
    expect(recipeModeExpired(null)).toBe(true);
    expect(recipeModeExpired({ at: 0 }, 19 * 60_000)).toBe(false);
    expect(recipeModeExpired({ at: 0 }, 21 * 60_000)).toBe(true);
  });
});
