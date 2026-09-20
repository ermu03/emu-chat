import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { CurrentSegmentBanner } from "./features/messages/current-segment-banner.js";
import { MessageView } from "./features/messages/message-view.js";
import { DraftComposer } from "./features/composer/draft-composer.js";
import { QueueDrawer } from "./features/queue/queue-drawer.js";
import { ApprovalDialog } from "./features/approval/approval-dialog.js";
import {
  PreferencesDrawer,
  type PreferencesState,
} from "./features/preferences/preferences-drawer.js";
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
  const [searchQuery, setSearchQuery] = useState("");
  const [queueOpen, setQueueOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [streamNotice, setStreamNotice] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const activeLoadRef = useRef(0);
  const activeConversationIdRef = useRef<string | null>(null);
  const activeRunRef = useRef<RunResponse | null>(null);
  const pendingSendRef = useRef<PendingSend | null>(null);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    activeRunRef.current = activeRun;
  }, [activeRun]);

  useEffect(() => {
    setStreamNotice(null);
  }, [activeConversationId, activeRun?.id]);

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
      setActiveRun(null);
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
      if (
        type === "approval.request" ||
        type === "run.completed" ||
        type === "run.failed" ||
        type === "run.cancelled" ||
        type === "run.interrupted"
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
    setActiveRun(null);
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

    let pending = pendingSendRef.current;
    if (
      !pending ||
      pending.conversationId !== activeConversationId ||
      pending.expectedRevision !== expectedDraftRevision
    ) {
      pending = {
        conversationId: activeConversationId,
        requestId: generateBrowserUuid(),
        expectedRevision: expectedDraftRevision,
      };
      pendingSendRef.current = pending;
    }

    try {
      const result = await apiClient.sendMessage(activeConversationId, {
        client_request_id: pending.requestId,
        expected_draft_revision: expectedDraftRevision,
      });
      pendingSendRef.current = null;
      setDraft(result.draft);
      setQueue((current) =>
        upsertQueueItem(current, activeConversationId, result.queue_item),
      );
      void refreshRuntime(activeConversationId, result.queue_item.local_run_id);
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
    setQueue((current) => replaceQueueItem(current, item));
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
    setQueue((current) => replaceQueueItem(current, item));
  };

  const handleResumeQueue = async () => {
    if (!activeConversationId) throw new Error("请先选择会话");
    const nextQueue = await apiClient.resumeQueue(activeConversationId);
    setQueue(nextQueue);
    void refreshRuntime(activeConversationId);
  };

  const handleCopyToDraft = async (queueItemId: string) => {
    if (!draft) throw new Error("草稿尚未加载");
    const overwrite = draft.content.length > 0;
    if (
      overwrite &&
      !window.confirm(
        "当前草稿会被恢复正文覆盖。再次发送可能产生重复。继续吗？",
      )
    ) {
      return;
    }
    const result = await apiClient.copyToDraft(queueItemId, {
      expected_draft_revision: draft.revision,
      overwrite_nonempty: overwrite,
    });
    setDraft(result.draft);
  };

  const handleDiscardRecovery = async (queueItemId: string) => {
    const item = await apiClient.discardRecovery(queueItemId);
    setQueue((current) => replaceQueueItem(current, item));
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
    setQueue((current) => replaceQueueItem(current, result.queue_item));
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
  const showStop =
    isLiveRun(activeRun) &&
    activeRun?.upstream_status !== "waiting_for_approval";
  const showReconcile =
    activeRun?.local_state === "reconciling" ||
    (activeRun?.local_state === "review_required" &&
      activeRun.hermes_run_id !== null);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-neutral-100 dark:bg-neutral-950 font-sans">
      <StatusBar
        status={status}
        loading={statusLoading}
        onRecheck={() => void loadStatus(true)}
      />

      {workspaceError && (
        <div
          role="alert"
          className="px-4 py-2 text-xs bg-rose-50 text-rose-800 border-b border-rose-200"
        >
          {workspaceError}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {sidebarOpen && (
          <button
            aria-label="关闭侧边栏"
            className="conversation-sidebar-backdrop"
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
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          loading={conversationsLoading}
          style={{
            width: effectivePreferences.sidebar_width,
            flex: `0 0 ${effectivePreferences.sidebar_width}px`,
          }}
          mobileOpen={sidebarOpen}
          onMobileClose={() => setSidebarOpen(false)}
        />

        <main className="flex-1 flex flex-col h-full overflow-hidden bg-white dark:bg-neutral-900">
          {activeConversation ? (
            <>
              <CurrentSegmentBanner conversation={activeConversation} />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "8px 16px",
                  borderBottom: "1px solid var(--border-color)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    minWidth: 0,
                  }}
                >
                  <button
                    className="mobile-sidebar-toggle"
                    aria-label="Toggle Sidebar"
                    onClick={() => setSidebarOpen(true)}
                    style={toolbarButtonStyle}
                  >
                    会话
                  </button>
                  <strong
                    style={{
                      fontSize: 13,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {activeConversation.title || "未命名会话"}
                  </strong>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => setQueueOpen(true)}
                    aria-label="打开消息队列"
                    style={toolbarButtonStyle}
                  >
                    队列 {queue?.data.length ?? 0}
                  </button>
                  <button
                    onClick={() => setPreferencesOpen(true)}
                    aria-label="打开偏好设置"
                    style={toolbarButtonStyle}
                  >
                    设置
                  </button>
                </div>
              </div>

              {activeRun && (
                <div
                  aria-live="polite"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "8px 16px",
                    background: "#f8fafc",
                    borderBottom: "1px solid var(--border-color)",
                    fontSize: 12,
                  }}
                >
                  <span>{getRunLabel(activeRun)}</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    {showStop && (
                      <button
                        onClick={() => void handleStopRun()}
                        style={dangerToolbarButtonStyle}
                      >
                        停止
                      </button>
                    )}
                    {showReconcile && (
                      <button
                        onClick={() => void handleReconcile()}
                        style={toolbarButtonStyle}
                      >
                        重新核对状态
                      </button>
                    )}
                  </div>
                </div>
              )}

              {streamNotice && (
                <div
                  className="text-xs text-amber-700"
                  style={{ padding: "6px 16px", background: "#fffbeb" }}
                >
                  {streamNotice}
                </div>
              )}
              {stream.isReconnecting && (
                <div
                  className="text-xs text-neutral-500"
                  style={{ padding: "6px 16px" }}
                >
                  {stream.error ?? "正在重新连接实时过程..."}
                </div>
              )}

              <MessageView messages={messages} loading={messagesLoading} />

              <div
                style={{
                  borderTop: "1px solid var(--border-color)",
                  padding: 12,
                  background: "var(--bg-primary)",
                }}
              >
                {draft ? (
                  <DraftComposer
                    conversationId={activeConversation.conversation_id}
                    initialDraft={draft.content}
                    initialRevision={draft.revision}
                    sendShortcut={effectivePreferences.send_shortcut}
                    onSaveDraft={handleSaveDraft}
                    onSend={handleSend}
                    disabled={composerDisabled}
                    sendDisabled={sendDisabled}
                  />
                ) : (
                  <div className="text-xs text-neutral-400">
                    正在加载草稿...
                  </div>
                )}
                {status?.status !== "healthy" && (
                  <div
                    className="text-xs text-neutral-500"
                    style={{ marginTop: 6 }}
                  >
                    连接恢复后请手动发送；草稿仍可保存。
                  </div>
                )}
              </div>
            </>
          ) : (
            <div
              className="flex-1 flex flex-col items-center justify-center text-neutral-400 text-xs"
              style={{ gap: 12 }}
            >
              <span>请从左侧选择或新建一个会话</span>
              <button
                className="mobile-sidebar-toggle"
                aria-label="Toggle Sidebar"
                onClick={() => setSidebarOpen(true)}
                style={toolbarButtonStyle}
              >
                会话
              </button>
              <button
                onClick={() => setPreferencesOpen(true)}
                style={toolbarButtonStyle}
              >
                设置
              </button>
            </div>
          )}
        </main>
      </div>

      <QueueDrawer
        isOpen={queueOpen}
        onClose={() => setQueueOpen(false)}
        items={queue?.data ?? []}
        paused={queue?.paused ?? false}
        pauseReason={queue?.pause_reason ?? null}
        onCancelItem={handleCancelQueueItem}
        onEditItem={handleEditQueueItem}
        onResume={handleResumeQueue}
        onCopyToDraft={handleCopyToDraft}
        onDiscardRecovery={handleDiscardRecovery}
      />

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

function getCurrentRunId(queue: QueueListResponse): string | null {
  return (
    queue.data.find((item) => item.local_run_id && isLiveQueueState(item.state))
      ?.local_run_id ?? null
  );
}

function isLiveQueueState(state: QueueItemResponse["state"]): boolean {
  return (
    state === "queued" ||
    state === "dispatching" ||
    state === "accepted" ||
    state === "reconciling"
  );
}

function isLiveRun(run: RunResponse | null): boolean {
  if (!run) return false;
  return (
    run.local_state === "submitting" ||
    run.local_state === "accepted" ||
    run.local_state === "reconciling" ||
    run.upstream_status === "queued" ||
    run.upstream_status === "running" ||
    run.upstream_status === "waiting_for_approval" ||
    run.upstream_status === "stopping"
  );
}

function getRunLabel(run: RunResponse): string {
  if (run.upstream_status === "waiting_for_approval") return "运行等待确认";
  if (run.upstream_status === "stopping") return "正在停止运行";
  if (run.local_state === "submitting" || run.upstream_status === "queued")
    return "正在提交到 Hermes";
  if (run.local_state === "reconciling") return "正在核对最终结果";
  if (run.local_state === "review_required") return "需要人工复核";
  if (run.upstream_status === "running") return "Hermes 正在运行";
  if (run.local_state === "reconciled") return "运行已完成";
  return "运行状态已更新";
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

const toolbarButtonStyle: React.CSSProperties = {
  border: "1px solid var(--border-color)",
  borderRadius: 4,
  padding: "5px 9px",
  background: "var(--bg-primary)",
  color: "var(--text-primary)",
  fontSize: 12,
  cursor: "pointer",
};

const dangerToolbarButtonStyle: React.CSSProperties = {
  ...toolbarButtonStyle,
  borderColor: "#dc2626",
  color: "#b91c1c",
};
