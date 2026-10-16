import { planHorizons, sanitizePlan } from "./claude";
import { addTask, clearState, getState, listActiveTasks, setState, updateTask } from "./db";
import type { Env, Horizon } from "./env";
import { escapeHtml, formatAllLists } from "./format";
import { planWithRules } from "./fallback";
import { friendlyDate, parseDayAnswer, periodLabels, shortDate } from "./time";

/**
 * The weekly check-in is a small conversation:
 *   collect:  the user sends tasks (one per line or one per message), then "done".
 *   details:  for each new task, the bot asks three questions in turn:
 *             rank (1-5), preferred day, and latest day it can be done.
 *   finish:   tasks are saved, Claude sorts everything into month/week/day lists,
 *             and the bot sends the three lists.
 * Progress is stored in D1, so a restart mid check-in loses nothing.
 */

const STATE_KEY = "checkin";

export type DetailStep = "rank" | "preferred" | "due";

export interface CheckinItem {
  title: string;
  rank: number | null;
  preferred_date?: string | null;
  due_date?: string | null;
}

export interface CheckinState {
  stage: "collect" | "rank";
  items: CheckinItem[];
  /** Which task the bot is asking about. */
  index: number;
  /** Which question for that task. Missing in check-ins started before dates existed. */
  step?: DetailStep;
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

const DAY_EXAMPLES = `a day ("Wed", "tomorrow") or a date ("Oct 28", "end of month")`;

/** The next question to ask about the current task. */
export function detailQuestion(state: CheckinState): string {
  const item = state.items[state.index];
  const title = `<b>${escapeHtml(item.title)}</b>`;
  const counter = `(${state.index + 1}/${state.items.length})`;
  switch (state.step ?? "rank") {
    case "rank":
      return `${counter} How important is ${title}?\nReply 1 to 5 (1 = most important).`;
    case "preferred":
      return `${counter} What day would you <b>like</b> to do ${title}?\nReply with ${DAY_EXAMPLES}, or "skip".`;
    case "due":
      return (
        `${counter} What's the <b>latest</b> day ${title} can be done?\n` +
        `Reply with ${DAY_EXAMPLES}${item.preferred_date ? `, "same"` : ""}, or "skip".`
      );
  }
}

/** Starts a check-in and returns the opening message. */
export async function startCheckin(env: Env): Promise<string> {
  await saveCheckin(env, { stage: "collect", items: [], index: 0, step: "rank" });
  const labels = periodLabels(new Date(), env.TIMEZONE, true);
  const tasks = await listActiveTasks(env.DB);
  const existing = tasks.length
    ? `\n\nAlready on your lists (${tasks.length}):\n${tasks.map((t) => `• ${escapeHtml(t.title)}`).join("\n")}`
    : "";
  return (
    `🗓 <b>Weekly check-in</b>\n` +
    `Planning the week of <b>${escapeHtml(labels.week)}</b> (${escapeHtml(labels.month)}).\n\n` +
    `What do you need to get done this week or this month? Send your tasks one per line, or one per message.\n` +
    `Send <b>done</b> when you've listed everything. For each task I'll ask for a rank, the day you'd like to do it, ` +
    `and the latest day it can be done.` +
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
      state.step = "rank";
      await saveCheckin(env, state);
      const n = state.items.length;
      return `Great, ${n} new task${n === 1 ? "" : "s"}. Let's go through them.\n\n${detailQuestion(state)}`;
    }
    const items = splitItems(text);
    state.items.push(...items.map((title) => ({ title, rank: null })));
    await saveCheckin(env, state);
    return `Got it, ${state.items.length} so far. Anything else? Send <b>done</b> when you're finished.`;
  }

  const item = state.items[state.index];
  const step = state.step ?? "rank";
  const fromIso = periodLabels(new Date(), env.TIMEZONE, true).iso.day;

  if (step === "rank") {
    const rank = parseRank(text);
    if (rank == null) return `Please reply with a number from 1 to 5.\n\n${detailQuestion(state)}`;
    item.rank = rank;
    state.step = "preferred";
  } else if (step === "preferred") {
    const answer = parseDayAnswer(text, fromIso);
    if (answer.kind === "invalid" || answer.kind === "same") {
      return `Sorry, I didn't get that day.\n\n${detailQuestion(state)}`;
    }
    item.preferred_date = answer.kind === "date" ? answer.date : null;
    state.step = "due";
  } else {
    // "Fri" after a preferred Wednesday means the Friday after that Wednesday.
    const answer = parseDayAnswer(text, fromIso, item.preferred_date ?? fromIso);
    if (answer.kind === "invalid" || (answer.kind === "same" && !item.preferred_date)) {
      return `Sorry, I didn't get that day.\n\n${detailQuestion(state)}`;
    }
    const due = answer.kind === "date" ? answer.date : answer.kind === "same" ? item.preferred_date! : null;
    if (due && item.preferred_date && due < item.preferred_date) {
      return (
        `The latest day can't be before the day you'd like to do it (${shortDate(item.preferred_date)}).\n\n` +
        detailQuestion(state)
      );
    }
    item.due_date = due;
    state.index++;
    state.step = "rank";
  }

  if (state.index < state.items.length) {
    await saveCheckin(env, state);
    return detailQuestion(state);
  }
  return finishCheckin(env, state);
}

async function finishCheckin(env: Env, state: CheckinState): Promise<string> {
  const now = new Date();
  const labels = periodLabels(now, env.TIMEZONE, true);

  for (const item of state.items) {
    // Starting list from the dates; Claude (or the rules) refine it below.
    const date = item.preferred_date ?? item.due_date;
    const horizon: Horizon = date && date > labels.iso.weekEnd ? "month" : "week";
    await addTask(env.DB, item.title, horizon, item.rank ?? 3, {
      preferred_date: item.preferred_date ?? null,
      due_date: item.due_date ?? null,
    });
  }

  const tasks = await listActiveTasks(env.DB);
  let assignments: Map<number, Horizon>;
  let note = "";
  try {
    const plan = await planHorizons(env, tasks, friendlyDate(now, env.TIMEZONE), labels);
    assignments = sanitizePlan(plan, tasks);
    note = plan.note;
  } catch (err) {
    console.error("planHorizons failed, using rules", err);
    assignments = planWithRules(tasks, labels);
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
