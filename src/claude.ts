import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Recurring, Reminder } from "./db";
import type { Env, Horizon, Task } from "./env";
import type { PeriodLabels } from "./time";

/**
 * Claude does two jobs:
 *  1. interpretMessage: turn a free-form text ("done with the deck") into actions.
 *  2. planHorizons: after the weekly check-in, sort tasks into month, week and day lists.
 * Both use structured outputs, so the reply is always valid JSON the bot can act on.
 * If a call fails, the caller falls back to simple rules, so the bot keeps working.
 */

function client(env: Env): Anthropic {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 20_000 });
}

function taskSnapshot(tasks: Task[]): string {
  if (tasks.length === 0) return "(no active tasks)";
  return tasks
    .map((t) =>
      JSON.stringify({
        id: t.id,
        title: t.title,
        list: t.horizon,
        rank: t.rank,
        status: t.status,
        preferred_date: t.preferred_date,
        due_date: t.due_date,
        category: t.category,
        repeating: t.recurring_id != null,
      }),
    )
    .join("\n");
}

// ---------- 1. Understanding messages ----------

const DAY = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

export const ActionSchema = z.object({
  type: z.enum(["add", "done", "start", "update", "remove", "show", "repeat", "stop_repeat", "remind", "cancel_reminder"]),
  task_id: z
    .number()
    .int()
    .nullable()
    .describe(
      "ID of an existing task (done, start, update, remove), repeating task (stop_repeat) or reminder (cancel_reminder). Otherwise null.",
    ),
  title: z
    .string()
    .nullable()
    .describe("Task title for add or repeat, a new title for update, or what to be reminded about for remind. Otherwise null."),
  horizon: z
    .enum(["day", "week", "month"])
    .nullable()
    .describe("Which list. For show, null means all lists. For add, null means the default (week)."),
  rank: z.number().int().nullable().describe("1 (most important) to 5 (least). Null to keep the default."),
  preferred_date: z
    .string()
    .nullable()
    .describe("YYYY-MM-DD day the user would like to do it, for add or update. Null to leave unchanged."),
  due_date: z
    .string()
    .nullable()
    .describe("YYYY-MM-DD latest day it can be done, for add or update. Null to leave unchanged."),
  category: z
    .string()
    .nullable()
    .describe("One-word category for add, repeat or update (Work, Personal, Health, Home, Errands, Finance, or the user's own). For show, filters to that category. Null otherwise."),
  repeat_days: z.array(DAY).nullable().describe("For repeat: the weekdays it repeats on. All seven for every day. Null otherwise."),
  repeat_month_day: z.number().int().nullable().describe("For repeat: day of the month (1-31) for monthly repeats. Null otherwise."),
  remind_at: z
    .string()
    .nullable()
    .describe("For remind: local date and time as YYYY-MM-DD HH:MM (24-hour). Null otherwise."),
});

export const InterpretationSchema = z.object({
  actions: z.array(ActionSchema),
  reply: z
    .string()
    .describe("A short, friendly message for the user only when no action applies (a question or chit-chat). Otherwise empty."),
});

export type Action = z.infer<typeof ActionSchema>;
export type Interpretation = z.infer<typeof InterpretationSchema>;

const INTERPRET_SYSTEM = `You are the brain of a personal Telegram planning bot. The user keeps three lists: day (today), week (this week) and month (this month). Every task has a rank from 1 (most important) to 5 (least important) and a status: open, doing (currently working on it) or done.

Turn the user's message into a list of actions:
- add: a new task. Put the task wording in title, cleaned up but in the user's words. Use horizon "day" if they say today/tonight, "month" if they say this month/later/someday, otherwise null. Use rank only if they give one or clearly signal urgency (urgent/asap means 1).
- done: they finished an existing task ("done with X", "finished X", "X is done").
- start: they are now working on an existing task ("working on X", "starting X").
- update: change an existing task's list, rank, title or dates ("move X to this month", "make X rank 1", "rename X to Y", "X is due Friday", "I'd like to do X Wednesday").
- Dates: "due", "by", "deadline" or "latest" mean due_date; "do it on", "I'd like to", "planning to" mean preferred_date. Convert day names to the next such date on or after today, using the calendar you are given. Weeks run Monday to Sunday.
- remove: delete an existing task without completing it ("drop X", "remove X", "never mind X").
- show: they want to see a list ("what's on today?" means horizon day; "this week" means week; "everything" or "my lists" means null). "Show my work tasks" means show with category Work.
- repeat: a task that comes back on a schedule ("gym every Mon, Wed and Fri", "water plants every day", "pay rent on the 1st of every month"). Use repeat_days for weekly or daily repeats and repeat_month_day for monthly ones. Use repeat instead of add whenever the user says every/daily/weekly/monthly.
- stop_repeat: stop a repeating task ("stop repeating gym", "no more daily walks"). Use the ID from the repeating tasks list.
- remind: a reminder at a set time ("remind me to call the bank at 2pm", "remind me in 20 minutes to stretch"). Put what to remind about in title and the local time in remind_at. If no day is given and the time has already passed today, use tomorrow. If the user adds a task with a specific clock time ("call mom tomorrow at 6pm"), return both an add and a remind.
- cancel_reminder: cancel an upcoming reminder. Use the ID from the reminders list.
- Category: for add and repeat, set a category when the task makes it obvious (a work meeting is Work, the gym is Health, groceries are Errands). Reuse the user's existing categories when they fit.

Rules:
- One message can hold several actions, such as "done with A, add B".
- Match existing tasks by meaning against the active task list you are given, and only use IDs from that list. If nothing matches, return no action for it and say so in reply.
- If the message is a question or chat that no action covers, return no actions and answer briefly in reply.
- Keep reply short and plain. Leave it empty when actions cover the message.`;

export interface InterpretContext {
  tasks: Task[];
  recurring: Recurring[];
  reminders: Reminder[];
  /** "Friday, Oct 16" */
  todayLabel: string;
  /** "2:05 PM" */
  clock: string;
  labels: PeriodLabels;
}

export async function interpretMessage(env: Env, text: string, ctx: InterpretContext): Promise<Interpretation> {
  const { tasks, labels } = ctx;
  const repeating = ctx.recurring.length
    ? ctx.recurring.map((r) => JSON.stringify({ id: r.id, title: r.title, rule: r.rule })).join("\n")
    : "(none)";
  const reminders = ctx.reminders.length
    ? ctx.reminders.map((r) => JSON.stringify({ id: r.id, text: r.text, at_utc: r.remind_at })).join("\n")
    : "(none)";
  const response = await client(env).messages.parse({
    model: env.CLAUDE_MODEL,
    max_tokens: 4000,
    system: INTERPRET_SYSTEM,
    output_config: { effort: "low", format: zodOutputFormat(InterpretationSchema) },
    messages: [
      {
        role: "user",
        content:
          `Today is ${ctx.todayLabel} (${labels.iso.day}) and it is ${ctx.clock} local time. ` +
          `This week is ${labels.week} (${labels.iso.weekStart} to ${labels.iso.weekEnd}).\n\n` +
          `Active tasks (JSON lines):\n${taskSnapshot(tasks)}\n\n` +
          `Repeating tasks (JSON lines):\n${repeating}\n\n` +
          `Upcoming reminders (JSON lines):\n${reminders}\n\nUser message:\n${text}`,
      },
    ],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new Error(`Claude returned no usable output (stop_reason: ${response.stop_reason})`);
  }
  return response.parsed_output;
}

// ---------- 2. Building month, week and day lists ----------

export const PlanSchema = z.object({
  assignments: z.array(
    z.object({
      task_id: z.number().int(),
      horizon: z.enum(["day", "week", "month"]),
      category: z
        .string()
        .nullable()
        .describe("For tasks with no category yet: a one-word category when the task makes it obvious. Otherwise null."),
    }),
  ),
  note: z.string().describe("One or two encouraging sentences about the plan for the week. No lists."),
});

export type Plan = z.infer<typeof PlanSchema>;

const PLAN_SYSTEM = `You are a planning assistant. After the user's weekly check-in, sort every active task into exactly one list:
- day: what to focus on first, the next working day. At most 5 tasks. Tasks with status "doing" usually belong here.
- week: what should get done this week.
- month: important but can wait until later this month.

Weeks run Monday 12:00 AM to Sunday 11:59 PM. The check-in usually happens on Sunday evening: in that case "week" means the week starting tomorrow (Monday), and "day" means Monday.

Dates matter most: a task whose preferred_date or due_date is on or before the planning day belongs in day; one whose dates fall in the planning week belongs in week; one whose dates fall later belongs in month. Without dates, use rank as the main signal (1 is most important). Respect a list the user set on purpose unless rank strongly disagrees. Return an assignment for every task ID you are given and no others.

Categories: for each task whose category is null, suggest a one-word category (Work, Personal, Health, Home, Errands, Finance, or one the user already uses) when the task makes it obvious; otherwise null. Leave tasks that already have a category as null.`;

export async function planHorizons(env: Env, tasks: Task[], todayLabel: string, labels: PeriodLabels): Promise<Plan> {
  const response = await client(env).messages.parse({
    model: env.CLAUDE_MODEL,
    max_tokens: 4000,
    system: PLAN_SYSTEM,
    output_config: { effort: "low", format: zodOutputFormat(PlanSchema) },
    messages: [
      {
        role: "user",
        content: `Today is ${todayLabel}. Planning: day = ${labels.day} (${labels.iso.day}), week = ${labels.week} (${labels.iso.weekStart} to ${labels.iso.weekEnd}), month = ${labels.month}.\n\nActive tasks (JSON lines):\n${taskSnapshot(tasks)}`,
      },
    ],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new Error(`Claude returned no usable plan (stop_reason: ${response.stop_reason})`);
  }
  return response.parsed_output;
}

/** Keeps only assignments for real task IDs; anything missing keeps its current list. */
export function sanitizePlan(plan: Plan, tasks: Task[]): Map<number, Horizon> {
  const ids = new Set(tasks.map((t) => t.id));
  const result = new Map<number, Horizon>();
  for (const a of plan.assignments) {
    if (ids.has(a.task_id)) result.set(a.task_id, a.horizon);
  }
  return result;
}

/** Suggested categories for tasks that don't have one yet. */
export function suggestedCategories(plan: Plan, tasks: Task[]): Map<number, string> {
  const uncategorized = new Set(tasks.filter((t) => !t.category).map((t) => t.id));
  const result = new Map<number, string>();
  for (const a of plan.assignments) {
    const c = a.category?.trim();
    if (c && uncategorized.has(a.task_id) && c.length <= 20) result.set(a.task_id, c);
  }
  return result;
}
