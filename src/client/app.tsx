import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { apiClient } from "./api/client.js";
import type {
  ConnectionStatusResponse,
  ConversationSummary,
  PreferencesResponse,
} from "../shared/api-schemas.js";
import { StatusBar } from "./features/status/status-bar.js";
import { ConversationList } from "./features/conversations/conversation-list.js";
import { MessageView } from "./features/messages/message-view.js";
import {
  DraftComposer,
  type DraftComposerHandle,
} from "./features/composer/draft-composer.js";
import { QueuePanel } from "./features/queue/queue-panel.js";
import { isLiveRun } from "./features/queue/queue-state.js";
import { ApprovalDialog } from "./features/approval/approval-dialog.js";
import {
  Check,
  Menu,
  MessageSquarePlus,
  Moon,
  Pencil,
  Sparkles,
  Sun,
} from "lucide-react";
import { getErrorMessage } from "./state/app-shell-utils.js";
import { useConversationView } from "./state/use-conversation-view.js";
import { useRunRuntime } from "./state/use-run-runtime.js";
import { useMessageSend } from "./state/use-message-send.js";

type PreferencePatch = Partial<
  Pick<PreferencesResponse, "theme" | "sidebar_width">
>;

function getStoredSidebarWidth(): number {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const cached = window.localStorage.getItem("emu-chat:sidebar-width");
      if (cached) {
        const num = Number(cached);
        if (!Number.isNaN(num) && num >= 240 && num <= 480) return num;
      }
    }
  } catch {
    // Ignore storage errors in test or restricted environments
  }
  return 300;
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
  const [preferences, setPreferences] = useState<PreferencesResponse | null>(
    null,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(
    getStoredSidebarWidth,
  );
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const routeConversationIdRef = useRef(routeConversationId);
  const composerRef = useRef<DraftComposerHandle | null>(null);
  routeConversationIdRef.current = routeConversationId;

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

  const view = useConversationView(
    activeConversationId,
    conversations,
    setWorkspaceError,
  );
  const runtime = useRunRuntime(
    view,
    activeConversationId,
    loadConversations,
    setWorkspaceError,
  );
  const send = useMessageSend(
    view,
    activeConversationId,
    runtime.refreshRuntime,
    setConversations,
  );
  const {
    activeConversation,
    messages,
    hasMoreEarlier,
    loadingEarlier,
    draft,
    queueOpen,
    setQueueOpen,
    runDisplay,
    hasTargetMessages,
    hasActiveConversationView,
    transitionSnapshot,
    activeConversationSummary,
    activeConversationTitle,
    currentConversationLoadError,
    visibleRun,
    queuedMessages,
    agentGenerating,
    loadActiveConversation,
    handleLoadEarlier,
    handleSaveDraft,
  } = view;
  const {
    stream,
    streamNotice,
    handleCancelQueueItem,
    handleEditQueueItem,
    handleStopRun,
    handleApproval,
    handleReconcile,
  } = runtime;
  const {
    handleSend,
    pendingUserMessage,
    transitionPendingUserMessage,
    transitionIsAssistantReplying,
    pendingQueueItems,
    hasPendingPrimarySubmission,
  } = send;

  useEffect(() => {
    void loadStatus();
    void loadConversations();
    void loadPreferences();
  }, [loadConversations, loadPreferences, loadStatus]);

  useEffect(() => {
    // Sidebar selection updates state before navigation; only URL changes
    // should synchronize selection back from browser history.
    if (!routeConversationId || routeConversationId === activeConversationId)
      return;
    view.restoreCachedView(routeConversationId);
    setActiveConversationId(routeConversationId);
  }, [routeConversationId, view.restoreCachedView]);

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

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  const selectConversation = (conversationId: string) => {
    setIsEditingTitle(false);
    view.restoreCachedView(conversationId);
    setActiveConversationId(conversationId);
    setSidebarOpen(false);
    navigate(`/conversations/${encodeURIComponent(conversationId)}`);
  };

  const handleCreateConversation = async () => {
    try {
      const created = await apiClient.createConversation({
        title: "新会话",
      });
      await loadConversations();
      selectConversation(created.conversation_id);
    } catch (error) {
      setWorkspaceError(getErrorMessage(error, "创建会话失败"));
    }
  };

  const startEditingTitle = () => {
    setTitleDraft(activeConversationTitle);
    setIsEditingTitle(true);
  };

  const saveTitleEdit = async () => {
    setIsEditingTitle(false);
    if (!activeConversationId) return;
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== activeConversationTitle) {
      await handleUpdateMetadata(
        activeConversationId,
        trimmed,
        activeConversation?.pinned ?? false,
      );
    }
  };

  const cancelTitleEdit = () => {
    setIsEditingTitle(false);
    setTitleDraft(activeConversationTitle);
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
      view.dropCachedView(conversationId);
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
        view.setActiveConversation({ ...activeConversation, title, pinned });
      }
    } catch (error) {
      setWorkspaceError(getErrorMessage(error, "更新会话失败"));
    }
  };

  const handleUpdatePreferences = async (patch: PreferencePatch) => {
    if (!preferences) throw new Error("偏好设置尚未加载");
    const next = await apiClient.putPreferences({
      theme: patch.theme ?? preferences.theme,
      sidebar_width: patch.sidebar_width ?? preferences.sidebar_width,
      send_shortcut: preferences.send_shortcut,
      expected_revision: preferences.revision,
    });
    setPreferences(next);
  };

  const handleSidebarWidthChange = useCallback((width: number) => {
    setSidebarWidth(width);
  }, []);

  const handleSidebarWidthCommit = useCallback(
    (width: number) => {
      setSidebarWidth(width);
      try {
        if (typeof window !== "undefined" && window.localStorage) {
          window.localStorage.setItem("emu-chat:sidebar-width", String(width));
        }
      } catch {
        // Ignore storage errors in test or restricted environments
      }
      void handleUpdatePreferences({ sidebar_width: width }).catch(() => {});
    },
    [handleUpdatePreferences],
  );

  const composerDisabled =
    !hasActiveConversationView || activeConversation?.delete_state !== "none";
  const sendDisabled = status?.status !== "healthy" || composerDisabled;
  const currentSidebarWidth = sidebarCollapsed ? 64 : sidebarWidth;
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
        sidebarWidth={sidebarWidth}
        onSidebarWidthChange={handleSidebarWidthChange}
        onSidebarWidthCommit={handleSidebarWidthCommit}
        onResizingChange={setIsSidebarResizing}
        style={{
          width: currentSidebarWidth,
          flex: `0 0 ${currentSidebarWidth}px`,
          transition: isSidebarResizing ? "none" : undefined,
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
                <div className="toolbar-title-block">
                  {isEditingTitle ? (
                    <form
                      className="toolbar-title-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveTitleEdit();
                      }}
                    >
                      <input
                        type="text"
                        className="toolbar-title-input"
                        value={titleDraft}
                        onChange={(e) => setTitleDraft(e.target.value)}
                        onBlur={() => void saveTitleEdit()}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") cancelTitleEdit();
                        }}
                        autoFocus
                        maxLength={200}
                        aria-label="编辑会话标题"
                      />
                      <button
                        type="submit"
                        className="icon-button"
                        aria-label="保存标题"
                        title="保存标题"
                      >
                        <Check size={14} />
                      </button>
                    </form>
                  ) : (
                    <div
                      className="main-toolbar-title-wrap"
                      onClick={startEditingTitle}
                      title="点击修改会话标题"
                    >
                      <div className="main-toolbar-title">
                        {activeConversationTitle}
                      </div>
                      <Pencil size={12} className="toolbar-title-edit-icon" />
                    </div>
                  )}
                </div>
              </div>
              <div className="main-toolbar-end">
                <button
                  type="button"
                  className="icon-button theme-toggle-btn"
                  onClick={() => {
                    const current = document.documentElement.dataset.theme;
                    const next = current === "dark" ? "light" : "dark";
                    void handleUpdatePreferences({ theme: next });
                  }}
                  aria-label="切换明暗主题"
                  title={
                    document.documentElement.dataset.theme === "dark"
                      ? "切换为浅色模式"
                      : "切换为深色模式"
                  }
                >
                  {document.documentElement.dataset.theme === "dark" ? (
                    <Sun size={16} strokeWidth={1.8} />
                  ) : (
                    <Moon size={16} strokeWidth={1.8} />
                  )}
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
              runDisplay={
                hasTargetMessages
                  ? runDisplay
                  : (transitionSnapshot?.runDisplay ?? null)
              }
              activeRunId={
                hasTargetMessages
                  ? (visibleRun?.id ?? null)
                  : (transitionSnapshot?.activeRun?.id ?? null)
              }
              onStopGenerating={
                showStop ? () => void handleStopRun() : undefined
              }
              onReconcile={
                showReconcile
                  ? () => void handleReconcile()
                  : hasTargetMessages &&
                      runDisplay?.phase === "syncing" &&
                      activeConversationId
                    ? () =>
                        void runtime.refreshRuntime(
                          activeConversationId,
                          runDisplay.runId,
                        )
                    : undefined
              }
              onSelectPrompt={
                hasActiveConversationView && draft && !composerDisabled
                  ? (prompt) => composerRef.current?.selectPrompt(prompt)
                  : undefined
              }
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
                    ref={composerRef}
                    conversationId={activeConversationId}
                    initialDraft={draft.content}
                    initialRevision={draft.revision}
                    sendShortcut={preferences?.send_shortcut ?? "mod_enter"}
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
                <span className="main-toolbar-title">emu-chat</span>
              </div>
              <div className="main-toolbar-end">
                <button
                  type="button"
                  className="icon-button theme-toggle-btn"
                  onClick={() => {
                    const current = document.documentElement.dataset.theme;
                    const next = current === "dark" ? "light" : "dark";
                    void handleUpdatePreferences({ theme: next });
                  }}
                  aria-label="切换明暗主题"
                  title={
                    document.documentElement.dataset.theme === "dark"
                      ? "切换为浅色模式"
                      : "切换为深色模式"
                  }
                >
                  {document.documentElement.dataset.theme === "dark" ? (
                    <Sun size={16} strokeWidth={1.8} />
                  ) : (
                    <Moon size={16} strokeWidth={1.8} />
                  )}
                </button>
              </div>
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
