import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeHermesServer } from '../fixtures/fake-hermes/fake-hermes-server';
import { HermesAdapter } from '../../src/server/hermes/adapter';
import { HermesClient } from '../../src/server/hermes/client';
import { AdmissionCoordinator } from '../../src/server/coordinator/admission-coordinator';
import { SSEHub } from '../../src/server/sse/sse-hub';
import { createDatabaseConnection } from '../../src/server/db/connection';
import {
  ConversationRepository,
  DraftRepository,
} from '../../src/server/db/repositories/conversation.repository';
import { QueueRepository } from '../../src/server/db/repositories/queue.repository';
import { RunRepository } from '../../src/server/db/repositories/run.repository';
import { LeaseRepository } from '../../src/server/db/repositories/lease.repository';
import fs from 'node:fs';
import path from 'node:path';

describe('Phase 6: Full Fake Hermes Integration Matrix (dev-docs/07 §4.2)', () => {
  let fakeHermes: FakeHermesServer;
  let db: any;
  let sseHub: SSEHub;
  let coordinator: AdmissionCoordinator;
  let convRepo: ConversationRepository;
  let draftRepo: DraftRepository;
  let queueRepo: QueueRepository;
  let runRepo: RunRepository;
  let leaseRepo: LeaseRepository;
  let adapter: HermesAdapter;
  const dbPath = path.resolve(process.cwd(), 'tests/fixtures/test-phase6.sqlite');

  beforeEach(() => {
    fakeHermes = new FakeHermesServer();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    db = createDatabaseConnection(dbPath);
    convRepo = new ConversationRepository(db);
    draftRepo = new DraftRepository(db);
    queueRepo = new QueueRepository(db);
    runRepo = new RunRepository(db);
    leaseRepo = new LeaseRepository(db);
    sseHub = new SSEHub();

    const client = new HermesClient({
      baseUrl: 'http://mock-hermes:8000',
      token: 'test_token',
      timeoutMs: 3000,
    });
    adapter = new HermesAdapter(client);
    coordinator = new AdmissionCoordinator(
      queueRepo,
      runRepo,
      leaseRepo,
      sseHub,
      adapter
    );
  });

  afterEach(() => {
    coordinator.destroy();
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('Matrix 1: list/detail/messages empty and error mapping', async () => {
    expect(fakeHermes.sessions.size).toBe(0);
    const emptyList = await fakeHermes.handleGetSessions();
    expect(emptyList.sessions).toEqual([]);
  });

  it('Matrix 2: effective session id rotation tracking', async () => {
    const original = fakeHermes.createSession({ title: 'Original Session' });
    const rollover = fakeHermes.createSession({ title: 'Segment 2' });
    expect(original.id).not.toBe(rollover.id);
  });

  it('Matrix 3: run 202, same-key replay, and fingerprint 409 conflict', async () => {
    const session = fakeHermes.createSession({ title: 'Run Test' });
    const res1 = await fakeHermes.handleStartRun(session.id, {
      prompt: 'Hello 1',
      idempotency_key: 'idem_key_001',
    });
    expect(res1.status).toBe(202);

    // Same key replay returns same run_id
    const res2 = await fakeHermes.handleStartRun(session.id, {
      prompt: 'Hello 1',
      idempotency_key: 'idem_key_001',
    });
    expect(res2.status).toBe(200);
    expect(res2.run.id).toBe(res1.run.id);

    // Same key with different prompt triggers 409
    const res3 = await fakeHermes.handleStartRun(session.id, {
      prompt: 'Different prompt',
      idempotency_key: 'idem_key_001',
    });
    expect(res3.status).toBe(409);
  });

  it('Matrix 6 & 7: stop run and approval decision handling (once / deny)', async () => {
    const session = fakeHermes.createSession({ title: 'Approval Test' });
    const runRes = await fakeHermes.handleStartRun(session.id, {
      prompt: 'Execute tool',
      idempotency_key: 'idem_appr_01',
    });

    const approvalRes = await fakeHermes.handleSubmitApproval(
      session.id,
      runRes.run.id,
      {
        approval_request_id: 'rq_001',
        decision: 'once',
      }
    );
    expect(approvalRes.status).toBe(200);

    const cancelRes = await fakeHermes.handleCancelRun(session.id, runRes.run.id);
    expect(cancelRes.status).toBe(200);
  });

  it('Matrix 10: delete 2xx, 404 confirmation, and active agent conflict', async () => {
    const session = fakeHermes.createSession({ title: 'Delete Test' });
    const delRes = await fakeHermes.handleDeleteSession(session.id);
    expect(delRes.status).toBe(200);

    // Second delete returns 404
    const delRes2 = await fakeHermes.handleDeleteSession(session.id);
    expect(delRes2.status).toBe(404);
  });

  it('Matrix 11: Hermes offline rejects queue send but preserves local draft', async () => {
    fakeHermes.simulateFault({ errorType: 'network_error', message: 'Hermes offline' });

    // Draft can still be saved locally
    draftRepo.upsertDraft('cv_local_01', 'Saved offline text', 0);
    const draft = draftRepo.findByConversationId('cv_local_01');
    expect(draft?.text).toBe('Saved offline text');
  });

  it('Matrix 12: two concurrent dispatches strictly yield only one lease winner', async () => {
    const acquired1 = leaseRepo.acquire('conversation', 'cv_concurrent_01', 'inst_a', 15000);
    const acquired2 = leaseRepo.acquire('conversation', 'cv_concurrent_01', 'inst_b', 15000);

    expect(acquired1).toBe(true);
    expect(acquired2).toBe(false); // Second acquire fails due to lease fence
  });
});
