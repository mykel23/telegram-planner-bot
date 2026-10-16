import type { Env } from "./env";
import { downloadFile } from "./telegram";

/**
 * Voice notes: Telegram voice messages are downloaded and turned into text with
 * Whisper on Cloudflare Workers AI, then handled like a typed message.
 */

/** Longest voice note the bot will transcribe, in seconds. Keeps cost and wait time low. */
export const MAX_VOICE_SECONDS = 120;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function transcribeVoice(env: Env, fileId: string): Promise<string> {
  const audio = await downloadFile(env, fileId);
  try {
    const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
      audio: toBase64(audio),
      task: "transcribe",
      language: "en",
      vad_filter: true,
      initial_prompt: "A message to a personal planner bot about tasks, reminders and plans.",
    });
    return (result.text ?? "").trim();
  } catch (err) {
    // The original Whisper model takes raw bytes; try it before giving up.
    console.error("whisper-large-v3-turbo failed, trying whisper", err);
    const result = await env.AI.run("@cf/openai/whisper", { audio: [...new Uint8Array(audio)] });
    return (result.text ?? "").trim();
  }
}
