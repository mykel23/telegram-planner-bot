import { addGroceries, type Grocery, getState, listGroceries, setState } from "./db";
import type { Env } from "./env";
import { escapeHtml } from "./format";
import type { InlineButton } from "./telegram";

/**
 * The grocery list, built to take as few taps as possible:
 *   - add several items in one message ("milk, eggs, bread"), typed or spoken,
 *   - stores are saved once and offered as buttons after that,
 *   - each store remembers what was bought there and shows those items as
 *     ➕ buttons, so re-buying is a tap. Nothing is ever added without asking.
 *   - in the store, tapping an item's ✅ button checks it off.
 */

const STORES_KEY = "grocery_stores";
const HISTORY_KEY = "grocery_history";
const PENDING_KEY = "grocery_pending";
const CURRENT_KEY = "grocery_current_store";
const OPENED_KEY = "grocery_opened_at";

export const ANY_STORE = "Any store";
/** Callback id for "Any store" (real stores use their position in the saved list). */
const ANY_ID = "x";
/** Most past items shown as buttons for one store. */
const MAX_PAST = 24;

/** "milk, eggs and bread" or one item per line -> ["milk", "eggs", "bread"]. */
export function splitGroceryItems(text: string): string[] {
  let parts: string[];
  if (/\n/.test(text)) {
    // One item per line: keep each line whole ("mac and cheese").
    parts = text.split(/\r?\n|;/);
  } else if (/[,;]/.test(text)) {
    // "milk, eggs and bread": commas separate, and so does "and" in the last part.
    parts = text.split(/[,;]/);
    const last = parts.pop()!;
    parts.push(...last.split(/\band\b|&/i));
  } else {
    parts = text.split(/\band\b|&/i);
  }
  return parts
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((s) => s.length > 0 && s.length <= 60);
}

async function readJson<T>(env: Env, key: string, empty: T): Promise<T> {
  const raw = await getState(env.DB, key);
  return raw ? (JSON.parse(raw) as T) : empty;
}

export function getStores(env: Env): Promise<string[]> {
  return readJson<string[]>(env, STORES_KEY, []);
}

/** Returns the saved spelling of a store, saving it if it's new. Stores are only ever appended. */
export async function rememberStore(env: Env, name: string): Promise<string> {
  const stores = await getStores(env);
  const clean = name.trim().slice(0, 30);
  const existing = stores.find((s) => s.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  await setState(env.DB, STORES_KEY, JSON.stringify([...stores, clean]));
  return clean;
}

/** Store name -> items ever bought there, oldest first. Append-only, so button positions stay valid. */
function getHistory(env: Env): Promise<Record<string, string[]>> {
  return readJson<Record<string, string[]>>(env, HISTORY_KEY, {});
}

const historyKey = (store: string | null) => store ?? ANY_STORE;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Adds items to the list under a store and remembers them for that store. */
export async function addItems(env: Env, items: string[], store: string | null): Promise<Grocery[]> {
  if (items.length === 0) return [];
  await addGroceries(env.DB, items, store);
  const history = await getHistory(env);
  const past = history[historyKey(store)] ?? [];
  for (const item of items) if (!past.some((p) => same(p, item))) past.push(item);
  history[historyKey(store)] = past;
  await setState(env.DB, HISTORY_KEY, JSON.stringify(history));
  return items.map((item) => ({ id: 0, item, store }));
}

/** The store being shopped for right now ("Any store" is null); undefined when none is picked. */
export async function getCurrentStore(env: Env): Promise<string | null | undefined> {
  const raw = await getState(env.DB, CURRENT_KEY);
  if (!raw) return undefined;
  return raw === ANY_STORE ? null : raw;
}

export async function setCurrentStore(env: Env, store: string | null | undefined): Promise<void> {
  await setState(env.DB, CURRENT_KEY, store === undefined ? "" : historyKey(store));
  await setState(env.DB, OPENED_KEY, String(Date.now()));
}

/** After this long without grocery activity, messages go back to being tasks. */
const OPEN_MINUTES = 20;

export async function groceryModeExpired(env: Env, now: number = Date.now()): Promise<boolean> {
  const opened = Number((await getState(env.DB, OPENED_KEY)) ?? 0);
  return now - opened > OPEN_MINUTES * 60_000;
}

/**
 * While adding groceries, is this message really something else for the planner
 * ("add call mom", "remind me…", "done with…")? Then it isn't a grocery item.
 */
export function looksLikePlannerMessage(text: string): boolean {
  const t = text.trim();
  if (/\b(grocery|groceries|shopping list)\b/i.test(t)) return false;
  return /^(add|todo|new task|remind me|remember|done with|finished|working on|move|make|drop|remove|what'?s|show|cancel|stop)\b/i.test(t);
}

/** "groceries: rice" -> "rice". */
export function stripGroceryPrefix(text: string): string {
  return text.replace(/^\s*(?:groceries|grocery list|grocery)\s*[:\-]\s*/i, "").replace(/^\s*add\s+/i, "");
}

export async function setPending(env: Env, items: string[]): Promise<void> {
  await setState(env.DB, PENDING_KEY, JSON.stringify(items));
}

export function getPending(env: Env): Promise<string[]> {
  return readJson<string[]>(env, PENDING_KEY, []);
}

export function storeQuestion(items: string[], hasStores: boolean): string {
  const what = items.length ? `${items.map((i) => `<b>${escapeHtml(i)}</b>`).join(", ")} from` : "shopping at";
  return hasStores
    ? `🛒 Which store are you ${items.length ? "getting " + what : what}? Tap one, or type a new store.`
    : `🛒 Which store are you ${items.length ? "getting " + what : what}? Type the store's name (I'll save it as a button), or tap <b>${ANY_STORE}</b>.`;
}

export function addedText(added: Grocery[]): string {
  if (added.length === 0) return "";
  const store = added[0].store ?? ANY_STORE;
  return `➕ Added ${added.map((g) => escapeHtml(g.item)).join(", ")} → <b>${escapeHtml(store)}</b>`;
}

/** Store buttons for the store question, three to a row. */
export function storeRows(stores: string[]): string[][] {
  const names = [...stores, ANY_STORE];
  const rows: string[][] = [];
  for (let i = 0; i < names.length; i += 3) rows.push(names.slice(i, i + 3));
  return rows;
}

function pairs(buttons: InlineButton[]): InlineButton[][] {
  const rows: InlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

export interface GroceryReply {
  text: string;
  inline: InlineButton[][];
}

/** The list grouped by store, with a ✅ per item and a ➕ button per store to add more. */
export async function groceryView(env: Env): Promise<GroceryReply> {
  const [items, stores] = [await listGroceries(env.DB), await getStores(env)];
  const storeButtons = pairs([
    ...stores.map((s, i) => ({ text: `➕ ${s.slice(0, 24)}`, data: `gs:${i}` })),
    { text: stores.length ? "➕ New store" : "➕ Add items", data: "gnew" },
  ]);
  if (items.length === 0) {
    return {
      text: `🛒 <b>Grocery list</b>\n<i>Empty.</i> Tap a store to add items, or just send them, like <i>milk, eggs, bread</i>.`,
      inline: storeButtons,
    };
  }
  const groups = new Map<string, Grocery[]>();
  for (const g of items) groups.set(historyKey(g.store), [...(groups.get(historyKey(g.store)) ?? []), g]);
  const text =
    `🛒 <b>Grocery list</b> (${items.length})\n\n` +
    [...groups].map(([store, list]) => `<b>${escapeHtml(store)}</b>\n${list.map((g) => `• ${escapeHtml(g.item)}`).join("\n")}`).join("\n\n") +
    `\n\n<i>Tap ✅ when an item is in your cart. Tap ➕ a store to add more.</i>`;
  const checkOffs = pairs(items.slice(0, 40).map((g) => ({ text: `✅ ${g.item.slice(0, 28)}`, data: `g:${g.id}` })));
  return { text, inline: [...checkOffs, ...storeButtons, [{ text: "🧹 Clear all", data: "gclear" }]] };
}

/** Callback id for a store, used in ➕ buttons. */
export async function storeId(env: Env, store: string | null): Promise<string> {
  if (store === null) return ANY_ID;
  const i = (await getStores(env)).indexOf(store);
  return i < 0 ? ANY_ID : String(i);
}

/** Reads a store callback id back into a store name (null = Any store); undefined if unknown. */
export async function storeFromId(env: Env, id: string): Promise<string | null | undefined> {
  if (id === ANY_ID) return null;
  return (await getStores(env))[Number(id)];
}

/**
 * The screen for adding at one store: what's already on the list for it, and
 * everything bought there before (and not on the list now) as ➕ buttons.
 */
export async function storeView(env: Env, store: string | null, intro = ""): Promise<GroceryReply> {
  const [items, history, sid] = [await listGroceries(env.DB), await getHistory(env), await storeId(env, store)];
  const onList = items.filter((g) => g.store === store);
  const past = (history[historyKey(store)] ?? [])
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => !onList.some((g) => same(g.item, item)))
    .slice(-MAX_PAST);
  const name = escapeHtml(historyKey(store));
  const lines = [
    intro,
    `🛒 <b>${name}</b>`,
    onList.length ? `On your list: ${onList.map((g) => escapeHtml(g.item)).join(", ")}` : `<i>Nothing on the list for ${name} yet.</i>`,
    "",
    past.length
      ? `Tap what you need from past trips, or type new items (like <i>milk, eggs</i>).`
      : `Type the items you need, like <i>milk, eggs, bread</i>. I'll remember them for next time.`,
    `<i>Tap 📋 Done when you're finished.</i>`,
  ].filter((l, i) => l !== "" || i > 0);
  const inline = [
    ...pairs(past.map(({ item, i }) => ({ text: `➕ ${item.slice(0, 28)}`, data: `ga:${sid}:${i}` }))),
    [{ text: "📋 Done, show my list", data: "gdone" }],
  ];
  return { text: lines.join("\n").trim(), inline };
}

/** The item behind a ➕ past-item button. */
export async function pastItem(env: Env, store: string | null, index: number): Promise<string | undefined> {
  return (await getHistory(env))[historyKey(store)]?.[index];
}
