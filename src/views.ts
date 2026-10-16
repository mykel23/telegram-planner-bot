import { listActiveTasks } from "./db";
import type { Env, Task } from "./env";
import { formatAllLists, formatDailyMessage, formatList, listTasks, morningScript } from "./format";
import { dayCap } from "./settings";
import type { InlineButton } from "./telegram";
import { friendlyDate, periodLabels } from "./time";
import { morningWeather } from "./weather";

/**
 * Task lists with a ✅ button per task ("tap to finish"). Each button carries
 * the task and the view it was shown in, so after a tap the same message is
 * redrawn without that task.
 */

export type View = "t" | "w" | "l" | "m";

export interface ViewReply {
  text: string;
  inline: InlineButton[][];
  /** Spoken version, for the morning message. */
  script?: string;
}

const MAX_BUTTONS = 12;

export function finishButtons(tasks: Task[], view: View): InlineButton[][] {
  return tasks.slice(0, MAX_BUTTONS).map((t) => [{ text: `✅ ${t.title.slice(0, 40)}`, data: `d:${t.id}:${view}` }]);
}

export function isView(v: string): v is View {
  return v === "t" || v === "w" || v === "l" || v === "m";
}

export async function renderView(env: Env, view: View, now: Date = new Date()): Promise<ViewReply> {
  const tasks = await listActiveTasks(env.DB);
  const labels = periodLabels(now, env.TIMEZONE);
  switch (view) {
    case "t":
      return { text: formatList(tasks, "day", labels), inline: finishButtons(listTasks(tasks, "day", labels), view) };
    case "w":
      return { text: formatList(tasks, "week", labels), inline: finishButtons(listTasks(tasks, "week", labels), view) };
    case "l": {
      const shown = (["day", "week", "month"] as const).flatMap((h) => listTasks(tasks, h, labels));
      return { text: formatAllLists(tasks, labels), inline: finishButtons(shown, view) };
    }
    case "m": {
      const [cap, weather] = [await dayCap(env), await morningWeather(env)];
      const dateLabel = friendlyDate(now, env.TIMEZONE);
      return {
        text: formatDailyMessage(tasks, dateLabel, labels, cap, weather),
        inline: finishButtons(listTasks(tasks, "day", labels), view),
        script: morningScript(tasks, dateLabel, labels, cap),
      };
    }
  }
}
