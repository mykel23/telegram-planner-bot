import { clearState, deleteTask, getState, getTask, listActiveTasks, setState, updateTask } from "./db";
import type { Env, Task } from "./env";
import { effectiveHorizon, escapeHtml } from "./format";
import { addDays, parseDayAnswer, periodLabels, shortDate } from "./time";

/**
 * Evening review: the bot goes through today's list one task at a time and asks
 * whether it got done.
 *   yes          -> marked done
 *   no           -> rolls over to tomorrow
 *   a day        -> moved to that day ("Fri", "Oct 28")
 *   drop         -> removed from the lists
 * Progress is stored in D1, so a restart mid-review loses nothing.
 */

const STATE_KEY = "review";

export interface ReviewState {
  /** The day being reviewed, YYYY-MM-DD. */
  date: string;
  ids: number[];
  index: number;
  done: number;
  moved: number;
  dropped: number;
}

export type ReviewAnswer =
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "drop" }
  | { kind: "move"; date: string }
  | { kind: "invalid" };

export function parseReviewAnswer(text: string, todayIso: string): ReviewAnswer {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(y|yes|yep|yeah|yup|done|finished|completed|did it|✅|👍)$/.test(t)) return { kind: "yes" };
  if (/^(n|no|nope|not yet|not done|didn'?t|did not)$/.test(t)) return { kind: "no" };
  if (/^(drop|remove|delete|cancel it|never ?mind)$/.test(t)) return { kind: "drop" };
  const day = parseDayAnswer(t.replace(/^(move( it)?( to)?|push( it)?( to)?) /, ""), todayIso);
  if (day.kind === "date") return { kind: "move", date: day.date };
  return { kind: "invalid" };
}

export async function getReview(env: Env): Promise<ReviewState | null> {
  const raw = await getState(env.DB, STATE_KEY);
  return raw ? (JSON.parse(raw) as ReviewState) : null;
}

async function saveReview(env: Env, state: ReviewState): Promise<void> {
  await setState(env.DB, STATE_KEY, JSON.stringify(state));
}

export async function cancelReview(env: Env): Promise<void> {
  await clearState(env.DB, STATE_KEY);
}

function question(state: ReviewState, task: Task): string {
  return (
    `(${state.index + 1}/${state.ids.length}) Did you finish <b>${escapeHtml(task.title)}</b>?\n` +
    `Reply <b>yes</b>, <b>no</b> (moves it to tomorrow), a day to move it to ("Fri", "Oct 28"), or <b>drop</b>.`
  );
}

/** Starts the evening review and returns the first message. */
export async function startReview(env: Env, now: Date = new Date()): Promise<string> {
  const labels = periodLabels(now, env.TIMEZONE);
  const today = (await listActiveTasks(env.DB)).filter((t) => effectiveHorizon(t, labels) === "day");
  if (today.length === 0) {
    await cancelReview(env);
    return `🌙 <b>Evening check-in</b>\nNothing was on today's list. Text <code>add …</code> if there's anything for tomorrow. Good night!`;
  }
  const state: ReviewState = { date: labels.iso.day, ids: today.map((t) => t.id), index: 0, done: 0, moved: 0, dropped: 0 };
  await saveReview(env, state);
  return `🌙 <b>Evening check-in</b> for ${escapeHtml(labels.day)}\nLet's go through today's list.\n\n${question(state, today[0])}`;
}

/** Handles one reply during the review and returns the bot's answer. */
export async function handleReviewReply(env: Env, state: ReviewState, text: string): Promise<string> {
  const task = await getTask(env.DB, state.ids[state.index]);
  let note = "";

  if (task && task.status !== "done") {
    const answer = parseReviewAnswer(text, state.date);
    if (answer.kind === "invalid") return `Sorry, I didn't get that. ${question(state, task)}\n\nOr send /cancel to stop.`;

    if (answer.kind === "yes") {
      await updateTask(env.DB, task.id, { status: "done" });
      state.done++;
      note = `✅ Nice work!`;
    } else if (answer.kind === "drop") {
      await deleteTask(env.DB, task.id);
      state.dropped++;
      note = `🗑 Dropped.`;
    } else {
      const target = answer.kind === "move" ? answer.date : addDays(state.date, 1);
      if (target <= state.date) return `Pick a day after today, or reply <b>no</b> to move it to tomorrow.`;
      note = await moveTask(env, task, target, state.date);
      state.moved++;
    }
  }

  state.index++;
  // Skip tasks that were finished or deleted some other way since the review started.
  while (state.index < state.ids.length) {
    const next = await getTask(env.DB, state.ids[state.index]);
    if (next && next.status !== "done") {
      await saveReview(env, state);
      return `${note}\n\n${question(state, next)}`.trim();
    }
    state.index++;
  }

  await cancelReview(env);
  const summary = [
    state.done ? `✅ ${state.done} done` : null,
    state.moved ? `➡️ ${state.moved} moved` : null,
    state.dropped ? `🗑 ${state.dropped} dropped` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return `${note}\n\n🌙 <b>That's everything for today.</b>${summary ? `\n${summary}` : ""}\nGood night!`.trim();
}

/** Moves a task to a later day, never past its latest day. */
async function moveTask(env: Env, task: Task, date: string, todayIso: string): Promise<string> {
  // Tasks pinned to the Day list move to the week, so they leave today's list.
  const leaveDay = task.horizon === "day" ? { horizon: "week" as const } : {};
  if (task.due_date && date > task.due_date) {
    if (task.due_date > todayIso) {
      await updateTask(env.DB, task.id, { preferred_date: task.due_date, ...leaveDay });
      return `➡️ It's due ${shortDate(task.due_date)}, so I've moved it to that day.`;
    }
    return `⚠️ It was due ${shortDate(task.due_date)}, so it stays on your list as overdue. Use /edit to change the deadline.`;
  }
  await updateTask(env.DB, task.id, { preferred_date: date, ...leaveDay });
  return `➡️ Moved to ${shortDate(date)}.`;
}
