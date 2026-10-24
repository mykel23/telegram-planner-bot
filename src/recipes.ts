import {
  type Grocery,
  type Ingredient,
  type Recipe,
  addIngredients,
  addRecipe,
  getRecipe,
  getState,
  listGroceries,
  listIngredients,
  listRecipes,
  setState,
} from "./db";
import type { Env } from "./env";
import { escapeHtml } from "./format";
import { ANY_STORE, allStores, rankedStores, splitGroceryItems, storeId, titleCase } from "./grocery";
import type { InlineButton } from "./telegram";

/**
 * Recipes: each dish keeps its list of ingredients. Stores aren't part of a
 * recipe, because the same ingredient can come from any store.
 *   - tap a dish to see its ingredients, and tap one to check it off
 *     (checking off never deletes it); 🔄 Reset unchecks them all for next time,
 *   - 🛒 Add to grocery list: pick a store, then tap the ingredients to put on
 *     that store's list. Nothing is ever added without a tap.
 */

const CURRENT_KEY = "recipe_current";
/** Most ingredient buttons shown under one dish. */
const MAX_INGREDIENTS = 40;

export interface RecipeReply {
  text: string;
  inline: InlineButton[][];
}

const show = (item: string) => escapeHtml(titleCase(item));
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function pairs(buttons: InlineButton[]): InlineButton[][] {
  const rows: InlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

/** "chicken tacos" -> "Chicken Tacos", kept short enough for a button. */
export function dishName(text: string): string {
  return titleCase(text.trim().replace(/\s+/g, " ")).slice(0, 40);
}

// ---------- the dish being typed into ----------

/** After this long without typing ingredients, messages go back to being tasks. */
const OPEN_MINUTES = 20;

/** The dish whose ingredients are being typed, and when that started. */
export async function getCurrentRecipe(env: Env): Promise<{ id: number; at: number } | null> {
  const raw = await getState(env.DB, CURRENT_KEY);
  return raw ? (JSON.parse(raw) as { id: number; at: number }) : null;
}

export async function setCurrentRecipe(env: Env, id: number | null): Promise<void> {
  await setState(env.DB, CURRENT_KEY, id === null ? "" : JSON.stringify({ id, at: Date.now() }));
}

export function recipeModeExpired(current: { at: number } | null, now: number = Date.now()): boolean {
  return !current || now - current.at > OPEN_MINUTES * 60_000;
}

/** Saves a new dish. Reuses the existing one if a dish with that name is already saved. */
export async function createRecipe(env: Env, text: string): Promise<Recipe | null> {
  const name = dishName(text);
  if (!name) return null;
  const existing = (await listRecipes(env.DB)).find((r) => same(r.name, name));
  return existing ?? addRecipe(env.DB, name);
}

/** Adds typed ingredients to a dish, skipping ones it already has. Returns the ones added. */
export async function addRecipeItems(env: Env, recipeId: number, text: string): Promise<string[]> {
  const have = await listIngredients(env.DB, recipeId);
  const added: string[] = [];
  for (const item of splitGroceryItems(text)) {
    if (!have.some((i) => same(i.item, item)) && !added.some((a) => same(a, item))) added.push(item);
  }
  await addIngredients(env.DB, recipeId, added);
  return added;
}

// ---------- screens ----------

/** The Recipes menu: a button per dish, and one to add a dish. */
export function recipesText(recipes: Recipe[]): RecipeReply {
  const add = [{ text: "➕ Add a dish", data: "rnew" }];
  if (recipes.length === 0) {
    return {
      text: `🍳 <b>Recipes</b>\n<i>No dishes yet.</i>\n\nTap <b>➕ Add a dish</b>, then type its ingredients. You can check them off while you shop.`,
      inline: [add],
    };
  }
  const buttons = recipes.map((r) => ({ text: `🍽 ${r.name.slice(0, 26)}`, data: `r:${r.id}` }));
  return {
    text: `🍳 <b>Recipes</b>\nTap a dish to see its ingredients and check them off, or add a new dish.`,
    inline: [...pairs(buttons), add],
  };
}

export async function recipesView(env: Env): Promise<RecipeReply> {
  return recipesText(await listRecipes(env.DB));
}

/**
 * One dish: its ingredients as ⬜/✅ buttons. Tapping checks an ingredient
 * off (or back on) and never removes it. "typing" adds the hint for typing more.
 */
export function dishText(recipe: Recipe, items: Ingredient[], intro = "", typing = false): RecipeReply {
  const done = items.filter((i) => i.checked).length;
  const name = escapeHtml(recipe.name);
  const lines = [intro, items.length ? `🍳 <b>${name}</b> (${done} of ${items.length} checked)` : `🍳 <b>${name}</b>`];
  if (items.length === 0) {
    lines.push(`<i>No ingredients yet.</i>`, "", `Type them, like <i>tortillas, ground beef, cheese</i>.`);
  } else {
    lines.push(...items.map((i) => `${i.checked ? "✅" : "⬜"} ${show(i.item)}`), "");
    lines.push(
      typing
        ? `Type more ingredients, or tap <b>Done</b> when you're finished.`
        : done === items.length
          ? `🎉 Got everything. Tap <b>🔄 Reset</b> to uncheck them for next time.`
          : `<i>Tap an ingredient to check it off. It stays in the recipe.</i>`,
    );
  }
  const checks = pairs(
    items.slice(0, MAX_INGREDIENTS).map((i) => ({ text: `${i.checked ? "✅" : "⬜"} ${titleCase(i.item).slice(0, 26)}`, data: `rc:${i.id}` })),
  );
  const inline: InlineButton[][] = typing
    ? [...checks, [{ text: "✔️ Done adding", data: `r:${recipe.id}` }]]
    : [
        ...checks,
        [
          { text: "➕ Add ingredients", data: `ra:${recipe.id}` },
          ...(done ? [{ text: "🔄 Reset", data: `rr:${recipe.id}` }] : []),
        ],
        ...(items.length ? [[{ text: "🛒 Add to grocery list", data: `rg:${recipe.id}` }]] : []),
        [
          ...(items.length ? [{ text: "✏️ Remove ingredients", data: `rx:${recipe.id}` }] : []),
          { text: "🗑 Delete dish", data: `rd:${recipe.id}` },
        ],
        [{ text: "⬅️ Recipes", data: "rm" }],
      ];
  return { text: lines.filter((l, i) => l !== "" || i > 1).join("\n").trim(), inline };
}

export async function dishView(env: Env, recipeId: number, intro = "", typing = false): Promise<RecipeReply> {
  const recipe = await getRecipe(env.DB, recipeId);
  if (!recipe) return { ...(await recipesView(env)), text: `That dish was deleted.\n\n${(await recipesView(env)).text}` };
  return dishText(recipe, await listIngredients(env.DB, recipeId), intro, typing);
}

/** Taking ingredients out of a dish: one ❌ per ingredient. */
export function removeText(recipe: Recipe, items: Ingredient[]): RecipeReply {
  const name = escapeHtml(recipe.name);
  const finish = [{ text: "✔️ Finished removing", data: `r:${recipe.id}` }];
  if (items.length === 0) return { text: `🍳 <b>${name}</b>\n<i>No ingredients left.</i>`, inline: [finish] };
  return {
    text: `✏️ <b>${name}</b>\nTap ❌ to take an ingredient out of this recipe.`,
    inline: [...pairs(items.slice(0, MAX_INGREDIENTS).map((i) => ({ text: `❌ ${titleCase(i.item).slice(0, 26)}`, data: `rxi:${i.id}` }))), finish],
  };
}

export async function removeView(env: Env, recipeId: number): Promise<RecipeReply> {
  const recipe = await getRecipe(env.DB, recipeId);
  if (!recipe) return recipesView(env);
  return removeText(recipe, await listIngredients(env.DB, recipeId));
}

export function deleteQuestion(recipe: Recipe): RecipeReply {
  return {
    text: `🗑 Delete <b>${escapeHtml(recipe.name)}</b> and its ingredients? Your grocery lists won't change.`,
    inline: [[{ text: "🗑 Yes, delete it", data: `rdy:${recipe.id}` }, { text: "Keep it", data: `r:${recipe.id}` }]],
  };
}

// ---------- adding a dish to the grocery list ----------

/** Step 1: which store's list the ingredients go on. */
export async function storePickView(env: Env, recipeId: number): Promise<RecipeReply> {
  const recipe = await getRecipe(env.DB, recipeId);
  if (!recipe) return recipesView(env);
  const [stores, ranked] = [await allStores(env), await rankedStores(env)];
  const buttons = [
    ...ranked.slice(0, 16).map((s) => ({ text: `🏪 ${s.slice(0, 24)}`, data: `rgs:${recipeId}:${stores.indexOf(s)}` })),
    { text: `🏪 ${ANY_STORE}`, data: `rgs:${recipeId}:x` },
  ];
  const hint = stores.length ? "" : `\n<i>To save your stores as buttons, add them in 🛒 Groceries.</i>`;
  return {
    text: `🛒 Which store are you getting the <b>${escapeHtml(recipe.name)}</b> ingredients from?${hint}`,
    inline: [...pairs(buttons), [{ text: "⬅️ Back to dish", data: `r:${recipeId}` }]],
  };
}

/**
 * Step 2: the dish's ingredients as ➕ buttons for one store. Ones already on
 * that store's list are shown as added; ones on another store's list are
 * pointed out, so the same ingredient isn't bought twice.
 */
export function groceryPickText(recipe: Recipe, items: Ingredient[], groceries: Grocery[], store: string | null, sid: string): RecipeReply {
  const storeName = escapeHtml(store ?? ANY_STORE);
  const here = groceries.filter((g) => g.store === store);
  const elsewhere = groceries.filter((g) => g.store !== store);
  const onHere = items.filter((i) => here.some((g) => same(g.item, i.item)));
  const left = items.filter((i) => !onHere.includes(i));
  const lines = [`🛒 <b>${escapeHtml(recipe.name)}</b> → <b>${storeName}</b>`];
  if (onHere.length) lines.push(`On the ${storeName} list: ${onHere.map((i) => show(i.item)).join(", ")}`);
  const other = left
    .map((i) => {
      const at = elsewhere.filter((g) => same(g.item, i.item)).map((g) => escapeHtml(g.store ?? ANY_STORE));
      return at.length ? `${show(i.item)} (${[...new Set(at)].join(", ")})` : null;
    })
    .filter(Boolean);
  if (other.length) lines.push(`Already on another list: ${other.join(", ")}`);
  lines.push(
    "",
    left.length
      ? `Tap what you need from ${storeName}. Nothing is added unless you tap it.`
      : `🎉 Every ingredient is on the ${storeName} list.`,
  );
  const inline: InlineButton[][] = [
    ...pairs(left.slice(0, MAX_INGREDIENTS).map((i) => ({ text: `➕ ${titleCase(i.item).slice(0, 26)}`, data: `rgi:${i.id}:${sid}` }))),
    ...(left.length > 1 ? [[{ text: `➕ Add all ${left.length}`, data: `rga:${recipe.id}:${sid}` }]] : []),
    [
      { text: "🏪 Other store", data: `rg:${recipe.id}` },
      { text: "⬅️ Back to dish", data: `r:${recipe.id}` },
    ],
  ];
  return { text: lines.join("\n"), inline };
}

export async function groceryPickView(env: Env, recipeId: number, store: string | null): Promise<RecipeReply> {
  const recipe = await getRecipe(env.DB, recipeId);
  if (!recipe) return recipesView(env);
  const [items, groceries, sid] = [await listIngredients(env.DB, recipeId), await listGroceries(env.DB), await storeId(env, store)];
  return groceryPickText(recipe, items, groceries, store, sid);
}

/** The dish's ingredients that aren't on that store's list yet. */
export async function ingredientsNotOnList(env: Env, recipeId: number, store: string | null): Promise<string[]> {
  const [items, groceries] = [await listIngredients(env.DB, recipeId), await listGroceries(env.DB)];
  const here = groceries.filter((g) => g.store === store);
  return items.map((i) => i.item).filter((item) => !here.some((g) => same(g.item, item)));
}
