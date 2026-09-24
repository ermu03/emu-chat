import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiClient } from "../api/client.js";
import type {
  ConversationDetailResponse,
  ConversationSummary,
  DraftResponse,
  MessageItem,
  MessageListResponse,
  QueueItemResponse,
  QueueListResponse,
  RunResponse,
} from "../../shared/api-schemas.js";
import { ConversationViewCache } from "../features/conversations/conversation-view-cache.js";
import { mergeMessages } from "../features/messages/message-display.js";
import { StreamedAssistantCache } from "../features/messages/streamed-assistant-cache.js";
import { LIMITS } from "../../shared/limits.js";
import {
  getCurrentRunId,
  getPrimaryQueueItem,
  getQueuedFollowUps,
  isAgentGenerating,
} from "../features/queue/queue-state.js";
import {
  getErrorMessage,
  replaceQueueItem,
  upsertQueueItem,
} from "./app-shell-utils.js";

type ConversationViewSnapshot = {
  conversation: ConversationDetailResponse;
  messages: MessageItem[];
  hasMoreEarlier: boolean;
  olderMessagesCursor: OlderMessagesCursor | null;
  draft: DraftResponse;
  queue: QueueListResponse;
  activeRun: RunResponse | null;
  queueOpen: boolean;
  streamedContent: string;
  streamedRunId: string | null;
};

type OlderMessagesCursor = {
  oldestId: number;
  offset: number; // Position of oldestId in Hermes's latest-first order at the last fetch.
};

const MESSAGE_PAGE_SIZE = LIMITS.MESSAGES_PAGE_DEFAULT;

async function fetchLatestThroughAnchor(
  conversationId: string,
  anchorId: number | null,
): Promise<{
  items: MessageItem[];
  cursor: OlderMessagesCursor | null;
  hasMoreEarlier: boolean;
  reachedAnchor: boolean;
}> {
  const items: MessageItem[] = [];
  let offset = 0;
  let cursor: OlderMessagesCursor | null = null;

  for (;;) {
    const page: MessageListResponse = await apiClient.listMessages(
      conversationId,
      { limit: MESSAGE_PAGE_SIZE, offset, order: "latest" },
    );
    items.push(...page.items);
    const oldest = page.items.at(-1);
    if (oldest) {
      cursor = {
        oldestId: oldest.id,
        offset: page.offset + page.items.length - 1,
      };
    }
    const reachedAnchor =
      anchorId !== null && page.items.some((item) => item.id === anchorId);
    if (
      anchorId === null ||
      reachedAnchor ||
      !page.has_more ||
      page.items.length === 0
    ) {
      return {
        items,
        cursor,
        hasMoreEarlier: page.has_more && page.items.length > 0,
        reachedAnchor,
      };
    }
    // Overlap the preceding page so messages inserted at the newest end
    // while scanning cannot move a page boundary past the anchor.
    offset = page.offset + Math.max(page.items.length - 1, 1);
  }
}

export type RetainedConversationView = {
  conversationId: string;
  title: string | null;
  messages: MessageItem[];
  queue: QueueListResponse | null;
  activeRun: RunResponse | null;
  streamedContent: string;
};

function retainConversationView(
  snapshot: ConversationViewSnapshot,
): RetainedConversationView {
  return {
    conversationId: snapshot.conversation.conversation_id,
    title: snapshot.conversation.title,
    messages: snapshot.messages,
    queue: snapshot.queue,
    activeRun: snapshot.activeRun,
    streamedContent: snapshot.streamedContent,
  };
}

/** Owns the selected conversation snapshot, cache, draft, queue and visible stream text. */
export function useConversationView(
  activeConversationId: string | null,
  conversations: ConversationSummary[],
  setWorkspaceError: Dispatch<SetStateAction<string | null>>,
) {
  const [activeConversation, setActiveConversation] =
    useState<ConversationDetailResponse | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const messagesRef = useRef<{
    conversationId: string | null;
    items: MessageItem[];
  }>({ conversationId: null, items: [] });
  const [messagesConversationId, setMessagesConversationId] = useState<
    string | null
  >(null);
  const [hasMoreEarlier, setHasMoreEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const olderMessagesCursorRef = useRef<OlderMessagesCursor | null>(null);
  const latestLoadSeqRef = useRef(0);
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [queue, setQueue] = useState<QueueListResponse | null>(null);
  const [activeRun, setActiveRun] = useState<RunResponse | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [conversationLoadError, setConversationLoadError] = useState<{
    conversationId: string;
    message: string;
  } | null>(null);
  const activeLoadRef = useRef(0);
  const activeConversationIdRef = useRef<string | null>(null);
  const activeRunRef = useRef<RunResponse | null>(null);
  const queueRef = useRef<QueueListResponse | null>(null);
  const previousQueuedMessageCountRef = useRef(0);
  const streamedAssistantRunIdRef = useRef<string | null>(null);
  const streamedAssistantCacheRef = useRef(new StreamedAssistantCache());
  const conversationViewCacheRef = useRef(
    new ConversationViewCache<ConversationViewSnapshot>(),
  );
  const currentViewSnapshotRef = useRef<RetainedConversationView | null>(null);
  const [streamedAssistantContent, setStreamedAssistantContent] = useState("");

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useLayoutEffect(() => {
    messagesRef.current = {
      conversationId: messagesConversationId,
      items: messages,
    };
  }, [messages, messagesConversationId]);

  useEffect(() => {
    activeRunRef.current = activeRun;
  }, [activeRun]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    setStreamedAssistantContent("");
    streamedAssistantRunIdRef.current = null;
  }, [activeConversationId]);

  useEffect(() => {
    if (!activeRun?.id) return;
    streamedAssistantRunIdRef.current = activeRun.id;
    setStreamedAssistantContent(
      streamedAssistantCacheRef.current.get(activeRun.id),
    );
  }, [activeRun?.id]);

  useEffect(() => {
    if (
      !activeConversationId ||
      messagesConversationId !== activeConversationId
    ) {
      return;
    }
    const currentConversation =
      activeConversation?.conversation_id === activeConversationId
        ? activeConversation
        : null;
    const activeSummary = conversations.find(
      (conversation) => conversation.conversation_id === activeConversationId,
    );
    const currentQueue =
      queue?.conversation_id === activeConversationId ? queue : null;
    const currentRun =
      activeRun?.conversation_id === activeConversationId ? activeRun : null;
    currentViewSnapshotRef.current = {
      conversationId: activeConversationId,
      title: currentConversation?.title ?? activeSummary?.title ?? null,
      messages,
      queue: currentQueue,
      activeRun: currentRun,
      streamedContent: streamedAssistantContent,
    };

    if (
      !currentConversation ||
      !draft ||
      draft.conversation_id !== activeConversationId ||
      !currentQueue
    ) {
      return;
    }
    const snapshot = {
      conversation: currentConversation,
      messages,
      hasMoreEarlier,
      olderMessagesCursor: olderMessagesCursorRef.current,
      draft,
      queue: currentQueue,
      activeRun: currentRun,
      queueOpen,
      streamedContent: streamedAssistantContent,
      streamedRunId: streamedAssistantRunIdRef.current,
    };
    conversationViewCacheRef.current.set(activeConversationId, snapshot);
  }, [
    activeConversationId,
    activeConversation,
    activeRun,
    conversations,
    draft,
    messages,
    messagesConversationId,
    hasMoreEarlier,
    queue,
    queueOpen,
    streamedAssistantContent,
  ]);

  const loadActiveConversation = useCallback(async (conversationId: string) => {
    const loadId = ++activeLoadRef.current;
    const snapshot = conversationViewCacheRef.current.get(conversationId);
    const useCachedView = snapshot !== undefined;
    setConversationLoadError(null);
    setWorkspaceError(null);

    if (snapshot) {
      currentViewSnapshotRef.current = retainConversationView(snapshot);
      setActiveConversation(snapshot.conversation);
      setMessages(snapshot.messages);
      setMessagesConversationId(conversationId);
      setHasMoreEarlier(snapshot.hasMoreEarlier);
      olderMessagesCursorRef.current = snapshot.olderMessagesCursor;
      setDraft(snapshot.draft);
      setQueue(snapshot.queue);
      queueRef.current = snapshot.queue;
      setActiveRun(snapshot.activeRun);
      setQueueOpen(snapshot.queueOpen);
      previousQueuedMessageCountRef.current = getQueuedFollowUps(
        snapshot.queue,
        snapshot.activeRun,
      ).length;
      streamedAssistantRunIdRef.current = snapshot.streamedRunId;
      setStreamedAssistantContent(snapshot.streamedContent);
    } else {
      setActiveConversation(null);
      setMessages([]);
      setMessagesConversationId(null);
      setHasMoreEarlier(false);
      olderMessagesCursorRef.current = null;
      setDraft(null);
      setQueue(null);
      queueRef.current = null;
      setActiveRun(null);
      setQueueOpen(false);
      streamedAssistantRunIdRef.current = null;
      setStreamedAssistantContent("");
    }
    setLoadingEarlier(false);

    const reportLoadError = (error: unknown, fallback: string) => {
      if (!useCachedView && loadId === activeLoadRef.current) {
        const message = getErrorMessage(error, fallback);
        setWorkspaceError(message);
        setConversationLoadError({ conversationId, message });
      }
    };

    const loadConversationContent = async () => {
      const loadConversation = async () => {
        try {
          const conversation = await apiClient.getConversation(conversationId);
          if (loadId !== activeLoadRef.current) return;
          setActiveConversation(conversation);
        } catch (error) {
          if (loadId !== activeLoadRef.current) return;
          if (!useCachedView) setActiveConversation(null);
          reportLoadError(error, "无法加载会话详情");
        }
      };

      const loadMessages = async () => {
        const latestLoadSeq = ++latestLoadSeqRef.current;
        try {
          const anchorId = snapshot?.messages.at(-1)?.id ?? null;
          const result = await fetchLatestThroughAnchor(
            conversationId,
            anchorId,
          );
          if (
            loadId !== activeLoadRef.current ||
            latestLoadSeq !== latestLoadSeqRef.current
          )
            return;
          if (snapshot?.olderMessagesCursor && result.reachedAnchor) {
            setMessages((prev) => mergeMessages(prev, result.items));
          } else {
            setMessages(mergeMessages([], result.items));
            olderMessagesCursorRef.current = result.cursor;
            setHasMoreEarlier(result.hasMoreEarlier);
          }
          setMessagesConversationId(conversationId);
        } catch (error) {
          if (
            loadId !== activeLoadRef.current ||
            latestLoadSeq !== latestLoadSeqRef.current ||
            useCachedView
          )
            return;
          setMessages([]);
          setMessagesConversationId(null);
          setHasMoreEarlier(false);
          olderMessagesCursorRef.current = null;
          reportLoadError(error, "无法从 Hermes 加载消息");
        }
      };

      const loadDraft = async () => {
        try {
          const nextDraft = await apiClient.getDraft(conversationId);
          if (loadId !== activeLoadRef.current) return;
          setDraft(nextDraft);
        } catch (error) {
          if (loadId !== activeLoadRef.current || useCachedView) return;
          setDraft(null);
          reportLoadError(error, "无法加载草稿");
        }
      };

      await Promise.all([loadConversation(), loadMessages(), loadDraft()]);
    };

    if (snapshot && isAgentGenerating(snapshot.activeRun, snapshot.queue)) {
      try {
        const nextQueue = await apiClient.getQueue(conversationId);
        if (loadId !== activeLoadRef.current) return;

        setQueue(nextQueue);
        queueRef.current = nextQueue;
        const runId = getCurrentRunId(nextQueue);
        if (runId) {
          const run = await apiClient.getRun(runId);
          if (loadId !== activeLoadRef.current) return;
          setActiveRun(run);
          streamedAssistantRunIdRef.current = run.id;
          setStreamedAssistantContent(
            streamedAssistantCacheRef.current.get(run.id),
          );
        } else {
          setActiveRun(null);
          if (snapshot.streamedRunId) {
            streamedAssistantCacheRef.current.clear(snapshot.streamedRunId);
          }
          streamedAssistantRunIdRef.current = null;
          setStreamedAssistantContent("");
          await loadConversationContent();
        }
      } catch (error) {
        reportLoadError(error, "无法刷新运行状态");
      }
      return;
    }

    const loadQueue = async () => {
      let nextQueue: QueueListResponse;
      try {
        nextQueue = await apiClient.getQueue(conversationId);
      } catch (error) {
        if (loadId !== activeLoadRef.current) return;
        if (!useCachedView) {
          setQueue(null);
          queueRef.current = null;
          setActiveRun(null);
          setQueueOpen(false);
        }
        reportLoadError(error, "无法加载消息队列");
        return;
      }
      if (loadId !== activeLoadRef.current) return;

      setQueue(nextQueue);
      queueRef.current = nextQueue;
      const runId = getCurrentRunId(nextQueue);
      if (runId) {
        try {
          const run = await apiClient.getRun(runId);
          if (loadId === activeLoadRef.current) {
            setActiveRun(run);
            streamedAssistantRunIdRef.current = run.id;
            setStreamedAssistantContent(
              streamedAssistantCacheRef.current.get(run.id),
            );
          }
        } catch (error) {
          if (loadId === activeLoadRef.current) {
            reportLoadError(error, "无法加载运行状态");
          }
        }
      } else {
        setActiveRun(null);
        if (snapshot?.streamedRunId) {
          streamedAssistantCacheRef.current.clear(snapshot.streamedRunId);
        }
        streamedAssistantRunIdRef.current = null;
        setStreamedAssistantContent("");
      }
    };

    await Promise.all([loadConversationContent(), loadQueue()]);
  }, []);

  const restoreConversationView = useCallback(
    (snapshot: ConversationViewSnapshot) => {
      currentViewSnapshotRef.current = retainConversationView(snapshot);
      setActiveConversation(snapshot.conversation);
      setMessages(snapshot.messages);
      setMessagesConversationId(snapshot.conversation.conversation_id);
      setHasMoreEarlier(snapshot.hasMoreEarlier);
      olderMessagesCursorRef.current = snapshot.olderMessagesCursor;
      setDraft(snapshot.draft);
      setQueue(snapshot.queue);
      queueRef.current = snapshot.queue;
      setActiveRun(snapshot.activeRun);
      setQueueOpen(snapshot.queueOpen);
      previousQueuedMessageCountRef.current = getQueuedFollowUps(
        snapshot.queue,
        snapshot.activeRun,
      ).length;
      streamedAssistantRunIdRef.current = snapshot.streamedRunId;
      setStreamedAssistantContent(snapshot.streamedContent);
    },
    [],
  );

  const hasTargetMessages =
    activeConversationId !== null &&
    messagesConversationId === activeConversationId;
  const transitionSnapshot =
    activeConversationId && !hasTargetMessages
      ? currentViewSnapshotRef.current
      : null;
  const hasActiveConversationView =
    activeConversation?.conversation_id === activeConversationId &&
    hasTargetMessages;
  const activeConversationSummary = useMemo(
    () =>
      conversations.find(
        (conversation) => conversation.conversation_id === activeConversationId,
      ) ?? null,
    [activeConversationId, conversations],
  );
  const activeConversationTitle = transitionSnapshot
    ? transitionSnapshot.title || "未命名会话"
    : activeConversation?.conversation_id === activeConversationId
      ? activeConversation.title || "未命名会话"
      : activeConversationSummary?.title || "未命名会话";
  const currentConversationLoadError =
    conversationLoadError?.conversationId === activeConversationId
      ? conversationLoadError.message
      : null;
  const visibleQueue = hasActiveConversationView ? queue : null;
  const visibleRun = hasActiveConversationView ? activeRun : null;
  const activeQueueItem = useMemo(
    () => getPrimaryQueueItem(visibleQueue, visibleRun),
    [visibleQueue, visibleRun],
  );
  const queuedMessages = useMemo(
    () => getQueuedFollowUps(visibleQueue, visibleRun),
    [visibleQueue, visibleRun],
  );
  const agentGenerating = isAgentGenerating(visibleRun, visibleQueue);
  useEffect(() => {
    if (queuedMessages.length > previousQueuedMessageCountRef.current) {
      setQueueOpen(true);
    }
    previousQueuedMessageCountRef.current = queuedMessages.length;
  }, [queuedMessages.length]);

  useEffect(() => {
    if (activeConversationId) {
      void loadActiveConversation(activeConversationId);
      return;
    }

    activeLoadRef.current += 1;
    setActiveConversation(null);
    setMessages([]);
    setMessagesConversationId(null);
    setLoadingEarlier(false);
    olderMessagesCursorRef.current = null;
    setConversationLoadError(null);
    setWorkspaceError(null);
    currentViewSnapshotRef.current = null;
    setDraft(null);
    setQueue(null);
    queueRef.current = null;
    setActiveRun(null);
    setQueueOpen(false);
    previousQueuedMessageCountRef.current = 0;
  }, [activeConversationId, loadActiveConversation]);

  const handleSaveDraft = async (content: string, expectedRevision: number) => {
    if (!activeConversationId) throw new Error("请先选择会话");
    const saved = await apiClient.putDraft(activeConversationId, {
      content,
      expected_revision: expectedRevision,
    });
    if (activeConversationIdRef.current === activeConversationId)
      setDraft(saved);
    return { revision: saved.revision };
  };

  const handleSelectPrompt = useCallback(
    (prompt: string) => {
      if (!activeConversationId) return;
      setDraft((prev) =>
        prev
          ? { ...prev, content: prompt }
          : {
              object: "emu_chat.draft",
              conversation_id: activeConversationId,
              content: prompt,
              revision: 0,
              updated_at: null,
            },
      );
    },
    [activeConversationId],
  );

  const handleLoadEarlier = useCallback(async () => {
    const cursor = olderMessagesCursorRef.current;
    if (!activeConversationId || loadingEarlier || !hasMoreEarlier || !cursor)
      return;
    const loadId = activeLoadRef.current;
    setLoadingEarlier(true);
    try {
      let offset = cursor.offset;
      for (;;) {
        const response = await apiClient.listMessages(activeConversationId, {
          limit: MESSAGE_PAGE_SIZE + 1,
          offset,
          order: "latest",
        });
        if (
          activeConversationIdRef.current !== activeConversationId ||
          activeLoadRef.current !== loadId
        )
          return;

        const firstOlderIndex = response.items.findIndex(
          (item) => item.id < cursor.oldestId,
        );
        if (firstOlderIndex !== -1) {
          const earlier = response.items.slice(firstOlderIndex);
          const oldest = earlier.at(-1)!;
          olderMessagesCursorRef.current = {
            oldestId: oldest.id,
            offset: response.offset + response.items.length - 1,
          };
          setMessages((prev) => mergeMessages(prev, earlier));
          setHasMoreEarlier(response.has_more);
          return;
        }
        if (!response.has_more || response.items.length === 0) {
          setHasMoreEarlier(false);
          return;
        }
        // New messages shift latest-first offsets. Keep scanning until this
        // page reaches the oldest message already shown, then prepend older ones.
        offset = response.offset + Math.max(response.items.length - 1, 1);
      }
    } catch (error) {
      if (
        activeConversationIdRef.current === activeConversationId &&
        activeLoadRef.current === loadId
      ) {
        setWorkspaceError(getErrorMessage(error, "加载更早历史消息失败"));
      }
    } finally {
      if (
        activeConversationIdRef.current === activeConversationId &&
        activeLoadRef.current === loadId
      ) {
        setLoadingEarlier(false);
      }
    }
  }, [activeConversationId, hasMoreEarlier, loadingEarlier]);

  const refreshLatestMessages = useCallback(async (conversationId: string) => {
    const loadId = activeLoadRef.current;
    const latestLoadSeq = ++latestLoadSeqRef.current;
    const anchorId =
      messagesRef.current.conversationId === conversationId
        ? (messagesRef.current.items.at(-1)?.id ?? null)
        : null;
    const result = await fetchLatestThroughAnchor(conversationId, anchorId);
    if (
      activeConversationIdRef.current !== conversationId ||
      activeLoadRef.current !== loadId ||
      latestLoadSeq !== latestLoadSeqRef.current
    )
      return;
    if (anchorId !== null && result.reachedAnchor) {
      setMessages((prev) => mergeMessages(prev, result.items));
    } else {
      setMessages(mergeMessages([], result.items));
      olderMessagesCursorRef.current = result.cursor;
      setHasMoreEarlier(result.hasMoreEarlier);
    }
    setMessagesConversationId(conversationId);
  }, []);

  const applyQueue = useCallback((nextQueue: QueueListResponse | null) => {
    queueRef.current = nextQueue;
    setQueue(nextQueue);
  }, []);

  const applyRun = useCallback((nextRun: RunResponse | null) => {
    activeRunRef.current = nextRun;
    setActiveRun(nextRun);
  }, []);

  const upsertQueueItemInView = useCallback(
    (conversationId: string, item: QueueItemResponse) => {
      applyQueue(upsertQueueItem(queueRef.current, conversationId, item));
    },
    [applyQueue],
  );

  const replaceQueueItemInView = useCallback(
    (item: QueueItemResponse) => {
      applyQueue(replaceQueueItem(queueRef.current, item));
    },
    [applyQueue],
  );

  const clearStreamForNewSend = useCallback(() => {
    setStreamedAssistantContent("");
    streamedAssistantRunIdRef.current = null;
  }, []);

  const appendStreamDelta = useCallback(
    (runId: string, sequence: number | null, delta: string) => {
      streamedAssistantRunIdRef.current = runId;
      const content = streamedAssistantCacheRef.current.append(
        runId,
        sequence,
        delta,
      );
      if (content !== null) setStreamedAssistantContent(content);
    },
    [],
  );

  const clearStreamAfterReconcile = useCallback((runId: string) => {
    if (streamedAssistantRunIdRef.current === runId) {
      setStreamedAssistantContent("");
      streamedAssistantRunIdRef.current = null;
    }
    streamedAssistantCacheRef.current.clear(runId);
  }, []);

  const restoreCachedView = useCallback(
    (conversationId: string) => {
      activeLoadRef.current += 1;
      activeConversationIdRef.current = conversationId;
      const snapshot = conversationViewCacheRef.current.get(conversationId);
      setConversationLoadError(null);
      if (snapshot) restoreConversationView(snapshot);
    },
    [restoreConversationView],
  );

  const dropCachedView = useCallback((conversationId: string) => {
    conversationViewCacheRef.current.delete(conversationId);
  }, []);

  return {
    activeConversation,
    setActiveConversation,
    messages,
    setMessages,
    hasMoreEarlier,
    loadingEarlier,
    draft,
    setDraft,
    queue,
    activeRun,
    queueOpen,
    setQueueOpen,
    streamedAssistantContent,
    activeConversationIdRef,
    activeRunRef,
    queueRef,
    hasTargetMessages,
    hasActiveConversationView,
    transitionSnapshot,
    activeConversationSummary,
    activeConversationTitle,
    currentConversationLoadError,
    visibleQueue,
    visibleRun,
    activeQueueItem,
    queuedMessages,
    agentGenerating,
    loadActiveConversation,
    handleLoadEarlier,
    refreshLatestMessages,
    handleSaveDraft,
    handleSelectPrompt,
    applyQueue,
    applyRun,
    upsertQueueItemInView,
    replaceQueueItemInView,
    clearStreamForNewSend,
    appendStreamDelta,
    clearStreamAfterReconcile,
    restoreCachedView,
    dropCachedView,
  };
}

export type ConversationView = ReturnType<typeof useConversationView>;
