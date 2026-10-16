import { clearState, getState, setState } from "./db";
import type { Env } from "./env";
import { escapeHtml } from "./format";
import { sendVoice } from "./telegram";

/**
 * Two personal settings, each with a small picker:
 *   capacity: how much the owner can take on this month (asked at the first
 *             weekly check-in of each month, or anytime with /capacity).
 *   voice:    which voice the bot speaks with, or off (/voice).
 */

// ---------- capacity ----------

export type CapacityLevel = "light" | "normal" | "full";

export const CAPACITY: Record<CapacityLevel, { perDay: number; label: string; button: string }> = {
  light: { perDay: 3, label: "Light: up to 3 tasks a day", button: "😮‍💨 Light" },
  normal: { perDay: 5, label: "Normal: up to 5 tasks a day", button: "🙂 Normal" },
  full: { perDay: 7, label: "Full: up to 7 tasks a day", button: "💪 Full" },
};

export interface Capacity {
  level: CapacityLevel;
  /** The month it was set for, YYYY-MM. */
  month: string;
}

export async function getCapacity(env: Env): Promise<Capacity | null> {
  const raw = await getState(env.DB, "capacity");
  return raw ? (JSON.parse(raw) as Capacity) : null;
}

export async function setCapacity(env: Env, level: CapacityLevel, month: string): Promise<void> {
  await setState(env.DB, "capacity", JSON.stringify({ level, month }));
}

/** Tasks per day to plan for. Normal until the owner says otherwise. */
export async function dayCap(env: Env): Promise<number> {
  return CAPACITY[(await getCapacity(env))?.level ?? "normal"].perDay;
}

function stripButton(text: string): string {
  return text.trim().replace(/^[^\p{L}\p{N}]+/u, "").trim().toLowerCase().replace(/[.!]+$/, "");
}

export function parseCapacity(text: string): CapacityLevel | null {
  const t = stripButton(text);
  if (/^(1|light|lighter|busy|low|not much|less)$/.test(t)) return "light";
  if (/^(2|normal|medium|regular|same|usual)$/.test(t)) return "normal";
  if (/^(3|full|heavy|more|push me|lots|a lot)$/.test(t)) return "full";
  return null;
}

export function capacityQuestion(monthLabel: string, current: Capacity | null): string {
  const now = current ? `\nRight now it's set to <b>${current.level}</b>.` : "";
  return (
    `🧭 <b>Monthly check</b>\n` +
    `With everything going on in your life right now, how much can you realistically take on in ${escapeHtml(monthLabel)}?\n` +
    `• ${CAPACITY.light.label}\n• ${CAPACITY.normal.label}\n• ${CAPACITY.full.label}${now}`
  );
}

export function capacitySaved(level: CapacityLevel): string {
  const extra =
    level === "light"
      ? " I'll keep your days short and push the rest to later. Go easy on yourself."
      : level === "full"
        ? " I'll fill your days a bit more."
        : "";
  return `👍 Got it: <b>${level}</b>, up to ${CAPACITY[level].perDay} tasks a day.${extra}`;
}

// ---------- voice ----------

/**
 * Voices from Cloudflare Workers AI (Deepgram Aura 1 and 2). The provider names
 * them after figures from myth; "about" says what they sound like.
 */
export const VOICES: { id: string; about: string; model: "aura-1" | "aura-2" }[] = [
  { id: "helios", about: "British, male", model: "aura-1" },
  { id: "angus", about: "Irish, male", model: "aura-1" },
  { id: "orpheus", about: "American, male", model: "aura-1" },
  { id: "perseus", about: "American, male", model: "aura-1" },
  { id: "stella", about: "American, female", model: "aura-1" },
  { id: "athena", about: "British, female", model: "aura-1" },
  { id: "draco", about: "male, newer model", model: "aura-2" },
  { id: "pandora", about: "female, newer model", model: "aura-2" },
];

const VOICE_KEY = "voice";

export async function getVoice(env: Env): Promise<string | null> {
  return getState(env.DB, VOICE_KEY);
}

export async function setVoice(env: Env, voice: string | null): Promise<void> {
  if (voice) await setState(env.DB, VOICE_KEY, voice);
  else await clearState(env.DB, VOICE_KEY);
}

export function parseVoice(text: string): string | "off" | null {
  const t = stripButton(text);
  if (/^(off|no voice|text only|none|stop)$/.test(t)) return "off";
  return VOICES.find((v) => t === v.id || t.startsWith(`${v.id} `))?.id ?? null;
}

export function voiceMenu(current: string | null): string {
  return (
    `🔊 <b>Pick a voice</b>\n` +
    `Tap a name to hear it. I'll use the last one you tap. Tap <b>Off</b> for text only, or <b>Done</b> when you're happy.\n\n` +
    VOICES.map((v) => `• ${cap(v.id)} <i>(${v.about})</i>`).join("\n") +
    `\n\nRight now: <b>${current ? cap(current) : "off"}</b>. With a voice on, I'll speak your morning plan, reminders, and my replies to your voice notes.`
  );
}

export function cap(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Turns a bot message into something pleasant to listen to. */
export function toSpeech(html: string): string {
  return html
    .replace(/<i>\([^<]*\)<\/i>/g, "") // "(rank 2 · do Wed 10/21)" details
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, " and ")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\b(\d{1,2})\/(\d{1,2})\b/g, (_, m, d) => `${MONTHS[Number(m) - 1] ?? m} ${d}`)
    .replace(/^\s*\d+\.\s*/gm, "")
    .replace(/^\s*•\s*/gm, "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[.!?:]$/.test(l) ? l : `${l}.`))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .slice(0, 1500);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

async function audioBytes(result: unknown): Promise<Uint8Array> {
  if (result instanceof Uint8Array) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (result instanceof ReadableStream) return new Uint8Array(await new Response(result).arrayBuffer());
  if (typeof result === "string") return Uint8Array.from(atob(result), (c) => c.charCodeAt(0));
  if (result && typeof result === "object" && "audio" in result) return audioBytes((result as { audio: unknown }).audio);
  throw new Error(`Unexpected text-to-speech output: ${typeof result}`);
}

/** Speech in the chosen voice, as MP3 (clearer than low-bitrate Opus; Telegram plays it as a voice note). */
export async function synthesize(env: Env, text: string, speaker: string): Promise<{ audio: Uint8Array; filename: string }> {
  const model = VOICES.find((v) => v.id === speaker)?.model ?? "aura-2";
  // The speaker is checked against VOICES by parseVoice; the casts keep each model's strict type happy.
  const out =
    model === "aura-1"
      ? await env.AI.run("@cf/deepgram/aura-1", { text, speaker: speaker as "helios", encoding: "mp3" })
      : await env.AI.run("@cf/deepgram/aura-2-en", { text, speaker: speaker as "draco", encoding: "mp3" });
  return { audio: await audioBytes(out), filename: "voice.mp3" };
}

/** Sends a spoken version of a message if a voice is on. Never throws: the text already went out. */
export async function speak(env: Env, chatId: number | string, text: string, speaker?: string | null): Promise<void> {
  const voice = speaker === undefined ? await getVoice(env) : speaker;
  if (!voice || !text.trim()) return;
  try {
    const { audio, filename } = await synthesize(env, text, voice);
    await sendVoice(env, chatId, audio, filename);
  } catch (err) {
    console.error("speak failed", err);
  }
}

// ---------- the pickers ----------

export interface Picker {
  /**
   * "add": the next message is a task to add.
   * "grocery_items" / "grocery_store": adding to the grocery list.
   * "weather_city": the next message (or shared location) is the weather city.
   */
  kind: "voice" | "capacity" | "add" | "grocery_items" | "grocery_store" | "grocery_zip" | "weather_city";
}

export async function getPicker(env: Env): Promise<Picker | null> {
  const raw = await getState(env.DB, "picker");
  return raw ? (JSON.parse(raw) as Picker) : null;
}

export async function startPicker(env: Env, kind: Picker["kind"]): Promise<void> {
  await setState(env.DB, "picker", JSON.stringify({ kind }));
}

export async function cancelPicker(env: Env): Promise<void> {
  await clearState(env.DB, "picker");
}

/** Handles a reply while a picker is open. Voice samples are sent straight to the chat. */
export async function handlePickerReply(
  env: Env,
  chatId: number | string,
  picker: Picker,
  text: string,
  monthIso: string,
): Promise<string> {
  if (picker.kind === "capacity") {
    const level = parseCapacity(text);
    if (!level) return `Please pick <b>Light</b>, <b>Normal</b> or <b>Full</b>, or /cancel.`;
    await setCapacity(env, level, monthIso);
    await cancelPicker(env);
    return capacitySaved(level);
  }

  if (/^(done|ok|okay|that one|perfect|thanks?)$/i.test(stripButton(text))) {
    await cancelPicker(env);
    const voice = await getVoice(env);
    return voice ? `🔊 Voice set to <b>${cap(voice)}</b>.` : `🔇 Voice is off. I'll stick to text.`;
  }
  const choice = parseVoice(text);
  if (!choice) return `Tap one of the names, <b>Off</b>, or <b>Done</b>.`;
  if (choice === "off") {
    await setVoice(env, null);
    await cancelPicker(env);
    return `🔇 Voice is off. I'll stick to text. Send /voice to turn it back on.`;
  }
  await setVoice(env, choice);
  await speak(env, chatId, `Hi, I'm ${cap(choice)}. I'll read you your plan every morning.`, choice);
  return `🔊 That was <b>${cap(choice)}</b>. Tap another name to compare, or <b>Done</b> to keep this one.`;
}
