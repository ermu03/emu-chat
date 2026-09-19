import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { QueueRepository } from '../../src/server/db/repositories/queue.repository.js';
import { SSEHub } from '../../src/server/sse/sse-hub.js';
import { QueueFullError } from '../../src/server/domain/errors.js';

describe('Phase 4: Queue and Coordinator Unit Tests', () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let sseHub: SSEHub;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE queue_items (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        client_request_id TEXT UNIQUE,
        idempotency_key TEXT,
        sequence_number INTEGER NOT NULL,
        sender_type TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    queueRepo = new QueueRepository(db);
    sseHub = new SSEHub();
  });

  it('enforces maximum 10 queued items per conversation', async () => {
    const convId = 'cv_test123';

    // 排队 10 条
    for (let i = 1; i <= 10; i++) {
      await queueRepo.enqueue({
        id: `qi_${i}`,
        conversation_id: convId,
        client_request_id: `req_${i}`,
        content: `Message ${i}`,
        sender_type: 'user',
      });
    }

    // 第 11 条应该抛出 QueueFullError
    await expect(
      queueRepo.enqueue({
        id: 'qi_overflow',
        conversation_id: convId,
        client_request_id: 'req_overflow',
        content: 'Overflow message',
        sender_type: 'user',
      })
    ).rejects.toThrow(QueueFullError);
  });

  it('supports idempotent deduplication by client_request_id', async () => {
    const convId = 'cv_test123';

    const item1 = await queueRepo.enqueue({
      id: 'qi_1',
      conversation_id: convId,
      client_request_id: 'dup_req',
      content: 'Original',
      sender_type: 'user',
    });

    const item2 = await queueRepo.enqueue({
      id: 'qi_2',
      conversation_id: convId,
      client_request_id: 'dup_req',
      content: 'Duplicate attempt',
      sender_type: 'user',
    });

    expect(item1.id).toBe(item2.id);
    expect(item2.content).toBe('Original');
  });

  it('stores events in ring buffer and calculates monotonically increasing sequences', () => {
    const convId = 'cv_sse';

    const e1 = sseHub.broadcast(convId, 'test.event', { count: 1 });
    const e2 = sseHub.broadcast(convId, 'test.event', { count: 2 });

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);

    const history = sseHub.getEventHistory(convId);
    expect(history.length).toBe(2);
    expect(history[0].seq).toBe(1);
    expect(history[1].seq).toBe(2);
  });
});
