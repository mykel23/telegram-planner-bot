import { cancelCheckin, getCheckin, handleCheckinReply, startCheckin } from "./checkin";
import { type Action, type Interpretation, interpretMessage } from "./claude";
import { cancelEdit, getEdit, handleEditReply, startEdit } from "./edit";
import { cancelReview, getReview, handleReviewReply, startReview, stripButton } from "./review";
import {
  addMemory,
  addTask,
  clampRank,
  clearGroceries,
  clearStoreGroceries,
  deleteGrocery,
  deleteIngredient,
  deleteRecipe,
  getIngredient,
  getRecipe,
  resetIngredients,
  toggleIngredient,
  deleteMemory,
  getTask,
  eventsSince,
  listMemories,
  logEvent,
  deleteRecurring,
  deleteReminder,
  deleteTask,
  getState,
  listActiveTasks,
  listCategories,
  listRecurring,
  listUpcomingReminders,
  openTasksFromRecurring,
  setState,
  updateTask,
} from "./db";
import type { Env, Horizon, Task } from "./env";
import {
  HELP_TEXT,
  escapeHtml,
  formatAllLists,
  formatCategory,
  formatDailyMessage,
  formatList,
  horizonLabel,
  morningScript,
} from "./format";
import { interpretWithRules } from "./fallback";
import { computeInsights, formatInsights, lookbackStart } from "./insights";
import {
  cancelPicker,
  capacityQuestion,
  dayCap,
  getCapacity,
  getPicker,
  getVoice,
  handlePickerReply,
  speak,
  startPicker,
  toSpeech,
  voiceMenu,
} from "./settings";
import {
  ANY_STORE,
  addItems,
  addedText,
  getCurrentStore,
  getPending,
  allStores,
  clearArea,
  ZIP_QUESTION,
  findNearbyStores,
  getArea,
  lookupZip,
  parseZip,
  setArea,
  groceryModeExpired,
  chooseStoreView,
  groceryView,
  storeListView,
  looksLikePlannerMessage,
  stripGroceryPrefix,
  pastItem,
  rememberStore,
  setCurrentStore,
  setPending,
  splitGroceryItems,
  storeFromId,
  storeQuestion,
  storeView,
} from "./grocery";
import { keyboardFor } from "./keyboard";
import {
  addRecipeItems,
  createRecipe,
  deleteQuestion,
  dishView,
  getCurrentRecipe,
  groceryPickView,
  ingredientsNotOnList,
  recipeModeExpired,
  recipesView,
  removeView,
  setCurrentRecipe,
  storePickView,
} from "./recipes";
import { type ViewReply, isView, renderView } from "./views";
import { WEATHER_QUESTION, findPlace, getPlace, morningWeather, setPlace } from "./weather";
import { MENU_ROWS, menuCommand, menuGreeting } from "./menu";
import { createRepeat, formatRepeats, ruleFromFields } from "./recurring";
import { createReminder, formatReminders } from "./reminders";
import { answerCallback, editMessage, sendMessage, type TelegramUpdate } from "./telegram";
import { clockTime, friendlyDate, periodLabels, shortDate, zonedTimeToUtc } from "./time";
import { MAX_VOICE_SECONDS, transcribeVoice } from "./voice";

/** Only accept real YYYY-MM-DD dates from Claude. */
function validDate(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? null : value;
}

function datesText(preferred: string | null, due: string | null): string {
  return [preferred ? `do ${shortDate(preferred)}` : null, due ? `by ${shortDate(due)}` : null]
    .filter(Boolean)
    .join(", ");
}

export const OWNER_KEY = "owner_chat_id";
export const NAME_KEY = "owner_name";

/**
 * Entry point for every Telegram message.
 * The first person to send /start becomes the owner; everyone else is ignored,
 * so nobody else can read or change the task lists.
 */
export async function handleUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  if (update.callback_query) return handleButtonTap(env, update.callback_query);
  const message = update.message;
  if (!message || message.chat.type !== "private") return;
  let text = message.text?.trim();
  if (!text && !message.voice && !message.location) return;

  const chatId = message.chat.id;
  const owner = await getState(env.DB, OWNER_KEY);

  if (!owner) {
    if (text?.startsWith("/start")) {
      await setState(env.DB, OWNER_KEY, String(chatId));
      await sendMessage(
        env,
        chatId,
        `👋 Hi${message.from?.first_name ? ` ${escapeHtml(message.from.first_name)}` : ""}! I'm your planner. ` +
          `I'll message you every morning and run a weekly check-in.\n\n${HELP_TEXT}`,
        { menu: MENU_ROWS },
      );
      if (message.from?.first_name) await setState(env.DB, NAME_KEY, message.from.first_name);
    } else {
      await sendMessage(env, chatId, "Send /start to set up your planner.");
    }
    return;
  }
  if (owner !== String(chatId)) return;
  if (message.from?.first_name && !(await getState(env.DB, NAME_KEY))) {
    await setState(env.DB, NAME_KEY, message.from.first_name);
  }

  // The only reason to share a location is the weather.
  if (message.location) {
    await setPlace(env, { name: "your area", lat: message.location.latitude, lon: message.location.longitude });
    await cancelPicker(env);
    const line = await morningWeather(env);
    await sendMessage(env, chatId, `🌤 Got it. Your morning message will include the forecast for your area.\n${line}`, await keyboardFor(env));
    return;
  }

  let heard = "";
  if (!text && message.voice) {
    if (message.voice.duration > MAX_VOICE_SECONDS) {
      await sendMessage(env, chatId, `🎙 That voice note is a bit long. Please keep it under ${MAX_VOICE_SECONDS / 60} minutes.`);
      return;
    }
    try {
      text = await transcribeVoice(env, message.voice.file_id);
    } catch (err) {
      console.error("transcribeVoice failed", err);
      await sendMessage(env, chatId, "🎙 Sorry, I couldn't make out that voice note. Please try again or type it.");
      return;
    }
    if (!text) {
      await sendMessage(env, chatId, "🎙 I couldn't hear anything in that voice note. Please try again.");
      return;
    }
    heard = `🎙 <i>“${escapeHtml(text)}”</i>\n\n`;
  }

  const reply = await respond(env, text!, chatId);
  if (!reply) return;
  if (typeof reply === "string") {
    await sendMessage(env, chatId, heard + reply, await keyboardFor(env));
  } else {
    // A list with ✅ buttons. The menu buttons stay open underneath.
    await sendMessage(env, chatId, heard + reply.text, reply.inline.length ? { inline: reply.inline } : await keyboardFor(env));
  }
  const spoken = typeof reply === "string" ? toSpeech(reply) : (reply.script ?? (heard ? toSpeech(reply.text) : ""));
  // Talk back when talked to (a voice note), or read the morning plan, if a voice is on.
  if (heard || (typeof reply !== "string" && reply.script)) await speak(env, chatId, spoken);
}

/** A tap on a ✅ button under a list or the grocery list. */
async function handleButtonTap(env: Env, tap: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
  const owner = await getState(env.DB, OWNER_KEY);
  const chat = tap.message?.chat.id;
  if (!owner || String(chat) !== owner || !tap.message || !tap.data) {
    await answerCallback(env, tap.id);
    return;
  }
  const [kind, id, view] = tap.data.split(":");
  let toast = "";
  let redraw: ViewReply | null = null;

  if (kind.startsWith("r")) {
    const result = await handleRecipeTap(env, kind, id, view);
    if (result.send) {
      await answerCallback(env, tap.id);
      await sendMessage(env, owner, result.send, await keyboardFor(env));
      return;
    }
    toast = result.toast;
    redraw = result.redraw;
  } else if (kind === "d") {
    const task = await getTask(env.DB, Number(id));
    if (task && task.status !== "done") {
      await updateTask(env.DB, task.id, { status: "done" });
      await logEvent(env.DB, "done", task, periodLabels(new Date(), env.TIMEZONE).iso.day);
      toast = `✅ Done: ${task.title}`;
    } else {
      toast = "Already done.";
    }
    if (view && isView(view)) redraw = await renderView(env, view);
  } else if (kind === "g") {
    // ✅ an item. Newer buttons carry the store, so only that store's list is redrawn.
    await deleteGrocery(env.DB, Number(id));
    toast = "🛒 Checked off";
    const store = view === undefined ? undefined : await storeFromId(env, view);
    redraw = store === undefined ? await groceryView(env) : await storeListView(env, store);
  } else if (kind === "gclear") {
    await clearGroceries(env.DB);
    toast = "🧹 List cleared";
    redraw = await groceryView(env);
  } else if (kind === "gcl") {
    const store = await storeFromId(env, id);
    if (store !== undefined) {
      await clearStoreGroceries(env.DB, store);
      toast = "🧹 List cleared";
      redraw = await storeListView(env, store);
    }
  } else if (kind === "gshop") {
    // Shopping Mode: pick which store's list to shop from.
    await cancelPicker(env);
    await setCurrentStore(env, undefined);
    redraw = await chooseStoreView(env);
  } else if (kind === "gl") {
    const store = await storeFromId(env, id);
    if (store !== undefined) redraw = await storeListView(env, store);
  } else if (kind === "gmenu") {
    redraw = await groceryView(env);
  } else if (kind === "gs") {
    // ➕ a store: show what was bought there before.
    const store = await storeFromId(env, id);
    await answerCallback(env, tap.id);
    if (store === undefined) return;
    await Promise.all([cancelCheckin(env), cancelEdit(env), cancelReview(env)]);
    await setCurrentStore(env, store);
    await startPicker(env, "grocery_items");
    const screen = await storeView(env, store);
    await sendMessage(env, owner, screen.text, { inline: screen.inline });
    return;
  } else if (kind === "gnew") {
    await answerCallback(env, tap.id);
    await Promise.all([cancelCheckin(env), cancelEdit(env), cancelReview(env)]);
    await setPending(env, []);
    await startPicker(env, "grocery_store");
    await sendMessage(env, owner, storeQuestion([], (await allStores(env)).length > 0), await keyboardFor(env));
    return;
  } else if (kind === "gzipdel") {
    await clearArea(env);
    // Don't ask for a ZIP code again unless asked to.
    await setState(env.DB, ZIP_SKIPPED_KEY, "1");
    toast = "🗑 ZIP code removed";
    redraw = await groceryView(env);
  } else if (kind === "gzip") {
    await answerCallback(env, tap.id);
    await startPicker(env, "grocery_zip");
    await sendMessage(env, owner, ZIP_QUESTION, await keyboardFor(env));
    return;
  } else if (kind === "ga") {
    // ➕ a past item: add it to the list for that store.
    const store = await storeFromId(env, id);
    const item = store === undefined ? undefined : await pastItem(env, store, Number(view));
    if (store !== undefined && item) {
      await addItems(env, [item], store);
      toast = `➕ ${item}`;
      redraw = await storeView(env, store);
    }
  } else if (kind === "gdone") {
    // 📋 Show list: just the list for the store being added to.
    await cancelPicker(env);
    await setCurrentStore(env, undefined);
    const store = id === undefined ? undefined : await storeFromId(env, id);
    redraw = store === undefined ? await groceryView(env) : await storeListView(env, store);
  }

  await answerCallback(env, tap.id, toast);
  if (redraw) await editMessage(env, owner, tap.message.message_id, redraw.text, { inline: redraw.inline });
}

/**
 * A tap on a Recipes button. Most redraw the same message; ➕ Add a dish and
 * ➕ Add ingredients send a new question instead, since the answer is typed.
 */
async function handleRecipeTap(
  env: Env,
  kind: string,
  id: string | undefined,
  extra: string | undefined,
): Promise<{ toast: string; redraw: ViewReply | null; send?: string }> {
  const recipeId = Number(id);
  // Any recipe button other than ➕ ends typing ingredients.
  const stopTyping = async () => {
    const picker = await getPicker(env);
    if (picker?.kind === "recipe_items" || picker?.kind === "recipe_name") await cancelPicker(env);
    await setCurrentRecipe(env, null);
  };
  switch (kind) {
    case "rm":
      await stopTyping();
      return { toast: "", redraw: await recipesView(env) };
    case "rnew":
      await Promise.all([cancelCheckin(env), cancelEdit(env), cancelReview(env)]);
      await setCurrentRecipe(env, null);
      await startPicker(env, "recipe_name");
      return { toast: "", redraw: null, send: `🍳 What's the dish called? Type its name, like <i>Chicken Tacos</i>.` };
    case "r":
      await stopTyping();
      return { toast: "", redraw: await dishView(env, recipeId) };
    case "rc": {
      const ingredient = await getIngredient(env.DB, recipeId);
      if (!ingredient) return { toast: "That ingredient was removed.", redraw: null };
      await toggleIngredient(env.DB, ingredient.id);
      return { toast: ingredient.checked ? "⬜ Unchecked" : "✅ Checked off", redraw: await dishView(env, ingredient.recipe_id) };
    }
    case "rr":
      await resetIngredients(env.DB, recipeId);
      return { toast: "🔄 All unchecked", redraw: await dishView(env, recipeId) };
    case "ra": {
      const recipe = await getRecipe(env.DB, recipeId);
      if (!recipe) return { toast: "That dish was deleted.", redraw: await recipesView(env) };
      await Promise.all([cancelCheckin(env), cancelEdit(env), cancelReview(env)]);
      await setCurrentRecipe(env, recipe.id);
      await startPicker(env, "recipe_items");
      return {
        toast: "",
        redraw: null,
        send: `🍳 Type the ingredients for <b>${escapeHtml(recipe.name)}</b>, like <i>tortillas, ground beef, cheese</i>. Tap <b>Done</b> when you're finished.`,
      };
    }
    case "rx":
      await stopTyping();
      return { toast: "", redraw: await removeView(env, recipeId) };
    case "rxi": {
      const ingredient = await getIngredient(env.DB, recipeId);
      if (!ingredient) return { toast: "", redraw: null };
      await deleteIngredient(env.DB, ingredient.id);
      return { toast: `❌ Removed ${ingredient.item}`, redraw: await removeView(env, ingredient.recipe_id) };
    }
    case "rd": {
      await stopTyping();
      const recipe = await getRecipe(env.DB, recipeId);
      return { toast: "", redraw: recipe ? deleteQuestion(recipe) : await recipesView(env) };
    }
    case "rdy": {
      const recipe = await getRecipe(env.DB, recipeId);
      if (recipe) await deleteRecipe(env.DB, recipe.id);
      return { toast: recipe ? `🗑 Deleted ${recipe.name}` : "", redraw: await recipesView(env) };
    }
    case "rg":
      await stopTyping();
      return { toast: "", redraw: await storePickView(env, recipeId) };
    case "rgs": {
      const store = extra === undefined ? undefined : await storeFromId(env, extra);
      if (store === undefined) return { toast: "", redraw: await storePickView(env, recipeId) };
      return { toast: "", redraw: await groceryPickView(env, recipeId, store) };
    }
    case "rgi": {
      // ➕ one ingredient onto the chosen store's list.
      const ingredient = await getIngredient(env.DB, recipeId);
      const store = extra === undefined ? undefined : await storeFromId(env, extra);
      if (!ingredient || store === undefined) return { toast: "", redraw: null };
      await addItems(env, [ingredient.item], store);
      return { toast: `➕ ${ingredient.item} → ${store ?? ANY_STORE}`, redraw: await groceryPickView(env, ingredient.recipe_id, store) };
    }
    case "rga": {
      const store = extra === undefined ? undefined : await storeFromId(env, extra);
      if (store === undefined) return { toast: "", redraw: null };
      const items = await ingredientsNotOnList(env, recipeId, store);
      await addItems(env, items, store);
      return { toast: `➕ Added ${items.length} to ${store ?? ANY_STORE}`, redraw: await groceryPickView(env, recipeId, store) };
    }
  }
  return { toast: "", redraw: null };
}

const ZIP_SKIPPED_KEY = "grocery_zip_skipped";

/** Saves the ZIP code and lists the grocery stores near it. */
async function setGroceryZip(env: Env, text: string): Promise<string | ViewReply> {
  const zip = parseZip(text);
  if (!zip) return `That doesn't look like a ZIP code. Send 5 digits, like <i>60601</i>, or tap <b>Skip</b>.`;
  let area = null;
  try {
    area = await lookupZip(zip);
  } catch (err) {
    console.error("lookupZip failed", err);
    return "Sorry, I couldn't look up that ZIP code right now. Please try again in a minute, or tap <b>Skip</b>.";
  }
  if (!area) return `I couldn't find ZIP code ${zip}. Please check it, or tap <b>Skip</b>.`;
  let nearby: string[] = [];
  const owner = await getState(env.DB, OWNER_KEY);
  if (owner) await sendMessage(env, owner, `🔎 Looking for grocery stores within 10 miles of ${escapeHtml(area.name)}…`);
  try {
    nearby = await findNearbyStores(env, area);
  } catch (err) {
    console.error("findNearbyStores failed", err);
  }
  await setArea(env, area, nearby);
  // The same place works for the morning weather, if none is set yet.
  if (!(await getPlace(env))) await setPlace(env, { name: area.name, lat: area.lat, lon: area.lon });
  await startPicker(env, "grocery_items");
  const view = await groceryView(env);
  const found = nearby.length
    ? `📍 Found ${nearby.length} grocery ${nearby.length === 1 ? "store" : "stores"} near ${escapeHtml(area.name)}.`
    : `📍 Saved ${escapeHtml(area.name)}, but the store search didn't answer this time. Tap 📍 Change ZIP to try again, or ➕ Add a store to add yours.`;
  return { ...view, text: `${found}\n\n${view.text}` };
}

/** Adds groceries to a store, or asks which store when none is picked yet. Never guesses. */
async function addGroceryItems(env: Env, items: string[], store: string | null | undefined): Promise<string | ViewReply> {
  if (items.length === 0) return `🛒 Send the items, like <i>milk, eggs, bread</i>.`;
  if (store === undefined) {
    await setPending(env, items);
    await startPicker(env, "grocery_store");
    return storeQuestion(items, (await allStores(env)).length > 0);
  }
  const added = await addItems(env, items, store);
  await setCurrentStore(env, store);
  await startPicker(env, "grocery_items");
  return storeView(env, store, addedText(added) + "\n");
}

/** Works out the reply to one message from the owner. */
export async function respond(env: Env, text: string, chatId: number | string = ""): Promise<string | ViewReply> {
  const tapped = menuCommand(text);
  const command = tapped ?? (text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : null);
  const labels = periodLabels(new Date(), env.TIMEZONE);
  // Any command or menu tap closes an open question (grocery, weather, voice...).
  if (command && command !== "/cancel") await cancelPicker(env);

  switch (command) {
    case "/help":
      return HELP_TEXT;
    case "/start":
    case "/menu":
      await Promise.all([cancelEdit(env), cancelPicker(env)]);
      return menuGreeting(env, labels);
    case "/add":
      if (await getCheckin(env)) return "Finish the check-in first, or send /cancel to stop it.";
      await Promise.all([cancelEdit(env), cancelReview(env)]);
      await startPicker(env, "add");
      return `➕ What should I add? Type it or send a voice note, like <i>call the bank Friday, rank 2</i>.`;
    case "/today":
      return renderView(env, "t");
    case "/week":
      return renderView(env, "w");
    case "/month":
      return formatList(await listActiveTasks(env.DB), "month", labels);
    case "/lists":
    case "/all":
      return renderView(env, "l");
    case "/morning":
    case "/daily":
      return renderView(env, "m");
    case "/grocery":
    case "/groceries": {
      if (await getCheckin(env)) return "Finish the check-in first, or send /cancel to stop it.";
      await Promise.all([cancelEdit(env), cancelReview(env)]);
      await setCurrentStore(env, undefined);
      // First time: ask for the ZIP code so nearby stores can be buttons.
      if (!(await getArea(env)) && (await allStores(env)).length === 0 && !(await getState(env.DB, ZIP_SKIPPED_KEY))) {
        await startPicker(env, "grocery_zip");
        return ZIP_QUESTION;
      }
      await startPicker(env, "grocery_items");
      return groceryView(env);
    }
    case "/recipes":
    case "/recipe":
      await setCurrentRecipe(env, null);
      return recipesView(env);
    case "/weather":
      if (await getCheckin(env)) return "Finish the check-in first, or send /cancel to stop it.";
      await Promise.all([cancelEdit(env), cancelReview(env)]);
      await startPicker(env, "weather_city");
      return WEATHER_QUESTION;
    case "/checkin":
      await Promise.all([cancelEdit(env), cancelReview(env), cancelPicker(env)]);
      return startCheckin(env);
    case "/edit":
      if (await getCheckin(env)) return "Finish the check-in first, or send /cancel to stop it.";
      await cancelReview(env);
      return startEdit(env, labels.iso.day);
    case "/review":
      if (await getCheckin(env)) return "Finish the check-in first, or send /cancel to stop it.";
      await cancelEdit(env);
      return startReview(env);
    case "/voice":
      if (await getCheckin(env)) return "Finish the check-in first, or send /cancel to stop it.";
      await Promise.all([cancelEdit(env), cancelReview(env)]);
      await startPicker(env, "voice");
      return voiceMenu(await getVoice(env));
    case "/capacity":
      if (await getCheckin(env)) return "Finish the check-in first, or send /cancel to stop it.";
      await Promise.all([cancelEdit(env), cancelReview(env)]);
      await startPicker(env, "capacity");
      return capacityQuestion(labels.month, await getCapacity(env));
    case "/insights":
      return formatInsights(computeInsights(await eventsSince(env.DB, lookbackStart(labels.iso.day))));
    case "/memory": {
      const memories = await listMemories(env.DB);
      return memories.length
        ? `🧠 <b>What I remember about you</b>\n${memories.map((m) => `• ${escapeHtml(m.text)}`).join("\n")}\n\nTo change one, text <code>forget …</code>.`
        : `🧠 Nothing yet. Tell me things like <code>remember I work night shifts on Tuesdays</code> and I'll plan around them.`;
    }
    case "/repeats":
      return formatRepeats(await listRecurring(env.DB));
    case "/reminders":
      return formatReminders(await listUpcomingReminders(env.DB), env.TIMEZONE);
    case "/categories": {
      const categories = await listCategories(env.DB);
      return categories.length
        ? `🏷 <b>Your categories</b>\n${categories.map((c) => `/${escapeHtml(c.toLowerCase())}`).join("\n")}`
        : `🏷 No categories yet. Try <code>add dentist, category Health</code>.`;
    }
    case "/cancel": {
      const [checkinActive, editActive, reviewActive, pickerActive] = await Promise.all([
        getCheckin(env),
        getEdit(env),
        getReview(env),
        getPicker(env),
      ]);
      await Promise.all([cancelCheckin(env), cancelEdit(env), cancelReview(env), cancelPicker(env)]);
      if (checkinActive) return "Check-in cancelled. Nothing new was saved.";
      if (editActive) return "Edit stopped. Changes you already confirmed are kept.";
      if (reviewActive) return "Evening check-in stopped. Answers you already gave are kept.";
      if (pickerActive) return "Okay, nothing changed.";
      return "There's nothing to cancel.";
    }
  }

  // "/work", "/health": any category in use works as a command.
  if (command) {
    const category = (await listCategories(env.DB)).find((c) => `/${c.toLowerCase()}` === command);
    if (category) return formatCategory(await listActiveTasks(env.DB), category, labels);
    return `I don't know that command.\n\n${HELP_TEXT}`;
  }

  let picker = await getPicker(env);
  if (picker?.kind === "grocery_items" && ((await groceryModeExpired(env)) || looksLikePlannerMessage(text))) {
    // Back to normal: this message is for the planner, not the grocery list.
    await cancelPicker(env);
    await setCurrentStore(env, undefined);
    picker = null;
  } else if (picker?.kind === "grocery_items") {
    if (/^(done|that'?s (all|it)|nothing|no|show( my)? list)[.!]*$/i.test(stripButton(text))) {
      const store = await getCurrentStore(env);
      await cancelPicker(env);
      await setCurrentStore(env, undefined);
      return store === undefined ? groceryView(env) : storeListView(env, store);
    }
    return addGroceryItems(env, splitGroceryItems(stripGroceryPrefix(text)), await getCurrentStore(env));
  }
  if (picker?.kind === "recipe_name") {
    await cancelPicker(env);
    if (/^(cancel|never ?mind|skip|no)[.!]*$/i.test(stripButton(text))) return recipesView(env);
    const recipe = await createRecipe(env, text);
    if (!recipe) return recipesView(env);
    await setCurrentRecipe(env, recipe.id);
    await startPicker(env, "recipe_items");
    return dishView(env, recipe.id, `🍳 Saved <b>${escapeHtml(recipe.name)}</b>.\n`, true);
  }
  if (picker?.kind === "recipe_items") {
    const current = await getCurrentRecipe(env);
    const done = /^(done|that'?s (all|it)|nothing|no|finished)[.!]*$/i.test(stripButton(text));
    if (recipeModeExpired(current) || (!done && looksLikePlannerMessage(text))) {
      // Back to normal: this message is for the planner, not the recipe.
      await cancelPicker(env);
      await setCurrentRecipe(env, null);
      picker = null;
    } else if (done) {
      await cancelPicker(env);
      await setCurrentRecipe(env, null);
      return dishView(env, current!.id);
    } else {
      const added = await addRecipeItems(env, current!.id, text);
      await setCurrentRecipe(env, current!.id);
      const intro = added.length
        ? `➕ Added ${added.map((i) => escapeHtml(i)).join(", ")}\n`
        : `Those are already in this recipe.\n`;
      return dishView(env, current!.id, intro, true);
    }
  }
  if (picker?.kind === "grocery_zip") {
    if (/^(skip|cancel|no|not now)[.!]*$/i.test(stripButton(text))) {
      await setState(env.DB, ZIP_SKIPPED_KEY, "1");
      await startPicker(env, "grocery_items");
      return groceryView(env);
    }
    return setGroceryZip(env, text);
  }
  if (picker?.kind === "grocery_store") {
    const answer = stripButton(text);
    const store = new RegExp(`^(${ANY_STORE}|any|anywhere|skip|none)$`, "i").test(answer) ? null : await rememberStore(env, answer);
    const pending = await getPending(env);
    await setPending(env, []);
    if (pending.length) return addGroceryItems(env, pending, store);
    await setCurrentStore(env, store);
    await startPicker(env, "grocery_items");
    return storeView(env, store);
  }
  if (picker?.kind === "weather_city") {
    if (/^(cancel|never ?mind|skip)[.!]*$/i.test(stripButton(text))) {
      await cancelPicker(env);
      return "Okay, nothing changed.";
    }
    let place = null;
    try {
      place = await findPlace(text);
    } catch (err) {
      console.error("findPlace failed", err);
      return "Sorry, I couldn't look that up right now. Please try again in a minute.";
    }
    if (!place) return `I couldn't find "${escapeHtml(text)}". Try a city and state, like <i>Houston, TX</i>.`;
    await setPlace(env, place);
    await cancelPicker(env);
    return `🌤 Got it: <b>${escapeHtml(place.name)}</b>. Your morning message will include the forecast:\n${await morningWeather(env)}`;
  }
  if (picker?.kind === "add") {
    await cancelPicker(env);
    if (!/^(add|todo|new task)\b/i.test(text)) text = `add ${text}`;
  } else if (picker) {
    return handlePickerReply(env, chatId, picker, text, labels.iso.day.slice(0, 7));
  }

  const checkin = await getCheckin(env);
  if (checkin) return handleCheckinReply(env, checkin, text);

  const editing = await getEdit(env);
  if (editing) return handleEditReply(env, editing, text);

  const review = await getReview(env);
  if (review) return handleReviewReply(env, review, text);

  const [tasks, recurring, reminders, memories] = await Promise.all([
    listActiveTasks(env.DB),
    listRecurring(env.DB),
    listUpcomingReminders(env.DB),
    listMemories(env.DB),
  ]);
  const now = new Date();
  let interpretation: Interpretation;
  try {
    interpretation = await interpretMessage(env, text, {
      tasks,
      recurring,
      reminders,
      memories,
      todayLabel: friendlyDate(now, env.TIMEZONE),
      clock: clockTime(now, env.TIMEZONE),
      labels: periodLabels(now, env.TIMEZONE),
    });
  } catch (err) {
    console.error("interpretMessage failed, using rules", err);
    interpretation = interpretWithRules(text, tasks, { recurring, now, timeZone: env.TIMEZONE });
  }
  return applyInterpretation(env, interpretation, tasks);
}

export async function applyInterpretation(env: Env, interpretation: Interpretation, tasks: Task[]): Promise<string> {
  const lines: string[] = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const action of interpretation.actions) {
    const line = await applyAction(env, action, byId);
    if (line) lines.push(line);
  }

  if (lines.length === 0) {
    return interpretation.reply ? escapeHtml(interpretation.reply) : `I didn't catch that.\n\n${HELP_TEXT}`;
  }
  return lines.join("\n\n");
}

async function applyAction(env: Env, action: Action, byId: Map<number, Task>): Promise<string | null> {
  if (action.type === "add") {
    if (!action.title?.trim()) return null;
    const preferred = validDate(action.preferred_date);
    const due = validDate(action.due_date);
    const task = await addTask(env.DB, action.title, action.horizon ?? "week", clampRank(action.rank), {
      preferred_date: preferred,
      due_date: due,
      category: action.category,
    });
    byId.set(task.id, task);
    const details = [`rank ${task.rank}`, task.category ? escapeHtml(task.category) : null, datesText(preferred, due) || null]
      .filter(Boolean)
      .join(", ");
    return `➕ Added <b>${escapeHtml(task.title)}</b> to ${horizonLabel(task.horizon)} (${details}).`;
  }

  if (action.type === "show") {
    const fresh = await listActiveTasks(env.DB);
    const labels = periodLabels(new Date(), env.TIMEZONE);
    if (action.category) return formatCategory(fresh, action.category, labels);
    return action.horizon ? formatList(fresh, action.horizon, labels) : formatAllLists(fresh, labels);
  }

  if (action.type === "repeat") {
    const rule = ruleFromFields(action.repeat_days, action.repeat_month_day);
    if (!action.title?.trim() || !rule) return "🤔 I couldn't tell how often that should repeat. Try \"every Monday\" or \"on the 1st of every month\".";
    const today = periodLabels(new Date(), env.TIMEZONE).iso.day;
    return createRepeat(env, action.title, clampRank(action.rank), action.category, rule, today);
  }

  if (action.type === "stop_repeat") {
    const rec = (await listRecurring(env.DB)).find((r) => r.id === action.task_id);
    if (!rec) return "🤔 I couldn't find that repeating task. Send /repeats to see them.";
    await deleteRecurring(env.DB, rec.id);
    // Remove the open copy too, so it stops showing up right away.
    for (const copy of await openTasksFromRecurring(env.DB, rec.id)) await deleteTask(env.DB, copy.id);
    return `🛑 <b>${escapeHtml(rec.title)}</b> won't repeat anymore.`;
  }

  if (action.type === "grocery") {
    const items = splitGroceryItems(action.title ?? "");
    if (items.length === 0) return null;
    if (!action.category?.trim()) {
      await setPending(env, items);
      await startPicker(env, "grocery_store");
      return storeQuestion(items, (await allStores(env)).length > 0);
    }
    const store = await rememberStore(env, action.category);
    return `${addedText(await addItems(env, items, store))}\n\nTap 🛒 Groceries to see the list.`;
  }

  if (action.type === "remember") {
    if (!action.title?.trim()) return null;
    const memory = await addMemory(env.DB, action.title);
    return `🧠 Got it, I'll remember: <i>${escapeHtml(memory.text)}</i>`;
  }

  if (action.type === "forget") {
    const memory = (await listMemories(env.DB)).find((m) => m.id === action.task_id);
    if (!memory) return "🤔 I couldn't find that. Send /memory to see what I remember.";
    await deleteMemory(env.DB, memory.id);
    return `🧠 Forgotten: <i>${escapeHtml(memory.text)}</i>`;
  }

  if (action.type === "remind") {
    const m = action.remind_at?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/);
    if (!action.title?.trim() || !m) return "🤔 I couldn't work out when to remind you. Try \"remind me to call the bank at 2pm\".";
    const at = zonedTimeToUtc(m[1], Number(m[2]), Number(m[3]), env.TIMEZONE);
    return createReminder(env, action.title, at);
  }

  if (action.type === "cancel_reminder") {
    const reminder = (await listUpcomingReminders(env.DB)).find((r) => r.id === action.task_id);
    if (!reminder) return "🤔 I couldn't find that reminder. Send /reminders to see them.";
    await deleteReminder(env.DB, reminder.id);
    return `🛑 Cancelled the reminder to <b>${escapeHtml(reminder.text)}</b>.`;
  }

  const task = action.task_id != null ? byId.get(action.task_id) : undefined;
  if (!task) return "🤔 I couldn't find that task. Send /lists to see what's there.";
  const title = `<b>${escapeHtml(task.title)}</b>`;

  switch (action.type) {
    case "done":
      await updateTask(env.DB, task.id, { status: "done" });
      await logEvent(env.DB, "done", task, periodLabels(new Date(), env.TIMEZONE).iso.day);
      byId.delete(task.id);
      return `✅ Done: ${title}. Nice work!`;
    case "start":
      await updateTask(env.DB, task.id, { status: "doing" });
      return `⏳ Working on: ${title}`;
    case "remove":
      await logEvent(env.DB, "dropped", task, periodLabels(new Date(), env.TIMEZONE).iso.day);
      await deleteTask(env.DB, task.id);
      byId.delete(task.id);
      return `🗑 Removed: ${title}`;
    case "update": {
      const fields: {
        title?: string;
        horizon?: Horizon;
        rank?: number;
        preferred_date?: string;
        due_date?: string;
        category?: string;
      } = {};
      if (action.title?.trim()) fields.title = action.title;
      if (action.horizon) fields.horizon = action.horizon;
      if (action.rank != null) fields.rank = clampRank(action.rank);
      const preferred = validDate(action.preferred_date);
      const due = validDate(action.due_date);
      if (preferred) fields.preferred_date = preferred;
      if (due) fields.due_date = due;
      if (action.category?.trim()) fields.category = action.category;
      await updateTask(env.DB, task.id, fields);
      const changes = [
        fields.title ? `renamed to <b>${escapeHtml(fields.title.trim())}</b>` : null,
        fields.horizon ? `moved to ${horizonLabel(fields.horizon)}` : null,
        fields.rank != null ? `rank ${fields.rank}` : null,
        preferred ? `do ${shortDate(preferred)}` : null,
        due ? `by ${shortDate(due)}` : null,
        fields.category ? `category ${escapeHtml(fields.category)}` : null,
      ].filter(Boolean);
      return `✏️ Updated ${title}${changes.length ? `: ${changes.join(", ")}` : ""}.`;
    }
  }
  return null;
}
