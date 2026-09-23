import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiClient } from "../api/client.js";
import { mergeMessages } from "../features/messages/message-display.js";
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
    setMessages,
    clearStreamAfterReconcile,
    appendStreamDelta,
    replaceQueueItemInView,
    activeConversation,
    activeRun,
    visibleRun,
    visibleQueue,
    activeQueueItem,
  } = view;
  const [streamNotice, setStreamNotice] = useState<string | null>(null);
  const lastConversationListRefreshRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    setStreamNotice(null);
  }, [activeConversationId, activeRun?.id]);

  const refreshRuntime = useCallback(
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

        const run = await apiClient.getRun(runId);
        if (activeConversationIdRef.current !== conversationId) return;
        applyRun(run);

        if (run.local_state === "reconciled") {
          const messageResponse = await apiClient.listMessages(conversationId, {
            limit: 100,
            order: "latest",
          });
          if (activeConversationIdRef.current === conversationId) {
            setMessages((prev) => mergeMessages(prev, messageResponse.items));
            clearStreamAfterReconcile(run.id);
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
      clearStreamAfterReconcile,
      loadConversations,
      setMessages,
      setWorkspaceError,
    ],
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
      if (type === "message.delta") {
        const payload = event.data.payload;
        const sequence =
          typeof event.data.local_seq === "number"
            ? event.data.local_seq
            : null;
        const delta =
          isRecord(payload) && typeof payload.delta === "string"
            ? payload.delta
            : "";
        if (delta) {
          appendStreamDelta(eventRunId, sequence, delta);
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
        void refreshRuntime(conversationId, eventRunId);
      }
    },
    [appendStreamDelta, refreshRuntime],
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
    return (
      visibleQueue?.data.some((item) => isLiveQueueState(item.state)) ?? false
    );
  }, [visibleQueue, visibleRun]);
  const runtimePollInterval =
    !isLiveRun(visibleRun) && activeQueueItem?.local_run_id === null
      ? 300
      : 2_500;

  useEffect(() => {
    if (!activeConversationId || !shouldPollRuntime) return;
    const timer = window.setInterval(() => {
      void refreshRuntime(
        activeConversationId,
        isLiveRun(visibleRun) ? visibleRun?.id : undefined,
      );
    }, runtimePollInterval);
    return () => window.clearInterval(timer);
  }, [
    activeConversationId,
    refreshRuntime,
    runtimePollInterval,
    shouldPollRuntime,
    visibleRun,
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
