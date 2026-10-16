import { cancelCheckin, getCheckin, handleCheckinReply, startCheckin } from "./checkin";
import { type Action, type Interpretation, interpretMessage } from "./claude";
import { addTask, clampRank, deleteTask, getState, listActiveTasks, setState, updateTask } from "./db";
import type { Env, Horizon, Task } from "./env";
import { HELP_TEXT, escapeHtml, formatAllLists, formatDailyMessage, formatList, horizonLabel } from "./format";
import { interpretWithRules } from "./fallback";
import { sendMessage, type TelegramUpdate } from "./telegram";
import { friendlyDate, periodLabels, shortDate } from "./time";

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
  const text = message?.text?.trim();
  if (!message || !text || message.chat.type !== "private") return;

  const chatId = message.chat.id;
  const owner = await getState(env.DB, OWNER_KEY);

  if (!owner) {
    if (text.startsWith("/start")) {
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

  const reply = await respond(env, text);
  if (reply) await sendMessage(env, chatId, reply);
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
      return startCheckin(env);
    case "/cancel": {
      const active = await getCheckin(env);
      await cancelCheckin(env);
      return active ? "Check-in cancelled. Nothing new was saved." : "There's nothing to cancel.";
    }
  }

  const checkin = await getCheckin(env);
  if (checkin) return handleCheckinReply(env, checkin, text);

  const tasks = await listActiveTasks(env.DB);
  let interpretation: Interpretation;
  try {
    const now = new Date();
    interpretation = await interpretMessage(
      env,
      text,
      tasks,
      friendlyDate(now, env.TIMEZONE),
      periodLabels(now, env.TIMEZONE),
    );
  } catch (err) {
    console.error("interpretMessage failed, using rules", err);
    interpretation = interpretWithRules(text, tasks);
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
    });
    byId.set(task.id, task);
    const dates = datesText(preferred, due);
    return `➕ Added <b>${escapeHtml(task.title)}</b> to ${horizonLabel(task.horizon)} (rank ${task.rank}${dates ? `, ${dates}` : ""}).`;
  }

  if (action.type === "show") {
    const fresh = await listActiveTasks(env.DB);
    const labels = periodLabels(new Date(), env.TIMEZONE);
    return action.horizon ? formatList(fresh, action.horizon, labels) : formatAllLists(fresh, labels);
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
      } = {};
      if (action.title?.trim()) fields.title = action.title;
      if (action.horizon) fields.horizon = action.horizon;
      if (action.rank != null) fields.rank = clampRank(action.rank);
      const preferred = validDate(action.preferred_date);
      const due = validDate(action.due_date);
      if (preferred) fields.preferred_date = preferred;
      if (due) fields.due_date = due;
      await updateTask(env.DB, task.id, fields);
      const changes = [
        fields.title ? `renamed to <b>${escapeHtml(fields.title.trim())}</b>` : null,
        fields.horizon ? `moved to ${horizonLabel(fields.horizon)}` : null,
        fields.rank != null ? `rank ${fields.rank}` : null,
        preferred ? `do ${shortDate(preferred)}` : null,
        due ? `by ${shortDate(due)}` : null,
      ].filter(Boolean);
      return `✏️ Updated ${title}${changes.length ? `: ${changes.join(", ")}` : ""}.`;
    }
  }
  return null;
}
