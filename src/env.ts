/** Everything the Worker receives from Cloudflare: bindings, vars and secrets. */
export interface Env {
  /** D1 database that stores tasks and bot state. */
  DB: D1Database;

  // Secrets (set in the Cloudflare dashboard, never in the repo)
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;

  // Plain settings from wrangler.toml
  TIMEZONE: string;
  DAILY_HOUR: string;
  EVENING_HOUR: string;
  WEEKLY_DAY: string;
  WEEKLY_HOUR: string;
  CLAUDE_MODEL: string;

  /** Optional override, used only for local testing against a fake Telegram server. */
  TELEGRAM_API_BASE?: string;
}

export type Horizon = "day" | "week" | "month";
export type Status = "open" | "doing" | "done";

export interface Task {
  id: number;
  title: string;
  horizon: Horizon;
  /** 1 = most important, 5 = least important. */
  rank: number;
  status: Status;
  /** Day the owner would like to do it, YYYY-MM-DD, or null. */
  preferred_date: string | null;
  /** Latest day it can be done, YYYY-MM-DD, or null. */
  due_date: string | null;
}

export const HORIZONS: Horizon[] = ["month", "week", "day"];
