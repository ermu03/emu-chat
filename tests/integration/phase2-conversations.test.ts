import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrate.js';
import { ConversationRepository, DraftRepository } from '../../src/server/db/repositories/conversation.repository.js';
import { QueueRepository } from '../../src/server/db/repositories/queue.repository.js';
import { RunRepository } from '../../src/server/db/repositories/run.repository.js';
import { HermesAdapter } from '../../src/server/hermes/adapter.js';
import { HermesClient } from '../../src/server/hermes/client.js';
import { ConversationService } from '../../src/server/services/conversation-service.js';
import { StatusService } from '../../src/server/services/status-service.js';
import { buildServer } from '../../src/server/app.js';
import {
  mockHermesSession1,
  mockHermesSession2,
  mockHermesSessionListResponse
} from '../fixtures/hermes/sessions.fixture.js';
import { mockHermesMessageListResponse } from '../fixtures/hermes/messages.fixture.js';
import { validCapabilitiesHealthResponse } from '../fixtures/hermes/health.fixture.js';
import type { AppConfig } from '../../src/server/config.js';

describe('Phase 2: Hermes Adapter & Read-only Conversations Integration', () => {
  let db: Database.Database;
  let hermesClient: HermesClient;
  let hermesAdapter: HermesAdapter;
  let conversationRepo: ConversationRepository;
  let draftRepo: DraftRepository;
  let queueRepo: QueueRepository;
  let runRepo: RunRepository;
  let statusService: StatusService;
  let conversationService: ConversationService;
  let app: ReturnType<typeof buildServer>;

  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    conversationRepo = new ConversationRepository(db);
    draftRepo = new DraftRepository(db);
    queueRepo = new QueueRepository(db);
    runRepo = new RunRepository(db);

    hermesClient = new HermesClient({
      baseUrl: 'http://127.0.0.1:8642',
      token: 'test-token'
    });
    hermesAdapter = new HermesAdapter(hermesClient);
    statusService = new StatusService(hermesAdapter, runRepo);
    conversationService = new ConversationService(
      hermesAdapter,
      conversationRepo,
      draftRepo,
      queueRepo,
      runRepo
    );

    const config: AppConfig = {
      host: '127.0.0.1',
      port: 3000,
      dataDir: './data',
      sqlitePath: ':memory:',
      hermesBaseUrl: 'http://127.0.0.1:8642',
      hermesToken: 'test-token',
      hermesTimeoutMs: 5000,
      isProduction: false
    };

    app = buildServer(config, {
      db,
      hermesClient,
      hermesAdapter,
      statusService,
      conversationService
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  it('GET /api/v1/status returns healthy connection status with capabilities', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/health/detailed')) {
        return new Response(JSON.stringify(validCapabilitiesHealthResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/status'
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('healthy');
    expect(body.hermes_version).toBe('0.9.5');
    expect(body.capabilities.run_submission).toBe(true);
    expect(body.capabilities.durable).toBe(true);
  });

  it('GET /api/v1/conversations lazily creates local records and returns summaries', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/sessions')) {
        return new Response(JSON.stringify(mockHermesSessionListResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/conversations'
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(2);
    expect(body.items[0].title).toBe('Project Setup Discussion');
    expect(body.items[0].pinned).toBe(true);

    // Verify local database now has 2 conversation records and 2 empty drafts
    const localConvs = conversationRepo.list();
    expect(localConvs).toHaveLength(2);
    const draft = draftRepo.getDraft(localConvs[0]!.id);
    expect(draft?.draft_text).toBe('');
  });

  it('GET /api/v1/conversations/:id/messages fetches directly from Hermes without saving messages locally', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/sessions') && url.includes('/messages')) {
        return new Response(JSON.stringify(mockHermesMessageListResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url.includes('/api/sessions')) {
        return new Response(JSON.stringify(mockHermesSession1), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response('Not found', { status: 404 });
    });

    // Create local conversation
    const conv = conversationRepo.insert({
      id: 'cv_01j9a8b7c6d5e4f3a2b1c00001',
      hermes_profile: 'default',
      hermes_session_id: mockHermesSession1.id,
      tags_json: '[]',
      custom_order: null,
      queue_paused: 0,
      pause_reason: null,
      delete_state: 'none',
      metadata_revision: 1,
      last_seen_upstream_at: null
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conv.id}/messages`
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content).toBe('Hello Hermes, how are you?');

    // Confirm SQLite contains ZERO transcript/message tables or records
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%message%'")
      .all();
    expect(tables).toHaveLength(0);
  });

  it('PATCH /api/v1/conversations/:id/local-metadata updates tags with revision CAS', async () => {
    const conv = conversationRepo.insert({
      id: 'cv_01j9a8b7c6d5e4f3a2b1c00002',
      hermes_profile: 'default',
      hermes_session_id: mockHermesSession1.id,
      tags_json: '[]',
      custom_order: null,
      queue_paused: 0,
      pause_reason: null,
      delete_state: 'none',
      metadata_revision: 1,
      last_seen_upstream_at: null
    });

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes(`/api/sessions/${mockHermesSession1.id}`)) {
        return new Response(JSON.stringify(mockHermesSession1), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response('Not found', { status: 404 });
    });

    // Valid update with expected_revision: 1
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/conversations/${conv.id}/local-metadata`,
      payload: {
        tags: ['work', 'important'],
        expected_revision: 1
      }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tags).toEqual(['work', 'important']);
    expect(body.metadata_revision).toBe(2);

    // Stale update with old expected_revision: 1 should return 409 Conflict
    const conflictRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/conversations/${conv.id}/local-metadata`,
      payload: {
        tags: ['stale'],
        expected_revision: 1
      }
    });

    expect(conflictRes.statusCode).toBe(409);
  });

  it('POST /api/v1/conversations/:id/delete enforces expected_hermes_session_id and upstream gate', async () => {
    const conv = conversationRepo.insert({
      id: 'cv_01j9a8b7c6d5e4f3a2b1c00003',
      hermes_profile: 'default',
      hermes_session_id: mockHermesSession1.id,
      tags_json: '[]',
      custom_order: null,
      queue_paused: 0,
      pause_reason: null,
      delete_state: 'none',
      metadata_revision: 1,
      last_seen_upstream_at: null
    });
    draftRepo.saveDraft(conv.id, 'some draft');

    // Mismatched expected_hermes_session_id returns 409
    const mismatchRes = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/delete`,
      payload: {
        expected_hermes_session_id: 'wrong-id'
      }
    });
    expect(mismatchRes.statusCode).toBe(409);

    // When Hermes has active_agents > 0, deletion is blocked
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/health/detailed')) {
        return new Response(
          JSON.stringify({ ...validCapabilitiesHealthResponse, active_agents: 1 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('ok', { status: 200 });
    });

    const blockedRes = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/delete`,
      payload: {
        expected_hermes_session_id: mockHermesSession1.id
      }
    });
    expect(blockedRes.statusCode).toBe(409);

    // When active_agents == 0, deletion succeeds
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/health/detailed')) {
        return new Response(JSON.stringify(validCapabilitiesHealthResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ deleted: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const successRes = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/delete`,
      payload: {
        expected_hermes_session_id: mockHermesSession1.id
      }
    });
    expect(successRes.statusCode).toBe(200);
    const body = JSON.parse(successRes.body);
    expect(body.deleted).toBe(true);

    // Verify local record removed
    expect(conversationRepo.findById(conv.id)).toBeNull();
    expect(draftRepo.getDraft(conv.id)).toBeNull();
  });
});
