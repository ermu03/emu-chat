import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { FastifyReply } from "fastify";
import { runMigrations } from "../../src/server/db/migrate.js";
import { ConversationRepository } from "../../src/server/db/repositories/conversation.repository.js";
import { QueueRepository } from "../../src/server/db/repositories/queue.repository.js";
import { SSEHub } from "../../src/server/sse/sse-hub.js";
import { QueueFullError } from "../../src/server/domain/errors.js";
import { LIMITS } from "../../src/shared/limits.js";

describe("Phase 4: queue repository and local SSE hub", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let sseHub: SSEHub;
  const conversationId = "cv_01956789-0000-7000-8000-000000000100";

  const hashFor = (value: string) => value.padEnd(64, "0").slice(0, 64);

  const enqueue = (index: number, clientRequestId = `rq_${index}`) =>
    queueRepo.enqueue({
      id: `qi_01956789-0000-7000-8000-00000000${String(index).padStart(4, "0")}`,
      conversation_id: conversationId,
      operation_id: `op_01956789-0000-7000-8000-00000000${String(index).padStart(4, "0")}`,
      client_request_id: clientRequestId,
      state: "queued",
      payload_text: `Message ${index}`,
      payload_sha256: hashFor(`message-${index}`),
      payload_bytes: Buffer.byteLength(`Message ${index}`),
      idempotency_key: `idem-${index}`,
      dispatch_session_id: null,
      first_attempt_at: null,
      admission_deadline_at: null,
      recovery_expires_at: null,
      payload_expired_at: null,
      payload_discarded_at: null,
      last_error_code: null,
    });

  const makeReply = () => {
    const writes: string[] = [];
    const raw = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => {
        writes.push(String(chunk));
        return true;
      }),
      on: vi.fn(),
      end: vi.fn(),
    };
    return { reply: { raw } as unknown as FastifyReply, writes };
  };

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    const conversationRepo = new ConversationRepository(db);
    conversationRepo.insert({
      id: conversationId,
      hermes_profile: "default",
      hermes_session_id: "ses_queue_test",
      tags_json: "[]",
      custom_order: null,
      queue_paused: 0,
      pause_reason: null,
      delete_state: "none",
      delete_error_code: null,
      last_seen_upstream_at: null,
    });
    queueRepo = new QueueRepository(db);
    sseHub = new SSEHub();
  });

  it("assigns FIFO sequence numbers and returns an idempotent replay", () => {
    const first = enqueue(1, "rq_duplicate");
    const duplicate = queueRepo.enqueue({
      ...first,
      id: "qi_01956789-0000-7000-8000-000000000999",
      operation_id: "op_01956789-0000-7000-8000-000000000999",
      client_request_id: "rq_duplicate",
      payload_text: "Different payload",
      payload_sha256: hashFor("different"),
      payload_bytes: 17,
      idempotency_key: "idem-duplicate",
    });

    expect(first.fifo_seq).toBe(1);
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.payload_text).toBe(first.payload_text);
    expect(queueRepo.listByConversation(conversationId)).toHaveLength(1);
  });

  it("enforces the documented active queue depth limit", () => {
    for (let index = 1; index <= LIMITS.QUEUE_ACTIVE_MAX_COUNT; index += 1) {
      enqueue(index);
    }

    expect(() => enqueue(LIMITS.QUEUE_ACTIVE_MAX_COUNT + 1)).toThrow(
      QueueFullError,
    );
  });

  it("broadcasts monotonic run events and replays them from a numeric cursor", () => {
    const first = sseHub.publishRunEvent(conversationId, 1, "message.delta", {
      text: "a",
    });
    const second = sseHub.publishRunEvent(conversationId, 2, "message.delta", {
      text: "b",
    });
    expect(first.local_seq).toBe(1);
    expect(second.local_seq).toBe(2);

    const { reply, writes } = makeReply();
    sseHub.subscribe(conversationId, reply, first.local_seq);

    expect(writes[0]).toContain("event: stream.ready");
    expect(
      writes.some((payload) => payload.includes("id: 2\nevent: run.event")),
    ).toBe(true);
    expect(
      writes.some((payload) => payload.includes("id: 1\nevent: run.event")),
    ).toBe(false);

    sseHub.publishRunEvent(conversationId, 3, "run.completed", {
      status: "completed",
    });
    expect(writes.at(-1)).toContain('"type":"run.completed"');
    sseHub.close();
  });
});
