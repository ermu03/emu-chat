import type { AttachmentRef, MediaAsset } from "../../shared/media-schemas.js";
import { ApiClientError } from "../api/client.js";

export interface DraftSnapshot {
  content: string;
  attachments: MediaAsset[];
  revision: number;
}

type SaveDraft = (
  id: string,
  content: string,
  attachments: AttachmentRef[],
  revision: number,
) => Promise<{ revision: number }>;
type DraftState = DraftSnapshot & {
  saveError: string | null;
  busy: boolean;
  conflict: boolean;
  remote: DraftSnapshot | null;
};

export const attachmentRefs = (items: MediaAsset[]): AttachmentRef[] =>
  items.map(({ asset_id, sha256 }) => ({ asset_id, sha256 }));
export const sameDraftInput = (
  left: Pick<DraftSnapshot, "content" | "attachments">,
  right: Pick<DraftSnapshot, "content" | "attachments">,
) =>
  left.content === right.content &&
  JSON.stringify(attachmentRefs(left.attachments)) ===
    JSON.stringify(attachmentRefs(right.attachments));

/** One conversation's input and CAS queue, independent of the composer lifecycle. */
export class DraftSession {
  private value: DraftState;
  private saved: DraftSnapshot;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flight: Promise<void> | null = null;
  private alive = true;
  private saveUnconfirmed = false;

  constructor(
    readonly id: string,
    initial: DraftSnapshot,
    private readonly save: SaveDraft,
    private readonly prune: () => void,
  ) {
    this.saved = initial;
    this.value = {
      ...initial,
      saveError: null,
      busy: false,
      conflict: false,
      remote: null,
    };
  }

  getSnapshot = (): DraftState => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<DraftState>): void {
    if (!this.alive) return;
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener();
  }
  get dirty(): boolean {
    return this.saveUnconfirmed || !sameDraftInput(this.value, this.saved);
  }
  get retained(): boolean {
    return (
      this.dirty ||
      Boolean(this.flight) ||
      this.value.busy ||
      this.listeners.size > 0
    );
  }

  acceptServer(next: DraftSnapshot): void {
    if (
      this.dirty ||
      this.flight ||
      this.value.busy ||
      next.revision < this.value.revision
    )
      return;
    if (
      next.revision === this.value.revision &&
      sameDraftInput(next, this.value)
    )
      return;
    this.saved = next;
    this.update({ ...next, saveError: null, conflict: false, remote: null });
  }
  edit(content: string, attachments = this.value.attachments): void {
    this.update({ content, attachments });
    this.schedule();
  }
  setBusy(busy: boolean): void {
    this.clearTimer();
    this.update({ busy });
    if (!busy && this.dirty && !this.value.saveError) this.schedule();
    this.prune();
  }
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  schedule(): void {
    this.clearTimer();
    if (!this.alive || this.value.busy) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => undefined);
    }, 500);
  }
  leave(): void {
    this.clearTimer();
    if (this.dirty && !this.value.saveError && !this.value.busy)
      void this.flush().catch(() => undefined);
    this.prune();
  }

  async flush(): Promise<void> {
    this.clearTimer();
    if (this.flight) return this.flight;
    if (!this.alive) throw new Error("会话已删除");
    const saving = async () => {
      while (this.alive && this.dirty) {
        const snapshot = this.value;
        this.update({ saveError: null });
        try {
          const result = await this.save(
            this.id,
            snapshot.content,
            attachmentRefs(snapshot.attachments),
            this.saved.revision,
          );
          if (!this.alive) return;
          this.saveUnconfirmed = false;
          this.saved = {
            content: snapshot.content,
            attachments: snapshot.attachments,
            revision: result.revision,
          };
          this.update({
            revision: result.revision,
            conflict: false,
            remote: null,
          });
        } catch (error) {
          this.saveUnconfirmed = true;
          this.update({
            saveError: error instanceof Error ? error.message : "保存失败",
            conflict:
              error instanceof ApiClientError &&
              error.envelope.error.code === "DRAFT_CONFLICT",
          });
          throw error;
        }
      }
    };
    const promise = saving();
    this.flight = promise;
    try {
      await promise;
    } finally {
      if (this.flight === promise) this.flight = null;
      this.clearTimer();
      if (this.alive && this.dirty && !this.value.saveError && !this.value.busy)
        this.schedule();
      this.prune();
    }
    if (!this.alive) throw new Error("会话已删除");
  }

  acknowledgeAction(next: DraftSnapshot, before: DraftSnapshot): void {
    if (!this.alive) return;
    const unchanged = sameDraftInput(this.value, before);
    this.saveUnconfirmed = false;
    this.saved = next;
    this.update({
      ...(unchanged ? next : { revision: next.revision }),
      saveError: null,
      conflict: false,
      remote: null,
    });
  }
  showConflict(remote: DraftSnapshot): void {
    if (!this.value.conflict || remote.revision < this.saved.revision) return;
    this.update({ remote });
  }
  resolveConflict(keepLocal: boolean): void {
    const remote = this.value.remote;
    if (!remote) return;
    this.saveUnconfirmed = false;
    this.saved = remote;
    this.update({
      ...(keepLocal ? { revision: remote.revision } : remote),
      saveError: null,
      conflict: false,
      remote: null,
    });
    if (keepLocal) void this.flush().catch(() => undefined);
    this.prune();
  }
  dispose(): void {
    this.alive = false;
    this.clearTimer();
  }
}

/** Dirty or in-flight inputs never participate in ordinary view-cache eviction. */
export class DraftStore {
  private readonly entries = new Map<string, DraftSession>();
  constructor(private readonly save: SaveDraft) {}
  get(id: string, initial: DraftSnapshot): DraftSession {
    let session = this.entries.get(id);
    if (!session)
      session = new DraftSession(id, initial, this.save, () => this.prune());
    this.entries.delete(id);
    this.entries.set(id, session);
    return session;
  }
  has(id: string): boolean {
    return this.entries.has(id);
  }
  drop(id: string): void {
    this.entries.get(id)?.dispose();
    this.entries.delete(id);
  }
  private prune(): void {
    let clean = [...this.entries.values()].filter(
      (entry) => !entry.retained,
    ).length;
    for (const [id, entry] of this.entries) {
      if (clean <= 12) break;
      if (!entry.retained) {
        entry.dispose();
        this.entries.delete(id);
        clean -= 1;
      }
    }
  }
}
