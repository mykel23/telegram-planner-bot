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

/** The tasks one list shows, in the order it shows them. */
export function listTasks(tasks: Task[], horizon: Horizon, labels: PeriodLabels): Task[] {
  return tasks.filter((t) => effectiveHorizon(t, labels) === horizon).sort(byPriority);
}

/** Tasks for one list, most important first. */
export function formatList(tasks: Task[], horizon: Horizon, labels: PeriodLabels): string {
  const items = listTasks(tasks, horizon, labels);
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

/** Today's tasks in order, split at the daily capacity. */
function todaySplit(tasks: Task[], labels: PeriodLabels, dayCap: number) {
  const all = tasks.filter((t) => effectiveHorizon(t, labels) === "day").sort(byPriority);
  return { today: all.slice(0, dayCap), extra: all.slice(dayCap) };
}

export function formatDailyMessage(
  tasks: Task[],
  dateLabel: string,
  labels: PeriodLabels,
  dayCap = Infinity,
  weather = "",
): string {
  const doing = tasks.filter((t) => t.status === "doing");
  const { today, extra } = todaySplit(tasks, labels, dayCap);
  const upNext = tasks
    .filter((t) => effectiveHorizon(t, labels) === "week" && t.status !== "doing")
    .sort(byPriority)
    .slice(0, 3);
  const line = (t: Task, i: number) => formatTaskLine(t, i + 1, labels.iso.day);

  const parts = [
    `☀️ <b>Good morning!</b> Here's your plan for ${escapeHtml(dateLabel)}.\n` +
      `<i>This week: ${escapeHtml(labels.week)} (${escapeHtml(labels.month)})</i>` +
      (weather ? `\n${weather}` : ""),
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
  if (extra.length) {
    parts.push(
      `<b>➕ If you have extra time</b>\n${extra.map((t, i) => formatTaskLine(t, today.length + i + 1, labels.iso.day)).join("\n")}`,
    );
  }
  if (upNext.length) {
    const sunday = labels.week.split(" – ")[1] ?? "Sunday";
    parts.push(`<b>📅 Coming up later this week</b> <i>(through ${escapeHtml(sunday)})</i>\n${upNext.map(line).join("\n")}`);
  }
  parts.push(`<i>Reply "done with …", "add …", or "what's on today?" anytime.</i>`);
  return parts.join("\n\n");
}

/** The morning plan as something to listen to. */
export function morningScript(tasks: Task[], dateLabel: string, labels: PeriodLabels, dayCap = Infinity): string {
  const { today } = todaySplit(tasks, labels, dayCap);
  const doing = tasks.filter((t) => t.status === "doing");
  const lines = [`Good morning. Here's your plan for ${dateLabel}.`];
  if (today.length === 0) {
    lines.push("Nothing is set for today, so it's a good day to get ahead or rest.");
  } else {
    const words = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh"];
    lines.push(`You have ${today.length} ${today.length === 1 ? "thing" : "things"} today.`);
    today.forEach((t, i) => {
      const due = t.due_date === labels.iso.day ? ", which is due today" : t.due_date && t.due_date < labels.iso.day ? ", which is overdue" : "";
      lines.push(`${words[i] ?? "Next"}, ${t.title}${due}.`);
    });
  }
  if (doing.length) lines.push(`You're in the middle of ${doing.map((t) => t.title).join(" and ")}.`);
  lines.push("Have a great day.");
  return lines.join(" ");
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
  "• <code>remember I work night shifts on Tuesdays</code> and I'll plan around it",
  "• Tap ✅ under a list to mark a task done",
  "• <code>add milk and eggs to my grocery list</code>",
  "",
  "<b>Commands</b>",
  "/today /week /month /lists: show your lists",
  "/grocery: your grocery list, by store",
  "/weather: set your city for the morning forecast",
  "/edit: change a task's rank, days, name, list or category",
  "/repeats: your repeating tasks",
  "/reminders: upcoming reminders",
  "/categories: your categories",
  "/insights: what I've learned about how you work",
  "/memory: what I remember about you",
  "/capacity: how much you can take on this month",
  "/voice: pick a voice for spoken replies, or turn it off",
  "/checkin: start the weekly check-in now",
  "/morning: send the good morning message now",
  "/review: start the evening check-in now",
  "/cancel: stop a check-in, edit or evening review in progress",
  "",
  "Ranks go from 1 (most important) to 5.",
].join("\n");
