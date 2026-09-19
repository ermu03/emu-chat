import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrate.js';
import {
  ConversationRepository,
  DraftRepository,
  PreferencesRepository,
} from '../../src/server/db/repositories/conversation.repository.js';
import { QueueRepository } from '../../src/server/db/repositories/queue.repository.js';
import { RunRepository } from '../../src/server/db/repositories/run.repository.js';
import { LeaseRepository } from '../../src/server/db/repositories/lease.repository.js';
import { ConflictError, QueueFullError } from '../../src/server/domain/errors.js';

describe('Phase 1 Repositories & State Integration (In-Memory SQLite)', () => {
  let db: Database.Database;
  let convRepo: ConversationRepository;
  let draftRepo: DraftRepository;
  let prefRepo: PreferencesRepository;
  let queueRepo: QueueRepository;
  let runRepo: RunRepository;
  let leaseRepo: LeaseRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    convRepo = new ConversationRepository(db);
    draftRepo = new DraftRepository(db);
    prefRepo = new PreferencesRepository(db);
    queueRepo = new QueueRepository(db);
    runRepo = new RunRepository(db);
    leaseRepo = new LeaseRepository(db);
  });

  describe('ConversationRepository', () => {
    it('creates, reads, and updates conversation metadata with revision check', () => {
      const conv = convRepo.insert({
        id: 'cv_01956789-0000-7000-8000-000000000001',
        hermes_profile: 'default',
        hermes_session_id: 'session-123',
        tags_json: '["dev"]',
        custom_order: 1,
        queue_paused: 0,
        pause_reason: null,
        delete_state: 'none',
        delete_error_code: null,
        last_seen_upstream_at: null,
      });

      expect(conv.id).toBe('cv_01956789-0000-7000-8000-000000000001');
      expect(conv.metadata_revision).toBe(0);

      const updated = convRepo.updateMetadata(conv.id, 0, {
        tags_json: '["dev", "hermes"]',
      });
      expect(updated.metadata_revision).toBe(1);
      expect(updated.tags_json).toBe('["dev", "hermes"]');

      expect(() => {
        convRepo.updateMetadata(conv.id, 0, { custom_order: 2 });
      }).toThrow(ConflictError);
    });

    it('manages queue pause state and delete state', () => {
      const conv = convRepo.insert({
        id: 'cv_01956789-0000-7000-8000-000000000002',
        hermes_profile: 'default',
        hermes_session_id: 'session-456',
        tags_json: '[]',
        custom_order: null,
        queue_paused: 0,
        pause_reason: null,
        delete_state: 'none',
        delete_error_code: null,
        last_seen_upstream_at: null,
      });

      const paused = convRepo.setQueuePaused(conv.id, true, 'manual_pause');
      expect(paused.queue_paused).toBe(1);
      expect(paused.pause_reason).toBe('manual_pause');

      const deleting = convRepo.setDeleteState(conv.id, 'pending');
      expect(deleting.delete_state).toBe('pending');
    });
  });

  describe('DraftRepository', () => {
    it('creates, updates and conflicts on revision mismatch', () => {
      const cvId = 'cv_01956789-0000-7000-8000-000000000003';
      const draft = draftRepo.saveDraft(cvId, 'hello draft');
      expect(draft.content).toBe('hello draft');
      expect(draft.revision).toBe(0);

      const updated = draftRepo.saveDraft(cvId, 'updated draft', 0);
      expect(updated.revision).toBe(1);
      expect(updated.content).toBe('updated draft');

      expect(() => {
        draftRepo.saveDraft(cvId, 'conflict draft', 0);
      }).toThrow(ConflictError);
    });
  });

  describe('PreferencesRepository', () => {
    it('initializes default and increments revision on patch', () => {
      const pref = prefRepo.get();
      expect(pref.theme).toBe('system');
      expect(pref.revision).toBe(0);

      const updated = prefRepo.update(0, { theme: 'dark' });
      expect(updated.theme).toBe('dark');
      expect(updated.revision).toBe(1);

      expect(() => {
        prefRepo.update(0, { theme: 'light' });
      }).toThrow(ConflictError);
    });
  });

  describe('QueueRepository', () => {
    it('enforces FIFO sequence, deduplication and max depth limit', () => {
      const cvId = 'cv_01956789-0000-7000-8000-000000000004';
      const q1 = queueRepo.enqueue({
        id: 'qi_01956789-0000-7000-8000-000000000011',
        conversation_id: cvId,
        operation_id: 'op_01956789-0000-7000-8000-000000000011',
        client_request_id: 'rq_01956789-0000-7000-8000-000000000011',
        state: 'queued',
        payload_text: 'msg 1',
        payload_sha256: 'hash1',
        payload_bytes: 5,
        idempotency_key: 'idem-1',
        dispatch_session_id: null,
        first_attempt_at: null,
        admission_deadline_at: null,
        recovery_expires_at: null,
        payload_expired_at: null,
        payload_discarded_at: null,
        last_error_code: null,
      });
      expect(q1.fifo_seq).toBe(1);

      // Idempotency return
      const q1Dup = queueRepo.enqueue({
        id: 'qi_01956789-0000-7000-8000-000000000012',
        conversation_id: cvId,
        operation_id: 'op_01956789-0000-7000-8000-000000000012',
        client_request_id: 'rq_01956789-0000-7000-8000-000000000011', // same client_request_id
        state: 'queued',
        payload_text: 'msg 1 dup',
        payload_sha256: 'hash1',
        payload_bytes: 9,
        idempotency_key: 'idem-1',
        dispatch_session_id: null,
        first_attempt_at: null,
        admission_deadline_at: null,
        recovery_expires_at: null,
        payload_expired_at: null,
        payload_discarded_at: null,
        last_error_code: null,
      });
      expect(q1Dup.id).toBe(q1.id);

      // Check max queue limit (10)
      for (let i = 2; i <= 10; i++) {
        queueRepo.enqueue({
          id: `qi_01956789-0000-7000-8000-0000000000${i < 10 ? '0' + i : i}`,
          conversation_id: cvId,
          operation_id: `op_01956789-0000-7000-8000-0000000000${i < 10 ? '0' + i : i}`,
          client_request_id: `rq_01956789-0000-7000-8000-0000000000${i < 10 ? '0' + i : i}`,
          state: 'queued',
          payload_text: `msg ${i}`,
          payload_sha256: `hash${i}`,
          payload_bytes: 5,
          idempotency_key: `idem-${i}`,
          dispatch_session_id: null,
          first_attempt_at: null,
          admission_deadline_at: null,
          recovery_expires_at: null,
          payload_expired_at: null,
          payload_discarded_at: null,
          last_error_code: null,
        });
      }

      // 11th should throw QueueFullError
      expect(() => {
        queueRepo.enqueue({
          id: 'qi_01956789-0000-7000-8000-000000000099',
          conversation_id: cvId,
          operation_id: 'op_01956789-0000-7000-8000-000000000099',
          client_request_id: 'rq_01956789-0000-7000-8000-000000000099',
          state: 'queued',
          payload_text: 'overflow',
          payload_sha256: 'hash99',
          payload_bytes: 8,
          idempotency_key: 'idem-99',
          dispatch_session_id: null,
          first_attempt_at: null,
          admission_deadline_at: null,
          recovery_expires_at: null,
          payload_expired_at: null,
          payload_discarded_at: null,
          last_error_code: null,
        });
      }).toThrow(QueueFullError);
    });
  });

  describe('LeaseRepository', () => {
    it('acquires, renews and releases lease safely', () => {
      const scopeType = 'global';
      const scopeId = 'coordinator';
      const owner = 'worker-1';
      const token = 'token-123';

      const acquired = leaseRepo.acquire(scopeType, scopeId, owner, token, 5000);
      expect(acquired).toBe(true);

      // Re-acquire by different owner should fail before expiry
      const acquireFailed = leaseRepo.acquire(scopeType, scopeId, 'worker-2', 'token-456', 5000);
      expect(acquireFailed).toBe(false);

      // Renew by same owner succeeds
      const renewed = leaseRepo.renew(scopeType, scopeId, token, 10000);
      expect(renewed).toBe(true);

      // Release
      const released = leaseRepo.release(scopeType, scopeId, token);
      expect(released).toBe(true);

      // Now worker-2 can acquire
      const acquireSecond = leaseRepo.acquire(scopeType, scopeId, 'worker-2', 'token-456', 5000);
      expect(acquireSecond).toBe(true);
    });
  });
});
