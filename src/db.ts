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

const TASK_COLUMNS = "id, title, horizon, rank, status, preferred_date, due_date";

export function clampRank(rank: number | null | undefined, fallback = 3): number {
  if (rank == null || !Number.isFinite(rank)) return fallback;
  return Math.min(5, Math.max(1, Math.round(rank)));
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
  dates: { preferred_date?: string | null; due_date?: string | null } = {},
): Promise<Task> {
  const row = await db
    .prepare(
      `INSERT INTO tasks (title, horizon, rank, preferred_date, due_date) VALUES (?, ?, ?, ?, ?)
       RETURNING ${TASK_COLUMNS}`,
    )
    .bind(title.trim(), horizon, clampRank(rank), dates.preferred_date ?? null, dates.due_date ?? null)
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

export async function logSend(db: D1Database, kind: "daily" | "weekly", localDate: string): Promise<void> {
  await db.prepare(`INSERT INTO sends (kind, local_date) VALUES (?, ?)`).bind(kind, localDate).run();
}

export async function recentSends(db: D1Database, limit = 14) {
  const { results } = await db
    .prepare(`SELECT kind, local_date, sent_at FROM sends ORDER BY id DESC LIMIT ?`)
    .bind(limit)
    .all<{ kind: string; local_date: string; sent_at: string }>();
  return results;
}
