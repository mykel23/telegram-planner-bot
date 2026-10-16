import { addTask, clearState, deleteTask, getState, getTask, listActiveTasks, setState, updateTask } from "./db";
import { splitItems } from "./checkin";
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
 * A repeating task that wasn't done is skipped for the day; it comes back on its next day.
 * A task pushed back STUCK_AFTER times gets a follow-up question: split it into
 * smaller steps, move it to the month list, drop it, or keep it.
 * Progress is stored in D1, so a restart mid-review loses nothing.
 */

const STATE_KEY = "review";

/** After this many push-backs, the bot asks what to do with the task. */
export const STUCK_AFTER = 3;

export interface ReviewState {
  /** The day being reviewed, YYYY-MM-DD. */
  date: string;
  ids: number[];
  index: number;
  done: number;
  moved: number;
  dropped: number;
  /** Set while asking what to do with a task that keeps getting pushed back. */
  stuck?: { taskId: number; stage: "choose" | "split" };
}

export type StuckAnswer = "split" | "month" | "drop" | "keep" | null;

/** Removes a leading emoji, so a tapped "✅ Done" reads as "done". */
export function stripButton(text: string): string {
  return text.trim().replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

export function parseStuckAnswer(text: string): StuckAnswer {
  const t = stripButton(text).toLowerCase().replace(/[.!]+$/, "");
  if (/^(split|split it|break it up|smaller steps)$/.test(t)) return "split";
  if (/^(month|move to month|this month|later)$/.test(t)) return "month";
  if (/^(drop|drop it|remove|delete)$/.test(t)) return "drop";
  if (/^(keep|keep it|leave it|keep it as is)$/.test(t)) return "keep";
  return null;
}

export type ReviewAnswer =
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "drop" }
  | { kind: "move"; date: string }
  | { kind: "invalid" };

export function parseReviewAnswer(text: string, todayIso: string): ReviewAnswer {
  const t = stripButton(text).toLowerCase().replace(/[.!]+$/, "");
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
    `Tap a button, or type a day to move it to ("Fri", "Oct 28").`
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

function stuckQuestion(task: Task): string {
  return (
    `🤔 <b>${escapeHtml(task.title)}</b> has been pushed back ${task.rollovers} times. What should we do with it?\n` +
    `• <b>Split</b> it into smaller steps\n• Move it to this <b>Month</b>'s list\n• <b>Drop</b> it\n• <b>Keep</b> it as is`
  );
}

/** Handles one reply during the review and returns the bot's answer. */
export async function handleReviewReply(env: Env, state: ReviewState, text: string): Promise<string> {
  if (state.stuck) return handleStuckReply(env, state, state.stuck, text);

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
    } else if (task.recurring_id != null) {
      // Repeating tasks don't pile up: today's copy is skipped and the next one comes on schedule.
      await deleteTask(env.DB, task.id);
      state.moved++;
      note = `🔁 Skipped for today. It'll be back on its next day.`;
    } else {
      const target = answer.kind === "move" ? answer.date : addDays(state.date, 1);
      if (target <= state.date) return `Pick a day after today, or reply <b>no</b> to move it to tomorrow.`;
      note = await moveTask(env, task, target, state.date);
      state.moved++;
      const rollovers = task.rollovers + 1;
      await updateTask(env.DB, task.id, { rollovers });
      if (rollovers >= STUCK_AFTER) {
        state.index++;
        state.stuck = { taskId: task.id, stage: "choose" };
        await saveReview(env, state);
        return `${note}\n\n${stuckQuestion({ ...task, rollovers })}`;
      }
    }
  }

  state.index++;
  return nextQuestion(env, state, note);
}

async function handleStuckReply(
  env: Env,
  state: ReviewState,
  stuck: NonNullable<ReviewState["stuck"]>,
  text: string,
): Promise<string> {
  const task = await getTask(env.DB, stuck.taskId);
  let note = "";
  if (task) {
    if (stuck.stage === "split") {
      const steps = splitItems(text);
      if (steps.length === 0) return `Send the smaller steps, one per line.`;
      for (const step of steps) {
        await addTask(env.DB, step, task.horizon, task.rank, {
          preferred_date: task.preferred_date,
          due_date: task.due_date,
          category: task.category,
        });
      }
      await deleteTask(env.DB, task.id);
      note = `✂️ Split into ${steps.length} step${steps.length === 1 ? "" : "s"}:\n${steps.map((s) => `• ${escapeHtml(s)}`).join("\n")}`;
    } else {
      const answer = parseStuckAnswer(text);
      if (!answer) return `Please pick one: <b>Split</b>, <b>Month</b>, <b>Drop</b> or <b>Keep</b>.`;
      if (answer === "split") {
        state.stuck = { taskId: task.id, stage: "split" };
        await saveReview(env, state);
        return `What are the smaller steps for <b>${escapeHtml(task.title)}</b>? Send them one per line.`;
      }
      if (answer === "month") {
        await updateTask(env.DB, task.id, { horizon: "month", preferred_date: null, rollovers: 0 });
        note = `🗓 Moved to this month's list, with no set day.`;
      } else if (answer === "drop") {
        await deleteTask(env.DB, task.id);
        state.dropped++;
        note = `🗑 Dropped.`;
      } else {
        await updateTask(env.DB, task.id, { rollovers: 0 });
        note = `👍 Keeping it as is.`;
      }
    }
  }
  state.stuck = undefined;
  return nextQuestion(env, state, note);
}

/** Asks about the next task still open, or wraps up the review. */
async function nextQuestion(env: Env, state: ReviewState, note: string): Promise<string> {
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
