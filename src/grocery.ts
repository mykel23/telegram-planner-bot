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
/** Free public APIs ask callers to say who they are. */
const USER_AGENT = "telegram-planner-bot (github.com/mykel23/telegram-planner-bot)";

const AREA_KEY = "grocery_area";
const NEARBY_KEY = "grocery_nearby";

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
    .filter((s) => s.length > 0 && s.length <= 60)
    .map(titleCase);
}

/** Small words that stay lowercase unless they start the item. */
const SMALL_WORDS = new Set(["and", "or", "of", "the", "a", "an", "with", "in", "on", "for", "to", "n"]);

/** "mac and cheese" -> "Mac and Cheese". Letters already capitalized ("BBQ") are kept. */
export function titleCase(item: string): string {
  let first = true;
  return item.replace(/(^|[\s\-\/(])(\p{L}[\p{L}']*)/gu, (_, before: string, word: string) => {
    const isFirst = first;
    first = false;
    const lower = word.toLowerCase();
    if (!isFirst && SMALL_WORDS.has(lower)) return before + lower;
    return before + word.charAt(0).toUpperCase() + word.slice(1);
  });
}

/** An item as shown in a message. */
const show = (item: string) => escapeHtml(titleCase(item));

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

/** Stores near the saved ZIP code that haven't been used yet. */
export function getNearby(env: Env): Promise<string[]> {
  return readJson<string[]>(env, NEARBY_KEY, []);
}

/** Every store to offer as a button: ones already used first, then nearby ones. */
export async function allStores(env: Env): Promise<string[]> {
  const [saved, nearby] = [await getStores(env), await getNearby(env)];
  return [...saved, ...nearby.filter((n) => !saved.some((s) => same(s, n)))];
}

const USES_KEY = "grocery_store_uses";

/** Store name (lowercase) -> how many lists have been made for it. */
function getUses(env: Env): Promise<Record<string, number>> {
  return readJson<Record<string, number>>(env, USES_KEY, {});
}

/** Stores in the order to show them: most-used first, then the rest as they were. */
export function rankStores(stores: string[], uses: Record<string, number>): string[] {
  const count = (s: string) => uses[s.toLowerCase()] ?? 0;
  return stores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => count(b.s) - count(a.s) || a.i - b.i)
    .map(({ s }) => s);
}

export async function rankedStores(env: Env): Promise<string[]> {
  return rankStores(await allStores(env), await getUses(env));
}

// ---------- stores near a ZIP code ----------

export interface Area {
  zip: string;
  name: string;
  lat: number;
  lon: number;
}

export function getArea(env: Env): Promise<Area | null> {
  return readJson<Area | null>(env, AREA_KEY, null);
}

/** A 5-digit US ZIP code in the message, or null. */
export function parseZip(text: string): string | null {
  return text.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1] ?? null;
}

/** ZIP code -> place, from Zippopotam.us (free, no key). */
export async function lookupZip(zip: string): Promise<Area | null> {
  const res = await fetch(`https://api.zippopotam.us/us/${zip}`, { headers: { "user-agent": USER_AGENT } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ZIP lookup failed (${res.status})`);
  return areaFromZipResponse(zip, await res.json());
}

export function areaFromZipResponse(zip: string, data: unknown): Area | null {
  const place = (data as { places?: Record<string, string>[] }).places?.[0];
  if (!place) return null;
  return {
    zip,
    name: `${place["place name"]}, ${place["state abbreviation"]}`,
    lat: Number(place.latitude),
    lon: Number(place.longitude),
  };
}

interface OsmElement {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Miles between two points. */
function miles(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 3959 * 2 * Math.asin(Math.sqrt(h));
}

/** Most nearby stores offered as buttons. */
const MAX_NEARBY = 12;

/** Grocery store names from an OpenStreetMap search, closest first, one per chain. */
export function storesFromOsm(data: unknown, lat: number, lon: number, maxMiles = Infinity): string[] {
  const elements = (data as { elements?: OsmElement[] }).elements ?? [];
  const found = elements
    .map((e) => {
      const name = (e.tags?.brand ?? e.tags?.name ?? "").trim();
      const pLat = e.lat ?? e.center?.lat;
      const pLon = e.lon ?? e.center?.lon;
      const known = isKnownChain(name) || isKnownChain(e.tags?.name ?? "");
      // Big chains first, then other branded stores, then small local shops.
      const tier = known ? 0 : e.tags?.brand || e.tags?.["brand:wikidata"] ? 1 : 2;
      // Department stores only count when they're a grocery chain (Walmart, Target).
      const grocery = e.tags?.shop !== "department_store" || known;
      return { name, tier, grocery, distance: pLat != null && pLon != null ? miles(lat, lon, pLat, pLon) : 99 };
    })
    .filter((s) => s.grocery && s.name.length > 0 && s.name.length <= 30 && s.distance <= maxMiles)
    .sort((a, b) => a.tier - b.tier || a.distance - b.distance);
  const names: string[] = [];
  for (const { name } of found) {
    if (!names.some((n) => same(n, name))) names.push(name);
    if (names.length === MAX_NEARBY) break;
  }
  return names;
}

/** Grocery chains people usually mean by "the main stores". Matched by the start of the name. */
const KNOWN_CHAINS = [
  "kroger", "sprouts", "restaurant depot", "h-e-b", "heb", "walmart", "target", "costco", "sam's club", "aldi",
  "whole foods", "trader joe", "publix", "safeway", "albertsons", "jewel-osco", "mariano", "meijer", "food lion",
  "giant", "stop & shop", "wegmans", "hy-vee", "fiesta", "fry's", "ralphs", "king soopers", "smith's", "dillons",
  "harris teeter", "winco", "food 4 less", "save a lot", "lidl", "vons", "randalls", "tom thumb", "shoprite",
  "piggly wiggly", "winn-dixie", "bj's", "fresh thyme", "natural grocers", "central market", "el super",
  "cardenas", "vallarta", "99 ranch", "h mart", "patel brothers", "food city", "ingles", "weis", "hannaford",
  "market basket", "price chopper", "tops", "acme", "pick 'n save", "festival foods", "cub", "schnucks",
  "dierbergs", "brookshire", "united supermarkets", "market street", "smart & final", "stater bros", "grocery outlet",
];

export function isKnownChain(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/’/g, "'");
  // The chain name must end at a word break: "Target" matches "Target Grocery", not "Targeted Foods".
  return KNOWN_CHAINS.some((c) => n.startsWith(c) && !/[a-z0-9]/.test(n.charAt(c.length)));
}

/** Public Overpass servers, tried in order: the main one is often busy. */
const OVERPASS_SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

/** One search attempt, with a time limit so a slow server doesn't stall the reply. */
async function fetchJson(url: string, init: RequestInit = {}, seconds = 14): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { "user-agent": USER_AGENT, ...(init.headers as Record<string, string>) },
    signal: AbortSignal.timeout(seconds * 1000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: { name?: string; osm_value?: string };
}

/** Photon results (komoot's free OpenStreetMap search) in the same shape as Overpass, so one parser handles both. */
export function photonToOsm(data: unknown): { elements: OsmElement[] } {
  const features = (data as { features?: PhotonFeature[] }).features ?? [];
  return {
    elements: features.map((f) => ({
      lon: f.geometry?.coordinates?.[0],
      lat: f.geometry?.coordinates?.[1],
      tags: { name: f.properties?.name ?? "" },
    })),
  };
}

/** Farthest a store can be to count as nearby, in miles. */
export const NEARBY_MILES = 10;
const NEARBY_METERS = Math.round(NEARBY_MILES * 1609.34);

/**
 * Grocery stores within 10 miles, from OpenStreetMap (free, no key).
 * Asks all the Overpass servers at once and takes the first good answer, then
 * falls back to Photon. The whole search stays under about 25 seconds, the
 * time a Worker gets to finish after answering Telegram. Errors are kept for /status.
 */
export async function findNearbyStores(env: Env, area: Area): Promise<string[]> {
  const query =
    `[out:json][timeout:12];` +
    `nwr["shop"~"^(supermarket|wholesale|greengrocer|department_store)$"](around:${NEARBY_METERS},${area.lat},${area.lon});` +
    `out tags center 300;`;
  const errors: string[] = [];
  const attempts = OVERPASS_SERVERS.map(async (server) => {
    try {
      const data = await fetchJson(server, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      const stores = storesFromOsm(data, area.lat, area.lon, NEARBY_MILES);
      if (stores.length) return stores;
      throw new Error(`${new URL(server).host}: no stores`);
    } catch (err) {
      errors.push(String(err));
      throw err;
    }
  });
  try {
    return await Promise.any(attempts);
  } catch {
    // Every Overpass server failed; try Photon.
  }
  try {
    const url = `https://photon.komoot.io/api/?q=supermarket&osm_tag=shop:supermarket&limit=50&lat=${area.lat}&lon=${area.lon}`;
    const stores = storesFromOsm(photonToOsm(await fetchJson(url, {}, 8)), area.lat, area.lon, NEARBY_MILES);
    if (stores.length) return stores;
    errors.push("photon: no stores");
  } catch (err) {
    errors.push(String(err));
  }
  console.error("findNearbyStores found nothing", errors);
  await setState(env.DB, "grocery_search_errors", JSON.stringify({ at: new Date().toISOString(), zip: area.zip, errors }));
  return [];
}

/** Forgets the ZIP code and its nearby stores. Stores already used stay as buttons. */
export async function clearArea(env: Env): Promise<void> {
  await setState(env.DB, AREA_KEY, "");
  await setState(env.DB, NEARBY_KEY, "");
}

/** Saves the ZIP code and the stores near it. */
export async function setArea(env: Env, area: Area, nearby: string[]): Promise<void> {
  await setState(env.DB, AREA_KEY, JSON.stringify(area));
  await setState(env.DB, NEARBY_KEY, JSON.stringify(nearby));
}

export const ZIP_QUESTION =
  `🛒 <b>What's your ZIP code?</b>\nI'll find the grocery stores within 10 miles and make them buttons. ` +
  `Or tap <b>Skip</b> to add your stores yourself.`;

/** Store name -> items ever bought there, oldest first. Append-only, so button positions stay valid. */
function getHistory(env: Env): Promise<Record<string, string[]>> {
  return readJson<Record<string, string[]>>(env, HISTORY_KEY, {});
}

const historyKey = (store: string | null) => store ?? ANY_STORE;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Adds items to the list under a store and remembers them for that store. */
export async function addItems(env: Env, items: string[], store: string | null): Promise<Grocery[]> {
  if (items.length === 0) return [];
  // A new list for a store (nothing on it yet) counts as one more use of that store.
  if (store !== null && !(await listGroceries(env.DB)).some((g) => g.store === store)) {
    const uses = await getUses(env);
    uses[store.toLowerCase()] = (uses[store.toLowerCase()] ?? 0) + 1;
    await setState(env.DB, USES_KEY, JSON.stringify(uses));
  }
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
  const what = items.length ? `Which store are you getting ${items.map((i) => `<b>${show(i)}</b>`).join(", ")} from?` : "Which store would you like to add?";
  return hasStores
    ? `🛒 ${what} Tap one, or type a new store's name.`
    : `🛒 ${what} Type the store's name (I'll save it as a button), or tap <b>${ANY_STORE}</b>.`;
}

export function addedText(added: Grocery[]): string {
  if (added.length === 0) return "";
  const store = added[0].store ?? ANY_STORE;
  return `➕ Added ${added.map((g) => show(g.item)).join(", ")} → <b>${escapeHtml(store)}</b>`;
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

/** The list's items grouped by store, in list order. */
function byStore(items: Grocery[]): Map<string | null, Grocery[]> {
  const groups = new Map<string | null, Grocery[]>();
  for (const g of items) groups.set(g.store, [...(groups.get(g.store) ?? []), g]);
  return groups;
}

/**
 * The grocery menu. It leads with the stores: tap one to see past items and add
 * more, or add a new store. 🛍 Shopping Mode opens the lists for the store trip.
 */
export async function groceryView(env: Env): Promise<GroceryReply> {
  const [items, stores, ranked, area] = [await listGroceries(env.DB), await allStores(env), await rankedStores(env), await getArea(env)];
  // Shown most-used first; each button keeps the store's fixed position as its id.
  const storeButtons = pairs(
    ranked.slice(0, 16).map((s) => ({ text: `🏪 ${s.slice(0, 24)}`, data: `gs:${stores.indexOf(s)}` })),
  );
  const extras: InlineButton[][] = [
    [{ text: "➕ Add a store", data: "gnew" }, { text: area ? "📍 Change ZIP" : "📍 Stores near me", data: "gzip" }],
    ...(area ? [[{ text: `🗑 Remove ZIP ${area.zip}`, data: "gzipdel" }]] : []),
  ];
  const near = area ? ` near ${escapeHtml(area.name)}` : "";
  const choose = stores.length
    ? `<b>Choose a store${near}</b> to see what you've bought there and add items, or add a new store.`
    : `<b>Add a store</b> to get started, or tap 📍 to find the stores near you.`;
  if (items.length === 0) {
    return { text: `🛒 <b>Grocery list</b>\n<i>Empty.</i>\n\n${choose}`, inline: [...storeButtons, ...extras] };
  }
  const lists = [...byStore(items)].map(([store, list]) => `${escapeHtml(historyKey(store))} (${list.length})`);
  const text =
    `🛒 <b>Grocery list</b>\nYour lists: ${lists.join(", ")}\n\n` +
    `Tap <b>🛍 Shopping Mode</b> when you're at the store.\n${choose}`;
  return { text, inline: [[{ text: "🛍 Shopping Mode", data: "gshop" }], ...storeButtons, ...extras] };
}

/** Shopping Mode, step 1: every list as bullets, and a button per store to open its list. */
export async function chooseStoreView(env: Env): Promise<GroceryReply> {
  const groups = byStore(await listGroceries(env.DB));
  const back = [{ text: "⬅️ Grocery menu", data: "gmenu" }];
  if (groups.size === 0) {
    return { text: `🛍 <b>Shopping Mode</b>\n<i>All your lists are empty.</i>`, inline: [back] };
  }
  const text =
    `🛍 <b>Shopping Mode</b>\n<b>Choose Store</b>\n\n` +
    [...groups].map(([store, list]) => `<b>${escapeHtml(historyKey(store))}</b>\n${list.map((g) => `• ${show(g.item)}`).join("\n")}`).join("\n\n");
  const buttons: InlineButton[] = [];
  for (const [store, list] of groups) {
    buttons.push({ text: `🛒 ${historyKey(store).slice(0, 22)} (${list.length})`, data: `gl:${await storeId(env, store)}` });
  }
  return { text, inline: [...pairs(buttons), back] };
}

/** Shopping Mode, step 2: one store's list, with a ✅ per item to check it off. */
export async function storeListView(env: Env, store: string | null): Promise<GroceryReply> {
  const [items, sid] = [(await listGroceries(env.DB)).filter((g) => g.store === store), await storeId(env, store)];
  const name = escapeHtml(historyKey(store));
  const back = [{ text: "🔙 Choose Store", data: "gshop" }];
  if (items.length === 0) {
    return { text: `🛒 <b>${name}</b>\n🎉 All done here. Nothing left on this list.`, inline: [back] };
  }
  const text =
    `🛒 <b>${name}</b> (${items.length})\n` +
    items.map((g) => `• ${show(g.item)}`).join("\n") +
    `\n\n<i>Tap ✅ when an item is in your cart.</i>`;
  const checkOffs = pairs(items.slice(0, 40).map((g) => ({ text: `✅ ${titleCase(g.item).slice(0, 28)}`, data: `g:${g.id}:${sid}` })));
  return { text, inline: [...checkOffs, back, [{ text: "🧹 Clear this list", data: `gcl:${sid}` }]] };
}

/** Callback id for a store: its position among the store buttons. */
export async function storeId(env: Env, store: string | null): Promise<string> {
  if (store === null) return ANY_ID;
  const i = (await allStores(env)).findIndex((s) => same(s, store));
  return i < 0 ? ANY_ID : String(i);
}

/**
 * Reads a store button back into a store name (null = Any store), saving a
 * nearby store as one of the user's own once it's picked. Undefined if unknown.
 */
export async function storeFromId(env: Env, id: string): Promise<string | null | undefined> {
  if (id === ANY_ID) return null;
  const name = (await allStores(env))[Number(id)];
  return name === undefined ? undefined : rememberStore(env, name);
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
    onList.length ? `On your list: ${onList.map((g) => show(g.item)).join(", ")}` : `<i>Nothing on the list for ${name} yet.</i>`,
    "",
    past.length
      ? `Tap what you need from past trips, or type new items (like <i>milk, eggs</i>).`
      : `Type the items you need, like <i>milk, eggs, bread</i>. I'll remember them for next time.`,
    `<i>Tap 📋 Show list when you're finished.</i>`,
  ].filter((l, i) => l !== "" || i > 0);
  const inline = [
    ...pairs(past.map(({ item, i }) => ({ text: `➕ ${titleCase(item).slice(0, 28)}`, data: `ga:${sid}:${i}` }))),
    [{ text: "📋 Show list", data: `gdone:${sid}` }],
  ];
  return { text: lines.join("\n").trim(), inline };
}

/** The item behind a ➕ past-item button. */
export async function pastItem(env: Env, store: string | null, index: number): Promise<string | undefined> {
  return (await getHistory(env))[historyKey(store)]?.[index];
}
