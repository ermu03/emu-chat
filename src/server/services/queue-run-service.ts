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
import type { MediaService } from "../media/service.js";
import type { AttachmentRef } from "../../shared/media-schemas.js";
import { enqueueMediaSync, queueMediaRegistration } from "../media/sync.js";

type WakeCoordinator = () => void;
type ReconcileCoordinator = (localRunId: string) => Promise<void>;
type StopCoordinator = (localRunId: string) => Promise<void>;
type ApproveCoordinator = (
  localRunId: string,
  input: ApprovalRequest,
) => Promise<void>;

export interface QueueRunServiceOptions {
  db: Database.Database;
  conversationRepo: ConversationRepository;
  draftRepo: DraftRepository;
  queueRepo: QueueRepository;
  runRepo: RunRepository;
  leaseRepo: LeaseRepository;
  hermesAdapter: HermesAdapter;
  mediaService?: MediaService;
  wakeCoordinator: WakeCoordinator;
  reconcileCoordinator: ReconcileCoordinator;
  stopCoordinator: StopCoordinator;
  approveCoordinator: ApproveCoordinator;
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
  private readonly mediaService: MediaService | undefined;
  private readonly wakeCoordinator: WakeCoordinator;
  private readonly reconcileCoordinator: ReconcileCoordinator;
  private readonly stopCoordinator: StopCoordinator;
  private readonly approveCoordinator: ApproveCoordinator;

  constructor(options: QueueRunServiceOptions) {
    this.db = options.db;
    this.conversationRepo = options.conversationRepo;
    this.draftRepo = options.draftRepo;
    this.queueRepo = options.queueRepo;
    this.runRepo = options.runRepo;
    this.leaseRepo = options.leaseRepo;
    this.hermesAdapter = options.hermesAdapter;
    this.mediaService = options.mediaService;
    this.wakeCoordinator = options.wakeCoordinator;
    this.reconcileCoordinator = options.reconcileCoordinator;
    this.stopCoordinator = options.stopCoordinator;
    this.approveCoordinator = options.approveCoordinator;
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

      this.requireMutableConversation(conversationId);

      const draft = this.draftRepo.findByConversationId(conversationId);
      const currentRevision = draft?.revision ?? 0;
      if (!draft || currentRevision !== expectedDraftRevision) {
        throw new DraftConflictError("Draft revision conflict", {
          current_revision: currentRevision,
          expected_revision: expectedDraftRevision,
        });
      }
      const attachments = JSON.parse(draft.attachments_json) as AttachmentRef[];
      if (draft.content.trim().length === 0 && attachments.length === 0) {
        throw new StateConflictError("Draft content cannot be empty", {
          current_state: "empty_draft",
        });
      }

      const payloadBytes =
        Buffer.byteLength(draft.content, "utf8") +
        (attachments.length
          ? Buffer.byteLength(draft.attachments_json, "utf8")
          : 0);
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
        .update(
          attachments.length
            ? JSON.stringify({ version: 1, text: draft.content, attachments })
            : draft.content,
          "utf8",
        )
        .digest("hex");

      this.db
        .prepare(
          `INSERT INTO queue_items (
             id, conversation_id, operation_id, client_request_id, fifo_seq,
             state, payload_text, payload_attachments_json, payload_sha256,
             payload_bytes, media_state, revision,
             idempotency_key, dispatch_session_id, attempt_count,
             first_attempt_at, admission_deadline_at, recovery_expires_at,
             payload_expired_at, payload_discarded_at, last_error_code,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 0, ?, NULL, 0,
                     NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          itemId,
          conversationId,
          operationId,
          clientRequestId,
          maxSeq.max_seq + 1,
          draft.content,
          draft.attachments_json,
          payloadSha256,
          payloadBytes,
          attachments.length ? "pending" : "ready",
          idempotencyKey,
          now,
          now,
        );

      const draftUpdate = this.db
        .prepare(
          `UPDATE drafts
           SET content = '', attachments_json = '[]', revision = revision + 1, updated_at = ?
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
      if (attachments.length) {
        const sessionId =
          this.requireMutableConversation(conversationId).hermes_session_id;
        queueMediaRegistration(this.db, conversationId, sessionId);
        enqueueMediaSync(
          this.db,
          `draft_${conversationId}`,
          conversationId,
          "reference_put",
          {
            reference_id: `ref_draft_${conversationId}`,
            kind: "draft",
            revision: expectedDraftRevision + 1,
            session_id: sessionId,
            asset_ids: [],
          },
        );
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
    const item = withImmediateTransaction(this.db, () => {
      const current = this.requireQueueItem(queueItemId);
      this.requireMutableConversation(current.conversation_id);
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
      const attachments =
        input.attachments ??
        (JSON.parse(current.payload_attachments_json) as AttachmentRef[]);
      if (!input.content.trim() && attachments.length === 0)
        throw new StateConflictError("Queue item content cannot be empty", {
          current_state: "empty_payload",
        });
      const attachmentsJson = JSON.stringify(attachments);
      const bytes =
        Buffer.byteLength(input.content, "utf8") +
        (attachments.length ? Buffer.byteLength(attachmentsJson, "utf8") : 0);
      if (bytes > LIMITS.INPUT_MAX_BYTES)
        throw new PayloadTooLargeError(
          `Queue item exceeds ${LIMITS.INPUT_MAX_BYTES} bytes`,
        );
      for (const attachment of attachments) {
        const asset = this.mediaService?.findStored(
          current.conversation_id,
          attachment.asset_id,
        );
        if (
          !asset ||
          asset.status !== "ready" ||
          asset.sha256 !== attachment.sha256
        )
          throw new StateConflictError(
            "Image attachment is not ready or has changed",
          );
      }
      const fingerprint = attachments.length
        ? JSON.stringify({ version: 1, text: input.content, attachments })
        : input.content;
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `UPDATE queue_items
           SET payload_text = ?, payload_attachments_json = ?, payload_sha256 = ?, payload_bytes = ?,
               media_state = ?, payload_run_input = NULL,
               revision = revision + 1, updated_at = ?
           WHERE id = ? AND state = 'queued' AND revision = ?`,
        )
        .run(
          input.content,
          attachmentsJson,
          createHash("sha256").update(fingerprint, "utf8").digest("hex"),
          bytes,
          attachments.length ? "pending" : "ready",
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
      this.requireMutableConversation(current.conversation_id);
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
      return this.queueRepo.updateState(queueItemId, current.revision, {
        state: "cancelled",
      });
    });
    return this.toQueueItem(item);
  }

  async resumeQueue(conversationId: string): Promise<QueueListResponse> {
    await this.assertHermesReady();
    const conversation = withImmediateTransaction(this.db, () => {
      const current = this.requireMutableConversation(conversationId);
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
      this.requireMutableConversation(item.conversation_id);
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
      if (
        current &&
        (current.content.length > 0 || current.attachments_json !== "[]") &&
        !input.overwrite_nonempty
      ) {
        throw new DraftConflictError("Draft is not empty", {
          current_revision: current.revision,
        });
      }
      const now = new Date().toISOString();
      if (current) {
        const updated = this.db
          .prepare(
            `UPDATE drafts SET content = ?, attachments_json = ?, revision = revision + 1, updated_at = ?
             WHERE conversation_id = ? AND revision = ?`,
          )
          .run(
            item.payload_text,
            item.payload_attachments_json,
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
            `INSERT INTO drafts (conversation_id, content, attachments_json, revision, created_at, updated_at)
             VALUES (?, ?, ?, 1, ?, ?)`,
          )
          .run(
            item.conversation_id,
            item.payload_text,
            item.payload_attachments_json,
            now,
            now,
          );
      }
      if (
        item.payload_attachments_json !== "[]" ||
        (current?.attachments_json ?? "[]") !== "[]"
      ) {
        const sessionId = this.requireMutableConversation(
          item.conversation_id,
        ).hermes_session_id;
        const assetIds = (
          JSON.parse(item.payload_attachments_json) as AttachmentRef[]
        ).map((attachment) => attachment.asset_id);
        queueMediaRegistration(this.db, item.conversation_id, sessionId);
        enqueueMediaSync(
          this.db,
          `draft_${item.conversation_id}`,
          item.conversation_id,
          "reference_put",
          {
            reference_id: `ref_draft_${item.conversation_id}`,
            kind: "draft",
            revision: current ? current.revision + 1 : 1,
            session_id: sessionId,
            asset_ids: assetIds,
          },
        );
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
      this.requireMutableConversation(current.conversation_id);
      if (!["paused", "review_required", "rejected"].includes(current.state)) {
        throw new StateConflictError(`Queue item is ${current.state}`, {
          current_state: current.state,
        });
      }
      const activeRun = this.runRepo.findByQueueItemId(queueItemId);
      if (
        activeRun &&
        ["submitting", "accepted", "reconciling"].includes(
          activeRun.local_state,
        )
      )
        throw new RunActiveError(
          "Recovery input is still needed by an active Run",
        );
      if (current.payload_text === null && current.payload_run_input === null)
        return current;
      return this.queueRepo.updateState(queueItemId, current.revision, {
        state: current.state,
        payload_text: null,
        payload_discarded_at: new Date().toISOString(),
      });
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
    await this.stopCoordinator(localRunId);
    return this.getRun(localRunId);
  }

  async submitApproval(
    localRunId: string,
    input: ApprovalRequest,
  ): Promise<RunResponse> {
    await this.approveCoordinator(localRunId, input);
    return this.getRun(localRunId);
  }

  async reconcile(localRunId: string): Promise<ReconcileResponse> {
    const run = this.requireRun(localRunId);
    const item = this.requireQueueItem(run.queue_item_id);
    const conversation = this.requireMutableConversation(run.conversation_id);
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

  private requireMutableConversation(
    conversationId: string,
  ): ConversationEntity {
    const conversation = this.requireConversation(conversationId);
    if (conversation.delete_state !== "none") {
      throw new StateConflictError(
        "Conversation is unavailable while deletion is pending or failed",
        { current_state: conversation.delete_state },
      );
    }
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
      attachments:
        this.mediaService?.findManyStored(
          conversationId,
          (JSON.parse(draft?.attachments_json ?? "[]") as AttachmentRef[]).map(
            (attachment) => attachment.asset_id,
          ),
        ) ?? [],
      revision: draft?.revision ?? 0,
      updated_at: draft?.updated_at ?? null,
    };
  }

  private payloadAvailable(item: QueueItemEntity): boolean {
    const recoverable = ["paused", "review_required", "rejected"].includes(
      item.state,
    );
    return (
      item.payload_text !== null &&
      item.payload_expired_at === null &&
      (!recoverable ||
        (item.recovery_expires_at !== null &&
          Date.parse(item.recovery_expires_at) > Date.now())) &&
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
      attachments: available
        ? (this.mediaService?.findManyStored(
            item.conversation_id,
            (JSON.parse(item.payload_attachments_json) as AttachmentRef[]).map(
              (attachment) => attachment.asset_id,
            ),
          ) ?? [])
        : [],
      media_state: item.media_state,
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
