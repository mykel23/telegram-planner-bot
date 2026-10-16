import { cancelCheckin, getCheckin, handleCheckinReply, startCheckin } from "./checkin";
import { type Action, type Interpretation, interpretMessage } from "./claude";
import { cancelEdit, getEdit, handleEditReply, startEdit } from "./edit";
import { cancelReview, getReview, handleReviewReply, startReview } from "./review";
import {
  addTask,
  clampRank,
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
} from "./format";
import { interpretWithRules } from "./fallback";
import { keyboardFor } from "./keyboard";
import { createRepeat, formatRepeats, ruleFromFields } from "./recurring";
import { createReminder, formatReminders } from "./reminders";
import { sendMessage, type TelegramUpdate } from "./telegram";
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

/**
 * Entry point for every Telegram message.
 * The first person to send /start becomes the owner; everyone else is ignored,
 * so nobody else can read or change the task lists.
 */
export async function handleUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || message.chat.type !== "private") return;
  let text = message.text?.trim();
  if (!text && !message.voice) return;

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
      );
    } else {
      await sendMessage(env, chatId, "Send /start to set up your planner.");
    }
    return;
  }
  if (owner !== String(chatId)) return;

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

  const reply = await respond(env, text!);
  if (reply) await sendMessage(env, chatId, heard + reply, await keyboardFor(env));
}

/** Works out the reply to one message from the owner. */
export async function respond(env: Env, text: string): Promise<string> {
  const command = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : null;
  const labels = periodLabels(new Date(), env.TIMEZONE);

  switch (command) {
    case "/start":
    case "/help":
      return HELP_TEXT;
    case "/today":
      return formatList(await listActiveTasks(env.DB), "day", labels);
    case "/week":
      return formatList(await listActiveTasks(env.DB), "week", labels);
    case "/month":
      return formatList(await listActiveTasks(env.DB), "month", labels);
    case "/lists":
    case "/all":
      return formatAllLists(await listActiveTasks(env.DB), labels);
    case "/daily":
      return formatDailyMessage(await listActiveTasks(env.DB), friendlyDate(new Date(), env.TIMEZONE), labels);
    case "/checkin":
      await Promise.all([cancelEdit(env), cancelReview(env)]);
      return startCheckin(env);
    case "/edit":
      if (await getCheckin(env)) return "Finish the check-in first, or send /cancel to stop it.";
      await cancelReview(env);
      return startEdit(env, labels.iso.day);
    case "/review":
      if (await getCheckin(env)) return "Finish the check-in first, or send /cancel to stop it.";
      await cancelEdit(env);
      return startReview(env);
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
      const [checkinActive, editActive, reviewActive] = await Promise.all([
        getCheckin(env),
        getEdit(env),
        getReview(env),
      ]);
      await Promise.all([cancelCheckin(env), cancelEdit(env), cancelReview(env)]);
      if (checkinActive) return "Check-in cancelled. Nothing new was saved.";
      if (editActive) return "Edit stopped. Changes you already confirmed are kept.";
      if (reviewActive) return "Evening check-in stopped. Answers you already gave are kept.";
      return "There's nothing to cancel.";
    }
  }

  // "/work", "/health": any category in use works as a command.
  if (command) {
    const category = (await listCategories(env.DB)).find((c) => `/${c.toLowerCase()}` === command);
    if (category) return formatCategory(await listActiveTasks(env.DB), category, labels);
    return `I don't know that command.\n\n${HELP_TEXT}`;
  }

  const checkin = await getCheckin(env);
  if (checkin) return handleCheckinReply(env, checkin, text);

  const editing = await getEdit(env);
  if (editing) return handleEditReply(env, editing, text);

  const review = await getReview(env);
  if (review) return handleReviewReply(env, review, text);

  const [tasks, recurring, reminders] = await Promise.all([
    listActiveTasks(env.DB),
    listRecurring(env.DB),
    listUpcomingReminders(env.DB),
  ]);
  const now = new Date();
  let interpretation: Interpretation;
  try {
    interpretation = await interpretMessage(env, text, {
      tasks,
      recurring,
      reminders,
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
      byId.delete(task.id);
      return `✅ Done: ${title}. Nice work!`;
    case "start":
      await updateTask(env.DB, task.id, { status: "doing" });
      return `⏳ Working on: ${title}`;
    case "remove":
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
