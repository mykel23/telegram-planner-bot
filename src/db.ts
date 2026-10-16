import type { Horizon, Status, Task } from "./env";

/**
 * Tables are created on first use, so a fresh D1 database needs no manual
 * migration step. CREATE TABLE IF NOT EXISTS is safe to run every time.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    horizon TEXT NOT NULL DEFAULT 'week' CHECK (horizon IN ('day', 'week', 'month')),
    rank INTEGER NOT NULL DEFAULT 3 CHECK (rank BETWEEN 1 AND 5),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'doing', 'done')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    done_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS recurring (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    rank INTEGER NOT NULL DEFAULT 3,
    category TEXT,
    rule TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    remind_at TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    category TEXT,
    local_date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS groceries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item TEXT NOT NULL,
    store TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    local_date TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

/** Columns added after the first release. Added in place, so existing tasks are kept. */
const ADDED_TASK_COLUMNS: Record<string, string> = {
  preferred_date: "TEXT",
  due_date: "TEXT",
  category: "TEXT",
  rollovers: "INTEGER NOT NULL DEFAULT 0",
  recurring_id: "INTEGER",
};

let schemaReady = false;

export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  const { results } = await db.prepare(`SELECT name FROM pragma_table_info('tasks')`).all<{ name: string }>();
  const existing = new Set(results.map((r) => r.name));
  for (const [column, type] of Object.entries(ADDED_TASK_COLUMNS)) {
    if (!existing.has(column)) await db.prepare(`ALTER TABLE tasks ADD COLUMN ${column} ${type}`).run();
  }
  schemaReady = true;
}

const TASK_COLUMNS = "id, title, horizon, rank, status, preferred_date, due_date, category, rollovers, recurring_id";

export function clampRank(rank: number | null | undefined, fallback = 3): number {
  if (rank == null || !Number.isFinite(rank)) return fallback;
  return Math.min(5, Math.max(1, Math.round(rank)));
}

/** "work" and "WORK" become "Work"; blank becomes null. */
export function normalizeCategory(category: string | null | undefined): string | null {
  const c = category?.trim().replace(/^#/, "");
  if (!c) return null;
  return c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
}

// ---------- tasks ----------

/** All tasks that are not done, most important first. */
export async function listActiveTasks(db: D1Database): Promise<Task[]> {
  const { results } = await db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE status != 'done'
       ORDER BY rank ASC, id ASC`,
    )
    .all<Task>();
  return results;
}

export async function getTask(db: D1Database, id: number): Promise<Task | null> {
  return db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).bind(id).first<Task>();
}

export async function addTask(
  db: D1Database,
  title: string,
  horizon: Horizon,
  rank: number,
  extra: {
    preferred_date?: string | null;
    due_date?: string | null;
    category?: string | null;
    recurring_id?: number | null;
  } = {},
): Promise<Task> {
  const row = await db
    .prepare(
      `INSERT INTO tasks (title, horizon, rank, preferred_date, due_date, category, recurring_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING ${TASK_COLUMNS}`,
    )
    .bind(
      title.trim(),
      horizon,
      clampRank(rank),
      extra.preferred_date ?? null,
      extra.due_date ?? null,
      normalizeCategory(extra.category),
      extra.recurring_id ?? null,
    )
    .first<Task>();
  if (!row) throw new Error("Insert returned no row");
  return row;
}

export async function updateTask(
  db: D1Database,
  id: number,
  fields: {
    title?: string;
    horizon?: Horizon;
    rank?: number;
    status?: Status;
    preferred_date?: string | null;
    due_date?: string | null;
    category?: string | null;
    rollovers?: number;
  },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (fields.title) {
    sets.push("title = ?");
    values.push(fields.title.trim());
  }
  if (fields.horizon) {
    sets.push("horizon = ?");
    values.push(fields.horizon);
  }
  if (fields.rank != null) {
    sets.push("rank = ?");
    values.push(clampRank(fields.rank));
  }
  if (fields.preferred_date !== undefined) {
    sets.push("preferred_date = ?");
    values.push(fields.preferred_date);
  }
  if (fields.due_date !== undefined) {
    sets.push("due_date = ?");
    values.push(fields.due_date);
  }
  if (fields.category !== undefined) {
    sets.push("category = ?");
    values.push(normalizeCategory(fields.category));
  }
  if (fields.rollovers != null) {
    sets.push("rollovers = ?");
    values.push(fields.rollovers);
  }
  if (fields.status) {
    sets.push("status = ?");
    values.push(fields.status);
    sets.push(fields.status === "done" ? "done_at = datetime('now')" : "done_at = NULL");
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  await db
    .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values, id)
    .run();
}

export async function deleteTask(db: D1Database, id: number): Promise<void> {
  await db.prepare(`DELETE FROM tasks WHERE id = ?`).bind(id).run();
}

/** Distinct categories in use on active tasks, alphabetical. */
export async function listCategories(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT DISTINCT category FROM tasks WHERE status != 'done' AND category IS NOT NULL ORDER BY category`)
    .all<{ category: string }>();
  return results.map((r) => r.category);
}

/** Open copies of a repeating task, so a missed one can be replaced by the next. */
export async function openTasksFromRecurring(db: D1Database, recurringId: number): Promise<Task[]> {
  const { results } = await db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE recurring_id = ? AND status != 'done'`)
    .bind(recurringId)
    .all<Task>();
  return results;
}

// ---------- repeating tasks ----------

export interface Recurring {
  id: number;
  title: string;
  rank: number;
  category: string | null;
  /** "daily", "weekly:mon,wed,fri" or "monthly:1". */
  rule: string;
}

export async function listRecurring(db: D1Database): Promise<Recurring[]> {
  const { results } = await db
    .prepare(`SELECT id, title, rank, category, rule FROM recurring ORDER BY id`)
    .all<Recurring>();
  return results;
}

export async function addRecurring(
  db: D1Database,
  title: string,
  rank: number,
  category: string | null,
  rule: string,
): Promise<Recurring> {
  const row = await db
    .prepare(`INSERT INTO recurring (title, rank, category, rule) VALUES (?, ?, ?, ?) RETURNING id, title, rank, category, rule`)
    .bind(title.trim(), clampRank(rank), normalizeCategory(category), rule)
    .first<Recurring>();
  if (!row) throw new Error("Insert returned no row");
  return row;
}

export async function deleteRecurring(db: D1Database, id: number): Promise<void> {
  await db.prepare(`DELETE FROM recurring WHERE id = ?`).bind(id).run();
}

// ---------- reminders ----------

export interface Reminder {
  id: number;
  text: string;
  /** UTC time, ISO 8601. */
  remind_at: string;
}

export async function addReminder(db: D1Database, text: string, remindAt: Date): Promise<Reminder> {
  const row = await db
    .prepare(`INSERT INTO reminders (text, remind_at) VALUES (?, ?) RETURNING id, text, remind_at`)
    .bind(text.trim(), remindAt.toISOString())
    .first<Reminder>();
  if (!row) throw new Error("Insert returned no row");
  return row;
}

export async function listUpcomingReminders(db: D1Database): Promise<Reminder[]> {
  const { results } = await db
    .prepare(`SELECT id, text, remind_at FROM reminders WHERE sent = 0 ORDER BY remind_at`)
    .all<Reminder>();
  return results;
}

/** Reminders whose time has come. ISO strings in UTC sort in time order. */
export async function dueReminders(db: D1Database, now: Date): Promise<Reminder[]> {
  const { results } = await db
    .prepare(`SELECT id, text, remind_at FROM reminders WHERE sent = 0 AND remind_at <= ? ORDER BY remind_at`)
    .bind(now.toISOString())
    .all<Reminder>();
  return results;
}

export async function markReminderSent(db: D1Database, id: number): Promise<void> {
  await db.prepare(`UPDATE reminders SET sent = 1 WHERE id = ?`).bind(id).run();
}

export async function deleteReminder(db: D1Database, id: number): Promise<void> {
  await db.prepare(`DELETE FROM reminders WHERE id = ?`).bind(id).run();
}

// ---------- things the owner asked the bot to remember ----------

export interface Memory {
  id: number;
  text: string;
}

export async function listMemories(db: D1Database): Promise<Memory[]> {
  const { results } = await db.prepare(`SELECT id, text FROM memories ORDER BY id`).all<Memory>();
  return results;
}

export async function addMemory(db: D1Database, text: string): Promise<Memory> {
  const row = await db
    .prepare(`INSERT INTO memories (text) VALUES (?) RETURNING id, text`)
    .bind(text.trim())
    .first<Memory>();
  if (!row) throw new Error("Insert returned no row");
  return row;
}

export async function deleteMemory(db: D1Database, id: number): Promise<void> {
  await db.prepare(`DELETE FROM memories WHERE id = ?`).bind(id).run();
}

// ---------- history, used to learn the owner's patterns ----------

export type EventKind = "done" | "pushed" | "dropped";

export interface TaskEvent {
  kind: EventKind;
  title: string;
  category: string | null;
  local_date: string;
}

export async function logEvent(db: D1Database, kind: EventKind, task: Pick<Task, "title" | "category">, localDate: string) {
  await db
    .prepare(`INSERT INTO events (kind, title, category, local_date) VALUES (?, ?, ?, ?)`)
    .bind(kind, task.title, task.category ?? null, localDate)
    .run();
}

export async function eventsSince(db: D1Database, fromDate: string): Promise<TaskEvent[]> {
  const { results } = await db
    .prepare(`SELECT kind, title, category, local_date FROM events WHERE local_date >= ? ORDER BY id`)
    .bind(fromDate)
    .all<TaskEvent>();
  return results;
}

// ---------- grocery list ----------

export interface Grocery {
  id: number;
  item: string;
  /** Store name, or null for "any store". */
  store: string | null;
}

export async function listGroceries(db: D1Database): Promise<Grocery[]> {
  const { results } = await db.prepare(`SELECT id, item, store FROM groceries ORDER BY store IS NULL, store, id`).all<Grocery>();
  return results;
}

export async function addGroceries(db: D1Database, items: string[], store: string | null): Promise<void> {
  if (items.length === 0) return;
  await db.batch(items.map((item) => db.prepare(`INSERT INTO groceries (item, store) VALUES (?, ?)`).bind(item.trim(), store)));
}

export async function getGrocery(db: D1Database, id: number): Promise<Grocery | null> {
  return db.prepare(`SELECT id, item, store FROM groceries WHERE id = ?`).bind(id).first<Grocery>();
}

export async function deleteGrocery(db: D1Database, id: number): Promise<void> {
  await db.prepare(`DELETE FROM groceries WHERE id = ?`).bind(id).run();
}

export async function clearGroceries(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM groceries`).run();
}

// ---------- key/value state ----------

export async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM state WHERE key = ?`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(`INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(key, value)
    .run();
}

export async function clearState(db: D1Database, key: string): Promise<void> {
  await db.prepare(`DELETE FROM state WHERE key = ?`).bind(key).run();
}

// ---------- send log (proof that scheduled messages went out) ----------

export async function logSend(db: D1Database, kind: "daily" | "evening" | "weekly", localDate: string): Promise<void> {
  await db.prepare(`INSERT INTO sends (kind, local_date) VALUES (?, ?)`).bind(kind, localDate).run();
}

export async function recentSends(db: D1Database, limit = 14) {
  const { results } = await db
    .prepare(`SELECT kind, local_date, sent_at FROM sends ORDER BY id DESC LIMIT ?`)
    .bind(limit)
    .all<{ kind: string; local_date: string; sent_at: string }>();
  return results;
}
