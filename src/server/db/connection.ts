import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';
import { logger } from '../logging.js';

export function createDatabase(dbPath: string): Database.Database {
  logger.info(`Opening SQLite database at: ${dbPath}`);
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  runMigrations(db);
  return db;
}
