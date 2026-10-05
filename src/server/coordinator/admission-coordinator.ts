import type Database from "better-sqlite3";
import type { ApprovalRequest } from "../../shared/api-schemas.js";
import { generateId, ID_PREFIXES } from "../../shared/ids.js";
import { LIMITS } from "../../shared/limits.js";
import type { QueueItemEntity, RunEntity } from "../db/schema-types.js";
import { ConversationRepository } from "../db/repositories/conversation.repository.js";
import { LeaseRepository } from "../db/repositories/lease.repository.js";
import { QueueRepository } from "../db/repositories/queue.repository.js";
import { RunRepository } from "../db/repositories/run.repository.js";
import { HermesAdapter, type HermesRunEvent } from "../hermes/adapter.js";
import { SSEHub } from "../sse/sse-hub.js";
import { maskDisplaySensitiveText } from "../display-masking.js";
import {
  ApprovalNotPendingError,
  AppError,
  HermesAuthFailedError,
  HermesNotFoundError,
  HermesProtocolError,
  LocalNotFoundError,
  StateConflictError,
} from "../domain/errors.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { logger } from "../logging.js";
import type { MediaDispatchService } from "../media/dispatch.js";

type LeasePair = { global: string; conversation: string };
type RunConsumer = {
  pair: LeasePair;
  controller: AbortController;
  attempts: number;
  flight: Promise<void> | null;
  retryTimer: NodeJS.Timeout | null;
};

/** Coordinates the single local admission slot and run lifecycle. */
export class AdmissionCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private stopped = false;
  private restartRecoveryMarked = false;
  private lastLeaseHeartbeatAt = 0;
  private readonly ownerId = `inst_${process.pid}_${generateId(ID_PREFIXES.request).slice(3, 11)}`;
  private readonly leases = new Map<string, LeasePair>();
  private readonly submitFlights = new Set<string>();
  private readonly reconcileFlights = new Map<string, Promise<void>>();
  private readonly consumers = new Map<string, RunConsumer>();

  constructor(
    private readonly db: Database.Database,
    private readonly queueRepo: QueueRepository,
    private readonly runRepo: RunRepository,
    private readonly leaseRepo: LeaseRepository,
    private readonly conversationRepo: ConversationRepository,
    private readonly hermesAdapter: HermesAdapter,
    private readonly sseHub: SSEHub,
    private readonly mediaDispatch?: MediaDispatchService,
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
    this.scheduleTick();
    this.timer = setInterval(() => this.scheduleTick(), intervalMs);
    this.heartbeatTimer = setInterval(
      () => this.heartbeatLeases(),
      LIMITS.LEASE_HEARTBEAT_INTERVAL_MS,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.timer = null;
    this.heartbeatTimer = null;
    for (const runId of this.consumers.keys()) this.cancelConsumer(runId);
    for (const [runId, pair] of this.leases) this.releaseLeases(runId, pair);
    this.leases.clear();
    await Promise.allSettled(
      [...this.consumers.values()].flatMap((consumer) =>
        consumer.flight ? [consumer.flight] : [],
      ),
    );
  }

  /** Wake the dispatcher after a queue mutation commits. */
  wake(): void {
    this.scheduleTick();
  }

  private scheduleTick(): void {
    void this.tick().catch((error: unknown) => {
      logger.error("Coordinator tick failed", {
        details: {
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
      });
    });
  }

  /** Reconcile a Run through the same entry used by polling and SSE. */
  async reconcileRun(localRunId: string): Promise<void> {
    const run = this.runRepo.findById(localRunId);
    if (!run) throw new LocalNotFoundError(`Run ${localRunId} not found`);
    await this.reconcileById(localRunId, run.conversation_id);
  }

  async stopRun(localRunId: string): Promise<void> {
    if (this.stopped) throw new StateConflictError("Coordinator is stopped");
    const stop = withImmediateTransaction(this.db, () => {
      const run = this.requireRun(localRunId);
      const item = this.queueRepo.findById(run.queue_item_id);
      this.requireMutableConversation(run.conversation_id);
      if (
        run.local_state === "reconciling" ||
        run.local_state === "reconciled" ||
        this.isTerminalStatus(run.upstream_status ?? "")
      ) {
        throw new StateConflictError(`Run is ${run.local_state}`, {
          current_state: run.local_state,
        });
      }
      if (run.upstream_status === "stopping")
        return { runId: run.hermes_run_id, shouldStop: false };
      if (
        run.local_state !== "accepted" ||
        item?.state !== "accepted" ||
        !run.hermes_run_id
      ) {
        throw new StateConflictError(
          "Run cannot be stopped in its current state",
          { current_state: run.local_state },
        );
      }
      this.runRepo.update(run.id, { upstream_status: "stopping" });
      this.conversationRepo.setQueuePaused(
        run.conversation_id,
        true,
        "user_stopped",
      );
      return { runId: run.hermes_run_id, shouldStop: true };
    });
    if (stop.shouldStop && stop.runId)
      await this.hermesAdapter.stopRun(stop.runId);
  }

  async submitApproval(
    localRunId: string,
    input: ApprovalRequest,
  ): Promise<void> {
    if (this.stopped) throw new StateConflictError("Coordinator is stopped");
    const run = this.requireRun(localRunId);
    this.requireMutableConversation(run.conversation_id);
    if (
      run.local_state !== "accepted" ||
      !run.hermes_run_id ||
      run.upstream_status !== "waiting_for_approval"
    ) {
      throw new ApprovalNotPendingError(
        `Run ${localRunId} is not waiting for approval`,
      );
    }
    const status = await this.hermesAdapter.getRunStatus(run.hermes_run_id);
    if (this.stopped) throw new StateConflictError("Coordinator is stopped");
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
    this.requireMutableConversation(run.conversation_id);
    await this.hermesAdapter.submitApproval(
      run.hermes_run_id,
      input.choice,
      approval.request_id,
    );
    if (this.stopped) throw new StateConflictError("Coordinator is stopped");
    withImmediateTransaction(this.db, () => {
      const current = this.requireRun(run.id);
      const item = this.queueRepo.findById(current.queue_item_id);
      this.requireMutableConversation(current.conversation_id);
      if (
        current.hermes_run_id !== run.hermes_run_id ||
        current.local_state !== "accepted" ||
        item?.state !== "accepted" ||
        current.upstream_status !== "waiting_for_approval"
      )
        return;
      this.runRepo.update(current.id, { upstream_status: "running" });
    });
    // The approval can finish before the SSE consumer receives another event.
    await this.reconcileById(run.id, run.conversation_id);
  }

  async tick(): Promise<void> {
    if (this.stopped || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      this.heartbeatLeases();
      const active = this.queueRepo.findActiveGlobal();
      if (active) {
        const run = this.runRepo.findByQueueItemId(active.id);
        if (run && !run.hermes_run_id) {
          await this.recoverSubmitting(active, run);
          return;
        }
        // SSE can close before an upstream run becomes terminal. Poll the
        // authoritative run status while an item is active so a closed stream
        // cannot strand the local queue behind a retained lease.
        if (run && run.hermes_run_id) await this.recoverRun(active, run);
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
      await this.dispatch(candidate);
    } finally {
      this.tickInFlight = false;
    }
  }

  private async dispatch(item: QueueItemEntity): Promise<void> {
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
      const started = withImmediateTransaction(this.db, () => {
        const current = this.queueRepo.findById(item.id);
        const conversation = this.conversationRepo.findById(
          item.conversation_id,
        );
        if (
          !this.ownsLeases(item.conversation_id, pair) ||
          !current ||
          current.state !== "queued" ||
          !conversation ||
          conversation.queue_paused ||
          conversation.delete_state !== "none"
        )
          return null;
        const now = new Date().toISOString();
        const dispatching = this.queueRepo.updateState(
          current.id,
          current.revision,
          {
            state: "dispatching",
            dispatch_session_id: conversation.hermes_session_id,
            attempt_count: 1,
            first_attempt_at: now,
            admission_deadline_at: new Date(
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
        return { run, dispatching };
      });
      if (!started) {
        this.leaseRepo.release(
          "conversation",
          item.conversation_id,
          conversationToken,
        );
        this.leaseRepo.release("global", "global", globalToken);
        return;
      }
      const { run, dispatching } = started;
      this.leases.set(run.id, pair);
      this.emitRunEvent(run.id, "run.started", { queue_item_id: item.id });
      this.scheduleSubmit(run, dispatching);
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

  private scheduleSubmit(run: RunEntity, item: QueueItemEntity): void {
    if (this.submitFlights.has(run.id)) return;
    this.submitFlights.add(run.id);
    void this.submit(run, item)
      .catch((error: unknown) => {
        logger.error("Run submission recovery failed", {
          details: {
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
        });
      })
      .finally(() => this.submitFlights.delete(run.id));
  }

  private async submit(run: RunEntity, item: QueueItemEntity): Promise<void> {
    let requestStarted = false;
    try {
      if (item.payload_text === null || !item.dispatch_session_id)
        throw new HermesProtocolError("Queue payload is incomplete");
      const attachments = JSON.parse(
        item.payload_attachments_json,
      ) as unknown[];
      const prompt = attachments.length
        ? await this.mediaDispatch?.prepare(item)
        : item.payload_text;
      if (prompt === undefined)
        throw new HermesProtocolError("Image dispatch service is unavailable");
      requestStarted = true;
      const admission = await this.hermesAdapter.startRun(
        item.dispatch_session_id,
        { prompt, idempotency_key: item.idempotency_key },
      );
      if (this.stopped || !this.ownsRunLease(run.id, item.conversation_id))
        return;
      if (!admission.run_id)
        throw new HermesProtocolError("Hermes admission did not return run_id");
      const accepted = withImmediateTransaction(this.db, () => {
        const currentRun = this.runRepo.findById(run.id);
        const currentItem = this.queueRepo.findById(item.id);
        if (
          !this.ownsRunLease(run.id, item.conversation_id) ||
          currentRun?.local_state !== "submitting" ||
          currentRun.hermes_run_id !== null ||
          currentItem?.state !== "dispatching"
        )
          return false;
        this.runRepo.update(run.id, {
          hermes_run_id: admission.run_id,
          local_state: "accepted",
          upstream_status: null,
          last_error_code: null,
        });
        this.queueRepo.updateState(item.id, currentItem.revision, {
          state: "accepted",
          last_error_code: null,
        });
        return true;
      });
      if (!accepted) {
        this.releaseLeases(run.id);
        return;
      }
      this.emitRunEvent(run.id, "run.accepted", {
        hermes_run_id: admission.run_id,
      });
      this.ensureConsumer(run.id);
    } catch (error) {
      if (this.stopped || !this.ownsRunLease(run.id, item.conversation_id))
        return;
      if (this.runRepo.findById(run.id)?.hermes_run_id) {
        this.sseHub.publishGap(run.id, "upstream_disconnected");
        return;
      }
      if (
        !requestStarted ||
        error instanceof HermesAuthFailedError ||
        error instanceof HermesNotFoundError
      ) {
        this.rejectSubmission(run, item, this.errorCode(error));
      } else {
        this.recordUnknownAdmission(run, item, this.errorCode(error));
      }
    }
  }

  private async recoverSubmitting(
    item: QueueItemEntity,
    run: RunEntity,
  ): Promise<void> {
    if (this.submitFlights.has(run.id) || run.local_state !== "submitting")
      return;
    if (!this.ensureRunLease(run)) return;
    const deadline = item.admission_deadline_at
      ? Date.parse(item.admission_deadline_at)
      : NaN;
    if (
      !Number.isFinite(deadline) ||
      deadline <= Date.now() ||
      item.attempt_count >= LIMITS.MAX_ADMISSION_ATTEMPTS
    ) {
      this.markAdmissionUnconfirmed(run, item);
      return;
    }
    if (
      item.last_error_code &&
      Date.now() - Date.parse(item.updated_at) <
        this.admissionRetryDelayMs(item.attempt_count)
    ) {
      this.releaseLeases(run.id);
      return;
    }
    const retryItem = withImmediateTransaction(this.db, () => {
      const currentRun = this.runRepo.findById(run.id);
      const currentItem = this.queueRepo.findById(item.id);
      if (
        !this.ownsRunLease(run.id, item.conversation_id) ||
        currentRun?.local_state !== "submitting" ||
        currentRun.hermes_run_id !== null ||
        currentItem?.state !== "dispatching" ||
        currentItem.attempt_count >= LIMITS.MAX_ADMISSION_ATTEMPTS ||
        !currentItem.admission_deadline_at ||
        Date.parse(currentItem.admission_deadline_at) <= Date.now()
      )
        return null;
      this.runRepo.update(run.id, { last_error_code: null });
      return this.queueRepo.updateState(item.id, currentItem.revision, {
        state: "dispatching",
        attempt_count: currentItem.attempt_count + 1,
        last_error_code: null,
      });
    });
    if (retryItem) this.scheduleSubmit(run, retryItem);
    else this.releaseLeases(run.id);
  }

  private rejectSubmission(
    run: RunEntity,
    item: QueueItemEntity,
    code: string,
  ): void {
    const rejected = withImmediateTransaction(this.db, () => {
      const currentRun = this.runRepo.findById(run.id);
      const currentItem = this.queueRepo.findById(item.id);
      if (
        !this.ownsRunLease(run.id, item.conversation_id) ||
        currentRun?.local_state !== "submitting" ||
        currentRun.hermes_run_id !== null ||
        currentItem?.state !== "dispatching"
      )
        return false;
      const now = new Date().toISOString();
      this.runRepo.update(run.id, {
        local_state: "rejected",
        last_error_code: code,
        terminal_at: now,
      });
      this.queueRepo.updateState(item.id, currentItem.revision, {
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
      return true;
    });
    if (!rejected) return;
    this.emitRunEvent(run.id, "run.failed", { code });
    this.sseHub.scheduleCleanup(run.id);
    this.releaseLeases(run.id);
    this.scheduleTick();
  }

  private recordUnknownAdmission(
    run: RunEntity,
    item: QueueItemEntity,
    code: string,
  ): void {
    const currentItem = this.queueRepo.findById(item.id);
    if (
      !currentItem ||
      currentItem.attempt_count >= LIMITS.MAX_ADMISSION_ATTEMPTS ||
      !currentItem.admission_deadline_at ||
      Date.parse(currentItem.admission_deadline_at) <= Date.now()
    ) {
      this.markAdmissionUnconfirmed(run, item);
      return;
    }
    const recorded = withImmediateTransaction(this.db, () => {
      const currentRun = this.runRepo.findById(run.id);
      const latestItem = this.queueRepo.findById(item.id);
      if (
        !this.ownsRunLease(run.id, item.conversation_id) ||
        currentRun?.local_state !== "submitting" ||
        currentRun.hermes_run_id !== null ||
        latestItem?.state !== "dispatching"
      )
        return false;
      this.runRepo.update(run.id, { last_error_code: code });
      this.queueRepo.updateState(item.id, latestItem.revision, {
        state: "dispatching",
        last_error_code: code,
      });
      return true;
    });
    if (!recorded) return;
    this.sseHub.publishGap(run.id, "upstream_disconnected");
    this.releaseLeases(run.id);
  }

  private markAdmissionUnconfirmed(
    run: RunEntity,
    item: QueueItemEntity,
  ): void {
    const marked = withImmediateTransaction(this.db, () => {
      const currentRun = this.runRepo.findById(run.id);
      const currentItem = this.queueRepo.findById(item.id);
      if (
        !this.ownsRunLease(run.id, item.conversation_id) ||
        currentRun?.local_state !== "submitting" ||
        currentRun.hermes_run_id !== null ||
        currentItem?.state !== "dispatching"
      )
        return false;
      const now = new Date().toISOString();
      this.runRepo.update(run.id, {
        local_state: "review_required",
        events_truncated: 1,
        last_error_code: "ADMISSION_UNCONFIRMED",
        terminal_at: now,
      });
      this.queueRepo.updateState(item.id, currentItem.revision, {
        state: "review_required",
        recovery_expires_at: new Date(
          Date.now() + LIMITS.RECOVERY_RETENTION_MS,
        ).toISOString(),
        last_error_code: "ADMISSION_UNCONFIRMED",
      });
      this.conversationRepo.setQueuePaused(
        item.conversation_id,
        true,
        "manual_resume_required",
      );
      return true;
    });
    if (!marked) return;
    this.emitRunEvent(run.id, "run.review_required", {
      code: "ADMISSION_UNCONFIRMED",
    });
    this.sseHub.scheduleCleanup(run.id);
    this.releaseLeases(run.id);
    this.scheduleTick();
  }

  private admissionRetryDelayMs(attemptCount: number): number {
    return Math.min(30_000, 5_000 * 2 ** Math.max(0, attemptCount - 1));
  }

  private requireRun(localRunId: string): RunEntity {
    const run = this.runRepo.findById(localRunId);
    if (!run) throw new LocalNotFoundError(`Run ${localRunId} not found`);
    return run;
  }

  private requireMutableConversation(conversationId: string): void {
    const conversation = this.conversationRepo.findById(conversationId);
    if (!conversation)
      throw new LocalNotFoundError(`Conversation ${conversationId} not found`);
    if (conversation.delete_state !== "none") {
      throw new StateConflictError(
        "Conversation is unavailable while deletion is pending or failed",
        { current_state: conversation.delete_state },
      );
    }
  }

  private ensureConsumer(localRunId: string): void {
    if (this.stopped || this.consumers.has(localRunId)) return;
    const run = this.runRepo.findById(localRunId);
    const pair = this.leases.get(localRunId);
    const item = run && this.queueRepo.findById(run.queue_item_id);
    if (
      !run ||
      !pair ||
      !item?.dispatch_session_id ||
      !run.hermes_run_id ||
      run.local_state !== "accepted" ||
      item.state !== "accepted" ||
      this.isTerminalStatus(run.upstream_status ?? "") ||
      !this.ownsLeases(run.conversation_id, pair)
    )
      return;
    const consumer: RunConsumer = {
      pair,
      controller: new AbortController(),
      attempts: 0,
      flight: null,
      retryTimer: null,
    };
    this.consumers.set(localRunId, consumer);
    this.launchConsumer(run, item.dispatch_session_id, consumer);
  }

  private consumerIsCurrent(run: RunEntity, consumer: RunConsumer): boolean {
    if (
      this.stopped ||
      consumer.controller.signal.aborted ||
      this.consumers.get(run.id) !== consumer ||
      this.leases.get(run.id) !== consumer.pair ||
      !this.ownsLeases(run.conversation_id, consumer.pair)
    )
      return false;
    const current = this.runRepo.findById(run.id);
    return (
      current?.local_state === "accepted" &&
      current.hermes_run_id === run.hermes_run_id &&
      !this.isTerminalStatus(current.upstream_status ?? "")
    );
  }

  private launchConsumer(
    run: RunEntity,
    sessionId: string,
    consumer: RunConsumer,
  ): void {
    consumer.attempts += 1;
    consumer.flight = this.consume(run, sessionId, consumer)
      .catch((error: unknown) => {
        // Polling remains available even if local reconciliation fails.
        logger.error("Run event consumer failed", {
          details: {
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
        });
      })
      .finally(() => {
        consumer.flight = null;
        if (!this.consumerIsCurrent(run, consumer)) {
          if (this.consumers.get(run.id) === consumer)
            this.consumers.delete(run.id);
          return;
        }
        if (consumer.attempts >= LIMITS.UPSTREAM_SSE_MAX_ATTEMPTS) return;
        consumer.retryTimer = setTimeout(
          () => {
            consumer.retryTimer = null;
            if (this.consumers.get(run.id) !== consumer) return;
            if (this.consumerIsCurrent(run, consumer))
              this.launchConsumer(run, sessionId, consumer);
            else this.cancelConsumer(run.id);
          },
          LIMITS.UPSTREAM_SSE_RETRY_BASE_MS * 2 ** (consumer.attempts - 1),
        );
        consumer.retryTimer.unref();
      });
  }

  private cancelConsumer(localRunId: string): void {
    const consumer = this.consumers.get(localRunId);
    if (!consumer) return;
    if (consumer.retryTimer) clearTimeout(consumer.retryTimer);
    consumer.retryTimer = null;
    consumer.controller.abort();
    // Keep a draining consumer registered until its reader has been released.
    if (!consumer.flight) this.consumers.delete(localRunId);
  }

  private async consume(
    run: RunEntity,
    sessionId: string,
    consumer: RunConsumer,
  ): Promise<void> {
    if (!this.consumerIsCurrent(run, consumer) || !run.hermes_run_id) return;
    try {
      for await (const event of this.hermesAdapter.streamEvents(
        sessionId,
        run.hermes_run_id,
        consumer.controller.signal,
      )) {
        if (!this.consumerIsCurrent(run, consumer)) return;
        this.handleEvent(run.id, event);
        if (this.isTerminalEvent(event.type)) break;
      }
    } catch (error) {
      if (error instanceof AppError && !error.retryable)
        consumer.attempts = LIMITS.UPSTREAM_SSE_MAX_ATTEMPTS;
    }
    if (
      this.stopped ||
      consumer.controller.signal.aborted ||
      this.leases.get(run.id) !== consumer.pair ||
      !this.ownsLeases(run.conversation_id, consumer.pair)
    )
      return;
    if (
      !this.isTerminalStatus(
        this.runRepo.findById(run.id)?.upstream_status ?? "",
      )
    ) {
      this.runRepo.update(run.id, { events_truncated: 1 });
      this.sseHub.publishGap(run.id, "upstream_disconnected");
    }
    await this.reconcileById(run.id, run.conversation_id);
  }

  private handleEvent(localRunId: string, event: HermesRunEvent): void {
    const accepted = withImmediateTransaction(this.db, () => {
      const run = this.runRepo.findById(localRunId);
      if (
        !run ||
        !this.ownsRunLease(run.id, run.conversation_id) ||
        !["accepted", "reconciling"].includes(run.local_state)
      )
        return false;
      const nextStatus =
        event.type === "approval.request"
          ? "waiting_for_approval"
          : event.type === "run.completed"
            ? "completed"
            : event.type === "run.failed"
              ? "failed"
              : event.type === "run.cancelled"
                ? "cancelled"
                : event.type === "run.interrupted"
                  ? "interrupted"
                  : null;
      if (nextStatus) {
        if (
          this.isTerminalStatus(run.upstream_status ?? "") ||
          (run.upstream_status === "stopping" &&
            nextStatus === "waiting_for_approval")
        )
          return false;
        this.runRepo.update(localRunId, { upstream_status: nextStatus });
      }
      return true;
    });
    if (!accepted) return;
    this.emitRunEvent(localRunId, event.type, event.data);
  }

  private async recoverRun(
    item: QueueItemEntity,
    run: RunEntity,
  ): Promise<void> {
    if (run.hermes_run_id)
      await this.reconcileById(run.id, item.conversation_id);
    this.ensureConsumer(run.id);
  }

  private async reconcileById(
    localRunId: string,
    conversationId: string,
  ): Promise<void> {
    const existing = this.reconcileFlights.get(localRunId);
    if (existing) return existing;
    const flight = this.reconcileOnce(localRunId, conversationId).finally(
      () => {
        this.reconcileFlights.delete(localRunId);
      },
    );
    this.reconcileFlights.set(localRunId, flight);
    return flight;
  }

  private async reconcileOnce(
    localRunId: string,
    conversationId: string,
  ): Promise<void> {
    if (this.stopped) return;
    const run = this.runRepo.findById(localRunId);
    if (
      !run ||
      !run.hermes_run_id ||
      run.local_state === "reconciled" ||
      run.local_state === "rejected"
    )
      return;
    const startingItem = this.queueRepo.findById(run.queue_item_id);
    if (!startingItem) return;
    if (
      this.isActiveQueueState(startingItem.state) &&
      !this.ensureRunLease(run)
    )
      return;
    let status;
    try {
      status = await this.hermesAdapter.getRunStatus(run.hermes_run_id);
    } catch {
      return;
    }
    if (this.stopped) return;
    const terminal = this.isTerminalStatus(status.status);
    const statusApplied = withImmediateTransaction(this.db, () => {
      const current = this.runRepo.findById(run.id);
      const item = this.queueRepo.findById(run.queue_item_id);
      if (
        !current ||
        current.hermes_run_id !== run.hermes_run_id ||
        !item ||
        current.local_state === "reconciled" ||
        current.local_state === "rejected" ||
        (this.isTerminalStatus(current.upstream_status ?? "") &&
          current.upstream_status !== status.status) ||
        (this.isActiveQueueState(item.state) &&
          !this.ownsRunLease(run.id, conversationId)) ||
        (!terminal &&
          (current.local_state === "review_required" ||
            this.isTerminalStatus(current.upstream_status ?? "")))
      )
        return false;
      const now = new Date().toISOString();
      this.runRepo.update(run.id, {
        upstream_status: status.status,
        last_status_checked_at: now,
        partial: status.partial ? 1 : 0,
        ...(terminal
          ? {
              local_state: "reconciling" as const,
              terminal_at: current.terminal_at ?? now,
              reconciliation_started_at:
                current.reconciliation_started_at ?? now,
            }
          : {}),
      });
      return true;
    });
    if (!statusApplied || !terminal) return;
    this.cancelConsumer(run.id);
    const conversation = this.conversationRepo.findById(conversationId);
    let messagesOk = Boolean(conversation?.hermes_session_id);
    if (conversation?.hermes_session_id) {
      try {
        const messages = await this.hermesAdapter.getSessionMessages(
          conversation.hermes_session_id,
          { limit: 1, offset: 0, order: "latest" },
        );
        if (messages.session_id !== conversation.hermes_session_id)
          this.conversationRepo.adoptEffectiveHermesSessionId(
            conversation.id,
            messages.session_id,
          );
      } catch {
        messagesOk = false;
      }
    }
    if (this.stopped) return;
    const outcome = withImmediateTransaction(this.db, () => {
      const current = this.runRepo.findById(run.id);
      const item = this.queueRepo.findById(run.queue_item_id);
      const latestConversation = this.conversationRepo.findById(conversationId);
      if (
        !current ||
        !item ||
        !latestConversation ||
        latestConversation.delete_state !== "none" ||
        current.hermes_run_id !== run.hermes_run_id ||
        current.local_state !== "reconciling" ||
        current.upstream_status !== status.status ||
        current.partial !== (status.partial ? 1 : 0) ||
        !["accepted", "reconciling", "review_required"].includes(item.state) ||
        (this.isActiveQueueState(item.state) &&
          !this.ownsRunLease(run.id, conversationId))
      )
        return null;
      const now = new Date().toISOString();
      if (messagesOk && status.status === "completed" && !status.partial) {
        this.runRepo.update(run.id, {
          local_state: "reconciled",
          reconciled_at: now,
        });
        this.queueRepo.updateState(item.id, item.revision, {
          state: "done",
          payload_text: null,
          recovery_expires_at: null,
        });
        // A successful Run does not revoke the user's request to stop the queue.
        // Only the automatic pause caused by this Run's failed reconciliation
        // can be cleared when authoritative history becomes readable.
        if (
          !latestConversation.queue_paused ||
          latestConversation.pause_reason === "reconciliation_failed"
        )
          this.conversationRepo.setQueuePaused(conversationId, false, null);
        return {
          event: "run.reconciled",
          payload: { upstream_status: status.status },
        };
      }
      if (messagesOk) {
        const reason =
          status.status === "cancelled"
            ? "run_cancelled"
            : status.status === "interrupted"
              ? "run_interrupted"
              : status.partial
                ? "run_partial"
                : "run_failed";
        this.runRepo.update(run.id, {
          local_state: "reconciled",
          reconciled_at: now,
        });
        this.queueRepo.updateState(item.id, item.revision, {
          state: "paused",
          recovery_expires_at: new Date(
            Date.now() + LIMITS.RECOVERY_RETENTION_MS,
          ).toISOString(),
        });
        if (latestConversation.pause_reason !== "user_stopped")
          this.conversationRepo.setQueuePaused(conversationId, true, reason);
        return {
          event: "run.paused",
          payload: { reason, review_required: false },
        };
      }
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
      if (latestConversation.pause_reason !== "user_stopped")
        this.conversationRepo.setQueuePaused(
          conversationId,
          true,
          "reconciliation_failed",
        );
      return { event: null, payload: {} };
    });
    if (!outcome) return;
    if (outcome.event)
      this.emitRunEvent(run.id, outcome.event, outcome.payload);
    this.sseHub.scheduleCleanup(run.id);
    this.releaseLeases(run.id);
  }

  private emitRunEvent(
    localRunId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    if (this.stopped) return;
    const maskedPayload = this.maskEventPayload(type, payload);
    const run = this.runRepo.appendEvent(localRunId, type);
    this.sseHub.publishRunEvent(
      run.id,
      run.last_event_seq,
      type,
      maskedPayload,
    );
  }

  private maskEventPayload(
    type: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    if (type === "tool.started" || type === "tool.completed") {
      if (typeof payload.preview === "string") {
        return {
          ...payload,
          preview: maskDisplaySensitiveText(payload.preview),
        };
      }
    }
    return payload;
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
    this.cancelConsumer(runId);
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

  private ownsLeases(conversationId: string, pair: LeasePair): boolean {
    return (
      this.leaseRepo.owns("global", "global", this.ownerId, pair.global) &&
      this.leaseRepo.owns(
        "conversation",
        conversationId,
        this.ownerId,
        pair.conversation,
      )
    );
  }

  private ownsRunLease(runId: string, conversationId: string): boolean {
    const pair = this.leases.get(runId);
    return pair !== undefined && this.ownsLeases(conversationId, pair);
  }

  private ensureRunLease(run: RunEntity): boolean {
    if (this.ownsRunLease(run.id, run.conversation_id)) return true;
    if (this.leases.has(run.id)) this.releaseLeases(run.id);
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
      return false;
    if (
      !this.leaseRepo.acquire(
        "conversation",
        run.conversation_id,
        this.ownerId,
        conversationToken,
        LIMITS.LEASE_TTL_MS,
      )
    ) {
      this.leaseRepo.release("global", "global", globalToken);
      return false;
    }
    this.leases.set(run.id, {
      global: globalToken,
      conversation: conversationToken,
    });
    return true;
  }

  private isActiveQueueState(state: QueueItemEntity["state"]): boolean {
    return ["dispatching", "accepted", "reconciling"].includes(state);
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
