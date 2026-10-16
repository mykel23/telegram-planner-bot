import type { Action, Interpretation } from "./claude";
import type { Recurring } from "./db";
import type { Horizon, Task } from "./env";
import { parseRepeatText, type RepeatRule } from "./recurring";
import { parseReminderText } from "./reminders";
import { localTime, type PeriodLabels } from "./time";

/**
 * Rule-based backups for when the Claude API is unreachable.
 * They cover the core commands so "add" and "done" always work.
 */

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Finds the active task whose title best matches the query, or null. */
export function findTask<T extends { id: number; title: string }>(query: string, tasks: T[]): T | null {
  const q = normalize(query);
  if (!q) return null;

  const idMatch = q.match(/^#?(\d+)$/);
  if (idMatch) return tasks.find((t) => t.id === Number(idMatch[1])) ?? null;

  const exact = tasks.find((t) => normalize(t.title) === q);
  if (exact) return exact;

  const qWords = new Set(q.split(" "));
  let best: T | null = null;
  let bestScore = 0;
  for (const task of tasks) {
    const title = normalize(task.title);
    if (title.includes(q) || q.includes(title)) return task;
    const words = title.split(" ");
    const overlap = words.filter((w) => qWords.has(w)).length;
    const score = overlap / Math.max(words.length, qWords.size);
    if (score > bestScore) {
      bestScore = score;
      best = task;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

function horizonFromText(text: string): Horizon | null {
  const t = text.toLowerCase();
  if (/\btoday\b|\btonight\b/.test(t)) return "day";
  if (/\bthis month\b|\bmonth\b/.test(t)) return "month";
  if (/\bthis week\b|\bweek\b/.test(t)) return "week";
  return null;
}

function action(partial: Partial<Action> & Pick<Action, "type">): Action {
  return {
    task_id: null,
    title: null,
    horizon: null,
    rank: null,
    preferred_date: null,
    due_date: null,
    category: null,
    repeat_days: null,
    repeat_month_day: null,
    remind_at: null,
    ...partial,
  };
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function repeatFields(rule: RepeatRule): Pick<Action, "repeat_days" | "repeat_month_day"> {
  if (rule.kind === "monthly") return { repeat_days: null, repeat_month_day: rule.day };
  const days = rule.kind === "daily" ? [0, 1, 2, 3, 4, 5, 6] : rule.days;
  return { repeat_days: days.map((d) => DAY_KEYS[d]), repeat_month_day: null };
}

/** "2026-10-16 14:00" in the given time zone. */
export function localStamp(when: Date, timeZone: string): string {
  const { date } = localTime(when, timeZone);
  const clock = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(when);
  return `${date} ${clock}`;
}

export interface RuleContext {
  recurring?: Recurring[];
  now?: Date;
  timeZone?: string;
}

export function interpretWithRules(text: string, tasks: Task[], ctx: RuleContext = {}): Interpretation {
  const trimmed = text.trim();

  if (/^remind me\b/i.test(trimmed)) {
    const reminder = ctx.now && ctx.timeZone ? parseReminderText(trimmed, ctx.now, ctx.timeZone) : null;
    return reminder
      ? { actions: [action({ type: "remind", title: reminder.text, remind_at: localStamp(reminder.at, ctx.timeZone!) })], reply: "" }
      : { actions: [], reply: `I couldn't work out the time. Try "remind me to call the bank at 2pm".` };
  }

  const stop = trimmed.match(/^(?:stop repeating|stop|no more)\s+(.+)$/i);
  if (stop && ctx.recurring?.length) {
    const rec = findTask(stop[1], ctx.recurring);
    if (rec) return { actions: [action({ type: "stop_repeat", task_id: rec.id })], reply: "" };
  }

  const add = trimmed.match(/^(?:add|todo|new task)[:\s]+(.+)$/i);
  if (add) {
    let title = add[1];
    const horizon = horizonFromText(title);
    const rankMatch = title.match(/,?\s*rank\s*([1-5])\b/i);
    const rank = rankMatch ? Number(rankMatch[1]) : null;
    title = title.replace(/,?\s*rank\s*[1-5]\b/i, "").trim();
    const repeat = parseRepeatText(title);
    if (repeat) {
      return { actions: [action({ type: "repeat", title: repeat.rest, rank, ...repeatFields(repeat.rule) })], reply: "" };
    }
    title = title.replace(/,?\s*\b(today|tonight|this week|this month)\b\s*$/i, "").trim();
    return { actions: [action({ type: "add", title, horizon, rank })], reply: "" };
  }

  const done = trimmed.match(/^(?:done(?: with)?|finished|completed|complete)[:\s]+(.+)$/i);
  if (done) {
    const task = findTask(done[1], tasks);
    return task
      ? { actions: [action({ type: "done", task_id: task.id })], reply: "" }
      : { actions: [], reply: `I couldn't find a task matching "${done[1]}".` };
  }

  const start = trimmed.match(/^(?:working on|start(?:ing)?)[:\s]+(.+)$/i);
  if (start) {
    const task = findTask(start[1], tasks);
    return task
      ? { actions: [action({ type: "start", task_id: task.id })], reply: "" }
      : { actions: [], reply: `I couldn't find a task matching "${start[1]}".` };
  }

  if (/\b(what'?s|show|list|lists)\b/i.test(trimmed)) {
    return { actions: [action({ type: "show", horizon: horizonFromText(trimmed) })], reply: "" };
  }

  return { actions: [], reply: "" };
}

/**
 * Rule-based list building, used if Claude can't plan the week.
 * Dates come first: preferred or due on the planning day goes to today,
 * within the planning week goes to this week, later goes to this month.
 * Without dates: tasks in progress and the top-ranked (rank 1-2, up to 5)
 * go to today, rank 3 to this week, rank 4-5 to this month.
 */
export function planWithRules(tasks: Task[], labels: PeriodLabels): Map<number, Horizon> {
  const result = new Map<number, Horizon>();
  let dayCount = 0;
  for (const task of [...tasks].sort((a, b) => a.rank - b.rank || a.id - b.id)) {
    const date = [task.preferred_date, task.due_date].filter((d): d is string => !!d).sort()[0];
    if (date) {
      const horizon: Horizon = date <= labels.iso.day ? "day" : date <= labels.iso.weekEnd ? "week" : "month";
      result.set(task.id, horizon);
      if (horizon === "day") dayCount++;
      continue;
    }
    if ((task.status === "doing" || task.rank <= 2) && dayCount < 5) {
      result.set(task.id, "day");
      dayCount++;
    } else if (task.rank <= 3) {
      result.set(task.id, "week");
    } else {
      result.set(task.id, "month");
    }
  }
  return result;
}
