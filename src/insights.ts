import type { TaskEvent } from "./db";
import { escapeHtml } from "./format";
import { addDays, weekdayIndex } from "./time";

/**
 * Learning the owner's patterns from what actually happens to tasks:
 * every "done", "pushed to later" and "dropped" is logged with its day and
 * category. From the last four weeks the bot works out how much really gets
 * done per day, which weekdays are strong or weak, and what keeps slipping.
 * The summary goes into Claude's planning prompt, /insights and the weekly scorecard.
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Four weeks back. */
export const LOOKBACK_DAYS = 28;
/** Below this many events, patterns would be guesses. */
export const MIN_EVENTS = 8;

export interface Insights {
  events: number;
  done: number;
  pushed: number;
  dropped: number;
  /** Days with any activity. */
  activeDays: number;
  /** Average tasks finished on an active day. */
  donePerDay: number;
  /** Share of answered tasks that got done, 0-1. */
  completionRate: number;
  bestDay: string | null;
  weakDay: string | null;
  /** Categories pushed back most, most first. */
  slippingCategories: string[];
  /** Tasks pushed back most often, most first. */
  slippingTasks: string[];
}

function top(counts: Map<string, number>, min: number, limit: number): string[] {
  return [...counts.entries()]
    .filter(([, n]) => n >= min)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

export function computeInsights(events: TaskEvent[]): Insights {
  const done = events.filter((e) => e.kind === "done");
  const pushed = events.filter((e) => e.kind === "pushed");
  const activeDays = new Set(events.map((e) => e.local_date)).size;

  // Per weekday: share of answered tasks that got done.
  const byDay = Array.from({ length: 7 }, () => ({ done: 0, total: 0 }));
  for (const e of events) {
    if (e.kind === "dropped") continue;
    const d = byDay[weekdayIndex(e.local_date)];
    d.total++;
    if (e.kind === "done") d.done++;
  }
  const rated = byDay
    .map((d, i) => ({ day: DAY_NAMES[i], rate: d.total ? d.done / d.total : 0, total: d.total }))
    .filter((d) => d.total >= 3);
  rated.sort((a, b) => b.rate - a.rate);
  const bestDay = rated.length >= 2 ? rated[0].day : null;
  const weakDay = rated.length >= 2 && rated[rated.length - 1].rate < rated[0].rate - 0.2 ? rated[rated.length - 1].day : null;

  const catCounts = new Map<string, number>();
  const taskCounts = new Map<string, number>();
  for (const e of pushed) {
    if (e.category) catCounts.set(e.category, (catCounts.get(e.category) ?? 0) + 1);
    taskCounts.set(e.title, (taskCounts.get(e.title) ?? 0) + 1);
  }

  return {
    events: events.length,
    done: done.length,
    pushed: pushed.length,
    dropped: events.length - done.length - pushed.length,
    activeDays,
    donePerDay: activeDays ? done.length / activeDays : 0,
    completionRate: done.length + pushed.length ? done.length / (done.length + pushed.length) : 0,
    bestDay,
    weakDay,
    slippingCategories: top(catCounts, 3, 2),
    slippingTasks: top(taskCounts, 2, 3),
  };
}

export function lookbackStart(todayIso: string): string {
  return addDays(todayIso, -LOOKBACK_DAYS);
}

/** Plain-text summary for Claude's planning prompt, or "" when there isn't enough history yet. */
export function patternSummary(i: Insights): string {
  if (i.events < MIN_EVENTS) return "";
  const lines = [
    `Over the last 4 weeks the user finished about ${i.donePerDay.toFixed(1)} tasks per active day and completed ${Math.round(i.completionRate * 100)}% of tasks they planned.`,
  ];
  if (i.bestDay) lines.push(`Strongest day: ${i.bestDay}.`);
  if (i.weakDay) lines.push(`Weakest day: ${i.weakDay}; plan lighter then.`);
  if (i.slippingCategories.length) lines.push(`Tasks that often slip: ${i.slippingCategories.join(", ")}.`);
  if (i.slippingTasks.length) lines.push(`Repeatedly pushed back: ${i.slippingTasks.join("; ")}.`);
  return lines.join(" ");
}

/** The /insights message. */
export function formatInsights(i: Insights): string {
  if (i.events < MIN_EVENTS) {
    return (
      `🧠 <b>What I've learned</b>\n<i>Still learning.</i> I learn from your evening check-ins and the tasks you finish. ` +
      `After about a week I'll know how much you usually get done and which days work best for you.`
    );
  }
  const lines = [
    `🧠 <b>What I've learned</b> <i>(last 4 weeks)</i>`,
    `• You finish about <b>${i.donePerDay.toFixed(1)}</b> tasks on a typical day.`,
    `• You complete <b>${Math.round(i.completionRate * 100)}%</b> of what you plan.`,
  ];
  if (i.bestDay) lines.push(`• Your strongest day is <b>${i.bestDay}</b>.`);
  if (i.weakDay) lines.push(`• <b>${i.weakDay}</b> is usually tougher, so I plan lighter then.`);
  if (i.slippingCategories.length) {
    lines.push(`• ${i.slippingCategories.map(escapeHtml).join(" and ")} tasks slip the most.`);
  }
  if (i.slippingTasks.length) {
    lines.push(`• Keeps getting pushed: ${i.slippingTasks.map((t) => `<b>${escapeHtml(t)}</b>`).join(", ")}.`);
  }
  return lines.join("\n");
}

/** One line for the start of the weekly check-in, about the last 7 days. */
export function weeklyScorecard(events: TaskEvent[]): string {
  if (events.length === 0) return "";
  const done = events.filter((e) => e.kind === "done").length;
  const pushed = events.filter((e) => e.kind === "pushed").length;
  const dropped = events.filter((e) => e.kind === "dropped").length;
  const rate = done + pushed ? Math.round((done / (done + pushed)) * 100) : 0;
  const cheer = rate >= 80 ? " Strong week! 💪" : rate >= 50 ? " Solid." : " Busy week. Let's plan lighter.";
  return `📊 <b>Last week:</b> ✅ ${done} done · ➡️ ${pushed} pushed · 🗑 ${dropped} dropped (${rate}% done).${cheer}`;
}
