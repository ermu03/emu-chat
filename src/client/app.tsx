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
import { MessageView } from "./features/messages/message-view.js";
import { DraftComposer } from "./features/composer/draft-composer.js";
import { QueuePanel } from "./features/queue/queue-panel.js";
import {
  getCurrentRunId,
  getQueuedFollowUps,
  isAgentGenerating,
  isLiveQueueState,
  isLiveRun,
} from "./features/queue/queue-state.js";
import { ApprovalDialog } from "./features/approval/approval-dialog.js";
import {
  PreferencesDrawer,
  type PreferencesState,
} from "./features/preferences/preferences-drawer.js";
import { MessageSquarePlus, Menu, Settings2 } from "lucide-react";
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
  const [messagesLoading, setMessagesLoading] = useState(false);
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

  const activeLoadRef = useRef(0);
  const activeConversationIdRef = useRef<string | null>(null);
  const activeRunRef = useRef<RunResponse | null>(null);
  const queueRef = useRef<QueueListResponse | null>(null);
  const pendingSendRef = useRef<PendingSend | null>(null);
  const previousQueuedMessageCountRef = useRef(0);
  const streamedAssistantRunIdRef = useRef<string | null>(null);
  const [streamedAssistantContent, setStreamedAssistantContent] = useState("");

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
    if (activeRun?.id && streamedAssistantRunIdRef.current !== activeRun.id) {
      setStreamedAssistantContent("");
    }
  }, [activeRun?.id]);

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
          routeConversationId ?? response.items[0]?.conversation_id ?? null
        );
      });
    } catch (error) {
      setWorkspaceError(getErrorMessage(error, "无法加载会话列表"));
    } finally {
      setConversationsLoading(false);
    }
  }, [routeConversationId]);

  const loadActiveConversation = useCallback(async (conversationId: string) => {
    const loadId = ++activeLoadRef.current;
    setMessagesLoading(true);
    setWorkspaceError(null);

    const [conversationResult, messagesResult, draftResult, queueResult] =
      await Promise.allSettled([
        apiClient.getConversation(conversationId),
        apiClient.listMessages(conversationId, { limit: 100, order: "oldest" }),
        apiClient.getDraft(conversationId),
        apiClient.getQueue(conversationId),
      ]);

    if (loadId !== activeLoadRef.current) return;

    if (conversationResult.status === "fulfilled") {
      setActiveConversation(conversationResult.value);
    } else {
      setActiveConversation((current) =>
        current?.conversation_id === conversationId ? current : null,
      );
      setWorkspaceError(
        getErrorMessage(conversationResult.reason, "无法加载会话详情"),
      );
    }

    if (messagesResult.status === "fulfilled") {
      setMessages(messagesResult.value.items);
    } else {
      setMessages([]);
      setWorkspaceError(
        getErrorMessage(messagesResult.reason, "无法从 Hermes 加载消息"),
      );
    }

    if (draftResult.status === "fulfilled") {
      setDraft(draftResult.value);
    } else {
      setDraft(null);
      setWorkspaceError(getErrorMessage(draftResult.reason, "无法加载草稿"));
    }

    if (queueResult.status === "fulfilled") {
      setQueue(queueResult.value);
      queueRef.current = queueResult.value;
      const runId = getCurrentRunId(queueResult.value);
      if (runId) {
        try {
          const run = await apiClient.getRun(runId);
          if (loadId === activeLoadRef.current) setActiveRun(run);
        } catch (error) {
          if (loadId === activeLoadRef.current) {
            setWorkspaceError(getErrorMessage(error, "无法加载运行状态"));
          }
        }
      } else {
        setActiveRun(null);
      }
    } else {
      setQueue(null);
      queueRef.current = null;
      setActiveRun(null);
      setQueueOpen(false);
      setWorkspaceError(
        getErrorMessage(queueResult.reason, "无法加载消息队列"),
      );
    }

    if (loadId === activeLoadRef.current) setMessagesLoading(false);
  }, []);

  const refreshRuntime = useCallback(
    async (conversationId: string, knownRunId?: string | null) => {
      try {
        const nextQueue = await apiClient.getQueue(conversationId);
        if (activeConversationIdRef.current !== conversationId) return;
        setQueue(nextQueue);
        queueRef.current = nextQueue;

        const runId =
          knownRunId ??
          getCurrentRunId(nextQueue) ??
          activeRunRef.current?.id ??
          null;
        if (!runId) return;

        const run = await apiClient.getRun(runId);
        if (activeConversationIdRef.current !== conversationId) return;
        setActiveRun(run);

        if (run.local_state === "reconciled") {
          const messageResponse = await apiClient.listMessages(conversationId, {
            limit: 100,
            order: "oldest",
          });
          if (activeConversationIdRef.current === conversationId) {
            setMessages(messageResponse.items);
            if (streamedAssistantRunIdRef.current === run.id) {
              setStreamedAssistantContent("");
              streamedAssistantRunIdRef.current = null;
            }
          }
        }
      } catch (error) {
        if (activeConversationIdRef.current === conversationId) {
          setWorkspaceError(getErrorMessage(error, "无法刷新运行状态"));
        }
      }
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
      if (!conversationId || !eventRunId) return;

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
        const delta =
          payload &&
          typeof payload === "object" &&
          typeof (payload as Record<string, unknown>).delta === "string"
            ? (payload as Record<string, unknown>).delta
            : "";
        if (delta) {
          streamedAssistantRunIdRef.current = eventRunId;
          setStreamedAssistantContent((content) => content + delta);
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

  const liveRunId = activeRun && isLiveRun(activeRun) ? activeRun.id : null;
  const stream = useStreamEvents({
    localRunId: liveRunId,
    enabled: liveRunId !== null,
    onEvent: handleRunStreamEvent,
  });

  const queuedMessages = useMemo(
    () => getQueuedFollowUps(queue, activeRun),
    [activeRun, queue],
  );
  const agentGenerating = isAgentGenerating(activeRun, queue);

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
    setDraft(null);
    setQueue(null);
    queueRef.current = null;
    setActiveRun(null);
    setQueueOpen(false);
    previousQueuedMessageCountRef.current = 0;
  }, [activeConversationId, loadActiveConversation]);

  const shouldPollRuntime = useMemo(() => {
    if (isLiveRun(activeRun)) return true;
    return queue?.data.some((item) => isLiveQueueState(item.state)) ?? false;
  }, [activeRun, queue]);

  useEffect(() => {
    if (!activeConversationId || !shouldPollRuntime) return;
    const timer = window.setInterval(() => {
      void refreshRuntime(activeConversationId, activeRun?.id);
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [activeConversationId, activeRun?.id, refreshRuntime, shouldPollRuntime]);

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

  const handleSend = async (expectedDraftRevision: number) => {
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

    try {
      const result = await apiClient.sendMessage(conversationId, {
        client_request_id: pending.requestId,
        expected_draft_revision: expectedDraftRevision,
      });
      pendingSendRef.current = null;
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
      void loadConversations();
      return {
        draft: {
          content: result.draft.content,
          revision: result.draft.revision,
        },
      };
    } catch (error) {
      // A response-bearing API error is definite; only a transport failure may
      // safely reuse the UUID when the user retries the same send.
      if (error instanceof ApiClientError) pendingSendRef.current = null;
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

  const composerDisabled = activeConversation?.delete_state !== "none";
  const sendDisabled = status?.status !== "healthy" || composerDisabled;
  const effectivePreferences = preferences ?? DEFAULT_PREFERENCES;
  const sidebarWidth = sidebarCollapsed
    ? 64
    : effectivePreferences.sidebar_width;
  const showStop =
    isLiveRun(activeRun) &&
    activeRun?.upstream_status !== "waiting_for_approval";
  const showReconcile =
    activeRun?.local_state === "reconciling" ||
    (activeRun?.local_state === "review_required" &&
      activeRun.hermes_run_id !== null);
  const isAssistantReplying =
    agentGenerating &&
    activeRun?.upstream_status !== "waiting_for_approval" &&
    activeRun?.upstream_status !== "stopping";

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

        {activeConversation ? (
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
                    {activeConversation.title || "未命名会话"}
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

            {(streamNotice || stream.isReconnecting) && (
              <div className="workspace-alert" role="status">
                <span>
                  {streamNotice ?? stream.error ?? "正在重新连接实时过程"}
                </span>
              </div>
            )}

            <MessageView
              messages={messages}
              loading={messagesLoading}
              isGenerating={isAssistantReplying}
              streamingContent={streamedAssistantContent}
              onStopGenerating={
                showStop ? () => void handleStopRun() : undefined
              }
              onReconcile={
                showReconcile ? () => void handleReconcile() : undefined
              }
            />

            <div className="composer-shell">
              <div className="composer-inner">
                {queueOpen && queuedMessages.length > 0 && (
                  <QueuePanel
                    isOpen={queueOpen}
                    onClose={() => setQueueOpen(false)}
                    items={queuedMessages}
                    onCancelItem={handleCancelQueueItem}
                    onEditItem={handleEditQueueItem}
                  />
                )}
                {draft ? (
                  <DraftComposer
                    conversationId={activeConversation.conversation_id}
                    initialDraft={draft.content}
                    initialRevision={draft.revision}
                    sendShortcut={effectivePreferences.send_shortcut}
                    onSaveDraft={handleSaveDraft}
                    onSend={async (revision) => {
                      const result = await handleSend(revision);
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
                  e
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
          activeRun?.upstream_status === "waiting_for_approval" &&
          activeRun.approval !== null
        }
        runId={activeRun?.id ?? ""}
        reason="等待 Hermes 工具审批"
        details={activeRun?.approval ?? undefined}
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
