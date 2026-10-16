import { getState, listActiveTasks, listUpcomingReminders } from "./db";
import type { Env } from "./env";
import { effectiveHorizon, escapeHtml } from "./format";
import { clockTime, localTime, type PeriodLabels } from "./time";

/**
 * The home menu: buttons that stay at the bottom of the chat whenever nothing
 * else is in progress. Each button stands for a command, so tapping
 * "☀️ Today" is the same as sending /today.
 */

export const MENU: [label: string, command: string][][] = [
  [
    ["☀️ Today", "/today"],
    ["📅 Week", "/week"],
    ["🗂 All lists", "/lists"],
  ],
  [
    ["➕ Add task", "/add"],
    ["✏️ Edit", "/edit"],
    ["🌙 Review day", "/review"],
  ],
  [
    ["⏰ Reminders", "/reminders"],
    ["🔁 Repeats", "/repeats"],
    ["🧠 Insights", "/insights"],
  ],
  [
    ["🔊 Voice", "/voice"],
    ["🧭 Capacity", "/capacity"],
    ["❓ Help", "/help"],
  ],
];

export const MENU_ROWS: string[][] = MENU.map((row) => row.map(([label]) => label));

const BY_LABEL = new Map(MENU.flat().map(([label, command]) => [label, command]));

/** The command for a tapped menu button, or null if the text isn't one. */
export function menuCommand(text: string): string | null {
  return BY_LABEL.get(text.trim()) ?? null;
}

/** "Good evening 👋" plus a one-line status, for /menu and /start. */
export async function menuGreeting(env: Env, labels: PeriodLabels, now: Date = new Date()): Promise<string> {
  const hour = localTime(now, env.TIMEZONE).hour;
  const hello = hour < 5 ? "Hey" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const [tasks, reminders, name] = await Promise.all([
    listActiveTasks(env.DB),
    listUpcomingReminders(env.DB),
    getState(env.DB, "owner_name"),
  ]);
  const today = tasks.filter((t) => effectiveHorizon(t, labels) === "day").length;
  const status = [
    `${today} ${today === 1 ? "task" : "tasks"} today`,
    reminders.length ? `next reminder at ${clockTime(new Date(reminders[0].remind_at), env.TIMEZONE)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const who = name ? `, ${escapeHtml(name)}` : "";
  return `👋 <b>${hello}${who}!</b> ${status}.\nWhat would you like to work on? Tap a button below, type, or send a voice note.`;
}

/** Commands shown in Telegram's Menu button. Bump the version when this list changes. */
export const COMMANDS_VERSION = "2";
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: "menu", description: "Show the menu" },
  { command: "today", description: "Today's list" },
  { command: "week", description: "This week's list" },
  { command: "lists", description: "Month, week and day lists" },
  { command: "edit", description: "Change a task" },
  { command: "review", description: "Evening check-in now" },
  { command: "checkin", description: "Weekly check-in now" },
  { command: "reminders", description: "Upcoming reminders" },
  { command: "repeats", description: "Repeating tasks" },
  { command: "insights", description: "What I've learned about you" },
  { command: "memory", description: "What I remember about you" },
  { command: "capacity", description: "How much you can take on" },
  { command: "voice", description: "Pick a voice" },
  { command: "help", description: "Everything I understand" },
  { command: "cancel", description: "Stop what's in progress" },
];
