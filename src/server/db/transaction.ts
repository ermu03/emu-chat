import type Database from "better-sqlite3";

/** Run a synchronous mutation under SQLite's immediate write lock. */
export function withImmediateTransaction<T>(
  db: Database.Database,
  operation: () => T,
): T {
  let began = false;
  let committed = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    began = true;
    const result = operation();
    db.exec("COMMIT");
    committed = true;
    return result;
  } catch (error) {
    if (began && !committed && db.inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the mutation error; SQLite may already have rolled back.
      }
    }
    throw error;
  }
}
