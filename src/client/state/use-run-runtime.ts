import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiClient } from "../api/client.js";
import {
  getCurrentRunId,
  isLiveQueueState,
  isLiveRun,
} from "../features/queue/queue-state.js";
import { getErrorMessage, isRecord } from "./app-shell-utils.js";
import type { ConversationView } from "./use-conversation-view.js";
import type { ViewTarget } from "./use-conversation-view.js";
import { useStreamEvents, type RunStreamEvent } from "./use-stream-events.js";

/** Owns run reconciliation, SSE subscription, polling and queue/run mutations. */
export function useRunRuntime(
  view: ConversationView,
  activeConversationId: string | null,
  loadConversations: () => Promise<void>,
  setWorkspaceError: Dispatch<SetStateAction<string | null>>,
) {
  const {
    captureTarget,
    isCurrentTarget,
    readRuntime,
    applyQueue,
    applyRun,
    refreshLatestMessages,
    applyRunStreamEvent,
    markRunSyncing,
    hydrateRunTools,
    applyQueueItem,
    activeConversation,
    activeRun,
    visibleRun,
    visibleQueue,
    activeQueueItem,
    runDisplay,
  } = view;
  const [streamNotice, setStreamNotice] = useState<string | null>(null);
  const lastConversationListRefreshRunIdRef = useRef<string | null>(null);
  const refreshFlightRef = useRef<{
    target: ViewTarget;
    promise: Promise<void>;
    rerun: boolean;
    reconciling: boolean;
    knownRunId: string | null;
  } | null>(null);
  const hydrateTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setStreamNotice(null);
  }, [activeConversationId, activeRun?.id]);

  const refreshOnce = useCallback(
    async (target: ViewTarget, knownRunId?: string | null) => {
      try {
        const before = readRuntime(target);
        if (!before) return;
        const nextQueue = await apiClient.getQueue(target.conversationId);
        if (!applyQueue(target, nextQueue, before.queueVersion)) return;

        const currentRun = readRuntime(target)?.run ?? null;
        const activeRunId =
          currentRun?.conversation_id === target.conversationId &&
          isLiveRun(currentRun)
            ? currentRun.id
            : null;
        const runId = getCurrentRunId(nextQueue) ?? knownRunId ?? activeRunId;
        if (!runId) {
          applyRun(target, null, currentRun?.id);
          return;
        }

        const fetchedRun = await apiClient.getRun(runId);
        applyRun(target, fetchedRun, runId);
        const run = readRuntime(target)?.run;
        if (!run || run.id !== runId) return;

        if (run.local_state === "reconciled") {
          const flight = refreshFlightRef.current;
          if (flight?.target === target) {
            flight.reconciling = true;
            flight.rerun = false;
          }
          markRunSyncing(target, run.id);
          await refreshLatestMessages(target, run.id);
          if (isCurrentTarget(target)) {
            if (lastConversationListRefreshRunIdRef.current !== run.id) {
              lastConversationListRefreshRunIdRef.current = run.id;
              void loadConversations();
            }
          }
        }
      } catch (error) {
        if (isCurrentTarget(target)) {
          setWorkspaceError(getErrorMessage(error, "无法刷新运行状态"));
        }
      }
    },
    [
      applyQueue,
      applyRun,
      isCurrentTarget,
      loadConversations,
      markRunSyncing,
      readRuntime,
      refreshLatestMessages,
      setWorkspaceError,
    ],
  );

  const refreshRuntime = useCallback(
    (conversationId: string, knownRunId?: string | null): Promise<void> => {
      const target = captureTarget(conversationId);
      if (!target) return Promise.resolve();
      const flight = refreshFlightRef.current;
      if (
        flight?.target.conversationId === target.conversationId &&
        flight.target.selection === target.selection
      ) {
        if (!flight.reconciling) flight.rerun = true;
        flight.knownRunId = knownRunId ?? flight.knownRunId;
        return flight.promise;
      }
      const nextFlight = {
        target,
        promise: Promise.resolve(),
        rerun: false,
        reconciling: false,
        knownRunId: knownRunId ?? null,
      };
      refreshFlightRef.current = nextFlight;
      nextFlight.promise = (async () => {
        do {
          nextFlight.rerun = false;
          await refreshOnce(target, nextFlight.knownRunId);
        } while (nextFlight.rerun && isCurrentTarget(target));
        if (refreshFlightRef.current === nextFlight) {
          refreshFlightRef.current = null;
        }
      })();
      return nextFlight.promise;
    },
    [captureTarget, isCurrentTarget, refreshOnce],
  );

  const scheduleToolHydration = useCallback(
    (target: ViewTarget, runId: string) => {
      if (hydrateTimerRef.current !== null)
        window.clearTimeout(hydrateTimerRef.current);
      hydrateTimerRef.current = window.setTimeout(() => {
        hydrateTimerRef.current = null;
        void hydrateRunTools(target, runId).catch(() => {
          // The event preview stays visible; a later completion or terminal refresh retries.
        });
      }, 120);
    },
    [hydrateRunTools],
  );

  useEffect(
    () => () => {
      if (hydrateTimerRef.current !== null)
        window.clearTimeout(hydrateTimerRef.current);
    },
    [],
  );

  const handleRunStreamEvent = useCallback(
    (event: RunStreamEvent) => {
      const eventRunId =
        typeof event.data.local_run_id === "string"
          ? event.data.local_run_id
          : null;
      const target = captureTarget();
      const run = target && readRuntime(target)?.run;
      if (
        !target ||
        !eventRunId ||
        run?.id !== eventRunId ||
        run.conversation_id !== target.conversationId
      ) {
        return;
      }

      if (event.event === "stream.gap") {
        setStreamNotice("最终状态可恢复，部分实时过程事件不可恢复。");
        void refreshRuntime(target.conversationId, eventRunId);
        return;
      }

      if (event.event !== "run.event" || typeof event.data.type !== "string")
        return;
      const type = event.data.type;
      if (type === "run.review_required") {
        void refreshLatestMessages(target, eventRunId).catch(() => {
          if (isCurrentTarget(target))
            setStreamNotice("运行提交结果未确认，请手动刷新会话历史。");
        });
        void refreshRuntime(target.conversationId, eventRunId);
        return;
      }
      // Hermes can emit reasoning.available from ordinary assistant content;
      // only the persisted message reasoning field is safe to render as a card.
      if (
        type === "message.delta" ||
        type === "tool.started" ||
        type === "tool.completed"
      ) {
        const sequence =
          typeof event.data.local_seq === "number"
            ? event.data.local_seq
            : null;
        const payload = isRecord(event.data.payload) ? event.data.payload : {};
        applyRunStreamEvent(target, eventRunId, sequence, type, payload);
        if (type === "tool.completed") {
          scheduleToolHydration(target, eventRunId);
        }
        return;
      }
      if (
        type === "approval.request" ||
        type === "run.completed" ||
        type === "run.failed" ||
        type === "run.cancelled" ||
        type === "run.interrupted" ||
        type === "run.reconciled"
      ) {
        if (type !== "approval.request") markRunSyncing(target, eventRunId);
        void refreshRuntime(target.conversationId, eventRunId);
      }
    },
    [
      applyRunStreamEvent,
      captureTarget,
      isCurrentTarget,
      markRunSyncing,
      readRuntime,
      refreshLatestMessages,
      refreshRuntime,
      scheduleToolHydration,
    ],
  );

  const liveRunId =
    activeConversation?.conversation_id === activeConversationId &&
    activeRun &&
    isLiveRun(activeRun)
      ? activeRun.id
      : null;
  const stream = useStreamEvents({
    localRunId: liveRunId,
    enabled: liveRunId !== null,
    onEvent: handleRunStreamEvent,
  });

  const shouldPollRuntime = useMemo(() => {
    if (isLiveRun(visibleRun)) return true;
    if (runDisplay?.phase === "syncing") return true;
    return (
      visibleQueue?.data.some((item) => isLiveQueueState(item.state)) ?? false
    );
  }, [runDisplay?.phase, visibleQueue, visibleRun]);
  const runtimePollInterval =
    !isLiveRun(visibleRun) && activeQueueItem?.local_run_id === null
      ? 300
      : 2_500;

  useEffect(() => {
    if (!activeConversationId || !shouldPollRuntime) return;
    const timer = window.setInterval(() => {
      void refreshRuntime(
        activeConversationId,
        isLiveRun(visibleRun) ? visibleRun?.id : runDisplay?.runId,
      );
    }, runtimePollInterval);
    return () => window.clearInterval(timer);
  }, [
    activeConversationId,
    refreshRuntime,
    runtimePollInterval,
    shouldPollRuntime,
    visibleRun,
    runDisplay?.runId,
  ]);

  const handleCancelQueueItem = async (
    queueItemId: string,
    expectedRevision: number,
  ) => {
    const target = captureTarget();
    if (!target) return;
    const item = await apiClient.cancelQueueItem(queueItemId, {
      expected_revision: expectedRevision,
    });
    if (applyQueueItem(target, item) || captureTarget(target.conversationId))
      void refreshRuntime(target.conversationId);
  };

  const handleEditQueueItem = async (
    queueItemId: string,
    content: string,
    attachments: import("../../shared/media-schemas.js").AttachmentRef[],
    expectedRevision: number,
  ) => {
    const target = captureTarget();
    if (!target) return;
    const item = await apiClient.patchQueueItem(queueItemId, {
      content,
      attachments,
      expected_revision: expectedRevision,
    });
    if (!applyQueueItem(target, item) && captureTarget(target.conversationId))
      void refreshRuntime(target.conversationId);
  };

  const handleStopRun = async () => {
    const target = captureTarget();
    const run = target && readRuntime(target)?.run;
    if (!target || !run) return;
    const nextRun = await apiClient.stopRun(run.id);
    if (
      applyRun(target, nextRun, run.id) ||
      captureTarget(target.conversationId)
    )
      void refreshRuntime(target.conversationId, nextRun.id);
  };

  const handleApproval = async (choice: "once" | "deny") => {
    const target = captureTarget();
    const run = target && readRuntime(target)?.run;
    if (!target || !run) return;
    const nextRun = await apiClient.submitApproval(run.id, {
      choice,
      request_id: run.approval?.request_id,
    });
    if (
      applyRun(target, nextRun, run.id) ||
      captureTarget(target.conversationId)
    )
      void refreshRuntime(target.conversationId, nextRun.id);
  };

  const handleReconcile = async () => {
    const target = captureTarget();
    const run = target && readRuntime(target)?.run;
    if (!target || !run) return;
    const result = await apiClient.reconcileRun(run.id);
    const appliedRun = applyRun(target, result.run, run.id);
    const appliedItem = applyQueueItem(target, result.queue_item);
    if (appliedRun || appliedItem || captureTarget(target.conversationId))
      void refreshRuntime(target.conversationId, result.run.id);
  };

  return {
    stream,
    streamNotice,
    refreshRuntime,
    handleCancelQueueItem,
    handleEditQueueItem,
    handleStopRun,
    handleApproval,
    handleReconcile,
  };
}
