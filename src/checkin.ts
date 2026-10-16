import { planHorizons, sanitizePlan } from "./claude";
import { addTask, clearState, getState, listActiveTasks, setState, updateTask } from "./db";
import type { Env, Horizon } from "./env";
import { escapeHtml, formatAllLists } from "./format";
import { planWithRules } from "./fallback";
import { friendlyDate, periodLabels } from "./time";

/**
 * The weekly check-in is a small conversation:
 *   collect: the user sends tasks (one per line or one per message), then "done".
 *   rank:    the bot asks for a 1-5 rank for each new task, one at a time.
 *   finish:  tasks are saved, Claude sorts everything into month/week/day lists,
 *            and the bot sends the three lists.
 * Progress is stored in D1, so a restart mid check-in loses nothing.
 */

const STATE_KEY = "checkin";

export interface CheckinState {
  stage: "collect" | "rank";
  items: { title: string; rank: number | null }[];
  index: number;
}

const FINISHED_WORDS = new Set([
  "done",
  "that's all",
  "thats all",
  "that's it",
  "thats it",
  "finished",
  "no more",
  "nothing else",
  "nope",
  "no",
]);

export function isFinishedSignal(text: string): boolean {
  return FINISHED_WORDS.has(text.trim().toLowerCase().replace(/[.!]+$/, ""));
}

/** Splits a message into task titles, dropping bullets and numbering. */
export function splitItems(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 0);
}

/** Reads a 1-5 rank from a reply like "2", "rank 2" or "2 - pretty important". */
export function parseRank(text: string): number | null {
  const match = text.trim().match(/^(?:rank\s*)?([1-5])\b/i);
  return match ? Number(match[1]) : null;
}

export async function getCheckin(env: Env): Promise<CheckinState | null> {
  const raw = await getState(env.DB, STATE_KEY);
  return raw ? (JSON.parse(raw) as CheckinState) : null;
}

async function saveCheckin(env: Env, state: CheckinState): Promise<void> {
  await setState(env.DB, STATE_KEY, JSON.stringify(state));
}

export async function cancelCheckin(env: Env): Promise<void> {
  await clearState(env.DB, STATE_KEY);
}

function rankQuestion(state: CheckinState): string {
  const item = state.items[state.index];
  return (
    `(${state.index + 1}/${state.items.length}) How important is <b>${escapeHtml(item.title)}</b>?\n` +
    `Reply 1 to 5 (1 = most important).`
  );
}

/** Starts a check-in and returns the opening message. */
export async function startCheckin(env: Env): Promise<string> {
  await saveCheckin(env, { stage: "collect", items: [], index: 0 });
  const tasks = await listActiveTasks(env.DB);
  const existing = tasks.length
    ? `\n\nAlready on your lists (${tasks.length}):\n${tasks.map((t) => `• ${escapeHtml(t.title)}`).join("\n")}`
    : "";
  return (
    `🗓 <b>Weekly check-in</b>\n` +
    `Planning the week of <b>${escapeHtml(periodLabels(new Date(), env.TIMEZONE, true).week)}</b> ` +
    `(${escapeHtml(periodLabels(new Date(), env.TIMEZONE, true).month)}).\n\n` +
    `What do you need to get done? Send your tasks one per line, or one per message.\n` +
    `Send <b>done</b> when you've listed everything.` +
    existing
  );
}

/** Handles one reply during a check-in and returns the bot's answer. */
export async function handleCheckinReply(env: Env, state: CheckinState, text: string): Promise<string> {
  if (state.stage === "collect") {
    if (isFinishedSignal(text)) {
      if (state.items.length === 0) return finishCheckin(env, state);
      state.stage = "rank";
      state.index = 0;
      await saveCheckin(env, state);
      return `Great, ${state.items.length} new task${state.items.length === 1 ? "" : "s"}. Let's rank them.\n\n${rankQuestion(state)}`;
    }
    const items = splitItems(text);
    state.items.push(...items.map((title) => ({ title, rank: null })));
    await saveCheckin(env, state);
    return `Got it, ${state.items.length} so far. Anything else? Send <b>done</b> when you're finished.`;
  }

  const rank = parseRank(text);
  if (rank == null) return `Please reply with a number from 1 to 5.\n\n${rankQuestion(state)}`;
  state.items[state.index].rank = rank;
  state.index++;
  if (state.index < state.items.length) {
    await saveCheckin(env, state);
    return rankQuestion(state);
  }
  return finishCheckin(env, state);
}

async function finishCheckin(env: Env, state: CheckinState): Promise<string> {
  for (const item of state.items) {
    await addTask(env.DB, item.title, "week", item.rank ?? 3);
  }

  const tasks = await listActiveTasks(env.DB);
  const now = new Date();
  const labels = periodLabels(now, env.TIMEZONE, true);
  let assignments: Map<number, Horizon>;
  let note = "";
  try {
    const plan = await planHorizons(env, tasks, friendlyDate(now, env.TIMEZONE), labels);
    assignments = sanitizePlan(plan, tasks);
    note = plan.note;
  } catch (err) {
    console.error("planHorizons failed, using rules", err);
    assignments = planWithRules(tasks);
  }

  for (const task of tasks) {
    const horizon = assignments.get(task.id);
    if (horizon && horizon !== task.horizon) {
      await updateTask(env.DB, task.id, { horizon });
      task.horizon = horizon;
    }
  }

  await cancelCheckin(env);
  const header = `🎯 <b>Your priorities</b>${note ? `\n${escapeHtml(note)}` : ""}`;
  return `${header}\n\n${formatAllLists(tasks, labels)}`;
}
