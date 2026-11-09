import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDirectory } from "./config.js";
import { migrations } from "./migrations.js";

export function openDatabase(databasePath: string, timezone: string): DatabaseSync {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  mkdirSync(dataDirectory, { recursive: true });

  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  for (const migration of migrations) {
    const applied = db.prepare("SELECT 1 FROM migrations WHERE version = ?").get(migration.version);
    if (applied) continue;

    db.exec("BEGIN IMMEDIATE");
    try {
      migration.apply(db);
      db.prepare("INSERT INTO migrations(version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString()
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }

  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('timezone', ?) ON CONFLICT(key) DO NOTHING"
  ).run(timezone);
  return db;
}
