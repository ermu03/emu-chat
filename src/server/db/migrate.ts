import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { logger } from '../logging.js';

export function runMigrations(db: Database.Database, migrationsDir?: string): string[] {
  const dir = migrationsDir || path.resolve(process.cwd(), 'migrations');

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as {
    version: string;
  }[];
  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  if (!fs.existsSync(dir)) {
    logger.warn('Migrations directory not found', { details: { dir } });
    return [];
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const newlyApplied: string[] = [];

  for (const file of files) {
    const version = path.basename(file, '.sql');
    if (!appliedVersions.has(version)) {
      const filePath = path.join(dir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      logger.info(`Applying migration: ${file}`);
      const executeTx = db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime(\'now\'))').run(
          version
        );
      });
      executeTx();
      newlyApplied.push(version);
    }
  }

  return newlyApplied;
}
