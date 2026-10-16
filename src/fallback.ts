import type { Action, Interpretation } from "./claude";
import type { Horizon, Task } from "./env";

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
export function findTask(query: string, tasks: Task[]): Task | null {
  const q = normalize(query);
  if (!q) return null;

  const idMatch = q.match(/^#?(\d+)$/);
  if (idMatch) return tasks.find((t) => t.id === Number(idMatch[1])) ?? null;

  const exact = tasks.find((t) => normalize(t.title) === q);
  if (exact) return exact;

  const qWords = new Set(q.split(" "));
  let best: Task | null = null;
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
  return { task_id: null, title: null, horizon: null, rank: null, ...partial };
}

export function interpretWithRules(text: string, tasks: Task[]): Interpretation {
  const trimmed = text.trim();

  const add = trimmed.match(/^(?:add|todo|new task)[:\s]+(.+)$/i);
  if (add) {
    let title = add[1];
    const horizon = horizonFromText(title);
    const rankMatch = title.match(/,?\s*rank\s*([1-5])\b/i);
    const rank = rankMatch ? Number(rankMatch[1]) : null;
    title = title
      .replace(/,?\s*rank\s*[1-5]\b/i, "")
      .replace(/,?\s*\b(today|tonight|this week|this month)\b\s*$/i, "")
      .trim();
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
 * Rule-based list building, used if Claude can't plan the week:
 * tasks in progress and the top-ranked (rank 1-2, up to 5) go to today,
 * rank 3 goes to this week, rank 4-5 goes to this month.
 */
export function planWithRules(tasks: Task[]): Map<number, Horizon> {
  const result = new Map<number, Horizon>();
  let dayCount = 0;
  for (const task of [...tasks].sort((a, b) => a.rank - b.rank || a.id - b.id)) {
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
