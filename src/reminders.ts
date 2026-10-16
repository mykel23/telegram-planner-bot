import { addReminder, dueReminders, markReminderSent, type Reminder } from "./db";
import type { Env } from "./env";
import { escapeHtml } from "./format";
import { speak } from "./settings";
import { sendMessage } from "./telegram";
import { addDays, friendlyDateTime, localTime, parseDayAnswer, zonedTimeToUtc } from "./time";

/**
 * Reminders at a set time ("remind me to call the bank at 2pm").
 * They are stored in UTC and checked every minute by the cron trigger.
 */

/** Reads "2pm", "2:30 pm", "14:00", "noon", "midnight". */
export function parseClock(text: string): { hour: number; minute: number } | null {
  const t = text.trim().toLowerCase().replace(/\./g, "");
  if (t === "noon") return { hour: 12, minute: 0 };
  if (t === "midnight") return { hour: 0, minute: 0 };
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (minute > 59) return null;
  if (m[3]) {
    if (hour < 1 || hour > 12) return null;
    if (m[3] === "pm" && hour !== 12) hour += 12;
    if (m[3] === "am" && hour === 12) hour = 0;
  } else if (!m[2] || hour > 23) {
    // A bare "2" is too ambiguous; "14:00" is fine.
    return null;
  }
  return { hour, minute };
}

/**
 * Finds a reminder in plain text, for when Claude is unavailable:
 * "remind me to call the bank at 2pm", "remind me at 9:30 tomorrow to send the deck",
 * "remind me in 20 minutes to stretch", "remind me Friday at noon to pay rent".
 */
export function parseReminderText(text: string, now: Date, timeZone: string): { text: string; at: Date } | null {
  const m = text.trim().match(/^remind me\s+(.+)$/i);
  if (!m) return null;
  let rest = m[1];
  let at: Date | null = null;

  const inMatch = rest.match(/\bin\s+(\d+|an?|half an)\s*(minutes?|mins?|hours?|hrs?)\b/i);
  if (inMatch) {
    const n = /^half/i.test(inMatch[1]) ? 30 : /^an?$/i.test(inMatch[1]) ? 1 : Number(inMatch[1]);
    const minutes = /^h/i.test(inMatch[2]) && !/^half/i.test(inMatch[1]) ? n * 60 : n;
    at = new Date(now.getTime() + minutes * 60_000);
    rest = rest.replace(inMatch[0], " ");
  } else {
    const clockMatch = rest.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?|noon|midnight)(?=\s|$|[,.!])/i);
    if (!clockMatch) return null;
    const clock = parseClock(clockMatch[1]);
    if (!clock) return null;
    rest = rest.replace(clockMatch[0], " ");

    const today = localTime(now, timeZone).date;
    let day = today;
    const dayMatch = rest.match(/\b(?:on\s+)?(today|tonight|tomorrow|(?:next\s+)?(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*)\b/i);
    if (dayMatch) {
      const word = dayMatch[1].toLowerCase() === "tonight" ? "today" : dayMatch[1];
      const answer = parseDayAnswer(word, today);
      if (answer.kind === "date") day = answer.date;
      rest = rest.replace(dayMatch[0], " ");
    }
    at = zonedTimeToUtc(day, clock.hour, clock.minute, timeZone);
    // "at 9am" when it's already past 9 means tomorrow.
    if (!dayMatch && at <= now) at = zonedTimeToUtc(addDays(day, 1), clock.hour, clock.minute, timeZone);
  }

  const what = rest
    .replace(/^\s*(to|that|about)\s+/i, "")
    .replace(/\s+(to|that|about)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,]+|[\s,.!]+$/g, "")
    .replace(/^(to|that|about)\s+/i, "");
  if (!what) return null;
  return { text: what, at };
}

/** Saves a reminder and returns the confirmation. */
export async function createReminder(env: Env, text: string, at: Date, now: Date = new Date()): Promise<string> {
  if (at.getTime() < now.getTime() - 60_000) return `That time has already passed. Try a later time.`;
  const reminder = await addReminder(env.DB, text, at);
  return `⏰ I'll remind you to <b>${escapeHtml(reminder.text)}</b> on ${friendlyDateTime(at, env.TIMEZONE)}.`;
}

export function formatReminders(list: Reminder[], timeZone: string): string {
  if (list.length === 0) {
    return `⏰ <b>Reminders</b>\n<i>None set.</i> Try <code>remind me to call the bank at 2pm</code>.`;
  }
  const lines = list.map(
    (r, i) => `${i + 1}. ${escapeHtml(r.text)} <i>(${friendlyDateTime(new Date(r.remind_at), timeZone)})</i>`,
  );
  return `⏰ <b>Reminders</b>\n${lines.join("\n")}\n\nTo cancel one, text <code>cancel the reminder to …</code>.`;
}

/** Sends every reminder whose time has come. A failed send is retried next minute. */
export async function sendDueReminders(env: Env, owner: string, now: Date): Promise<void> {
  for (const reminder of await dueReminders(env.DB, now)) {
    const lateMinutes = Math.round((now.getTime() - new Date(reminder.remind_at).getTime()) / 60_000);
    const late = lateMinutes > 10 ? `\n<i>(This was due ${friendlyDateTime(new Date(reminder.remind_at), env.TIMEZONE)}.)</i>` : "";
    await sendMessage(env, owner, `⏰ <b>Reminder:</b> ${escapeHtml(reminder.text)}${late}`);
    await markReminderSent(env.DB, reminder.id);
    await speak(env, owner, `Reminder: ${reminder.text}.`);
  }
}
