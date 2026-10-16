import {
  addRecurring,
  addTask,
  deleteTask,
  getState,
  listRecurring,
  openTasksFromRecurring,
  type Recurring,
  setState,
} from "./db";
import type { Env, Task } from "./env";
import { escapeHtml } from "./format";
import { daysInMonth, weekdayIndex } from "./time";

/**
 * Repeating tasks ("gym every Mon/Wed/Fri", "pay rent on the 1st").
 * A rule is stored once. On each day it matches, a normal task is created for
 * that day, so it shows up in the morning message and the evening check-in.
 * If yesterday's copy was never finished, today's copy replaces it instead of
 * piling up.
 */

export type RepeatRule = { kind: "daily" } | { kind: "weekly"; days: number[] } | { kind: "monthly"; day: number };

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function encodeRule(rule: RepeatRule): string {
  if (rule.kind === "daily") return "daily";
  if (rule.kind === "weekly") return `weekly:${[...rule.days].sort().map((d) => DAY_KEYS[d]).join(",")}`;
  return `monthly:${rule.day}`;
}

export function decodeRule(text: string): RepeatRule | null {
  if (text === "daily") return { kind: "daily" };
  const weekly = text.match(/^weekly:([a-z,]+)$/);
  if (weekly) {
    const days = weekly[1].split(",").map((d) => DAY_KEYS.indexOf(d)).filter((d) => d >= 0);
    return days.length ? { kind: "weekly", days } : null;
  }
  const monthly = text.match(/^monthly:(\d{1,2})$/);
  if (monthly) return { kind: "monthly", day: Number(monthly[1]) };
  return null;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

/** "every day", "every weekday", "every Mon, Wed, Fri", "on the 1st of each month" */
export function describeRule(rule: RepeatRule): string {
  if (rule.kind === "daily") return "every day";
  if (rule.kind === "monthly") return `on the ${ordinal(rule.day)} of each month`;
  const days = [...rule.days].sort();
  if (days.join() === "1,2,3,4,5") return "every weekday";
  if (days.join() === "0,6") return "every weekend day";
  if (days.length === 7) return "every day";
  // Monday first, Sunday last.
  return `every ${days.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_NAMES[d]).join(", ")}`;
}

/** Does the rule fall on this date? The 31st means the last day in shorter months. */
export function ruleMatches(rule: RepeatRule, iso: string): boolean {
  if (rule.kind === "daily") return true;
  if (rule.kind === "weekly") return rule.days.includes(weekdayIndex(iso));
  const day = Number(iso.slice(8, 10));
  return day === Math.min(rule.day, daysInMonth(iso));
}

/** Builds a rule from Claude's fields. */
export function ruleFromFields(days: string[] | null | undefined, monthDay: number | null | undefined): RepeatRule | null {
  if (monthDay != null && monthDay >= 1 && monthDay <= 31) return { kind: "monthly", day: Math.round(monthDay) };
  if (!days || days.length === 0) return null;
  const idx = [...new Set(days.map((d) => DAY_KEYS.indexOf(d.slice(0, 3).toLowerCase())).filter((d) => d >= 0))];
  if (idx.length === 0) return null;
  return idx.length === 7 ? { kind: "daily" } : { kind: "weekly", days: idx };
}

/**
 * Finds a repeat phrase in plain text, for when Claude is unavailable:
 * "every day", "daily", "every weekday", "every Mon and Thu", "every monday",
 * "on the 1st of every month", "monthly on the 15th". Returns the rule and the
 * text with the phrase removed.
 */
export function parseRepeatText(text: string): { rule: RepeatRule; rest: string } | null {
  const clean = (s: string) => s.replace(/\s{2,}/g, " ").replace(/[\s,]+$/, "").trim();
  const patterns: [RegExp, (m: RegExpMatchArray) => RepeatRule | null][] = [
    [/\b(every ?day|daily)\b/i, () => ({ kind: "daily" })],
    [/\bevery weekday\b|\bweekdays\b/i, () => ({ kind: "weekly", days: [1, 2, 3, 4, 5] })],
    [/\bevery weekend\b|\bweekends\b/i, () => ({ kind: "weekly", days: [0, 6] })],
    [
      /\b(?:monthly on the|on the|every month on the)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+of\s+(?:every|each)\s+month)?\b/i,
      (m) => (/month/i.test(m[0]) ? { kind: "monthly", day: Number(m[1]) } : null),
    ],
    [
      /\bevery\s+((?:(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*)(?:\s*(?:,|\/|and|&)\s*(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*)*)\b/i,
      (m) => ruleFromFields(m[1].split(/\s*(?:,|\/|and|&)\s*/i), null),
    ],
  ];
  for (const [re, build] of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const rule = build(m);
    if (rule) return { rule, rest: clean(text.replace(m[0], "")) };
  }
  return null;
}

/** Creates a repeating task. If it falls on today, today's copy is added right away. */
export async function createRepeat(
  env: Env,
  title: string,
  rank: number,
  category: string | null,
  rule: RepeatRule,
  todayIso: string,
): Promise<string> {
  const recurring = await addRecurring(env.DB, title, rank, category, encodeRule(rule));
  let today = "";
  if (ruleMatches(rule, todayIso)) {
    await createCopy(env, recurring, todayIso);
    today = " It's on today's list too.";
  }
  return `🔁 <b>${escapeHtml(recurring.title)}</b> will repeat ${describeRule(rule)} (rank ${recurring.rank}).${today}`;
}

async function createCopy(env: Env, recurring: Recurring, iso: string): Promise<Task | null> {
  const open = await openTasksFromRecurring(env.DB, recurring.id);
  for (const task of open) {
    // An unfinished copy from an earlier day is replaced by today's.
    if (task.preferred_date && task.preferred_date < iso) await deleteTask(env.DB, task.id);
  }
  if (open.some((t) => t.preferred_date === iso)) return null;
  return addTask(env.DB, recurring.title, "week", recurring.rank, {
    preferred_date: iso,
    category: recurring.category,
    recurring_id: recurring.id,
  });
}

/** Runs once per local day, shortly after midnight: adds today's repeating tasks. */
export async function generateRecurring(env: Env, todayIso: string): Promise<number> {
  if ((await getState(env.DB, "last_recurring_date")) === todayIso) return 0;
  let created = 0;
  for (const recurring of await listRecurring(env.DB)) {
    const rule = decodeRule(recurring.rule);
    if (rule && ruleMatches(rule, todayIso) && (await createCopy(env, recurring, todayIso))) created++;
  }
  await setState(env.DB, "last_recurring_date", todayIso);
  return created;
}

/** The /repeats list. */
export function formatRepeats(list: Recurring[]): string {
  if (list.length === 0) {
    return `🔁 <b>Repeating tasks</b>\n<i>None yet.</i> Try <code>add gym every Mon, Wed and Fri</code> or <code>add pay rent on the 1st of every month</code>.`;
  }
  const lines = list.map((r, i) => {
    const rule = decodeRule(r.rule);
    const cat = r.category ? ` · ${escapeHtml(r.category)}` : "";
    return `${i + 1}. ${escapeHtml(r.title)} <i>(${rule ? describeRule(rule) : r.rule} · rank ${r.rank}${cat})</i>`;
  });
  return `🔁 <b>Repeating tasks</b>\n${lines.join("\n")}\n\nTo stop one, text <code>stop repeating …</code>.`;
}
