import { OWNER_KEY } from "./bot";
import { startCheckin } from "./checkin";
import { ensureSchema, getState, listActiveTasks, logSend, setState } from "./db";
import type { Env } from "./env";
import { formatDailyMessage } from "./format";
import { sendMessage } from "./telegram";
import { friendlyDate, isDailyDue, isWeeklyDue, localTime } from "./time";

/**
 * Runs every hour from the cron trigger. Sends the morning message and starts
 * the weekly check-in when they are due in the owner's time zone.
 * The "last sent" date is saved only after Telegram accepts the message,
 * so a failed send is retried on the next hourly run.
 */
export async function runSchedule(env: Env, now: Date): Promise<void> {
  await ensureSchema(env.DB);
  const owner = await getState(env.DB, OWNER_KEY);
  if (!owner) return;

  const local = localTime(now, env.TIMEZONE);

  const lastDaily = await getState(env.DB, "last_daily_date");
  if (isDailyDue(local, Number(env.DAILY_HOUR), lastDaily)) {
    const tasks = await listActiveTasks(env.DB);
    await sendMessage(env, owner, formatDailyMessage(tasks, friendlyDate(now, env.TIMEZONE)));
    await setState(env.DB, "last_daily_date", local.date);
    await logSend(env.DB, "daily", local.date);
  }

  const lastWeekly = await getState(env.DB, "last_weekly_date");
  if (isWeeklyDue(local, env.WEEKLY_DAY, Number(env.WEEKLY_HOUR), lastWeekly)) {
    await sendMessage(env, owner, await startCheckin(env));
    await setState(env.DB, "last_weekly_date", local.date);
    await logSend(env.DB, "weekly", local.date);
  }
}
