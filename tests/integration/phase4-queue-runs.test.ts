import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp } from '../../src/server/app.js';
import type { FastifyInstance } from 'fastify';

describe('Phase 4: Queue and Runs Routes Integration', () => {
  let app: FastifyInstance;
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    // 初始化所需表结构
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        hermes_session_id TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
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
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        queue_item_id TEXT NOT NULL,
        hermes_run_id TEXT,
        status TEXT NOT NULL,
        pause_reason TEXT,
        pause_details TEXT,
        error_message TEXT,
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE coordinator_leases (
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        lease_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (scope_type, scope_id)
      );
      CREATE TABLE drafts (
        conversation_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE ui_preferences (
        id TEXT PRIMARY KEY,
        sidebar_collapsed INTEGER NOT NULL DEFAULT 0,
        theme TEXT NOT NULL DEFAULT 'dark',
        compact_mode INTEGER NOT NULL DEFAULT 0,
        stream_auto_scroll INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
    `);

    // 插入测试会话
    db.prepare(`
      INSERT INTO conversations (id, hermes_session_id, title, revision, created_at, updated_at)
      VALUES ('cv_test', 'hermes_sess_1', 'Test Conv', 1, datetime('now'), datetime('now'))
    `).run();

    app = await buildApp({ db });
  });

  afterEach(async () => {
    await app.close();
  });

  it('enqueues a message into the conversation queue', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/cv_test/messages',
      payload: {
        content: 'Hello Hermes from Queue Test',
        client_request_id: 'req_integration_1',
      },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.data.content).toBe('Hello Hermes from Queue Test');
    expect(body.data.status).toBe('queued');
  });

  it('lists queue items for the conversation', async () => {
    // 先入队一条
    await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/cv_test/messages',
      payload: {
        content: 'Query Queue Test',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/conversations/cv_test/queue',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.data[0].content).toBe('Query Queue Test');
  });
});
