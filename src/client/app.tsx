import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiClientError, apiClient } from "./api/client.js";
import type {
  ConnectionStatusResponse,
  ConversationDetailResponse,
  ConversationSummary,
  DraftResponse,
  MessageItem,
  PreferencesResponse,
  QueueItemResponse,
  QueueListResponse,
  RunResponse,
} from "../shared/api-schemas.js";
import { StatusBar } from "./features/status/status-bar.js";
import { ConversationList } from "./features/conversations/conversation-list.js";
import { ConversationViewCache } from "./features/conversations/conversation-view-cache.js";
import {
  MessageView,
  type PendingUserMessage,
} from "./features/messages/message-view.js";
import { mergeMessages } from "./features/messages/message-display.js";
import { StreamedAssistantCache } from "./features/messages/streamed-assistant-cache.js";
import { DraftComposer } from "./features/composer/draft-composer.js";
import {
  QueuePanel,
  type PendingQueueItem,
} from "./features/queue/queue-panel.js";
import {
  getCurrentRunId,
  getQueuedFollowUps,
  getPrimaryQueueItem,
  isAgentGenerating,
  isLiveQueueState,
  isLiveRun,
} from "./features/queue/queue-state.js";
import { ApprovalDialog } from "./features/approval/approval-dialog.js";
import {
  PreferencesDrawer,
  type PreferencesState,
} from "./features/preferences/preferences-drawer.js";
import { MessageSquarePlus, Menu, Settings2, Sparkles } from "lucide-react";
import {
  useStreamEvents,
  type RunStreamEvent,
} from "./state/use-stream-events.js";

const DEFAULT_PREFERENCES: PreferencesState = {
  theme: "system",
  sidebar_width: 320,
  send_shortcut: "mod_enter",
  revision: 0,
};

type PendingSend = {
  conversationId: string;
  requestId: string;
  expectedRevision: number;
};

type PendingSubmission = {
  requestId: string;
  conversationId: string;
  content: string;
  isFollowUp: boolean;
};

type ConversationViewSnapshot = {
  conversation: ConversationDetailResponse;
  messages: MessageItem[];
  hasMoreEarlier: boolean;
  draft: DraftResponse;
  queue: QueueListResponse;
  activeRun: RunResponse | null;
  queueOpen: boolean;
  streamedContent: string;
  streamedRunId: string | null;
};

type RetainedConversationView = {
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

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const routeConversationId = getConversationIdFromPath(location.pathname);

  const [status, setStatus] = useState<ConnectionStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [activeConversation, setActiveConversation] =
    useState<ConversationDetailResponse | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [messagesConversationId, setMessagesConversationId] = useState<
    string | null
  >(null);
  const [hasMoreEarlier, setHasMoreEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [queue, setQueue] = useState<QueueListResponse | null>(null);
  const [activeRun, setActiveRun] = useState<RunResponse | null>(null);
  const [preferences, setPreferences] = useState<PreferencesResponse | null>(
    null,
  );
  const [queueOpen, setQueueOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [streamNotice, setStreamNotice] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [conversationLoadError, setConversationLoadError] = useState<{
    conversationId: string;
    message: string;
  } | null>(null);
  const [pendingSubmissions, setPendingSubmissions] = useState<
    PendingSubmission[]
  >([]);

  const activeLoadRef = useRef(0);
  const routeConversationIdRef = useRef(routeConversationId);
  const activeConversationIdRef = useRef<string | null>(null);
  const activeRunRef = useRef<RunResponse | null>(null);
  const queueRef = useRef<QueueListResponse | null>(null);
  const pendingSendRef = useRef<PendingSend | null>(null);
  const lastConversationListRefreshRunIdRef = useRef<string | null>(null);
  const previousQueuedMessageCountRef = useRef(0);
  const streamedAssistantRunIdRef = useRef<string | null>(null);
  const streamedAssistantCacheRef = useRef(new StreamedAssistantCache());
  const conversationViewCacheRef = useRef(
    new ConversationViewCache<ConversationViewSnapshot>(),
  );
  const currentViewSnapshotRef = useRef<RetainedConversationView | null>(null);
  const [streamedAssistantContent, setStreamedAssistantContent] = useState("");

  routeConversationIdRef.current = routeConversationId;

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    activeRunRef.current = activeRun;
  }, [activeRun]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    setStreamNotice(null);
  }, [activeConversationId, activeRun?.id]);

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

  const loadStatus = useCallback(async (recheck = false) => {
    setStatusLoading(true);
    try {
      const data = recheck
        ? await apiClient.recheckStatus()
        : await apiClient.getStatus();
      setStatus(data);
    } catch (error) {
      setStatus(null);
      setWorkspaceError(getErrorMessage(error, "无法读取 Hermes 连接状态"));
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const loadPreferences = useCallback(async () => {
    try {
      setPreferences(await apiClient.getPreferences());
    } catch (error) {
      setWorkspaceError(getErrorMessage(error, "无法读取偏好设置"));
    }
  }, []);

  const loadConversations = useCallback(async () => {
    setConversationsLoading(true);
    try {
      const response = await apiClient.listConversations({ limit: 50 });
      setConversations(response.items);
      setActiveConversationId((current) => {
        if (current) return current;
        return (
          routeConversationIdRef.current ??
          response.items[0]?.conversation_id ??
          null
        );
      });
    } catch (error) {
      setWorkspaceError(getErrorMessage(error, "无法加载会话列表"));
    } finally {
      setConversationsLoading(false);
    }
  }, []);

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
      setDraft(null);
      setQueue(null);
      queueRef.current = null;
      setActiveRun(null);
      setQueueOpen(false);
      streamedAssistantRunIdRef.current = null;
      setStreamedAssistantContent("");
    }

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
        try {
          const response = await apiClient.listMessages(conversationId, {
            limit: 100,
            order: "oldest",
          });
          if (loadId !== activeLoadRef.current) return;
          setMessages(response.items);
          setMessagesConversationId(conversationId);
          setHasMoreEarlier(response.has_more);
        } catch (error) {
          if (loadId !== activeLoadRef.current || useCachedView) return;
          setMessages([]);
          setMessagesConversationId(null);
          setHasMoreEarlier(false);
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

  const refreshRuntime = useCallback(
    async (conversationId: string, knownRunId?: string | null) => {
      try {
        const nextQueue = await apiClient.getQueue(conversationId);
        if (activeConversationIdRef.current !== conversationId) return;
        setQueue(nextQueue);
        queueRef.current = nextQueue;

        const activeRunId =
          activeRunRef.current?.conversation_id === conversationId &&
          isLiveRun(activeRunRef.current)
            ? activeRunRef.current.id
            : null;
        const runId = getCurrentRunId(nextQueue) ?? knownRunId ?? activeRunId;
        if (!runId) {
          setActiveRun(null);
          return;
        }

        const run = await apiClient.getRun(runId);
        if (activeConversationIdRef.current !== conversationId) return;
        setActiveRun(run);

        if (run.local_state === "reconciled") {
          const messageResponse = await apiClient.listMessages(conversationId, {
            limit: 100,
            order: "latest",
          });
          if (activeConversationIdRef.current === conversationId) {
            setMessages((prev) => mergeMessages(prev, messageResponse.items));
            if (streamedAssistantRunIdRef.current === run.id) {
              setStreamedAssistantContent("");
              streamedAssistantRunIdRef.current = null;
            }
            streamedAssistantCacheRef.current.clear(run.id);
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
    [loadConversations],
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
          streamedAssistantRunIdRef.current = eventRunId;
          const content = streamedAssistantCacheRef.current.append(
            eventRunId,
            sequence,
            delta,
          );
          if (content !== null) setStreamedAssistantContent(content);
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
    [refreshRuntime],
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
      activeQueueItem?.content &&
      !hasPersistedQueueMessage(messages, activeQueueItem)
    ) {
      return {
        id: `queue:${activeQueueItem.id}`,
        content: activeQueueItem.content,
      };
    }

    const submission = activePendingSubmissions.find(
      (entry) => !entry.isFollowUp,
    );
    return submission
      ? {
          id: `submission:${submission.requestId}`,
          content: submission.content,
        }
      : null;
  }, [activePendingSubmissions, activeQueueItem, messages]);
  const transitionPendingUserMessage =
    useMemo<PendingUserMessage | null>(() => {
      if (!transitionSnapshot) return null;

      const queueItem = getPrimaryQueueItem(
        transitionSnapshot.queue,
        transitionSnapshot.activeRun,
      );
      if (
        queueItem?.content &&
        !hasPersistedQueueMessage(transitionSnapshot.messages, queueItem)
      ) {
        return { id: `queue:${queueItem.id}`, content: queueItem.content };
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
        })),
    [activePendingSubmissions],
  );
  const hasPendingPrimarySubmission = activePendingSubmissions.some(
    (entry) => !entry.isFollowUp,
  );

  useEffect(() => {
    if (queuedMessages.length > previousQueuedMessageCountRef.current) {
      setQueueOpen(true);
    }
    previousQueuedMessageCountRef.current = queuedMessages.length;
  }, [queuedMessages.length]);

  useEffect(() => {
    void loadStatus();
    void loadConversations();
    void loadPreferences();
  }, [loadConversations, loadPreferences, loadStatus]);

  useEffect(() => {
    if (!routeConversationId || routeConversationId === activeConversationId)
      return;
    setActiveConversationId(routeConversationId);
  }, [activeConversationId, routeConversationId]);

  useEffect(() => {
    if (activeConversationId) {
      void loadActiveConversation(activeConversationId);
      return;
    }

    activeLoadRef.current += 1;
    setActiveConversation(null);
    setMessages([]);
    setMessagesConversationId(null);
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

  useEffect(() => {
    if (!preferences) return;
    const applyTheme = () => {
      const resolved =
        preferences.theme === "system"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : preferences.theme;
      document.documentElement.dataset.theme = resolved;
    };
    applyTheme();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [preferences]);

  const selectConversation = (conversationId: string) => {
    const snapshot = conversationViewCacheRef.current.get(conversationId);
    setConversationLoadError(null);
    if (snapshot) {
      restoreConversationView(snapshot);
    }
    setActiveConversationId(conversationId);
    navigate(`/conversations/${encodeURIComponent(conversationId)}`);
  };

  const handleCreateConversation = async () => {
    const title = window.prompt("请输入新会话标题（可选）：", "新会话");
    if (title === null) return;
    try {
      const created = await apiClient.createConversation({
        title: title.trim() || undefined,
      });
      await loadConversations();
      selectConversation(created.conversation_id);
    } catch (error) {
      setWorkspaceError(getErrorMessage(error, "创建会话失败"));
    }
  };

  const handleFork = async (conversationId: string) => {
    try {
      const forked = await apiClient.forkConversation(conversationId);
      await loadConversations();
      selectConversation(forked.conversation_id);
    } catch (error) {
      setWorkspaceError(getErrorMessage(error, "分叉会话失败"));
    }
  };

  const handleDelete = async (
    conversationId: string,
    hermesSessionId: string,
    confirmed: boolean,
  ) => {
    try {
      await apiClient.deleteConversation(conversationId, {
        expected_hermes_session_id: hermesSessionId,
        confirmed,
      });
      conversationViewCacheRef.current.delete(conversationId);
      if (activeConversationId === conversationId) {
        setActiveConversationId(null);
        navigate("/");
      }
      await loadConversations();
    } catch (error) {
      setWorkspaceError(getErrorMessage(error, "删除会话失败"));
    }
  };

  const handleUpdateMetadata = async (
    conversationId: string,
    title: string,
    pinned: boolean,
  ) => {
    try {
      const current = conversations.find(
        (conversation) => conversation.conversation_id === conversationId,
      );
      if (!current || current.title !== title) {
        await apiClient.patchHermesMetadata(conversationId, {
          field: "title",
          value: title,
        });
      }
      if (!current || current.pinned !== pinned) {
        await apiClient.patchHermesMetadata(conversationId, {
          field: "pinned",
          value: pinned,
        });
      }
      await loadConversations();
      if (activeConversationId === conversationId && activeConversation) {
        setActiveConversation({ ...activeConversation, title, pinned });
      }
    } catch (error) {
      setWorkspaceError(getErrorMessage(error, "更新会话失败"));
    }
  };

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

  const handleSend = async (content: string, expectedDraftRevision: number) => {
    if (!activeConversationId) throw new Error("请先选择会话");
    const conversationId = activeConversationId;
    const isFollowUp = isAgentGenerating(
      activeRunRef.current,
      queueRef.current,
    );
    if (!isFollowUp) {
      setStreamedAssistantContent("");
      streamedAssistantRunIdRef.current = null;
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
        isFollowUp,
      },
    ]);
    if (isFollowUp) setQueueOpen(true);

    try {
      const result = await apiClient.sendMessage(conversationId, {
        client_request_id: pending.requestId,
        expected_draft_revision: expectedDraftRevision,
      });
      pendingSendRef.current = null;
      setPendingSubmissions((current) =>
        current.filter((entry) => entry.requestId !== pending.requestId),
      );
      if (activeConversationIdRef.current === conversationId) {
        setDraft(result.draft);
        const nextQueue = upsertQueueItem(
          queueRef.current,
          conversationId,
          result.queue_item,
        );
        queueRef.current = nextQueue;
        setQueue(nextQueue);
        if (isFollowUp) setQueueOpen(true);
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
          revision: result.draft.revision,
        },
      };
    } catch (error) {
      // A response-bearing API error is definite; only a transport failure may
      // safely reuse the UUID when the user retries the same send.
      if (error instanceof ApiClientError) {
        pendingSendRef.current = null;
        setPendingSubmissions((current) =>
          current.filter((entry) => entry.requestId !== pending.requestId),
        );
      }
      throw error;
    }
  };

  const handleCancelQueueItem = async (
    queueItemId: string,
    expectedRevision: number,
  ) => {
    const item = await apiClient.cancelQueueItem(queueItemId, {
      expected_revision: expectedRevision,
    });
    const nextQueue = replaceQueueItem(queueRef.current, item);
    queueRef.current = nextQueue;
    setQueue(nextQueue);
    if (activeConversationId) void refreshRuntime(activeConversationId);
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
    const nextQueue = replaceQueueItem(queueRef.current, item);
    queueRef.current = nextQueue;
    setQueue(nextQueue);
  };

  const handleStopRun = async () => {
    if (!activeRun) return;
    const nextRun = await apiClient.stopRun(activeRun.id);
    setActiveRun(nextRun);
    if (activeConversationId)
      void refreshRuntime(activeConversationId, nextRun.id);
  };

  const handleApproval = async (choice: "once" | "deny") => {
    if (!activeRun) return;
    const nextRun = await apiClient.submitApproval(activeRun.id, {
      choice,
      request_id: activeRun.approval?.request_id,
    });
    setActiveRun(nextRun);
    if (activeConversationId)
      void refreshRuntime(activeConversationId, nextRun.id);
  };

  const handleReconcile = async () => {
    if (!activeRun) return;
    const result = await apiClient.reconcileRun(activeRun.id);
    setActiveRun(result.run);
    const nextQueue = replaceQueueItem(queueRef.current, result.queue_item);
    queueRef.current = nextQueue;
    setQueue(nextQueue);
    if (activeConversationId)
      void refreshRuntime(activeConversationId, result.run.id);
  };

  const handleLoadEarlier = useCallback(async () => {
    if (!activeConversationId || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const response = await apiClient.listMessages(activeConversationId, {
        limit: 100,
        offset: messages.length,
        order: "oldest",
      });
      if (activeConversationIdRef.current === activeConversationId) {
        setMessages((prev) => mergeMessages(prev, response.items));
        setHasMoreEarlier(response.has_more);
      }
    } catch (error) {
      setWorkspaceError(getErrorMessage(error, "加载更早历史消息失败"));
    } finally {
      setLoadingEarlier(false);
    }
  }, [activeConversationId, loadingEarlier, messages.length]);

  const handleUpdatePreferences = async (patch: Partial<PreferencesState>) => {
    if (!preferences) throw new Error("偏好设置尚未加载");
    const next = await apiClient.putPreferences({
      theme: patch.theme ?? preferences.theme,
      sidebar_width: patch.sidebar_width ?? preferences.sidebar_width,
      send_shortcut: patch.send_shortcut ?? preferences.send_shortcut,
      expected_revision: preferences.revision,
    });
    setPreferences(next);
  };

  const composerDisabled =
    !hasActiveConversationView || activeConversation?.delete_state !== "none";
  const sendDisabled = status?.status !== "healthy" || composerDisabled;
  const effectivePreferences = preferences ?? DEFAULT_PREFERENCES;
  const sidebarWidth = sidebarCollapsed
    ? 64
    : effectivePreferences.sidebar_width;
  const showStop =
    isLiveRun(visibleRun) &&
    visibleRun?.upstream_status !== "waiting_for_approval";
  const showReconcile =
    visibleRun?.local_state === "reconciling" ||
    (visibleRun?.local_state === "review_required" &&
      visibleRun.hermes_run_id !== null);
  const isAssistantReplying =
    (agentGenerating || hasPendingPrimarySubmission) &&
    visibleRun?.upstream_status !== "waiting_for_approval" &&
    visibleRun?.upstream_status !== "stopping";

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          type="button"
          aria-label="关闭侧边栏"
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <ConversationList
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelect={selectConversation}
        onCreate={() => void handleCreateConversation()}
        onFork={(conversationId) => void handleFork(conversationId)}
        onDelete={(conversationId, hermesSessionId, confirmed) =>
          void handleDelete(conversationId, hermesSessionId, confirmed)
        }
        onUpdateMetadata={(conversationId, title, pinned) =>
          void handleUpdateMetadata(conversationId, title, pinned)
        }
        loading={conversationsLoading}
        style={{
          width: sidebarWidth,
          flex: `0 0 ${sidebarWidth}px`,
        }}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((collapsed) => !collapsed)}
        mobileOpen={sidebarOpen}
        onMobileClose={() => setSidebarOpen(false)}
        status={status?.status}
      />

      <main className="app-main">
        {workspaceError && (
          <div className="workspace-alert error" role="alert">
            <span>{workspaceError}</span>
            <button type="button" onClick={() => setWorkspaceError(null)}>
              关闭
            </button>
          </div>
        )}

        {activeConversationId ? (
          <>
            <header className="main-toolbar">
              <div className="main-toolbar-start">
                <button
                  type="button"
                  className="icon-button mobile-only"
                  aria-label="打开会话列表"
                  title="会话列表"
                  onClick={() => {
                    setSidebarCollapsed(false);
                    setSidebarOpen(true);
                  }}
                >
                  <Menu size={17} />
                </button>
                <span className="brand-mark" aria-hidden="true">
                  e
                </span>
                <div className="toolbar-title-block">
                  <div className="main-toolbar-title">
                    {activeConversationTitle}
                  </div>
                </div>
              </div>
              <div className="main-toolbar-end">
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setPreferencesOpen(true)}
                  aria-label="打开设置"
                  title="设置"
                >
                  <Settings2 size={16} strokeWidth={1.8} />
                </button>
              </div>
            </header>

            <StatusBar
              status={status}
              loading={statusLoading}
              onRecheck={() => void loadStatus(true)}
            />

            {activeConversationId && !hasTargetMessages && (
              <div
                className="workspace-alert"
                role={currentConversationLoadError ? "alert" : "status"}
              >
                <span>
                  {currentConversationLoadError
                    ? transitionSnapshot
                      ? `无法加载「${activeConversationSummary?.title || "目标会话"}」，仍显示「${transitionSnapshot.title || "未命名会话"}」。`
                      : `无法加载「${activeConversationSummary?.title || "目标会话"}」，请重试。`
                    : transitionSnapshot
                      ? `正在加载「${activeConversationSummary?.title || "目标会话"}」，当前暂显「${transitionSnapshot.title || "未命名会话"}」。`
                      : `正在加载「${activeConversationSummary?.title || "目标会话"}」。`}
                </span>
                {currentConversationLoadError && (
                  <button
                    type="button"
                    onClick={() =>
                      void loadActiveConversation(activeConversationId)
                    }
                  >
                    重试
                  </button>
                )}
              </div>
            )}

            {(streamNotice || stream.isReconnecting) && (
              <div className="workspace-alert" role="status">
                <span>
                  {streamNotice ?? stream.error ?? "正在重新连接实时过程"}
                </span>
              </div>
            )}

            <MessageView
              key={
                hasTargetMessages
                  ? activeConversationId
                  : (transitionSnapshot?.conversationId ?? activeConversationId)
              }
              messages={
                hasTargetMessages
                  ? messages
                  : (transitionSnapshot?.messages ?? [])
              }
              loading={!hasTargetMessages && !transitionSnapshot}
              hasMoreEarlier={hasActiveConversationView && hasMoreEarlier}
              loadingEarlier={hasActiveConversationView && loadingEarlier}
              onLoadEarlier={handleLoadEarlier}
              pendingUserMessage={
                hasTargetMessages
                  ? pendingUserMessage
                  : transitionPendingUserMessage
              }
              isGenerating={
                hasTargetMessages
                  ? isAssistantReplying
                  : transitionIsAssistantReplying
              }
              streamingContent={
                hasTargetMessages
                  ? streamedAssistantContent
                  : (transitionSnapshot?.streamedContent ?? "")
              }
              onStopGenerating={
                showStop ? () => void handleStopRun() : undefined
              }
              onReconcile={
                showReconcile ? () => void handleReconcile() : undefined
              }
              onSelectPrompt={handleSelectPrompt}
            />

            <div className="composer-shell">
              <div className="composer-inner">
                {queueOpen &&
                  (queuedMessages.length > 0 ||
                    pendingQueueItems.length > 0) && (
                    <QueuePanel
                      isOpen={queueOpen}
                      onClose={() => setQueueOpen(false)}
                      items={queuedMessages}
                      pendingItems={pendingQueueItems}
                      onCancelItem={handleCancelQueueItem}
                      onEditItem={handleEditQueueItem}
                    />
                  )}
                {hasActiveConversationView && draft ? (
                  <DraftComposer
                    conversationId={activeConversationId}
                    initialDraft={draft.content}
                    initialRevision={draft.revision}
                    sendShortcut={effectivePreferences.send_shortcut}
                    onSaveDraft={handleSaveDraft}
                    onSend={async (content, revision) => {
                      const result = await handleSend(content, revision);
                      return result;
                    }}
                    disabled={composerDisabled}
                    sendDisabled={sendDisabled}
                  />
                ) : (
                  <div className="composer-container composer-loading">
                    正在准备输入框...
                  </div>
                )}
                {status?.status !== "healthy" && (
                  <div className="composer-hint">
                    Hermes 恢复后即可发送，草稿会继续保存。
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <header className="main-toolbar">
              <div className="main-toolbar-start">
                <button
                  type="button"
                  className="icon-button mobile-only"
                  aria-label="打开会话列表"
                  title="会话列表"
                  onClick={() => {
                    setSidebarCollapsed(false);
                    setSidebarOpen(true);
                  }}
                >
                  <Menu size={17} />
                </button>
                <span className="brand-mark" aria-hidden="true">
                  e
                </span>
                <span className="main-toolbar-title">emu-chat</span>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setPreferencesOpen(true)}
                aria-label="打开设置"
                title="设置"
              >
                <Settings2 size={16} />
              </button>
            </header>
            <StatusBar
              status={status}
              loading={statusLoading}
              onRecheck={() => void loadStatus(true)}
            />
            <div className="message-empty">
              <div className="empty-greeting">
                <div className="empty-greeting-mark" aria-hidden="true">
                  <Sparkles size={24} strokeWidth={2} />
                </div>
                <h2>选择一个会话开始</h2>
                <p>从左侧打开已有会话，或创建一个全新的 Hermes 工作空间。</p>
                <button
                  type="button"
                  className="button-primary"
                  onClick={() => void handleCreateConversation()}
                >
                  <MessageSquarePlus size={14} />
                  新建会话
                </button>
              </div>
            </div>
          </>
        )}
      </main>

      <ApprovalDialog
        isOpen={
          visibleRun?.upstream_status === "waiting_for_approval" &&
          visibleRun.approval !== null
        }
        runId={visibleRun?.id ?? ""}
        reason="等待 Hermes 工具审批"
        details={visibleRun?.approval ?? undefined}
        onApprove={() => handleApproval("once")}
        onReject={() => handleApproval("deny")}
        onCancel={handleStopRun}
      />

      <PreferencesDrawer
        isOpen={preferencesOpen}
        preferences={effectivePreferences}
        onClose={() => setPreferencesOpen(false)}
        onUpdate={handleUpdatePreferences}
      />
    </div>
  );
}

function getConversationIdFromPath(pathname: string): string | null {
  const match = /^\/conversations\/([^/]+)$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function upsertQueueItem(
  current: QueueListResponse | null,
  conversationId: string,
  item: QueueItemResponse,
): QueueListResponse {
  if (!current || current.conversation_id !== conversationId) {
    return {
      object: "emu_chat.queue",
      conversation_id: conversationId,
      paused: false,
      pause_reason: null,
      data: [item],
    };
  }
  return (
    replaceQueueItem(current, item) ?? {
      object: "emu_chat.queue",
      conversation_id: conversationId,
      paused: current.paused,
      pause_reason: current.pause_reason,
      data: [...current.data, item],
    }
  );
}

function replaceQueueItem(
  current: QueueListResponse | null,
  item: QueueItemResponse,
): QueueListResponse | null {
  if (!current || current.conversation_id !== item.conversation_id)
    return current;
  const exists = current.data.some((entry) => entry.id === item.id);
  const data = exists
    ? current.data.map((entry) => (entry.id === item.id ? item : entry))
    : [...current.data, item];
  return {
    ...current,
    data: data.sort((left, right) => left.fifo_seq - right.fifo_seq),
  };
}

function hasPersistedQueueMessage(
  messages: MessageItem[],
  queueItem: QueueItemResponse,
): boolean {
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  return latestUserMessage?.content === queueItem.content;
}

function generateBrowserUuid(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error("当前浏览器无法安全生成发送请求标识");
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
