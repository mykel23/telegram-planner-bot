import type { Horizon, Task } from "./env";
import { type PeriodLabels, shortDate } from "./time";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const HORIZON_ICONS: Record<Horizon, string> = { month: "🗓", week: "📅", day: "☀️" };
const HORIZON_NAMES: Record<Horizon, string> = { month: "Month", week: "Week", day: "Day" };

/** "📅 Week: Mon, Oct 19 – Sun, Oct 25" */
export function listTitle(horizon: Horizon, labels: PeriodLabels): string {
  return `${HORIZON_ICONS[horizon]} ${HORIZON_NAMES[horizon]}: ${labels[horizon]}`;
}

export function horizonLabel(horizon: Horizon): string {
  return { day: "today", week: "this week", month: "this month" }[horizon];
}

/**
 * Which list a task appears in for the period in `labels`. Dates win over the
 * stored list: a task preferred or due today (or overdue) shows under Day,
 * one preferred or due by Sunday shows under Week.
 */
export function effectiveHorizon(task: Task, labels: PeriodLabels): Horizon {
  if (task.horizon === "day") return "day";
  const by = (limit: string) =>
    (task.preferred_date != null && task.preferred_date <= limit) || (task.due_date != null && task.due_date <= limit);
  if (by(labels.iso.day)) return "day";
  if (by(labels.iso.weekEnd)) return "week";
  return task.horizon;
}

export function formatTaskLine(task: Task, position: number, todayIso?: string): string {
  const doing = task.status === "doing" ? " ⏳" : "";
  const repeat = task.recurring_id != null ? " 🔁" : "";
  const details = [`rank ${task.rank}`];
  if (task.category) details.push(escapeHtml(task.category));
  if (task.preferred_date) details.push(`do ${shortDate(task.preferred_date)}`);
  if (task.due_date) details.push(`by ${shortDate(task.due_date)}`);
  let flag = "";
  if (task.due_date && todayIso) {
    if (task.due_date < todayIso) flag = " ⚠️ overdue";
    else if (task.due_date === todayIso) flag = " ❗ due today";
  }
  return `${position}. ${escapeHtml(task.title)}${repeat}${doing}${flag} <i>(${details.join(" · ")})</i>`;
}

/** Most important first; among equal ranks, the earliest deadline first. */
function byPriority(a: Task, b: Task): number {
  return a.rank - b.rank || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") || a.id - b.id;
}

/** Tasks for one list, most important first. */
export function formatList(tasks: Task[], horizon: Horizon, labels: PeriodLabels): string {
  const items = tasks.filter((t) => effectiveHorizon(t, labels) === horizon).sort(byPriority);
  const body = items.length
    ? items.map((t, i) => formatTaskLine(t, i + 1, labels.iso.day)).join("\n")
    : "<i>Nothing here yet.</i>";
  return `<b>${listTitle(horizon, labels)}</b>\n${body}`;
}

/** Month, week and day lists together. */
export function formatAllLists(tasks: Task[], labels: PeriodLabels): string {
  return (["month", "week", "day"] as Horizon[]).map((h) => formatList(tasks, h, labels)).join("\n\n");
}

/** One category's tasks, split by list. */
export function formatCategory(tasks: Task[], category: string, labels: PeriodLabels): string {
  const mine = tasks.filter((t) => t.category?.toLowerCase() === category.toLowerCase());
  if (mine.length === 0) return `🏷 <b>${escapeHtml(category)}</b>\n<i>No open tasks in this category.</i>`;
  const sections = (["day", "week", "month"] as Horizon[])
    .map((h) => {
      const items = mine.filter((t) => effectiveHorizon(t, labels) === h).sort(byPriority);
      return items.length
        ? `<b>${HORIZON_ICONS[h]} ${HORIZON_NAMES[h]}</b>\n${items.map((t, i) => formatTaskLine(t, i + 1, labels.iso.day)).join("\n")}`
        : null;
    })
    .filter(Boolean);
  return `🏷 <b>${escapeHtml(mine[0].category ?? category)}</b>\n\n${sections.join("\n\n")}`;
}

export function formatDailyMessage(tasks: Task[], dateLabel: string, labels: PeriodLabels): string {
  const doing = tasks.filter((t) => t.status === "doing");
  const today = tasks.filter((t) => effectiveHorizon(t, labels) === "day").sort(byPriority);
  const upNext = tasks
    .filter((t) => effectiveHorizon(t, labels) === "week" && t.status !== "doing")
    .sort(byPriority)
    .slice(0, 3);
  const line = (t: Task, i: number) => formatTaskLine(t, i + 1, labels.iso.day);

  const parts = [
    `☀️ <b>Good morning!</b> Here's your plan for ${escapeHtml(dateLabel)}.\n` +
      `<i>Week: ${escapeHtml(labels.week)} · Month: ${escapeHtml(labels.month)}</i>`,
  ];

  if (tasks.length === 0) {
    parts.push("Your lists are empty. Send <code>add …</code> to add a task.");
    return parts.join("\n\n");
  }

  if (doing.length) {
    parts.push(`<b>⏳ Currently working on</b>\n${doing.map((t) => `• ${escapeHtml(t.title)}`).join("\n")}`);
  }
  parts.push(
    `<b>✅ Today's ranked to-do list</b>\n` +
      (today.length ? today.map(line).join("\n") : "<i>Nothing set for today.</i>"),
  );
  if (upNext.length) {
    parts.push(`<b>📅 Up next this week</b>\n${upNext.map(line).join("\n")}`);
  }
  parts.push(`<i>Reply "done with …", "add …", or "what's on today?" anytime.</i>`);
  return parts.join("\n\n");
}

export const HELP_TEXT = [
  "<b>Here's what I understand</b>",
  "• <code>add call the bank</code>, or <code>add finish deck today, rank 1</code>",
  "• <code>done with call the bank</code>",
  "• <code>working on the deck</code> marks a task as in progress",
  "• <code>move the deck to this month</code> or <code>make the deck rank 2</code>",
  "• <code>the deck is due Friday</code> or <code>I'd like to do the deck Wednesday</code>",
  "• <code>what's on today?</code>, <code>what's this week?</code>",
  "• <code>add gym every Mon, Wed and Fri</code> or <code>add pay rent on the 1st of every month</code> repeats a task",
  "• <code>remind me to call the bank at 2pm</code> or <code>remind me in 20 minutes to stretch</code>",
  "• <code>add dentist, category Health</code>, then <code>/health</code> shows that category",
  "• 🎙 Send a voice note and I'll treat it like a text",
  "",
  "<b>Commands</b>",
  "/today /week /month /lists: show your lists",
  "/edit: change a task's rank, days, name, list or category",
  "/repeats: your repeating tasks",
  "/reminders: upcoming reminders",
  "/categories: your categories",
  "/checkin: start the weekly check-in now",
  "/daily: send the morning message now",
  "/review: start the evening check-in now",
  "/cancel: stop a check-in, edit or evening review in progress",
  "",
  "Ranks go from 1 (most important) to 5.",
].join("\n");
