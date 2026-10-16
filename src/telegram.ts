import type { Env } from "./env";

/** The parts of a Telegram update this bot uses. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; first_name?: string };
    text?: string;
    /** A voice note recorded in Telegram. */
    voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  };
}

/**
 * Buttons shown in place of the phone keyboard. Tapping one sends its text as a
 * normal message, so every button is also something you could type.
 * "remove" hides any buttons left from an earlier question.
 */
export type Keyboard = string[][] | "remove" | { menu: string[][] };

function apiUrl(env: Env, method: string): string {
  const base = env.TELEGRAM_API_BASE || "https://api.telegram.org";
  return `${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function call(env: Env, method: string, body: unknown): Promise<unknown> {
  const res = await fetch(apiUrl(env, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!res.ok || !data?.ok) {
    throw new Error(`Telegram ${method} failed (${res.status}): ${data?.description ?? "no description"}`);
  }
  return data;
}

/** Telegram's limit is 4096 characters per message. */
const MAX_LENGTH = 4000;

export async function sendMessage(env: Env, chatId: number | string, html: string, keyboard?: Keyboard): Promise<void> {
  const text = html.length > MAX_LENGTH ? html.slice(0, MAX_LENGTH) + "\n…" : html;
  await call(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: replyMarkup(keyboard) } : {}),
  });
}

function replyMarkup(keyboard: Keyboard) {
  if (keyboard === "remove") return { remove_keyboard: true };
  // The home menu stays open; question buttons hide after one tap.
  if ("menu" in keyboard) {
    return {
      keyboard: keyboard.menu.map((row) => row.map((text) => ({ text }))),
      resize_keyboard: true,
      is_persistent: true,
      input_field_placeholder: "Type, tap, or send a voice note",
    };
  }
  return {
    keyboard: keyboard.map((row) => row.map((text) => ({ text }))),
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

/** Sends audio as a Telegram voice note (OGG/Opus or MP3). */
export async function sendVoice(env: Env, chatId: number | string, audio: Uint8Array, filename: string, caption?: string) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("voice", new Blob([audio]), filename);
  if (caption) form.append("caption", caption.slice(0, 1000));
  const res = await fetch(apiUrl(env, "sendVoice"), { method: "POST", body: form });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!res.ok || !data?.ok) {
    throw new Error(`Telegram sendVoice failed (${res.status}): ${data?.description ?? "no description"}`);
  }
}

/** Downloads a file someone sent the bot, such as a voice note. Telegram allows up to 20 MB. */
export async function downloadFile(env: Env, fileId: string): Promise<ArrayBuffer> {
  const info = (await call(env, "getFile", { file_id: fileId })) as { result?: { file_path?: string } };
  const path = info.result?.file_path;
  if (!path) throw new Error("Telegram getFile returned no file_path");
  const base = env.TELEGRAM_API_BASE || "https://api.telegram.org";
  const res = await fetch(`${base}/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
  if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
  return res.arrayBuffer();
}

/** The list behind Telegram's "Menu" button next to the message box. */
export async function setMyCommands(env: Env, commands: { command: string; description: string }[]): Promise<void> {
  await call(env, "setMyCommands", { commands });
}

export async function setWebhook(env: Env, url: string): Promise<unknown> {
  return call(env, "setWebhook", {
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message"],
  });
}
