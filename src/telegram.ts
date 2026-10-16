import type { Env } from "./env";

/** The parts of a Telegram update this bot uses. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; first_name?: string };
    text?: string;
  };
}

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

export async function sendMessage(env: Env, chatId: number | string, html: string): Promise<void> {
  const text = html.length > MAX_LENGTH ? html.slice(0, MAX_LENGTH) + "\n…" : html;
  await call(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

export async function setWebhook(env: Env, url: string): Promise<unknown> {
  return call(env, "setWebhook", {
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message"],
  });
}
