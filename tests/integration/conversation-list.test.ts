import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/server/db/migrate.js";
import {
  ConversationRepository,
  DraftRepository,
} from "../../src/server/db/repositories/conversation.repository.js";
import { QueueRepository } from "../../src/server/db/repositories/queue.repository.js";
import { RunRepository } from "../../src/server/db/repositories/run.repository.js";
import { ConversationService } from "../../src/server/services/conversation-service.js";
import { HermesAdapter } from "../../src/server/hermes/adapter.js";
import { HermesClient } from "../../src/server/hermes/client.js";
import { HermesNotFoundError } from "../../src/server/domain/errors.js";
import { SSEHub } from "../../src/server/sse/sse-hub.js";
import type { HermesSessionDetailResponse } from "../../src/shared/hermes-schemas.js";

const now = "2026-10-05T00:00:00.000Z";
function session(id: string): HermesSessionDetailResponse {
  return {
    id,
    title: id,
    pinned: false,
    created_at: now,
    updated_at: now,
    last_active_at: now,
    message_count: 0,
    preview: "",
    parent_session_id: null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("conversation read and cleanup consistency", () => {
  let db: Database.Database;
  let conversations: ConversationRepository;
  let drafts: DraftRepository;
  let runs: RunRepository;
  let hub: SSEHub;
  let adapter: HermesAdapter;
  let service: ConversationService;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    conversations = new ConversationRepository(db);
    drafts = new DraftRepository(db);
    runs = new RunRepository(db);
    hub = new SSEHub();
    adapter = new HermesAdapter(
      new HermesClient({ baseUrl: "http://unused", token: "test" }),
    );
    service = new ConversationService(
      adapter,
      conversations,
      drafts,
      new QueueRepository(db),
      runs,
      hub,
    );
  });
  afterEach(() => {
    hub.close();
    db.close();
    vi.restoreAllMocks();
  });
  const add = (id: string, order: number | null = null) =>
    conversations.insert({
      id,
      hermes_profile: "default",
      hermes_session_id: `session_${id}`,
      created_at: now,
      custom_order: order,
    });

  it("preserves draft, queued work, Run and image references when an old 404 arrives after rollover", async () => {
    const conversation = add("cv_rollover");
    drafts.saveDraft(conversation.id, "unsent draft");
    db.prepare(
      `INSERT INTO queue_items
      (id,conversation_id,operation_id,client_request_id,fifo_seq,state,payload_text,payload_sha256,payload_bytes,idempotency_key,dispatch_session_id,created_at,updated_at)
      VALUES ('qi_saved',?,'op_saved','request-saved',1,'paused','saved task',?,10,'ec_saved','session_old',?,?)`,
    ).run(conversation.id, "a".repeat(64), now, now);
    runs.insert({
      id: "lr_saved",
      queue_item_id: "qi_saved",
      conversation_id: conversation.id,
      local_state: "review_required",
      hermes_run_id: "hermes_saved",
      upstream_status: "interrupted",
    });
    db.prepare(
      `INSERT INTO media_assets
      (conversation_id,asset_id,status,source_json,mime_type,byte_size,width,height,sha256,file_name,created_at,updated_at)
      VALUES (?,'img_saved','ready','{}','image/png',10,1,1,?,'saved.png',?,?)`,
    ).run(conversation.id, "b".repeat(64), now, now);
    const old = deferred<HermesSessionDetailResponse>();
    const read = vi
      .spyOn(adapter, "getSession")
      .mockImplementation(async (id) =>
        id === conversation.hermes_session_id ? old.promise : session(id),
      );
    vi.spyOn(adapter, "getSessionMessages").mockResolvedValue({
      session_id: "session_new",
      messages: [],
      limit: 100,
      offset: 0,
      order: "oldest",
      has_more: false,
    });
    const cleanup = vi.spyOn(hub, "cleanup");
    const listing = service.listConversations();
    await service.getMessages(conversation.id);
    old.reject(new HermesNotFoundError("old segment missing"));
    const result = await listing;
    expect(result.items).toMatchObject([
      {
        conversation_id: conversation.id,
        hermes_session_id: "session_new",
        title: "session_new",
      },
    ]);
    expect(read.mock.calls.map(([id]) => id)).toEqual([
      conversation.hermes_session_id,
      "session_new",
    ]);
    expect(drafts.findByConversationId(conversation.id)?.content).toBe(
      "unsent draft",
    );
    expect(db.prepare("SELECT count(*) AS n FROM queue_items").get()).toEqual({
      n: 1,
    });
    expect(runs.findById("lr_saved")).not.toBeNull();
    expect(db.prepare("SELECT count(*) AS n FROM media_assets").get()).toEqual({
      n: 1,
    });
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM media_outbox WHERE kind='scope_delete'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(cleanup).not.toHaveBeenCalled();

    read.mockRejectedValue(new HermesNotFoundError("current segment missing"));
    conversations.setDeleteState(conversation.id, "pending");
    expect((await service.listConversations()).items).toMatchObject([
      {
        conversation_id: conversation.id,
        delete_state: "pending",
        title: "上游会话不可用",
      },
    ]);
    expect(drafts.findByConversationId(conversation.id)?.content).toBe(
      "unsent draft",
    );
    expect(cleanup).not.toHaveBeenCalled();
    conversations.setDeleteState(conversation.id, "none");
    expect((await service.listConversations()).items).toEqual([]);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith("lr_saved");
    expect(db.prepare("SELECT count(*) AS n FROM media_assets").get()).toEqual({
      n: 0,
    });
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM media_outbox WHERE kind='scope_delete'",
        )
        .get(),
    ).toEqual({ n: 1 });
    await service.listConversations();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("re-reads successful old details after rollover instead of mixing metadata and mappings", async () => {
    const conversation = add("cv_details");
    const old = deferred<HermesSessionDetailResponse>();
    vi.spyOn(adapter, "getSession").mockImplementation(async (id) =>
      id === conversation.hermes_session_id ? old.promise : session(id),
    );
    const reading = service.getConversation(conversation.id);
    conversations.adoptEffectiveHermesSessionId(conversation.id, "session_new");
    old.resolve({
      ...session(conversation.hermes_session_id),
      title: "stale title",
      updated_at: "2020-01-01T00:00:00Z",
    });
    expect(await reading).toMatchObject({
      hermes_session_id: "session_new",
      effective_hermes_session_id: "session_new",
      title: "session_new",
    });
    expect(conversations.findById(conversation.id)?.last_seen_upstream_at).toBe(
      now,
    );
  });

  it("traverses beyond 50 with bounded page reads, including after deleting the cursor anchor", async () => {
    const ids = Array.from(
      { length: 53 },
      (_, i) => `cv_${String(i).padStart(3, "0")}`,
    );
    ids.forEach((id, i) => add(id, i < 51 ? null : 1));
    const missing = new Set([`session_${ids[0]}`, `session_${ids[49]}`]);
    let active = 0;
    let peak = 0;
    const read = vi
      .spyOn(adapter, "getSession")
      .mockImplementation(async (id) => {
        active++;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (missing.has(id)) throw new HermesNotFoundError("missing");
          return { ...session(id), pinned: id === `session_${ids[52]}` };
        } finally {
          active--;
        }
      });
    const first = await service.listConversations({ limit: 50 });
    expect(first.items).toHaveLength(48);
    expect(first.has_more).toBe(true);
    expect(read).toHaveBeenCalledTimes(50);
    expect(conversations.findById(ids[49]!)).toBeNull();
    const second = await service.listConversations({
      limit: 2,
      cursor: first.next_cursor!,
    });
    expect(second.has_more).toBe(true);
    expect(read).toHaveBeenCalledTimes(52);
    expect(second.items).toMatchObject([
      { conversation_id: ids[50] },
      { conversation_id: ids[51] },
    ]);
    // Continue within the non-null custom_order group after the null prefix.
    const third = await service.listConversations({
      limit: 50,
      cursor: second.next_cursor!,
    });
    expect(third.has_more).toBe(false);
    expect(third.next_cursor).toBeNull();
    expect(read).toHaveBeenCalledTimes(53);
    expect(third.items).toMatchObject([
      { conversation_id: ids[52], pinned: true },
    ]);
    expect(
      new Set(
        [...first.items, ...second.items, ...third.items].map(
          (item) => item.conversation_id,
        ),
      ).size,
    ).toBe(51);
    expect(peak).toBe(4);
  });
});
