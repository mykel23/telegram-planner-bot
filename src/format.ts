import type { Horizon, Task } from "./env";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const HORIZON_TITLES: Record<Horizon, string> = {
  month: "🗓 This month",
  week: "📅 This week",
  day: "☀️ Today",
};

export function horizonLabel(horizon: Horizon): string {
  return { day: "today", week: "this week", month: "this month" }[horizon];
}

export function formatTaskLine(task: Task, position: number): string {
  const doing = task.status === "doing" ? " ⏳" : "";
  return `${position}. ${escapeHtml(task.title)}${doing} <i>(rank ${task.rank})</i>`;
}

/** Tasks for one horizon, already sorted most important first. */
export function formatList(tasks: Task[], horizon: Horizon): string {
  const items = tasks.filter((t) => t.horizon === horizon);
  const body = items.length ? items.map((t, i) => formatTaskLine(t, i + 1)).join("\n") : "<i>Nothing here yet.</i>";
  return `<b>${HORIZON_TITLES[horizon]}</b>\n${body}`;
}

/** Month, week and day lists together. */
export function formatAllLists(tasks: Task[]): string {
  return (["month", "week", "day"] as Horizon[]).map((h) => formatList(tasks, h)).join("\n\n");
}

export function formatDailyMessage(tasks: Task[], dateLabel: string): string {
  const doing = tasks.filter((t) => t.status === "doing");
  const today = tasks.filter((t) => t.horizon === "day");
  const upNext = tasks.filter((t) => t.horizon === "week" && t.status !== "doing").slice(0, 3);

  const parts = [`☀️ <b>Good morning!</b> Here's your plan for ${escapeHtml(dateLabel)}.`];

  if (tasks.length === 0) {
    parts.push("Your lists are empty. Send <code>add …</code> to add a task.");
    return parts.join("\n\n");
  }

  if (doing.length) {
    parts.push(`<b>⏳ Currently working on</b>\n${doing.map((t) => `• ${escapeHtml(t.title)}`).join("\n")}`);
  }
  parts.push(
    `<b>✅ Today's ranked to-do list</b>\n` +
      (today.length ? today.map((t, i) => formatTaskLine(t, i + 1)).join("\n") : "<i>Nothing set for today.</i>"),
  );
  if (upNext.length) {
    parts.push(`<b>📅 Up next this week</b>\n${upNext.map((t, i) => formatTaskLine(t, i + 1)).join("\n")}`);
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
  "• <code>what's on today?</code>, <code>what's this week?</code>",
  "",
  "<b>Commands</b>",
  "/today /week /month /lists: show your lists",
  "/checkin: start the weekly check-in now",
  "/daily: send the morning message now",
  "/cancel: stop a check-in in progress",
  "",
  "Ranks go from 1 (most important) to 5.",
].join("\n");
