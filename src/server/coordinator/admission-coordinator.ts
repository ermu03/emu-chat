import { createHash } from "node:crypto";
import { generateId, ID_PREFIXES } from "../../shared/ids.js";
import { LIMITS } from "../../shared/limits.js";
import type { QueueItemEntity, RunEntity } from "../db/schema-types.js";
import { ConversationRepository } from "../db/repositories/conversation.repository.js";
import { LeaseRepository } from "../db/repositories/lease.repository.js";
import { QueueRepository } from "../db/repositories/queue.repository.js";
import { RunRepository } from "../db/repositories/run.repository.js";
import { HermesAdapter, type HermesRunEvent } from "../hermes/adapter.js";
import { SSEHub } from "../sse/sse-hub.js";
import {
  ApprovalNotPendingError,
  ConflictError,
  HermesNotReadyError,
  HermesProtocolError,
  LocalNotFoundError,
  StateConflictError,
} from "../domain/errors.js";

type LeasePair = { global: string; conversation: string };

/** Coordinates the single local admission slot and run lifecycle. */
export class AdmissionCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private stopped = false;
  private restartRecoveryMarked = false;
  private lastLeaseHeartbeatAt = 0;
  private readonly ownerId = `inst_${process.pid}_${generateId(ID_PREFIXES.request).slice(3, 11)}`;
  private readonly leases = new Map<string, LeasePair>();

  constructor(
    private readonly queueRepo: QueueRepository,
    private readonly runRepo: RunRepository,
    private readonly leaseRepo: LeaseRepository,
    private readonly conversationRepo: ConversationRepository,
    private readonly hermesAdapter: HermesAdapter,
    private readonly sseHub: SSEHub,
  ) {}

  start(intervalMs = 2000): void {
    if (this.timer) return;
    this.stopped = false;
    if (!this.restartRecoveryMarked) {
      for (const run of this.runRepo.findActiveAll()) {
        if (!run.events_truncated)
          this.runRepo.update(run.id, { events_truncated: 1 });
        this.sseHub.publishGap(run.id, "process_restarted");
      }
      this.restartRecoveryMarked = true;
    }
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [runId, pair] of this.leases) this.releaseLeases(runId, pair);
    this.leases.clear();
  }

  /** Wake the dispatcher after a queue mutation commits. */
  wake(): void {
    void this.tick();
  }

  /** Run a safe, read-only reconciliation pass for a browser-triggered request. */
  async reconcileRun(localRunId: string): Promise<void> {
    const run = this.runRepo.findById(localRunId);
    if (!run) throw new LocalNotFoundError(`Run ${localRunId} not found`);
    await this.reconcileById(localRunId, run.conversation_id);
  }

  async enqueueMessage(input: {
    conversation_id: string;
    client_request_id: string;
    text: string;
  }): Promise<{
    queue_item_id: string;
    operation_id: string;
    state: QueueItemEntity["state"];
    position: number;
    replayed?: boolean;
  }> {
    const conversation = this.conversationRepo.findById(input.conversation_id);
    if (!conversation)
      throw new LocalNotFoundError(
        `Conversation ${input.conversation_id} not found`,
      );
    if (!input.text || input.text.trim().length === 0)
      throw new StateConflictError("Message content cannot be empty");
    const payloadBytes = Buffer.byteLength(input.text, "utf8");
    if (payloadBytes > LIMITS.INPUT_MAX_BYTES)
      throw new StateConflictError(
        `Message exceeds ${LIMITS.INPUT_MAX_BYTES} bytes`,
      );

    const existing = this.queueRepo.findByClientRequestId(
      input.client_request_id,
    );
    if (existing) {
      if (existing.conversation_id !== input.conversation_id)
        throw new ConflictError(
          "client_request_id is already used by another conversation",
        );
      return {
        queue_item_id: existing.id,
        operation_id: existing.operation_id,
        state: existing.state,
        position: this.position(existing),
        replayed: true,
      };
    }

    try {
      await this.hermesAdapter.assertReady();
    } catch (error) {
      if (error instanceof HermesNotReadyError) throw error;
      throw new HermesNotReadyError(
        "Hermes is not ready to accept a new message",
      );
    }

    const item = this.queueRepo.enqueue({
      id: generateId(ID_PREFIXES.queueItem),
      conversation_id: input.conversation_id,
      operation_id: generateId(ID_PREFIXES.operation),
      client_request_id: input.client_request_id,
      state: "queued",
      payload_text: input.text,
      payload_sha256: createHash("sha256")
        .update(input.text, "utf8")
        .digest("hex"),
      payload_bytes: payloadBytes,
      idempotency_key: generateId(ID_PREFIXES.idempotency),
      dispatch_session_id: null,
      first_attempt_at: null,
      admission_deadline_at: null,
      recovery_expires_at: null,
      payload_expired_at: null,
      payload_discarded_at: null,
      last_error_code: null,
    });
    void this.tick();
    return {
      queue_item_id: item.id,
      operation_id: item.operation_id,
      state: item.state,
      position: this.position(item),
    };
  }

  async cancelQueueItem(
    conversationId: string,
    queueItemId: string,
  ): Promise<QueueItemEntity> {
    const item = this.queueRepo.findById(queueItemId);
    if (!item || item.conversation_id !== conversationId)
      throw new LocalNotFoundError(`Queue item ${queueItemId} not found`);
    if (item.state !== "queued")
      throw new StateConflictError(
        `Cannot cancel queue item in state ${item.state}`,
      );
    const updated = this.queueRepo.updateState(queueItemId, item.revision, {
      state: "cancelled",
      payload_text: null,
    });
    return updated;
  }

  async getQueue(conversationId: string): Promise<QueueItemEntity[]> {
    if (!this.conversationRepo.findById(conversationId))
      throw new LocalNotFoundError(`Conversation ${conversationId} not found`);
    return this.queueRepo.listByConversation(conversationId);
  }

  async getRun(conversationId: string, runId: string): Promise<RunEntity> {
    const run = this.runRepo.findById(runId);
    if (!run || run.conversation_id !== conversationId)
      throw new LocalNotFoundError(`Run ${runId} not found`);
    return run;
  }

  async cancelRun(conversationId: string, runId: string): Promise<RunEntity> {
    const run = await this.getRun(conversationId, runId);
    if (
      !run.hermes_run_id ||
      ["reconciled", "rejected"].includes(run.local_state)
    )
      return run;
    if (run.upstream_status === "stopping") return run;
    const updated = this.runRepo.update(run.id, {
      upstream_status: "stopping",
    });
    this.conversationRepo.setQueuePaused(conversationId, true, "user_stopped");
    try {
      await this.hermesAdapter.stopRun(run.hermes_run_id);
    } finally {
      this.emitRunEvent(run.id, "run.stopping", {});
    }
    return updated;
  }

  async submitApproval(
    conversationId: string,
    runId: string,
    decision: "once" | "deny" | "reject" | "always",
  ): Promise<RunEntity> {
    const run = await this.getRun(conversationId, runId);
    if (run.upstream_status !== "waiting_for_approval" || !run.hermes_run_id)
      throw new ApprovalNotPendingError(
        `Run ${runId} is not waiting for approval`,
      );
    if (decision === "always" || decision === "reject")
      throw new StateConflictError(
        "Only once or deny approval decisions are supported",
      );
    await this.hermesAdapter.submitApproval(run.hermes_run_id, decision);
    const updated = this.runRepo.update(run.id, { upstream_status: "running" });
    this.emitRunEvent(run.id, "approval.submitted", { choice: decision });
    return updated;
  }

  async tick(): Promise<void> {
    if (this.stopped || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      this.heartbeatLeases();
      const active = this.queueRepo.findActiveGlobal();
      if (active) {
        const run = this.runRepo.findByQueueItemId(active.id);
        if (run && run.hermes_run_id && !this.leases.has(run.id))
          await this.recoverRun(active, run);
        return;
      }
      const candidate = this.queueRepo.findNextGlobalQueued();
      if (!candidate) return;
      const conversation = this.conversationRepo.findById(
        candidate.conversation_id,
      );
      if (
        !conversation ||
        conversation.queue_paused ||
        conversation.delete_state !== "none"
      )
        return;
      await this.dispatch(candidate, conversation.hermes_session_id);
    } finally {
      this.tickInFlight = false;
    }
  }

  private async dispatch(
    item: QueueItemEntity,
    sessionId: string,
  ): Promise<void> {
    if (this.stopped) return;
    const globalToken = generateId(ID_PREFIXES.request);
    const conversationToken = generateId(ID_PREFIXES.request);
    if (
      !this.leaseRepo.acquire(
        "global",
        "global",
        this.ownerId,
        globalToken,
        LIMITS.LEASE_TTL_MS,
      )
    )
      return;
    if (
      !this.leaseRepo.acquire(
        "conversation",
        item.conversation_id,
        this.ownerId,
        conversationToken,
        LIMITS.LEASE_TTL_MS,
      )
    ) {
      this.leaseRepo.release("global", "global", globalToken);
      return;
    }
    const pair = { global: globalToken, conversation: conversationToken };
    try {
      const current = this.queueRepo.findById(item.id);
      if (!current || current.state !== "queued") {
        this.leaseRepo.release(
          "conversation",
          item.conversation_id,
          conversationToken,
        );
        this.leaseRepo.release("global", "global", globalToken);
        return;
      }
      const now = new Date().toISOString();
      const dispatching = this.queueRepo.updateState(
        current.id,
        current.revision,
        {
          state: "dispatching",
          dispatch_session_id: sessionId,
          attempt_count: Math.max(1, current.attempt_count),
          first_attempt_at: current.first_attempt_at ?? now,
          admission_deadline_at:
            current.admission_deadline_at ??
            new Date(
              Date.now() + LIMITS.IDEMPOTENCY_WINDOW_SECONDS * 1000,
            ).toISOString(),
        },
      );
      const run = this.runRepo.insert({
        id: generateId(ID_PREFIXES.localRun),
        queue_item_id: dispatching.id,
        conversation_id: dispatching.conversation_id,
        hermes_run_id: null,
        local_state: "submitting",
        upstream_status: null,
        last_event_name: null,
        last_error_code: null,
        last_status_checked_at: null,
        reconciliation_started_at: null,
        started_at: now,
        terminal_at: null,
        reconciled_at: null,
      });
      this.leases.set(run.id, pair);
      this.emitRunEvent(run.id, "run.started", { queue_item_id: item.id });
      void this.submit(run, dispatching);
    } catch (error) {
      this.leaseRepo.release(
        "conversation",
        item.conversation_id,
        conversationToken,
      );
      this.leaseRepo.release("global", "global", globalToken);
      throw error;
    }
  }

  private async submit(run: RunEntity, item: QueueItemEntity): Promise<void> {
    try {
      if (!item.payload_text || !item.dispatch_session_id)
        throw new HermesProtocolError("Queue payload is incomplete");
      const admission = await this.hermesAdapter.startRun(
        item.dispatch_session_id,
        { prompt: item.payload_text, idempotency_key: item.idempotency_key },
      );
      if (this.stopped || !this.leases.has(run.id)) return;
      if (!admission.run_id)
        throw new HermesProtocolError("Hermes admission did not return run_id");
      this.runRepo.update(run.id, {
        hermes_run_id: admission.run_id,
        local_state: "accepted",
        upstream_status: null,
      });
      const accepted = this.queueRepo.findById(item.id);
      if (accepted)
        this.queueRepo.updateState(item.id, accepted.revision, {
          state: "accepted",
        });
      this.emitRunEvent(run.id, "run.accepted", {
        hermes_run_id: admission.run_id,
      });
      await this.consume(
        run.id,
        item.conversation_id,
        item.dispatch_session_id,
        admission.run_id,
      );
    } catch (error) {
      if (this.stopped || !this.leases.has(run.id)) return;
      const current = this.runRepo.findById(run.id);
      if (current && !current.hermes_run_id) {
        const code = this.errorCode(error);
        this.runRepo.update(run.id, {
          local_state: "rejected",
          last_error_code: code,
          terminal_at: new Date().toISOString(),
        });
        const queued = this.queueRepo.findById(item.id);
        if (queued)
          this.queueRepo.updateState(item.id, queued.revision, {
            state: "rejected",
            recovery_expires_at: new Date(
              Date.now() + LIMITS.RECOVERY_RETENTION_MS,
            ).toISOString(),
            last_error_code: code,
          });
        this.conversationRepo.setQueuePaused(
          item.conversation_id,
          true,
          "submission_rejected",
        );
        this.emitRunEvent(run.id, "run.failed", { code });
        this.releaseLeases(run.id);
      } else {
        this.sseHub.publishGap(run.id, "upstream_disconnected");
      }
    }
  }

  private async consume(
    localRunId: string,
    conversationId: string,
    sessionId: string,
    hermesRunId: string,
  ): Promise<void> {
    try {
      for await (const event of this.hermesAdapter.streamEvents(
        sessionId,
        hermesRunId,
      )) {
        if (this.stopped || !this.leases.has(localRunId)) return;
        this.handleEvent(localRunId, event);
        if (this.isTerminalEvent(event.type)) break;
      }
    } catch {
      if (!this.stopped)
        this.sseHub.publishGap(localRunId, "upstream_disconnected");
    }
    if (this.stopped || !this.leases.has(localRunId)) return;
    await this.reconcileById(localRunId, conversationId, true);
  }

  private handleEvent(localRunId: string, event: HermesRunEvent): void {
    const run = this.runRepo.findById(localRunId);
    if (!run) return;
    if (event.type === "approval.request")
      this.runRepo.update(localRunId, {
        upstream_status: "waiting_for_approval",
      });
    if (event.type === "run.completed")
      this.runRepo.update(localRunId, { upstream_status: "completed" });
    if (event.type === "run.failed")
      this.runRepo.update(localRunId, { upstream_status: "failed" });
    if (event.type === "run.cancelled")
      this.runRepo.update(localRunId, { upstream_status: "cancelled" });
    this.emitRunEvent(localRunId, event.type, event.data);
  }

  private async recoverRun(
    item: QueueItemEntity,
    run: RunEntity,
  ): Promise<void> {
    if (run.hermes_run_id)
      await this.reconcileById(run.id, item.conversation_id);
  }

  private async reconcileById(
    localRunId: string,
    conversationId: string,
    requireOwnedLease = false,
  ): Promise<void> {
    if (this.stopped) return;
    const run = this.runRepo.findById(localRunId);
    if (!run || !run.hermes_run_id) return;
    let status;
    try {
      status = await this.hermesAdapter.getRunStatus(run.hermes_run_id);
    } catch {
      return;
    }
    if (this.stopped || (requireOwnedLease && !this.leases.has(localRunId)))
      return;
    this.runRepo.update(run.id, {
      upstream_status: status.status,
      last_status_checked_at: new Date().toISOString(),
      partial: status.partial ? 1 : 0,
    });
    if (!this.isTerminalStatus(status.status)) return;
    const current = this.runRepo.findById(run.id)!;
    this.runRepo.update(run.id, {
      local_state: "reconciling",
      terminal_at: current.terminal_at ?? new Date().toISOString(),
      reconciliation_started_at:
        current.reconciliation_started_at ?? new Date().toISOString(),
    });
    const conversation = this.conversationRepo.findById(conversationId);
    let messagesOk = Boolean(conversation?.hermes_session_id);
    if (conversation?.hermes_session_id) {
      try {
        await this.hermesAdapter.getSessionMessages(
          conversation.hermes_session_id,
          { limit: 1, offset: 0, order: "latest" },
        );
      } catch {
        messagesOk = false;
      }
    }
    if (this.stopped || (requireOwnedLease && !this.leases.has(localRunId)))
      return;
    const item = this.queueRepo.findById(current.queue_item_id);
    if (!item) return;
    if (messagesOk && status.status === "completed" && !status.partial) {
      this.runRepo.update(run.id, {
        local_state: "reconciled",
        reconciled_at: new Date().toISOString(),
      });
      this.queueRepo.updateState(item.id, item.revision, {
        state: "done",
        payload_text: null,
        recovery_expires_at: null,
      });
      this.conversationRepo.setQueuePaused(conversationId, false, null);
      this.emitRunEvent(run.id, "run.reconciled", {
        upstream_status: status.status,
      });
    } else if (messagesOk) {
      this.runRepo.update(run.id, { local_state: "reconciled" });
      const reason =
        status.status === "cancelled"
          ? "run_cancelled"
          : status.status === "interrupted"
            ? "run_interrupted"
            : status.partial
              ? "run_partial"
              : "run_failed";
      this.queueRepo.updateState(item.id, item.revision, {
        state: "paused",
        recovery_expires_at: new Date(
          Date.now() + LIMITS.RECOVERY_RETENTION_MS,
        ).toISOString(),
      });
      this.conversationRepo.setQueuePaused(conversationId, true, reason);
      this.emitRunEvent(run.id, "run.paused", {
        reason,
        review_required: false,
      });
    } else {
      this.runRepo.update(run.id, {
        local_state: "review_required",
        events_truncated: 1,
        last_error_code: "RECONCILIATION_FAILED",
      });
      this.queueRepo.updateState(item.id, item.revision, {
        state: "review_required",
        recovery_expires_at: new Date(
          Date.now() + LIMITS.RECOVERY_RETENTION_MS,
        ).toISOString(),
        last_error_code: "RECONCILIATION_FAILED",
      });
      this.conversationRepo.setQueuePaused(
        conversationId,
        true,
        "reconciliation_failed",
      );
    }
    this.releaseLeases(run.id);
  }

  private emitRunEvent(
    localRunId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    if (this.stopped) return;
    const run = this.runRepo.appendEvent(localRunId, type);
    this.sseHub.publishRunEvent(run.id, run.last_event_seq, type, payload);
  }

  private heartbeatLeases(): void {
    const now = Date.now();
    if (now - this.lastLeaseHeartbeatAt < LIMITS.LEASE_HEARTBEAT_INTERVAL_MS)
      return;
    this.lastLeaseHeartbeatAt = now;
    for (const [runId, pair] of this.leases) {
      const run = this.runRepo.findById(runId);
      if (!run) {
        this.releaseLeases(runId, pair);
        continue;
      }
      const globalRenewed = this.leaseRepo.renew(
        "global",
        "global",
        pair.global,
        LIMITS.LEASE_TTL_MS,
      );
      const conversationRenewed = this.leaseRepo.renew(
        "conversation",
        run.conversation_id,
        pair.conversation,
        LIMITS.LEASE_TTL_MS,
      );
      if (!globalRenewed || !conversationRenewed) {
        this.releaseLeases(runId, pair);
        this.sseHub.publishGap(runId, "upstream_disconnected");
      }
    }
  }

  private releaseLeases(runId: string, pair = this.leases.get(runId)): void {
    if (!pair) return;
    this.leaseRepo.release("global", "global", pair.global);
    const run = this.runRepo.findById(runId);
    if (run)
      this.leaseRepo.release(
        "conversation",
        run.conversation_id,
        pair.conversation,
      );
    this.leases.delete(runId);
  }

  private position(item: QueueItemEntity): number {
    const candidates = this.queueRepo
      .listByConversation(item.conversation_id)
      .filter((entry) => entry.state === "queued" || entry.id === item.id);
    const index = candidates.findIndex((entry) => entry.id === item.id);
    return index < 0 ? 0 : index + 1;
  }

  private errorCode(error: unknown): string {
    return error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "HERMES_UNAVAILABLE";
  }

  private isTerminalStatus(status: string): boolean {
    return ["completed", "failed", "cancelled", "interrupted"].includes(status);
  }
  private isTerminalEvent(type: string): boolean {
    return [
      "run.completed",
      "run.failed",
      "run.cancelled",
      "run.interrupted",
    ].includes(type);
  }
}
