import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Env, Horizon, Task } from "./env";

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
    .map((t) => JSON.stringify({ id: t.id, title: t.title, list: t.horizon, rank: t.rank, status: t.status }))
    .join("\n");
}

// ---------- 1. Understanding messages ----------

export const ActionSchema = z.object({
  type: z.enum(["add", "done", "start", "update", "remove", "show"]),
  task_id: z.number().int().nullable().describe("ID of an existing task. Null for add and show."),
  title: z.string().nullable().describe("Task title for add, or a new title for update. Otherwise null."),
  horizon: z
    .enum(["day", "week", "month"])
    .nullable()
    .describe("Which list. For show, null means all lists. For add, null means the default (week)."),
  rank: z.number().int().nullable().describe("1 (most important) to 5 (least). Null to keep the default."),
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
- update: change an existing task's list, rank or title ("move X to this month", "make X rank 1", "rename X to Y").
- remove: delete an existing task without completing it ("drop X", "remove X", "never mind X").
- show: they want to see a list ("what's on today?" means horizon day; "this week" means week; "everything" or "my lists" means null).

Rules:
- One message can hold several actions, such as "done with A, add B".
- Match existing tasks by meaning against the active task list you are given, and only use IDs from that list. If nothing matches, return no action for it and say so in reply.
- If the message is a question or chat that no action covers, return no actions and answer briefly in reply.
- Keep reply short and plain. Leave it empty when actions cover the message.`;

export async function interpretMessage(env: Env, text: string, tasks: Task[]): Promise<Interpretation> {
  const response = await client(env).messages.parse({
    model: env.CLAUDE_MODEL,
    max_tokens: 4000,
    system: INTERPRET_SYSTEM,
    output_config: { effort: "low", format: zodOutputFormat(InterpretationSchema) },
    messages: [
      {
        role: "user",
        content: `Active tasks (JSON lines):\n${taskSnapshot(tasks)}\n\nUser message:\n${text}`,
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

Use rank as the main signal (1 is most important). Respect a list the user set on purpose unless rank strongly disagrees. Return an assignment for every task ID you are given and no others.`;

export async function planHorizons(env: Env, tasks: Task[], todayLabel: string): Promise<Plan> {
  const response = await client(env).messages.parse({
    model: env.CLAUDE_MODEL,
    max_tokens: 4000,
    system: PLAN_SYSTEM,
    output_config: { effort: "low", format: zodOutputFormat(PlanSchema) },
    messages: [
      {
        role: "user",
        content: `Today is ${todayLabel}.\n\nActive tasks (JSON lines):\n${taskSnapshot(tasks)}`,
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
