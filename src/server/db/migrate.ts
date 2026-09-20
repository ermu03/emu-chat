import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { logger } from "../logging.js";

export function runMigrations(
  db: Database.Database,
  migrationsDir?: string,
): string[] {
  const dir = migrationsDir || path.resolve(process.cwd(), "migrations");

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
    .all() as {
    version: number;
  }[];
  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  if (!fs.existsSync(dir)) {
    logger.warn("Migrations directory not found", { details: { dir } });
    return [];
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const newlyApplied: string[] = [];

  for (const file of files) {
    const match = file.match(/^(\d+)_(.*)\.sql$/);
    if (!match) continue;
    const version = parseInt(match[1] ?? "", 10);
    const name = match[2] ?? "";
    if (!Number.isFinite(version) || !name) continue;

    if (!appliedVersions.has(version)) {
      const filePath = path.join(dir, file);
      const sql = fs.readFileSync(filePath, "utf-8");

      logger.info(`Applying migration: ${file}`);
      const executeTx = db.transaction(() => {
        db.exec(sql);
        db.prepare(
          "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, datetime('now'))",
        ).run(version, name);
      });
      executeTx();
      newlyApplied.push(file);
    }
  }

  return newlyApplied;
}
