import Database from "better-sqlite3";
import fs from "node:fs";
import { runMigrations } from "./migrate.js";
import { logger } from "../logging.js";

export function createDatabase(dbPath: string): Database.Database {
  logger.info("Opening SQLite database");
  const db = new Database(dbPath);

  if (dbPath !== ":memory:") {
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      logger.warn(
        "Unable to apply restrictive permissions to the SQLite database",
      );
    }
  }

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");

  runMigrations(db);
  return db;
}
