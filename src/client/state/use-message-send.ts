import { useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { ApiClientError, apiClient } from "../api/client.js";
import type { ConversationSummary } from "../../shared/api-schemas.js";
import type { MediaAsset } from "../../shared/media-schemas.js";
import type { PendingUserMessage } from "../features/messages/message-view.js";
import type { PendingQueueItem } from "../features/queue/queue-panel.js";
import {
  getPrimaryQueueItem,
  isAgentGenerating,
} from "../features/queue/queue-state.js";
import {
  generateBrowserUuid,
  hasPersistedQueueMessage,
} from "./app-shell-utils.js";
import type { ConversationView } from "./use-conversation-view.js";

type PendingSend = {
  conversationId: string;
  requestId: string;
  expectedRevision: number;
};

type PendingSubmission = {
  requestId: string;
  conversationId: string;
  content: string;
  attachments: MediaAsset[];
  isFollowUp: boolean;
};

/** Owns send request identity and optimistic primary/follow-up placeholders. */
export function useMessageSend(
  view: ConversationView,
  activeConversationId: string | null,
  refreshRuntime: (
    conversationId: string,
    knownRunId?: string | null,
  ) => Promise<void>,
  setConversations: Dispatch<SetStateAction<ConversationSummary[]>>,
) {
  const {
    captureTarget,
    readRuntime,
    openQueuePanel,
    clearStreamForNewSend,
    applySubmissionResult,
    activeQueueItem,
    messages,
    runDisplay,
    transitionSnapshot,
  } = view;
  const pendingSendRef = useRef<PendingSend | null>(null);
  const [pendingSubmissions, setPendingSubmissions] = useState<
    PendingSubmission[]
  >([]);

  const activePendingSubmissions = useMemo(
    () =>
      activeConversationId
        ? pendingSubmissions.filter(
            (entry) => entry.conversationId === activeConversationId,
          )
        : [],
    [activeConversationId, pendingSubmissions],
  );
  const pendingUserMessage = useMemo<PendingUserMessage | null>(() => {
    if (
      activeQueueItem &&
      (activeQueueItem.content || activeQueueItem.attachments.length > 0) &&
      !hasPersistedQueueMessage(messages, activeQueueItem)
    ) {
      return {
        id: `queue:${activeQueueItem.id}`,
        content: activeQueueItem.content ?? "",
        attachments: activeQueueItem.attachments,
      };
    }

    if (
      runDisplay &&
      (runDisplay.promptContent || runDisplay.operationId) &&
      runDisplay.phase !== "settled" &&
      !messages.some(
        (message) =>
          message.role === "user" &&
          message.id >= runDisplay.afterMessageId &&
          (runDisplay.operationId
            ? message.media_operation_id === runDisplay.operationId
            : message.content === runDisplay.promptContent),
      )
    ) {
      return {
        id: `run-prompt:${runDisplay.runId}`,
        content: runDisplay.promptContent ?? "",
        attachments: activeQueueItem?.attachments ?? [],
      };
    }

    const submission = activePendingSubmissions.find(
      (entry) => !entry.isFollowUp,
    );
    return submission
      ? {
          id: `submission:${submission.requestId}`,
          content: submission.content,
          attachments: submission.attachments,
        }
      : null;
  }, [activePendingSubmissions, activeQueueItem, messages, runDisplay]);
  const transitionPendingUserMessage =
    useMemo<PendingUserMessage | null>(() => {
      if (!transitionSnapshot) return null;

      const queueItem = getPrimaryQueueItem(
        transitionSnapshot.queue,
        transitionSnapshot.activeRun,
      );
      if (
        queueItem &&
        (queueItem.content || queueItem.attachments.length > 0) &&
        !hasPersistedQueueMessage(transitionSnapshot.messages, queueItem)
      ) {
        return {
          id: `queue:${queueItem.id}`,
          content: queueItem.content ?? "",
          attachments: queueItem.attachments,
        };
      }

      const display = transitionSnapshot.runDisplay;
      if (
        display &&
        (display.promptContent || display.operationId) &&
        display.phase !== "settled" &&
        !transitionSnapshot.messages.some(
          (message) =>
            message.role === "user" &&
            message.id >= display.afterMessageId &&
            (display.operationId
              ? message.media_operation_id === display.operationId
              : message.content === display.promptContent),
        )
      ) {
        return {
          id: `run-prompt:${display.runId}`,
          content: display.promptContent ?? "",
          attachments: queueItem?.attachments ?? [],
        };
      }

      const submission = pendingSubmissions.find(
        (entry) =>
          entry.conversationId === transitionSnapshot.conversationId &&
          !entry.isFollowUp,
      );
      return submission
        ? {
            id: `submission:${submission.requestId}`,
            content: submission.content,
            attachments: submission.attachments,
          }
        : null;
    }, [pendingSubmissions, transitionSnapshot]);
  const transitionIsAssistantReplying = useMemo(() => {
    if (!transitionSnapshot) return false;
    const hasPendingPrimarySubmission = pendingSubmissions.some(
      (entry) =>
        entry.conversationId === transitionSnapshot.conversationId &&
        !entry.isFollowUp,
    );
    const run = transitionSnapshot.activeRun;
    return (
      (isAgentGenerating(run, transitionSnapshot.queue) ||
        hasPendingPrimarySubmission) &&
      run?.upstream_status !== "waiting_for_approval" &&
      run?.upstream_status !== "stopping"
    );
  }, [pendingSubmissions, transitionSnapshot]);
  const pendingQueueItems = useMemo<PendingQueueItem[]>(
    () =>
      activePendingSubmissions
        .filter((entry) => entry.isFollowUp)
        .map((entry) => ({
          id: `submission:${entry.requestId}`,
          content: entry.content,
          attachments: entry.attachments,
        })),
    [activePendingSubmissions],
  );
  const hasPendingPrimarySubmission = activePendingSubmissions.some(
    (entry) => !entry.isFollowUp,
  );

  const handleSend = async (
    content: string,
    attachments: MediaAsset[],
    expectedDraftRevision: number,
  ) => {
    if (!activeConversationId) throw new Error("请先选择会话");
    const conversationId = activeConversationId;
    const target = captureTarget(conversationId);
    if (!target) throw new Error("会话已切换，请重试发送");
    const runtime = readRuntime(target);
    const isFollowUp = isAgentGenerating(
      runtime?.run ?? null,
      runtime?.queue ?? null,
    );
    if (!isFollowUp) {
      clearStreamForNewSend(target);
    }

    let pending = pendingSendRef.current;
    if (
      !pending ||
      pending.conversationId !== conversationId ||
      pending.expectedRevision !== expectedDraftRevision
    ) {
      pending = {
        conversationId,
        requestId: generateBrowserUuid(),
        expectedRevision: expectedDraftRevision,
      };
      pendingSendRef.current = pending;
    }

    setPendingSubmissions((current) => [
      ...current.filter((entry) => entry.requestId !== pending.requestId),
      {
        requestId: pending.requestId,
        conversationId,
        content,
        attachments,
        isFollowUp,
      },
    ]);
    if (isFollowUp) openQueuePanel(target);

    try {
      const result = await apiClient.sendMessage(conversationId, {
        client_request_id: pending.requestId,
        expected_draft_revision: expectedDraftRevision,
      });
      if (pendingSendRef.current?.requestId === pending.requestId)
        pendingSendRef.current = null;
      setPendingSubmissions((current) =>
        current.filter((entry) => entry.requestId !== pending.requestId),
      );
      if (
        applySubmissionResult(
          target,
          result.draft,
          result.queue_item,
          isFollowUp,
        )
      ) {
        void refreshRuntime(conversationId, result.queue_item.local_run_id);
      } else if (captureTarget(conversationId)) {
        // The request succeeded during an earlier visit to this conversation.
        void refreshRuntime(conversationId, result.queue_item.local_run_id);
      }
      setConversations((current) =>
        current.map((conversation) =>
          conversation.conversation_id === conversationId
            ? {
                ...conversation,
                last_active: Date.now(),
                queue_size: conversation.queue_size + 1,
              }
            : conversation,
        ),
      );
      return {
        draft: {
          content: result.draft.content,
          attachments: result.draft.attachments,
          revision: result.draft.revision,
        },
      };
    } catch (error) {
      // A response-bearing API error is definite; only a transport failure may
      // safely reuse the UUID when the user retries the same send.
      if (error instanceof ApiClientError) {
        if (pendingSendRef.current?.requestId === pending.requestId)
          pendingSendRef.current = null;
        setPendingSubmissions((current) =>
          current.filter((entry) => entry.requestId !== pending.requestId),
        );
      }
      throw error;
    }
  };

  return {
    handleSend,
    pendingUserMessage,
    transitionPendingUserMessage,
    transitionIsAssistantReplying,
    pendingQueueItems,
    hasPendingPrimarySubmission,
  };
}
