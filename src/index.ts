import { handleUpdate } from "./bot";
import { ensureSchema, recentSends } from "./db";
import type { Env } from "./env";
import { runSchedule } from "./schedule";
import { setWebhook, type TelegramUpdate } from "./telegram";

/** Compares two strings without leaking how much of them matched. */
function secretsMatch(given: string | null, expected: string): boolean {
  if (!given || !expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Telegram delivers every message here. The secret header proves it's really Telegram.
    if (request.method === "POST" && url.pathname === "/telegram") {
      if (!secretsMatch(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response("Forbidden", { status: 403 });
      }
      const update = (await request.json()) as TelegramUpdate;
      // Answer Telegram right away and do the work in the background,
      // so a slow reply never makes Telegram resend the same message.
      ctx.waitUntil(
        ensureSchema(env.DB)
          .then(() => handleUpdate(env, update))
          .catch((err) => console.error("handleUpdate failed", err)),
      );
      return new Response("OK");
    }

    // One-time setup: open https://<your-worker>/setup?key=<TELEGRAM_WEBHOOK_SECRET> in a browser.
    if (url.pathname === "/setup") {
      if (!secretsMatch(url.searchParams.get("key"), env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response("Forbidden: add ?key= with your webhook secret.", { status: 403 });
      }
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response(
          "TELEGRAM_WEBHOOK_SECRET may only use letters, numbers, _ and -. Change it in Cloudflare and try again.",
          { status: 400 },
        );
      }
      await ensureSchema(env.DB);
      const result = await setWebhook(env, `${url.origin}/telegram`);
      return json({ webhook: `${url.origin}/telegram`, telegram: result, next: "Open Telegram and send /start to your bot." });
    }

    // Proof of delivery for the 7-day test: the last scheduled sends, with no task data.
    if (url.pathname === "/status") {
      if (!secretsMatch(url.searchParams.get("key"), env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response("Forbidden", { status: 403 });
      }
      await ensureSchema(env.DB);
      return json({ timezone: env.TIMEZONE, recent_sends: await recentSends(env.DB) });
    }

    if (url.pathname === "/") return new Response("Planner bot is running.");
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runSchedule(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
