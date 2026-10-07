import type Database from "better-sqlite3";

export class MediaScopeDeferredError extends Error {
  override name = "MediaScopeDeferredError";
}
export class MediaScopeDeletedError extends Error {
  override name = "MediaScopeDeletedError";
}

export function mediaScopeState(
  db: Database.Database,
  scopeId: string,
): "available" | "deferred" | "deleted" {
  const row = db
    .prepare("SELECT delete_state FROM conversations WHERE id=?")
    .get(scopeId) as { delete_state: string } | undefined;
  if (!row) return "deleted";
  return row.delete_state === "none" ? "available" : "deferred";
}

export function requireMediaScope(
  db: Database.Database,
  scopeId: string,
): void {
  const state = mediaScopeState(db, scopeId);
  if (state === "deferred")
    throw new MediaScopeDeferredError(
      "Target conversation deletion is not confirmed",
    );
  if (state === "deleted")
    throw new MediaScopeDeletedError("Target conversation was deleted");
}
