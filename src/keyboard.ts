import { getCheckin } from "./checkin";
import { FIELDS, getEdit } from "./edit";
import type { Env } from "./env";
import { getReview } from "./review";
import { MENU_ROWS } from "./menu";
import { CAPACITY, VOICES, cap, getPicker } from "./settings";
import type { Keyboard } from "./telegram";

/**
 * Works out which buttons to show from where the conversation is: the evening
 * check-in, the weekly check-in or an edit. With nothing in progress, the home
 * menu is shown. Every button sends text the bot already understands.
 */

const WEEKDAYS = [
  ["Mon", "Tue", "Wed", "Thu"],
  ["Fri", "Sat", "Sun"],
];
const RANKS = [["1", "2", "3", "4", "5"]];

function numbers(count: number): string[][] {
  const rows: string[][] = [];
  for (let i = 1; i <= count; i++) {
    if ((i - 1) % 5 === 0) rows.push([]);
    rows[rows.length - 1].push(String(i));
  }
  return rows;
}

const CAPACITY_BUTTONS = [[CAPACITY.light.button, CAPACITY.normal.button, CAPACITY.full.button]];

export async function keyboardFor(env: Env): Promise<Keyboard> {
  const picker = await getPicker(env);
  if (picker?.kind === "capacity") return CAPACITY_BUTTONS;
  if (picker?.kind === "voice") {
    const names = VOICES.map((v) => cap(v.id));
    return [names.slice(0, 5), names.slice(5), ["🔇 Off", "✅ Done"]];
  }

  const checkin = await getCheckin(env);
  if (checkin) {
    if (checkin.stage === "capacity") return CAPACITY_BUTTONS;
    if (checkin.stage === "collect") return [["Done"]];
    switch (checkin.step ?? "rank") {
      case "rank":
        return RANKS;
      case "preferred":
        return [...WEEKDAYS, ["End of week", "End of month", "Skip"]];
      case "due": {
        const same = checkin.items[checkin.index]?.preferred_date ? ["Same"] : [];
        return [...WEEKDAYS, [...same, "End of week", "End of month", "Skip"]];
      }
    }
  }

  const edit = await getEdit(env);
  if (edit) {
    if (edit.stage === "pick") return edit.ids.length <= 25 ? numbers(edit.ids.length) : "remove";
    if (edit.stage === "field") {
      const labels = FIELDS.map((f) => f.label);
      return [labels.slice(0, 3), labels.slice(3), ["Done"]];
    }
    switch (edit.field) {
      case "rank":
        return RANKS;
      case "preferred":
      case "due":
        return [["Today", "Tomorrow"], ...WEEKDAYS, ["End of week", "End of month", "None"]];
      case "horizon":
        return [["Day", "Week", "Month"]];
      case "category":
        return [["Work", "Personal", "Health"], ["Home", "Errands", "None"]];
      default:
        return "remove";
    }
  }

  const review = await getReview(env);
  if (review) {
    if (review.stuck?.stage === "choose") return [["✂️ Split", "🗓 Month"], ["🗑 Drop", "👍 Keep"]];
    if (review.stuck?.stage === "split") return "remove";
    return [["✅ Done", "➡️ Tomorrow"], ["🗑 Drop"]];
  }

  if (picker?.kind === "add") return "remove";
  return { menu: MENU_ROWS };
}
