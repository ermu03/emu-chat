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
import { useStreamEvents, type RunStreamEvent } from "./use-stream-events.js";

/** Owns run reconciliation, SSE subscription, polling and queue/run mutations. */
export function useRunRuntime(
  view: ConversationView,
  activeConversationId: string | null,
  loadConversations: () => Promise<void>,
  setWorkspaceError: Dispatch<SetStateAction<string | null>>,
) {
  const {
    activeConversationIdRef,
    activeRunRef,
    applyQueue,
    applyRun,
    refreshLatestMessages,
    applyRunStreamEvent,
    markRunSyncing,
    hydrateRunTools,
    replaceQueueItemInView,
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
    conversationId: string;
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
    async (conversationId: string, knownRunId?: string | null) => {
      try {
        const nextQueue = await apiClient.getQueue(conversationId);
        if (activeConversationIdRef.current !== conversationId) return;
        applyQueue(nextQueue);

        const activeRunId =
          activeRunRef.current?.conversation_id === conversationId &&
          isLiveRun(activeRunRef.current)
            ? activeRunRef.current.id
            : null;
        const runId = getCurrentRunId(nextQueue) ?? knownRunId ?? activeRunId;
        if (!runId) {
          applyRun(null);
          return;
        }

        const fetchedRun = await apiClient.getRun(runId);
        if (activeConversationIdRef.current !== conversationId) return;
        const previous = activeRunRef.current;
        const run =
          previous?.id === runId &&
          previous.local_state === "reconciled" &&
          fetchedRun.local_state !== "reconciled"
            ? previous
            : fetchedRun;
        applyRun(run);

        if (run.local_state === "reconciled") {
          const flight = refreshFlightRef.current;
          if (flight?.conversationId === conversationId) {
            flight.reconciling = true;
            flight.rerun = false;
          }
          markRunSyncing(run.id);
          await refreshLatestMessages(conversationId, run.id);
          if (activeConversationIdRef.current === conversationId) {
            if (lastConversationListRefreshRunIdRef.current !== run.id) {
              lastConversationListRefreshRunIdRef.current = run.id;
              void loadConversations();
            }
          }
        }
      } catch (error) {
        if (activeConversationIdRef.current === conversationId) {
          setWorkspaceError(getErrorMessage(error, "无法刷新运行状态"));
        }
      }
    },
    [
      applyQueue,
      applyRun,
      loadConversations,
      markRunSyncing,
      refreshLatestMessages,
      setWorkspaceError,
    ],
  );

  const refreshRuntime = useCallback(
    (conversationId: string, knownRunId?: string | null): Promise<void> => {
      const flight = refreshFlightRef.current;
      if (flight?.conversationId === conversationId) {
        if (!flight.reconciling) flight.rerun = true;
        flight.knownRunId = knownRunId ?? flight.knownRunId;
        return flight.promise;
      }
      const nextFlight = {
        conversationId,
        promise: Promise.resolve(),
        rerun: false,
        reconciling: false,
        knownRunId: knownRunId ?? null,
      };
      refreshFlightRef.current = nextFlight;
      nextFlight.promise = (async () => {
        do {
          nextFlight.rerun = false;
          await refreshOnce(conversationId, nextFlight.knownRunId);
        } while (
          nextFlight.rerun &&
          activeConversationIdRef.current === conversationId
        );
        if (refreshFlightRef.current === nextFlight) {
          refreshFlightRef.current = null;
        }
      })();
      return nextFlight.promise;
    },
    [activeConversationIdRef, refreshOnce],
  );

  const scheduleToolHydration = useCallback(
    (conversationId: string, runId: string) => {
      if (hydrateTimerRef.current !== null)
        window.clearTimeout(hydrateTimerRef.current);
      hydrateTimerRef.current = window.setTimeout(() => {
        hydrateTimerRef.current = null;
        void hydrateRunTools(conversationId, runId).catch(() => {
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
      const conversationId = activeConversationIdRef.current;
      const run = activeRunRef.current;
      if (
        !conversationId ||
        !eventRunId ||
        run?.id !== eventRunId ||
        run.conversation_id !== conversationId
      ) {
        return;
      }

      if (event.event === "stream.gap") {
        setStreamNotice("最终状态可恢复，部分实时过程事件不可恢复。");
        void refreshRuntime(conversationId, eventRunId);
        return;
      }

      if (event.event !== "run.event" || typeof event.data.type !== "string")
        return;
      const type = event.data.type;
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
        applyRunStreamEvent(eventRunId, sequence, type, payload);
        if (type === "tool.completed") {
          scheduleToolHydration(conversationId, eventRunId);
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
        if (type !== "approval.request") markRunSyncing(eventRunId);
        void refreshRuntime(conversationId, eventRunId);
      }
    },
    [
      applyRunStreamEvent,
      markRunSyncing,
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
    const item = await apiClient.cancelQueueItem(queueItemId, {
      expected_revision: expectedRevision,
    });
    if (activeConversationIdRef.current !== item.conversation_id) return;
    replaceQueueItemInView(item);
    void refreshRuntime(item.conversation_id);
  };

  const handleEditQueueItem = async (
    queueItemId: string,
    content: string,
    expectedRevision: number,
  ) => {
    const item = await apiClient.patchQueueItem(queueItemId, {
      content,
      expected_revision: expectedRevision,
    });
    if (activeConversationIdRef.current !== item.conversation_id) return;
    replaceQueueItemInView(item);
  };

  const handleStopRun = async () => {
    if (!activeRun) return;
    const nextRun = await apiClient.stopRun(activeRun.id);
    if (activeConversationIdRef.current !== activeRun.conversation_id) return;
    applyRun(nextRun);
    if (activeConversationId)
      void refreshRuntime(activeConversationId, nextRun.id);
  };

  const handleApproval = async (choice: "once" | "deny") => {
    if (!activeRun) return;
    const nextRun = await apiClient.submitApproval(activeRun.id, {
      choice,
      request_id: activeRun.approval?.request_id,
    });
    if (activeConversationIdRef.current !== activeRun.conversation_id) return;
    applyRun(nextRun);
    if (activeConversationId)
      void refreshRuntime(activeConversationId, nextRun.id);
  };

  const handleReconcile = async () => {
    if (!activeRun) return;
    const result = await apiClient.reconcileRun(activeRun.id);
    if (activeConversationIdRef.current !== activeRun.conversation_id) return;
    applyRun(result.run);
    replaceQueueItemInView(result.queue_item);
    if (activeConversationId)
      void refreshRuntime(activeConversationId, result.run.id);
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
