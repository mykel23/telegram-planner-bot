import { OWNER_KEY } from "./bot";
import { getCheckin, startCheckin } from "./checkin";
import { getEdit } from "./edit";
import { keyboardFor } from "./keyboard";
import { generateRecurring } from "./recurring";
import { sendDueReminders } from "./reminders";
import { startReview } from "./review";
import { ensureSchema, getState, logSend, setState } from "./db";
import type { Env } from "./env";
import { speak } from "./settings";
import { renderView } from "./views";
import { BOT_COMMANDS, COMMANDS_VERSION } from "./menu";
import { ALLOWED_UPDATES, getWebhookInfo, sendMessage, setMyCommands, setWebhook } from "./telegram";
import { isDailyDue, isWeeklyDue, localTime } from "./time";

/**
 * Runs every minute from the cron trigger. In the owner's time zone it:
 *   - adds today's repeating tasks (once a day, just after midnight),
 *   - sends reminders whose time has come,
 *   - sends the morning message, the evening check-in and the weekly check-in when due.
 * Each "last sent" date is saved only after Telegram accepts the message,
 * so a failed send is retried on the next run. One failing job never blocks the others.
 */
export async function runSchedule(env: Env, now: Date): Promise<void> {
  await ensureSchema(env.DB);
  const owner = await getState(env.DB, OWNER_KEY);
  if (!owner) return;

  const local = localTime(now, env.TIMEZONE);
  const jobs: [string, () => Promise<void>][] = [
    [
      // Keeps Telegram's Menu button in step with the bot's commands, after any deploy.
      "commands",
      async () => {
        if ((await getState(env.DB, "commands_version")) === COMMANDS_VERSION) return;
        await setMyCommands(env, BOT_COMMANDS);
        // Button taps (✅ tap to finish) only arrive if the webhook asks for them.
        const info = await getWebhookInfo(env);
        if (info.url && !ALLOWED_UPDATES.every((u) => info.allowed_updates?.includes(u))) await setWebhook(env, info.url);
        await setState(env.DB, "commands_version", COMMANDS_VERSION);
      },
    ],
    ["recurring", async () => void (await generateRecurring(env, local.date))],
    ["reminders", () => sendDueReminders(env, owner, now)],
    [
      "daily",
      async () => {
        if (!isDailyDue(local, Number(env.DAILY_HOUR), await getState(env.DB, "last_daily_date"))) return;
        const morning = await renderView(env, "m", now);
        await sendMessage(env, owner, morning.text, morning.inline.length ? { inline: morning.inline } : await keyboardFor(env));
        await setState(env.DB, "last_daily_date", local.date);
        await logSend(env.DB, "daily", local.date);
        if (morning.script) await speak(env, owner, morning.script);
      },
    ],
    [
      // Waits (and retries next run) if a weekly check-in or edit is in progress.
      "evening",
      async () => {
        if (!isDailyDue(local, Number(env.EVENING_HOUR), await getState(env.DB, "last_evening_date"))) return;
        if ((await getCheckin(env)) || (await getEdit(env))) return;
        const text = await startReview(env, now);
        await sendMessage(env, owner, text, await keyboardFor(env));
        await setState(env.DB, "last_evening_date", local.date);
        await logSend(env.DB, "evening", local.date);
      },
    ],
    [
      "weekly",
      async () => {
        if (!isWeeklyDue(local, env.WEEKLY_DAY, Number(env.WEEKLY_HOUR), await getState(env.DB, "last_weekly_date"))) {
          return;
        }
        const text = await startCheckin(env);
        await sendMessage(env, owner, text, await keyboardFor(env));
        await setState(env.DB, "last_weekly_date", local.date);
        await logSend(env.DB, "weekly", local.date);
      },
    ],
  ];

  for (const [name, job] of jobs) {
    try {
      await job();
    } catch (err) {
      console.error(`scheduled job "${name}" failed`, err);
    }
  }
}
