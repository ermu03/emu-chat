import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type {
  ApprovalRequest,
  CancelQueueItemRequest,
  CopyToDraftRequest,
  DraftResponse,
  PatchQueueItemRequest,
  QueueItemResponse,
  QueueListResponse,
  ReconcileResponse,
  RunResponse,
  SendMessageResponse,
} from "../../shared/api-schemas.js";
import { LIMITS } from "../../shared/limits.js";
import { generateId, ID_PREFIXES } from "../../shared/ids.js";
import type { HermesRunStatusResponse } from "../../shared/hermes-schemas.js";
import type {
  ConversationEntity,
  DraftEntity,
  QueueItemEntity,
  RunEntity,
} from "../db/schema-types.js";
import { withImmediateTransaction } from "../db/transaction.js";
import {
  ConversationRepository,
  DraftRepository,
} from "../db/repositories/conversation.repository.js";
import { LeaseRepository } from "../db/repositories/lease.repository.js";
import { QueueRepository } from "../db/repositories/queue.repository.js";
import { RunRepository } from "../db/repositories/run.repository.js";
import {
  ApprovalNotPendingError,
  DraftConflictError,
  HermesAuthFailedError,
  HermesNotReadyError,
  LocalConflictError,
  LocalNotFoundError,
  PayloadTooLargeError,
  QueueFullError,
  RunActiveError,
  StateConflictError,
} from "../domain/errors.js";
import type { HermesAdapter } from "../hermes/adapter.js";

type WakeCoordinator = () => void;
type ReconcileCoordinator = (localRunId: string) => Promise<void>;

export interface QueueRunServiceOptions {
  db: Database.Database;
  conversationRepo: ConversationRepository;
  draftRepo: DraftRepository;
  queueRepo: QueueRepository;
  runRepo: RunRepository;
  leaseRepo: LeaseRepository;
  hermesAdapter: HermesAdapter;
  wakeCoordinator: WakeCoordinator;
  reconcileCoordinator: ReconcileCoordinator;
}

/** Implements the browser-facing queue/run mutations and resource projections. */
export class QueueRunService {
  private readonly db: Database.Database;
  private readonly conversationRepo: ConversationRepository;
  private readonly draftRepo: DraftRepository;
  private readonly queueRepo: QueueRepository;
  private readonly runRepo: RunRepository;
  private readonly leaseRepo: LeaseRepository;
  private readonly hermesAdapter: HermesAdapter;
  private readonly wakeCoordinator: WakeCoordinator;
  private readonly reconcileCoordinator: ReconcileCoordinator;

  constructor(options: QueueRunServiceOptions) {
    this.db = options.db;
    this.conversationRepo = options.conversationRepo;
    this.draftRepo = options.draftRepo;
    this.queueRepo = options.queueRepo;
    this.runRepo = options.runRepo;
    this.leaseRepo = options.leaseRepo;
    this.hermesAdapter = options.hermesAdapter;
    this.wakeCoordinator = options.wakeCoordinator;
    this.reconcileCoordinator = options.reconcileCoordinator;
  }

  async sendMessage(
    conversationId: string,
    clientRequestId: string,
    expectedDraftRevision: number,
  ): Promise<SendMessageResponse> {
    // Replay lookup intentionally precedes the Hermes probe. A retry after an
    // unknown response must work even if Hermes is currently offline.
    const replay = this.queueRepo.findByClientRequestId(clientRequestId);
    if (replay) return this.sendReplay(conversationId, replay);

    await this.assertHermesReady();

    const result = withImmediateTransaction(this.db, () => {
      const concurrent = this.queueRepo.findByClientRequestId(clientRequestId);
      if (concurrent) return { item: concurrent, replayed: true };

      const conversation = this.requireConversation(conversationId);
      if (conversation.delete_state !== "none") {
        throw new StateConflictError("Conversation is pending deletion", {
          current_state: conversation.delete_state,
        });
      }

      const draft = this.draftRepo.findByConversationId(conversationId);
      const currentRevision = draft?.revision ?? 0;
      if (!draft || currentRevision !== expectedDraftRevision) {
        throw new DraftConflictError("Draft revision conflict", {
          current_revision: currentRevision,
          expected_revision: expectedDraftRevision,
        });
      }
      if (draft.content.trim().length === 0) {
        throw new StateConflictError("Draft content cannot be empty", {
          current_state: "empty_draft",
        });
      }

      const payloadBytes = Buffer.byteLength(draft.content, "utf8");
      if (payloadBytes > LIMITS.INPUT_MAX_BYTES) {
        throw new PayloadTooLargeError(
          `Message exceeds ${LIMITS.INPUT_MAX_BYTES} bytes`,
          {
            limit_bytes: LIMITS.INPUT_MAX_BYTES,
          },
        );
      }

      const pending = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM queue_items
           WHERE conversation_id = ? AND state NOT IN ('done', 'cancelled')`,
        )
        .get(conversationId) as { count: number };
      if (pending.count >= LIMITS.QUEUE_ACTIVE_MAX_COUNT) {
        throw new QueueFullError("Queue depth limit exceeded for conversation");
      }

      const maxSeq = this.db
        .prepare(
          "SELECT COALESCE(MAX(fifo_seq), 0) AS max_seq FROM queue_items WHERE conversation_id = ?",
        )
        .get(conversationId) as { max_seq: number };
      const now = new Date().toISOString();
      const itemId = generateId(ID_PREFIXES.queueItem);
      const operationId = generateId(ID_PREFIXES.operation);
      const idempotencyKey = generateId(ID_PREFIXES.idempotency);
      const payloadSha256 = createHash("sha256")
        .update(draft.content, "utf8")
        .digest("hex");

      this.db
        .prepare(
          `INSERT INTO queue_items (
             id, conversation_id, operation_id, client_request_id, fifo_seq,
             state, payload_text, payload_sha256, payload_bytes, revision,
             idempotency_key, dispatch_session_id, attempt_count,
             first_attempt_at, admission_deadline_at, recovery_expires_at,
             payload_expired_at, payload_discarded_at, last_error_code,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, ?, NULL, 0,
                     NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          itemId,
          conversationId,
          operationId,
          clientRequestId,
          maxSeq.max_seq + 1,
          draft.content,
          payloadSha256,
          payloadBytes,
          idempotencyKey,
          now,
          now,
        );

      const draftUpdate = this.db
        .prepare(
          `UPDATE drafts
           SET content = '', revision = revision + 1, updated_at = ?
           WHERE conversation_id = ? AND revision = ?`,
        )
        .run(now, conversationId, expectedDraftRevision);
      if (draftUpdate.changes !== 1) {
        throw new DraftConflictError("Draft revision conflict", {
          current_revision:
            this.draftRepo.findByConversationId(conversationId)?.revision ?? 0,
          expected_revision: expectedDraftRevision,
        });
      }

      return { item: this.queueRepo.findById(itemId)!, replayed: false };
    });

    if (result.replayed) return this.sendReplay(conversationId, result.item);
    this.wakeCoordinator();
    return {
      object: "emu_chat.message_submission",
      replayed: false,
      queue_item: this.toQueueItem(result.item),
      draft: this.toDraft(
        this.draftRepo.findByConversationId(conversationId),
        conversationId,
      ),
    };
  }

  getQueue(conversationId: string, includeTerminal = false): QueueListResponse {
    const conversation = this.requireConversation(conversationId);
    let items = this.queueRepo.listByConversation(conversationId);
    if (!includeTerminal) {
      items = items.filter(
        (item) => item.state !== "done" && item.state !== "cancelled",
      );
    } else if (items.length > 100) {
      items = items.slice(-100);
    }
    return this.toQueueList(conversation, items);
  }

  patchQueueItem(
    queueItemId: string,
    input: PatchQueueItemRequest,
  ): QueueItemResponse {
    if (input.content.length === 0) {
      throw new StateConflictError("Queue item content cannot be empty", {
        current_state: "empty_payload",
      });
    }
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes > LIMITS.INPUT_MAX_BYTES) {
      throw new PayloadTooLargeError(
        `Queue item exceeds ${LIMITS.INPUT_MAX_BYTES} bytes`,
        {
          limit_bytes: LIMITS.INPUT_MAX_BYTES,
        },
      );
    }

    const item = withImmediateTransaction(this.db, () => {
      const current = this.requireQueueItem(queueItemId);
      if (current.state !== "queued") {
        throw new StateConflictError(`Queue item is ${current.state}`, {
          current_state: current.state,
        });
      }
      if (current.revision !== input.expected_revision) {
        throw new LocalConflictError("Queue item revision conflict", {
          current_revision: current.revision,
          expected_revision: input.expected_revision,
        });
      }
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `UPDATE queue_items
           SET payload_text = ?, payload_sha256 = ?, payload_bytes = ?,
               revision = revision + 1, updated_at = ?
           WHERE id = ? AND state = 'queued' AND revision = ?`,
        )
        .run(
          input.content,
          createHash("sha256").update(input.content, "utf8").digest("hex"),
          bytes,
          now,
          queueItemId,
          input.expected_revision,
        );
      if (result.changes !== 1)
        throw new LocalConflictError("Queue item revision conflict");
      return this.queueRepo.findById(queueItemId)!;
    });
    return this.toQueueItem(item);
  }

  cancelQueueItem(
    queueItemId: string,
    input: CancelQueueItemRequest,
  ): QueueItemResponse {
    const item = withImmediateTransaction(this.db, () => {
      const current = this.requireQueueItem(queueItemId);
      if (current.state !== "queued") {
        throw new StateConflictError(`Queue item is ${current.state}`, {
          current_state: current.state,
        });
      }
      if (current.revision !== input.expected_revision) {
        throw new LocalConflictError("Queue item revision conflict", {
          current_revision: current.revision,
          expected_revision: input.expected_revision,
        });
      }
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `UPDATE queue_items
           SET state = 'cancelled', payload_text = NULL, revision = revision + 1, updated_at = ?
           WHERE id = ? AND state = 'queued' AND revision = ?`,
        )
        .run(now, queueItemId, input.expected_revision);
      if (result.changes !== 1)
        throw new LocalConflictError("Queue item revision conflict");
      return this.queueRepo.findById(queueItemId)!;
    });
    return this.toQueueItem(item);
  }

  async resumeQueue(conversationId: string): Promise<QueueListResponse> {
    await this.assertHermesReady();
    const conversation = withImmediateTransaction(this.db, () => {
      const current = this.requireConversation(conversationId);
      if (current.delete_state !== "none") {
        throw new StateConflictError("Conversation is pending deletion", {
          current_state: current.delete_state,
        });
      }
      if (!current.queue_paused) {
        throw new StateConflictError("Conversation queue is not paused", {
          current_state: "not_paused",
        });
      }
      if (this.queueRepo.findActiveGlobal()) {
        throw new RunActiveError("Another queue item is currently active");
      }
      const lease = this.leaseRepo.findByScope("conversation", conversationId);
      if (lease && Date.parse(lease.expires_at) > Date.now()) {
        throw new RunActiveError("Conversation reconciliation is still active");
      }
      return this.conversationRepo.setQueuePaused(conversationId, false, null);
    });
    this.wakeCoordinator();
    return this.getQueue(conversation.id, false);
  }

  async copyToDraft(queueItemId: string, input: CopyToDraftRequest) {
    const draft = withImmediateTransaction(this.db, () => {
      const item = this.requireQueueItem(queueItemId);
      if (!["paused", "review_required", "rejected"].includes(item.state)) {
        throw new StateConflictError(`Queue item is ${item.state}`, {
          current_state: item.state,
        });
      }
      if (!this.payloadAvailable(item)) {
        throw new StateConflictError(
          "Queue item recovery payload is unavailable",
          {
            current_state: "payload_unavailable",
          },
        );
      }
      const current = this.draftRepo.findByConversationId(item.conversation_id);
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== input.expected_draft_revision) {
        throw new DraftConflictError("Draft revision conflict", {
          current_revision: currentRevision,
          expected_revision: input.expected_draft_revision,
        });
      }
      if (current && current.content.length > 0 && !input.overwrite_nonempty) {
        throw new DraftConflictError("Draft is not empty", {
          current_revision: current.revision,
        });
      }
      const now = new Date().toISOString();
      if (current) {
        const updated = this.db
          .prepare(
            `UPDATE drafts SET content = ?, revision = revision + 1, updated_at = ?
             WHERE conversation_id = ? AND revision = ?`,
          )
          .run(
            item.payload_text,
            now,
            item.conversation_id,
            input.expected_draft_revision,
          );
        if (updated.changes !== 1)
          throw new DraftConflictError("Draft revision conflict");
      } else {
        if (input.expected_draft_revision !== 0)
          throw new DraftConflictError("Draft revision conflict");
        this.db
          .prepare(
            `INSERT INTO drafts (conversation_id, content, revision, created_at, updated_at)
             VALUES (?, ?, 1, ?, ?)`,
          )
          .run(item.conversation_id, item.payload_text, now, now);
      }
      return this.draftRepo.findByConversationId(item.conversation_id)!;
    });
    return {
      object: "emu_chat.recovery_copy" as const,
      draft: this.toDraft(draft, draft.conversation_id),
      duplicate_risk: true as const,
    };
  }

  discardRecovery(queueItemId: string): QueueItemResponse {
    const item = withImmediateTransaction(this.db, () => {
      const current = this.requireQueueItem(queueItemId);
      if (!["paused", "review_required", "rejected"].includes(current.state)) {
        throw new StateConflictError(`Queue item is ${current.state}`, {
          current_state: current.state,
        });
      }
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `UPDATE queue_items
           SET payload_text = NULL, payload_discarded_at = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND state IN ('paused', 'review_required', 'rejected')`,
        )
        .run(now, now, queueItemId);
      if (result.changes !== 1)
        throw new LocalConflictError(
          "Queue item changed while discarding recovery",
        );
      return this.queueRepo.findById(queueItemId)!;
    });
    return this.toQueueItem(item);
  }

  async getRun(localRunId: string): Promise<RunResponse> {
    const run = this.requireRun(localRunId);
    let status: HermesRunStatusResponse | undefined;
    if (run.hermes_run_id && run.upstream_status === "waiting_for_approval") {
      try {
        status = await this.hermesAdapter.getRunStatus(run.hermes_run_id);
      } catch {
        // The persisted snapshot remains safe to return when a refresh fails.
      }
    }
    return this.toRun(run, status);
  }

  async stopRun(localRunId: string): Promise<RunResponse> {
    const stop = withImmediateTransaction(this.db, () => {
      const run = this.requireRun(localRunId);
      const item = this.requireQueueItem(run.queue_item_id);
      if (
        run.local_state === "reconciling" ||
        run.local_state === "reconciled"
      ) {
        throw new StateConflictError(`Run is ${run.local_state}`, {
          current_state: run.local_state,
        });
      }
      if (run.upstream_status === "stopping") return { run, shouldStop: false };
      if (
        run.local_state !== "accepted" ||
        item.state !== "accepted" ||
        !run.hermes_run_id
      ) {
        throw new StateConflictError(
          "Run cannot be stopped in its current state",
          {
            current_state: run.local_state,
          },
        );
      }
      const updated = this.runRepo.update(run.id, {
        upstream_status: "stopping",
      });
      this.conversationRepo.setQueuePaused(
        run.conversation_id,
        true,
        "user_stopped",
      );
      return { run: updated, shouldStop: true };
    });

    if (stop.shouldStop && stop.run.hermes_run_id) {
      await this.hermesAdapter.stopRun(stop.run.hermes_run_id);
    }
    return this.getRun(localRunId);
  }

  async submitApproval(
    localRunId: string,
    input: ApprovalRequest,
  ): Promise<RunResponse> {
    const run = this.requireRun(localRunId);
    if (!run.hermes_run_id || run.upstream_status !== "waiting_for_approval") {
      throw new ApprovalNotPendingError(
        `Run ${localRunId} is not waiting for approval`,
      );
    }
    const status = await this.hermesAdapter.getRunStatus(run.hermes_run_id);
    const approval = status.approval;
    const choices =
      approval?.choices.filter(
        (choice): choice is "once" | "deny" =>
          choice === "once" || choice === "deny",
      ) ?? [];
    if (
      status.status !== "waiting_for_approval" ||
      !approval ||
      !choices.includes(input.choice)
    ) {
      throw new ApprovalNotPendingError(
        `Run ${localRunId} is not waiting for approval`,
      );
    }
    if (
      input.request_id !== undefined &&
      input.request_id !== approval.request_id
    ) {
      throw new ApprovalNotPendingError("Approval request has expired");
    }
    await this.hermesAdapter.submitApproval(
      run.hermes_run_id,
      input.choice,
      approval.request_id,
    );
    this.runRepo.update(run.id, { upstream_status: "running" });
    // An approval can make the upstream run terminal before its paused SSE
    // consumer receives another event. Reconcile instead of assuming a later
    // stream callback will advance local state.
    await this.reconcileCoordinator(run.id);
    return this.getRun(localRunId);
  }

  async reconcile(localRunId: string): Promise<ReconcileResponse> {
    const run = this.requireRun(localRunId);
    const item = this.requireQueueItem(run.queue_item_id);
    const conversation = this.requireConversation(run.conversation_id);
    if (run.local_state === "reconciling") {
      await this.reconcileCoordinator(localRunId);
    } else if (run.local_state === "review_required") {
      if (
        !run.hermes_run_id ||
        item.state === "paused" ||
        !conversation.queue_paused
      ) {
        throw new StateConflictError(
          "Run cannot be reconciled in its current state",
          {
            current_state: run.local_state,
          },
        );
      }
      await this.reconcileCoordinator(localRunId);
    } else {
      throw new StateConflictError("Run is not awaiting reconciliation", {
        current_state: run.local_state,
      });
    }
    const updatedRun = this.requireRun(localRunId);
    const updatedItem = this.requireQueueItem(updatedRun.queue_item_id);
    return {
      object: "emu_chat.reconciliation",
      run: this.toRun(updatedRun),
      queue_item: this.toQueueItem(updatedItem),
    };
  }

  private async assertHermesReady(): Promise<void> {
    try {
      await this.hermesAdapter.assertReady();
    } catch (error) {
      if (
        error instanceof HermesNotReadyError ||
        error instanceof HermesAuthFailedError
      )
        throw error;
      throw new HermesNotReadyError(
        "Hermes is not ready to accept a new message",
      );
    }
  }

  private sendReplay(
    conversationId: string,
    item: QueueItemEntity,
  ): SendMessageResponse {
    if (item.conversation_id !== conversationId) {
      throw new LocalConflictError(
        "client_request_id is already used by another conversation",
        {
          current_conversation_id: item.conversation_id,
        },
      );
    }
    return {
      object: "emu_chat.message_submission",
      replayed: true,
      queue_item: this.toQueueItem(item),
      draft: this.toDraft(
        this.draftRepo.findByConversationId(conversationId),
        conversationId,
      ),
    };
  }

  private requireConversation(conversationId: string): ConversationEntity {
    const conversation = this.conversationRepo.findById(conversationId);
    if (!conversation)
      throw new LocalNotFoundError(`Conversation ${conversationId} not found`);
    return conversation;
  }

  private requireQueueItem(queueItemId: string): QueueItemEntity {
    const item = this.queueRepo.findById(queueItemId);
    if (!item)
      throw new LocalNotFoundError(`Queue item ${queueItemId} not found`);
    return item;
  }

  private requireRun(localRunId: string): RunEntity {
    const run = this.runRepo.findById(localRunId);
    if (!run) throw new LocalNotFoundError(`Run ${localRunId} not found`);
    return run;
  }

  private toDraft(
    draft: DraftEntity | null,
    conversationId: string,
  ): DraftResponse {
    return {
      object: "emu_chat.draft",
      conversation_id: conversationId,
      content: draft?.content ?? "",
      revision: draft?.revision ?? 0,
      updated_at: draft?.updated_at ?? null,
    };
  }

  private payloadAvailable(item: QueueItemEntity): boolean {
    return (
      item.payload_text !== null &&
      (item.payload_expired_at === null ||
        Date.parse(item.payload_expired_at) > Date.now()) &&
      item.payload_discarded_at === null
    );
  }

  private toQueueItem(item: QueueItemEntity): QueueItemResponse {
    const available = this.payloadAvailable(item);
    const run = this.runRepo.findByQueueItemId(item.id);
    return {
      object: "emu_chat.queue_item",
      id: item.id,
      conversation_id: item.conversation_id,
      operation_id: item.operation_id,
      fifo_seq: item.fifo_seq,
      state: item.state,
      content: available ? item.payload_text : null,
      payload_bytes: item.payload_bytes,
      payload_available: available,
      recovery_expires_at: item.recovery_expires_at,
      payload_expired_at: item.payload_expired_at,
      local_run_id: run?.id ?? null,
      revision: item.revision,
      last_error_code: item.last_error_code,
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  }

  private toQueueList(
    conversation: ConversationEntity,
    items: QueueItemEntity[],
  ): QueueListResponse {
    return {
      object: "emu_chat.queue",
      conversation_id: conversation.id,
      paused: Boolean(conversation.queue_paused),
      pause_reason:
        conversation.pause_reason as QueueListResponse["pause_reason"],
      data: items.map((item) => this.toQueueItem(item)),
    };
  }

  private toRun(run: RunEntity, status?: HermesRunStatusResponse): RunResponse {
    const approval = status?.approval ?? null;
    const safeApproval = approval
      ? {
          request_id: approval.request_id,
          ...(approval.command === undefined
            ? {}
            : { command: approval.command }),
          ...(approval.description === undefined
            ? {}
            : { description: approval.description }),
          choices: approval.choices.filter(
            (choice): choice is "once" | "deny" =>
              choice === "once" || choice === "deny",
          ),
          ...(approval.deadline_at === undefined
            ? {}
            : { deadline_at: approval.deadline_at }),
        }
      : null;
    return {
      object: "emu_chat.run",
      id: run.id,
      conversation_id: run.conversation_id,
      queue_item_id: run.queue_item_id,
      hermes_run_id: run.hermes_run_id,
      local_state: run.local_state,
      upstream_status: status?.status ?? run.upstream_status,
      partial: status?.partial ?? Boolean(run.partial),
      last_event_seq: run.last_event_seq,
      events_truncated: Boolean(run.events_truncated),
      approval: safeApproval,
      last_error_code: run.last_error_code,
      started_at: run.started_at,
      terminal_at: run.terminal_at,
      updated_at: run.updated_at,
    };
  }
}
