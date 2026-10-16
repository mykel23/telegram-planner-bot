import { parseRank } from "./checkin";
import { clearState, getState, getTask, listActiveTasks, setState, updateTask } from "./db";
import type { Env, Horizon, Task } from "./env";
import { escapeHtml, formatTaskLine, horizonLabel } from "./format";
import { parseDayAnswer, periodLabels, shortDate } from "./time";

/**
 * Guided editing, so a task never has to be re-entered:
 *   /edit       -> numbered list of tasks
 *   "2"         -> which field to change (rank, preferred day, latest day, name, list)
 *   "1"         -> the new value
 * After each change the bot offers to edit another field of the same task.
 * The task's dates and rank stay as they are unless changed here.
 */

const STATE_KEY = "edit";

export type EditField = "rank" | "preferred" | "due" | "title" | "horizon";

const FIELDS: { field: EditField; label: string }[] = [
  { field: "rank", label: "Rank" },
  { field: "preferred", label: "Preferred day" },
  { field: "due", label: "Latest day" },
  { field: "title", label: "Name" },
  { field: "horizon", label: "List (day, week or month)" },
];

export interface EditState {
  stage: "pick" | "field" | "value";
  /** Task IDs in the order they were listed, so "2" means the second task shown. */
  ids: number[];
  taskId?: number;
  field?: EditField;
}

export async function getEdit(env: Env): Promise<EditState | null> {
  const raw = await getState(env.DB, STATE_KEY);
  return raw ? (JSON.parse(raw) as EditState) : null;
}

async function saveEdit(env: Env, state: EditState): Promise<void> {
  await setState(env.DB, STATE_KEY, JSON.stringify(state));
}

export async function cancelEdit(env: Env): Promise<void> {
  await clearState(env.DB, STATE_KEY);
}

function fieldMenu(task: Task, todayIso: string): string {
  return (
    `Editing:\n${formatTaskLine(task, 1, todayIso).replace(/^1\. /, "")}\n\n` +
    `What do you want to change?\n` +
    FIELDS.map((f, i) => `${i + 1}. ${f.label}`).join("\n") +
    `\n\nReply with a number, or <b>done</b>.`
  );
}

function valueQuestion(field: EditField, task: Task): string {
  const title = `<b>${escapeHtml(task.title)}</b>`;
  switch (field) {
    case "rank":
      return `New rank for ${title}? Reply 1 to 5 (1 = most important).`;
    case "preferred":
      return `What day would you like to do ${title}?\nReply with a day ("Wed", "tomorrow"), a date ("Oct 28"), or "none" to clear it.`;
    case "due":
      return `What's the latest day ${title} can be done?\nReply with a day ("Fri"), a date ("Oct 30", "end of month"), or "none" to clear it.`;
    case "title":
      return `What should ${title} be called instead?`;
    case "horizon":
      return `Which list should ${title} be on? Reply <b>day</b>, <b>week</b> or <b>month</b>.`;
  }
}

function parseHorizon(text: string): Horizon | null {
  const t = text.trim().toLowerCase();
  if (/^(day|today|d)$/.test(t)) return "day";
  if (/^(week|this week|w)$/.test(t)) return "week";
  if (/^(month|this month|m)$/.test(t)) return "month";
  return null;
}

/** Starts an edit and returns the numbered task list. */
export async function startEdit(env: Env, todayIso: string): Promise<string> {
  const tasks = await listActiveTasks(env.DB);
  if (tasks.length === 0) return "You have no tasks to edit. Send <code>add …</code> to add one.";
  await saveEdit(env, { stage: "pick", ids: tasks.map((t) => t.id) });
  return (
    `✏️ <b>Which task do you want to edit?</b>\n` +
    tasks.map((t, i) => formatTaskLine(t, i + 1, todayIso)).join("\n") +
    `\n\nReply with its number, or /cancel.`
  );
}

/** Handles one reply during an edit and returns the bot's answer. */
export async function handleEditReply(env: Env, state: EditState, text: string): Promise<string> {
  const labels = periodLabels(new Date(), env.TIMEZONE);
  const todayIso = labels.iso.day;
  const reply = text.trim();

  if (state.stage === "pick") {
    const n = Number(reply.replace(/^#/, ""));
    const id = Number.isInteger(n) ? state.ids[n - 1] : undefined;
    const task = id != null ? await getTask(env.DB, id) : null;
    if (!task) return `Please reply with a task number from 1 to ${state.ids.length}, or /cancel.`;
    await saveEdit(env, { ...state, stage: "field", taskId: task.id });
    return fieldMenu(task, todayIso);
  }

  const task = state.taskId != null ? await getTask(env.DB, state.taskId) : null;
  if (!task) {
    await cancelEdit(env);
    return "That task no longer exists. Send /edit to start again.";
  }

  if (state.stage === "field") {
    if (/^(done|no|nope|that's it|thats it|finished)[.!]*$/i.test(reply)) {
      await cancelEdit(env);
      return "👍 All set.";
    }
    const choice = FIELDS[Number(reply) - 1];
    if (!choice) return `Please reply with a number from 1 to ${FIELDS.length}, or <b>done</b>.`;
    await saveEdit(env, { ...state, stage: "value", field: choice.field });
    return valueQuestion(choice.field, task);
  }

  // stage === "value"
  const field = state.field ?? "rank";
  let change: string;
  switch (field) {
    case "rank": {
      const rank = parseRank(reply);
      if (rank == null) return `Please reply with a number from 1 to 5.`;
      await updateTask(env.DB, task.id, { rank });
      change = `rank ${rank}`;
      break;
    }
    case "preferred":
    case "due": {
      const answer = parseDayAnswer(reply, todayIso, field === "due" ? (task.preferred_date ?? todayIso) : todayIso);
      if (answer.kind === "invalid") return `Sorry, I didn't get that day.\n\n${valueQuestion(field, task)}`;
      let date: string | null = null;
      if (answer.kind === "date") date = answer.date;
      if (answer.kind === "same") {
        if (field !== "due" || !task.preferred_date) {
          return `Sorry, I didn't get that day.\n\n${valueQuestion(field, task)}`;
        }
        date = task.preferred_date;
      }
      if (field === "due" && date && task.preferred_date && date < task.preferred_date) {
        return `The latest day can't be before the preferred day (${shortDate(task.preferred_date)}). Pick another day, or change the preferred day first.`;
      }
      if (field === "preferred" && date && task.due_date && date > task.due_date) {
        return `The preferred day can't be after the latest day (${shortDate(task.due_date)}). Pick another day, or change the latest day first.`;
      }
      await updateTask(env.DB, task.id, field === "due" ? { due_date: date } : { preferred_date: date });
      const name = field === "due" ? "latest day" : "preferred day";
      change = date ? `${name} ${shortDate(date)}` : `${name} cleared`;
      break;
    }
    case "title": {
      if (!reply || reply.startsWith("/")) return valueQuestion(field, task);
      await updateTask(env.DB, task.id, { title: reply });
      change = `renamed to <b>${escapeHtml(reply)}</b>`;
      break;
    }
    case "horizon": {
      const horizon = parseHorizon(reply);
      if (!horizon) return `Please reply <b>day</b>, <b>week</b> or <b>month</b>.`;
      await updateTask(env.DB, task.id, { horizon });
      change = `moved to ${horizonLabel(horizon)}`;
      break;
    }
  }

  const updated = (await getTask(env.DB, task.id)) ?? task;
  await saveEdit(env, { ...state, stage: "field", field: undefined });
  return `✏️ Updated: ${change}.\n\n${fieldMenu(updated, todayIso)}`;
}
