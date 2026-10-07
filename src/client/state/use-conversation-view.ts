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
import { DraftStore } from "./draft-store.js";
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
import { UNTITLED_CONVERSATION_LABEL } from "../features/conversations/conversation-title.js";
import {
  groupMessagesIntoTurns,
  mergeMessages,
} from "../features/messages/message-display.js";
import {
  applyRunDisplayEvent,
  createRunDisplay,
  hydrateRunDisplay,
  markRunDisplaySettled,
  markRunDisplaySyncing,
  type RunDisplay,
} from "../features/messages/run-display.js";
import { LIMITS } from "../../shared/limits.js";
import type { AttachmentRef } from "../../shared/media-schemas.js";
import {
  getCurrentRunId,
  getPrimaryQueueItem,
  getQueuedFollowUps,
  isAgentGenerating,
  isLiveRun,
} from "../features/queue/queue-state.js";
import { getErrorMessage, upsertQueueItem } from "./app-shell-utils.js";

type ConversationViewSnapshot = {
  conversation: ConversationDetailResponse;
  messages: MessageItem[];
  hasMoreEarlier: boolean;
  olderMessagesCursor: OlderMessagesCursor | null;
  draft: DraftResponse;
  queue: QueueListResponse;
  activeRun: RunResponse | null;
  queueOpen: boolean;
  runDisplay: RunDisplay | null;
};

type OlderMessagesCursor = {
  oldestId: number;
  offset: number; // Position of oldestId in Hermes's latest-first order at the last fetch.
};

const MESSAGE_PAGE_SIZE = LIMITS.MESSAGES_PAGE_DEFAULT;

function runHistoryAnchor(
  messages: MessageItem[],
  prompt: string | null,
  operationId: string | null = null,
): number {
  const promptMessage = operationId
    ? messages.findLast(
        (message) =>
          message.role === "user" && message.media_operation_id === operationId,
      )
    : prompt
      ? messages.findLast(
          (message) => message.role === "user" && message.content === prompt,
        )
      : null;
  return promptMessage?.id ?? messages.at(-1)?.id ?? 0;
}

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
  runDisplay: RunDisplay | null;
};

/** A selection, including its visit number so A → B → A invalidates old work. */
export type ViewTarget = Readonly<{
  conversationId: string;
  selection: number;
}>;

export interface ConversationView {
  readonly activeConversation: ConversationDetailResponse | null;
  readonly messages: MessageItem[];
  readonly hasMoreEarlier: boolean;
  readonly loadingEarlier: boolean;
  readonly draft: DraftResponse | null;
  readonly activeRun: RunResponse | null;
  readonly queueOpen: boolean;
  readonly runDisplay: RunDisplay | null;
  readonly hasTargetMessages: boolean;
  readonly hasActiveConversationView: boolean;
  readonly transitionSnapshot: RetainedConversationView | null;
  readonly activeConversationSummary: ConversationSummary | null;
  readonly activeConversationTitle: string;
  readonly currentConversationLoadError: string | null;
  readonly visibleQueue: QueueListResponse | null;
  readonly visibleRun: RunResponse | null;
  readonly activeQueueItem: QueueItemResponse | null;
  readonly queuedMessages: QueueItemResponse[];
  readonly agentGenerating: boolean;
  captureTarget(conversationId?: string): ViewTarget | null;
  isCurrentTarget(target: ViewTarget): boolean;
  readRuntime(target: ViewTarget): {
    queue: QueueListResponse | null;
    run: RunResponse | null;
    queueVersion: number;
  } | null;
  loadActiveConversation(conversationId: string): Promise<void>;
  handleLoadEarlier(): Promise<void>;
  readonly draftStore: DraftStore;
  refreshLatestMessages(target: ViewTarget, runId?: string): Promise<boolean>;
  applyMetadataField(
    conversationId: string,
    field: "title" | "pinned",
    value: string | boolean,
  ): void;
  applyQueue(
    target: ViewTarget,
    queue: QueueListResponse,
    expectedVersion?: number,
  ): boolean;
  applyRun(
    target: ViewTarget,
    run: RunResponse | null,
    expectedRunId?: string,
  ): boolean;
  applyQueueItem(target: ViewTarget, item: QueueItemResponse): boolean;
  applyRecoveredDraft(target: ViewTarget, draft: DraftResponse): boolean;
  applySubmissionResult(
    target: ViewTarget,
    draft: DraftResponse,
    item: QueueItemResponse,
    followUp: boolean,
  ): boolean;
  clearStreamForNewSend(target: ViewTarget): void;
  applyRunStreamEvent(
    target: ViewTarget,
    runId: string,
    sequence: number | null,
    type: string,
    payload: Record<string, unknown>,
  ): void;
  markRunSyncing(target: ViewTarget, runId: string): void;
  hydrateRunTools(target: ViewTarget, runId: string): Promise<void>;
  openQueuePanel(target: ViewTarget): void;
  closeQueuePanel(): void;
  restoreCachedView(conversationId: string): void;
  dropCachedView(conversationId: string): void;
}

function retainConversationView(
  snapshot: ConversationViewSnapshot,
): RetainedConversationView {
  return {
    conversationId: snapshot.conversation.conversation_id,
    title: snapshot.conversation.title,
    messages: snapshot.messages,
    queue: snapshot.queue,
    activeRun: snapshot.activeRun,
    runDisplay: snapshot.runDisplay,
  };
}

/** Owns the selected conversation snapshot, cache, draft, queue and Run display. */
export function useConversationView(
  activeConversationId: string | null,
  conversations: ConversationSummary[],
  setWorkspaceError: Dispatch<SetStateAction<string | null>>,
): ConversationView {
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
  const draftRef = useRef<DraftResponse | null>(null);
  const draftStoreRef = useRef<DraftStore | null>(null);
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
  const queueVersionRef = useRef(0);
  const metadataSequenceRef = useRef(0);
  const metadataWritesRef = useRef(
    new Map<
      string,
      {
        title?: { sequence: number; value: string };
        pinned?: { sequence: number; value: boolean };
      }
    >(),
  );
  const previousQueuedMessageCountRef = useRef(0);
  const runDisplayRef = useRef<RunDisplay | null>(null);
  const runDisplaysRef = useRef(new Map<string, RunDisplay>());
  const conversationViewCacheRef = useRef(
    new ConversationViewCache<ConversationViewSnapshot>(),
  );
  const currentViewSnapshotRef = useRef<RetainedConversationView | null>(null);
  const [runDisplay, setRunDisplay] = useState<RunDisplay | null>(null);

  const captureTarget = useCallback(
    (conversationId?: string): ViewTarget | null => {
      const currentId = activeConversationIdRef.current;
      if (!currentId || (conversationId && conversationId !== currentId))
        return null;
      return { conversationId: currentId, selection: activeLoadRef.current };
    },
    [],
  );

  const isCurrentTarget = useCallback(
    (target: ViewTarget) =>
      activeConversationIdRef.current === target.conversationId &&
      activeLoadRef.current === target.selection,
    [],
  );

  const readRuntime = useCallback(
    (target: ViewTarget) =>
      isCurrentTarget(target)
        ? {
            queue: queueRef.current,
            run: activeRunRef.current,
            queueVersion: queueVersionRef.current,
          }
        : null,
    [isCurrentTarget],
  );

  const setDraftSnapshot = useCallback((next: DraftResponse | null) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const setQueueSnapshot = useCallback((next: QueueListResponse | null) => {
    queueVersionRef.current += 1;
    queueRef.current = next;
    setQueue(next);
  }, []);

  const setRunSnapshot = useCallback((next: RunResponse | null) => {
    activeRunRef.current = next;
    setActiveRun(next);
  }, []);

  const applyQueue = useCallback(
    (
      target: ViewTarget,
      next: QueueListResponse,
      expectedVersion?: number,
    ): boolean => {
      if (
        !isCurrentTarget(target) ||
        next.conversation_id !== target.conversationId ||
        (expectedVersion !== undefined &&
          queueVersionRef.current !== expectedVersion)
      )
        return false;
      const current = queueRef.current;
      if (current?.conversation_id === target.conversationId) {
        const revisions = new Map(
          current.data.map((item) => [item.id, item.revision]),
        );
        if (
          next.data.some(
            (item) => item.revision < (revisions.get(item.id) ?? 0),
          )
        )
          return false;
      }
      setQueueSnapshot(next);
      return true;
    },
    [isCurrentTarget, setQueueSnapshot],
  );

  const applyRun = useCallback(
    (
      target: ViewTarget,
      next: RunResponse | null,
      expectedRunId?: string,
    ): boolean => {
      if (!isCurrentTarget(target)) return false;
      const current = activeRunRef.current;
      const queueRunId = queueRef.current && getCurrentRunId(queueRef.current);
      if (!next) {
        if (queueRunId || (expectedRunId && current?.id !== expectedRunId))
          return false;
        setRunSnapshot(null);
        return true;
      }
      if (
        next.conversation_id !== target.conversationId ||
        (expectedRunId && next.id !== expectedRunId) ||
        (queueRunId && queueRunId !== next.id) ||
        (current &&
          current.id !== next.id &&
          !queueRef.current?.data.some((item) => item.local_run_id === next.id))
      )
        return false;
      if (current?.id === next.id) {
        if (Date.parse(current.updated_at) > Date.parse(next.updated_at))
          return false;
        if (
          (current.local_state === "reconciled" ||
            current.local_state === "rejected") &&
          current.local_state !== next.local_state
        )
          return false;
        if (
          ["completed", "failed", "cancelled", "interrupted"].includes(
            current.upstream_status ?? "",
          ) &&
          !["completed", "failed", "cancelled", "interrupted"].includes(
            next.upstream_status ?? "",
          )
        )
          return false;
      }
      setRunSnapshot(next);
      return true;
    },
    [isCurrentTarget, setRunSnapshot],
  );

  const commitDraft = useCallback(
    (target: ViewTarget, next: DraftResponse): boolean => {
      if (
        !isCurrentTarget(target) ||
        next.conversation_id !== target.conversationId
      )
        return false;
      if (
        draftRef.current?.conversation_id === target.conversationId &&
        draftRef.current.revision > next.revision
      )
        return false;
      setDraftSnapshot(next);
      return true;
    },
    [isCurrentTarget, setDraftSnapshot],
  );

  const applyMetadataField = useCallback(
    (
      conversationId: string,
      field: "title" | "pinned",
      value: string | boolean,
    ) => {
      if (
        (field === "title" && typeof value !== "string") ||
        (field === "pinned" && typeof value !== "boolean")
      )
        return;
      const sequence = ++metadataSequenceRef.current;
      const previous = metadataWritesRef.current.get(conversationId) ?? {};
      const writes =
        field === "title"
          ? { ...previous, title: { sequence, value: value as string } }
          : { ...previous, pinned: { sequence, value: value as boolean } };
      metadataWritesRef.current.set(conversationId, writes);

      const patch =
        field === "title"
          ? { title: value as string }
          : { pinned: value as boolean };
      const cached = conversationViewCacheRef.current.get(conversationId);
      if (cached) {
        conversationViewCacheRef.current.set(conversationId, {
          ...cached,
          conversation: { ...cached.conversation, ...patch },
        });
      }
      if (
        currentViewSnapshotRef.current?.conversationId === conversationId &&
        field === "title"
      ) {
        currentViewSnapshotRef.current = {
          ...currentViewSnapshotRef.current,
          title: value as string,
        };
      }
      if (activeConversationIdRef.current === conversationId) {
        setActiveConversation((current) =>
          current?.conversation_id === conversationId
            ? { ...current, ...patch }
            : current,
        );
      }
    },
    [],
  );

  const commitRunDisplay = useCallback((next: RunDisplay | null) => {
    runDisplayRef.current = next;
    if (next) {
      runDisplaysRef.current.delete(next.runId);
      runDisplaysRef.current.set(next.runId, next);
      if (runDisplaysRef.current.size > 24) {
        runDisplaysRef.current.delete(
          runDisplaysRef.current.keys().next().value!,
        );
      }
    }
    setRunDisplay(next);
  }, []);

  const restoreRunDisplay = useCallback(
    (snapshot: ConversationViewSnapshot) => {
      const runId = snapshot.runDisplay?.runId ?? snapshot.activeRun?.id;
      const recent = runId ? runDisplaysRef.current.get(runId) : null;
      commitRunDisplay(recent ?? snapshot.runDisplay);
    },
    [commitRunDisplay],
  );

  const activateRunDisplay = useCallback(
    (runId: string, prompt: string | null = null) => {
      const queueItem = getPrimaryQueueItem(
        queueRef.current,
        activeRunRef.current,
      );
      const operationId = queueItem?.attachments.length
        ? queueItem.operation_id
        : null;
      const existing = runDisplaysRef.current.get(runId);
      const next = existing
        ? (prompt && !existing.promptContent) ||
          (operationId && !existing.operationId)
          ? {
              ...existing,
              promptContent: existing.promptContent ?? prompt,
              operationId: existing.operationId ?? operationId,
            }
          : existing
        : createRunDisplay(
            runId,
            messagesRef.current.conversationId ===
              activeConversationIdRef.current
              ? runHistoryAnchor(messagesRef.current.items, prompt, operationId)
              : 0,
            prompt,
            operationId,
          );
      commitRunDisplay(next);
      return next;
    },
    [commitRunDisplay],
  );

  const settleDisplayWithMessages = useCallback(
    (runId: string, nextMessages: MessageItem[]) => {
      const display = runDisplayRef.current;
      if (display?.runId !== runId || display.phase === "settled") return;
      const canonicalTurn = groupMessagesIntoTurns(nextMessages).findLast(
        (turn) =>
          turn.kind === "assistant_turn" &&
          turn.rawMessages.some(
            (message) => message.id > display.afterMessageId,
          ),
      );
      if (canonicalTurn) {
        commitRunDisplay(markRunDisplaySettled(display, canonicalTurn.id));
      } else if (display.blocks.length === 0) {
        commitRunDisplay(null);
      }
    },
    [commitRunDisplay],
  );

  useLayoutEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useLayoutEffect(() => {
    messagesRef.current = {
      conversationId: messagesConversationId,
      items: messages,
    };
  }, [messages, messagesConversationId]);

  useEffect(() => {
    if (!activeRun?.id || !isLiveRun(activeRun)) return;
    if (runDisplayRef.current?.runId === activeRun.id) return;
    const prompt =
      getPrimaryQueueItem(queueRef.current, activeRun)?.content ?? null;
    activateRunDisplay(activeRun.id, prompt);
  }, [activeRun?.id, activateRunDisplay]);

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
      runDisplay,
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
      runDisplay,
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
    runDisplay,
  ]);

  const loadActiveConversation = useCallback(
    async (conversationId: string) => {
      activeConversationIdRef.current = conversationId;
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
        setDraftSnapshot(snapshot.draft);
        setQueueSnapshot(snapshot.queue);
        setRunSnapshot(snapshot.activeRun);
        setQueueOpen(snapshot.queueOpen);
        previousQueuedMessageCountRef.current = getQueuedFollowUps(
          snapshot.queue,
          snapshot.activeRun,
        ).length;
        restoreRunDisplay(snapshot);
      } else {
        setActiveConversation(null);
        setMessages([]);
        setMessagesConversationId(null);
        setHasMoreEarlier(false);
        olderMessagesCursorRef.current = null;
        setDraftSnapshot(null);
        setQueueSnapshot(null);
        setRunSnapshot(null);
        setQueueOpen(false);
        commitRunDisplay(null);
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
          const metadataAtStart = metadataSequenceRef.current;
          try {
            const conversation =
              await apiClient.getConversation(conversationId);
            if (loadId !== activeLoadRef.current) return;
            const writes = metadataWritesRef.current.get(conversationId);
            setActiveConversation({
              ...conversation,
              ...(writes?.title && writes.title.sequence > metadataAtStart
                ? { title: writes.title.value }
                : {}),
              ...(writes?.pinned && writes.pinned.sequence > metadataAtStart
                ? { pinned: writes.pinned.value }
                : {}),
            });
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
            const nextMessages =
              snapshot?.olderMessagesCursor && result.reachedAnchor
                ? mergeMessages(snapshot.messages, result.items)
                : mergeMessages([], result.items);
            setMessages(nextMessages);
            messagesRef.current = { conversationId, items: nextMessages };
            if (!(snapshot?.olderMessagesCursor && result.reachedAnchor)) {
              olderMessagesCursorRef.current = result.cursor;
              setHasMoreEarlier(result.hasMoreEarlier);
            }
            setMessagesConversationId(conversationId);
            const display = runDisplayRef.current;
            if (display?.afterMessageId === 0) {
              commitRunDisplay({
                ...display,
                afterMessageId: runHistoryAnchor(
                  nextMessages,
                  display.promptContent,
                  display.operationId,
                ),
              });
            }
            if (display?.phase === "syncing") {
              settleDisplayWithMessages(display.runId, nextMessages);
            }
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
            commitDraft({ conversationId, selection: loadId }, nextDraft);
          } catch (error) {
            if (loadId !== activeLoadRef.current || useCachedView) return;
            setDraftSnapshot(null);
            reportLoadError(error, "无法加载草稿");
          }
        };

        await Promise.all([loadConversation(), loadMessages(), loadDraft()]);
      };

      if (
        snapshot &&
        (isLiveRun(snapshot.activeRun) ||
          getPrimaryQueueItem(snapshot.queue, snapshot.activeRun))
      ) {
        const queueVersion = queueVersionRef.current;
        try {
          const nextQueue = await apiClient.getQueue(conversationId);
          if (
            loadId !== activeLoadRef.current ||
            queueVersion !== queueVersionRef.current
          )
            return;
          const target = { conversationId, selection: loadId };
          if (!applyQueue(target, nextQueue, queueVersion)) return;
          const runId = getCurrentRunId(nextQueue);
          if (runId) {
            const run = await apiClient.getRun(runId);
            if (loadId !== activeLoadRef.current) return;
            applyRun(target, run, runId);
            const committedRun = readRuntime(target)?.run;
            if (committedRun?.id !== runId) return;
            const display = activateRunDisplay(
              committedRun.id,
              getPrimaryQueueItem(nextQueue, committedRun)?.content ?? null,
            );
            if (committedRun.local_state === "reconciled") {
              commitRunDisplay(markRunDisplaySyncing(display));
              await loadConversationContent();
            }
          } else {
            applyRun(target, null);
            const display = runDisplayRef.current;
            if (display && display.phase !== "settled") {
              commitRunDisplay(markRunDisplaySyncing(display));
            }
            await loadConversationContent();
          }
        } catch (error) {
          if (queueVersion !== queueVersionRef.current) return;
          reportLoadError(error, "无法刷新运行状态");
        }
        return;
      }

      const loadQueue = async () => {
        let nextQueue: QueueListResponse;
        const queueVersion = queueVersionRef.current;
        try {
          nextQueue = await apiClient.getQueue(conversationId);
        } catch (error) {
          if (
            loadId !== activeLoadRef.current ||
            queueVersion !== queueVersionRef.current
          )
            return;
          if (!useCachedView) {
            setQueueSnapshot(null);
            setRunSnapshot(null);
            setQueueOpen(false);
          }
          reportLoadError(error, "无法加载消息队列");
          return;
        }
        if (
          loadId !== activeLoadRef.current ||
          queueVersion !== queueVersionRef.current
        )
          return;

        const target = { conversationId, selection: loadId };
        if (!applyQueue(target, nextQueue, queueVersion)) return;
        const runId = getCurrentRunId(nextQueue);
        if (runId) {
          try {
            const run = await apiClient.getRun(runId);
            if (loadId === activeLoadRef.current) {
              applyRun(target, run, runId);
              const committedRun = readRuntime(target)?.run;
              if (committedRun?.id !== runId) return;
              const display = activateRunDisplay(
                committedRun.id,
                getPrimaryQueueItem(nextQueue, committedRun)?.content ?? null,
              );
              if (committedRun.local_state === "reconciled") {
                commitRunDisplay(markRunDisplaySyncing(display));
              }
            }
          } catch (error) {
            if (loadId === activeLoadRef.current) {
              reportLoadError(error, "无法加载运行状态");
            }
          }
        } else {
          applyRun(target, null);
          const display = runDisplayRef.current;
          if (display && display.phase !== "settled") {
            commitRunDisplay(markRunDisplaySyncing(display));
          }
        }
      };

      await Promise.all([loadConversationContent(), loadQueue()]);
    },
    [
      activateRunDisplay,
      applyQueue,
      applyRun,
      commitDraft,
      commitRunDisplay,
      restoreRunDisplay,
      readRuntime,
      setDraftSnapshot,
      setQueueSnapshot,
      setRunSnapshot,
      settleDisplayWithMessages,
    ],
  );

  const restoreConversationView = useCallback(
    (snapshot: ConversationViewSnapshot) => {
      currentViewSnapshotRef.current = retainConversationView(snapshot);
      setActiveConversation(snapshot.conversation);
      setMessages(snapshot.messages);
      setMessagesConversationId(snapshot.conversation.conversation_id);
      setHasMoreEarlier(snapshot.hasMoreEarlier);
      olderMessagesCursorRef.current = snapshot.olderMessagesCursor;
      setDraftSnapshot(snapshot.draft);
      setQueueSnapshot(snapshot.queue);
      setRunSnapshot(snapshot.activeRun);
      setQueueOpen(snapshot.queueOpen);
      previousQueuedMessageCountRef.current = getQueuedFollowUps(
        snapshot.queue,
        snapshot.activeRun,
      ).length;
      restoreRunDisplay(snapshot);
    },
    [restoreRunDisplay, setDraftSnapshot, setQueueSnapshot, setRunSnapshot],
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
    ? transitionSnapshot.title || UNTITLED_CONVERSATION_LABEL
    : activeConversation?.conversation_id === activeConversationId
      ? activeConversation.title || UNTITLED_CONVERSATION_LABEL
      : activeConversationSummary?.title || UNTITLED_CONVERSATION_LABEL;
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
    activeConversationIdRef.current = null;
    setActiveConversation(null);
    setMessages([]);
    setMessagesConversationId(null);
    setLoadingEarlier(false);
    olderMessagesCursorRef.current = null;
    setConversationLoadError(null);
    setWorkspaceError(null);
    currentViewSnapshotRef.current = null;
    setDraftSnapshot(null);
    setQueueSnapshot(null);
    setRunSnapshot(null);
    commitRunDisplay(null);
    setQueueOpen(false);
    previousQueuedMessageCountRef.current = 0;
  }, [
    activeConversationId,
    commitRunDisplay,
    loadActiveConversation,
    setDraftSnapshot,
    setQueueSnapshot,
    setRunSnapshot,
  ]);

  const handleSaveDraft = async (
    conversationId: string,
    content: string,
    attachments: AttachmentRef[],
    expectedRevision: number,
  ) => {
    const target = captureTarget(conversationId);
    const saved = await apiClient.putDraft(conversationId, {
      content,
      attachments,
      expected_revision: expectedRevision,
    });
    if (draftStoreRef.current?.has(conversationId)) {
      const cached = conversationViewCacheRef.current.get(conversationId);
      if (cached && cached.draft.revision <= saved.revision)
        conversationViewCacheRef.current.set(conversationId, {
          ...cached,
          draft: saved,
        });
      if (target) commitDraft(target, saved);
    }
    return { revision: saved.revision };
  };
  draftStoreRef.current ??= new DraftStore(handleSaveDraft);

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

  const refreshLatestMessages = useCallback(
    async (target: ViewTarget, runId?: string) => {
      if (!isCurrentTarget(target)) return false;
      const conversationId = target.conversationId;
      const latestLoadSeq = ++latestLoadSeqRef.current;
      const anchorId =
        messagesRef.current.conversationId === conversationId
          ? (messagesRef.current.items.at(-1)?.id ?? null)
          : null;
      const result = await fetchLatestThroughAnchor(conversationId, anchorId);
      if (
        !isCurrentTarget(target) ||
        latestLoadSeq !== latestLoadSeqRef.current
      )
        return false;
      const nextMessages =
        anchorId !== null && result.reachedAnchor
          ? mergeMessages(messagesRef.current.items, result.items)
          : mergeMessages([], result.items);
      setMessages(nextMessages);
      if (!(anchorId !== null && result.reachedAnchor)) {
        olderMessagesCursorRef.current = result.cursor;
        setHasMoreEarlier(result.hasMoreEarlier);
      }
      messagesRef.current = { conversationId, items: nextMessages };
      setMessagesConversationId(conversationId);
      if (runId) settleDisplayWithMessages(runId, nextMessages);
      return true;
    },
    [isCurrentTarget, settleDisplayWithMessages],
  );

  const applyRunStreamEvent = useCallback(
    (
      target: ViewTarget,
      runId: string,
      sequence: number | null,
      type: string,
      payload: Record<string, unknown>,
    ) => {
      if (!isCurrentTarget(target) || activeRunRef.current?.id !== runId)
        return;
      const current =
        runDisplayRef.current?.runId === runId
          ? runDisplayRef.current
          : activateRunDisplay(
              runId,
              getPrimaryQueueItem(queueRef.current, activeRunRef.current)
                ?.content ?? null,
            );
      const next = applyRunDisplayEvent(current, sequence, type, payload);
      if (next !== current) commitRunDisplay(next);
    },
    [activateRunDisplay, commitRunDisplay, isCurrentTarget],
  );

  const markRunSyncing = useCallback(
    (target: ViewTarget, runId: string) => {
      if (!isCurrentTarget(target) || activeRunRef.current?.id !== runId)
        return;
      const current = runDisplayRef.current;
      if (current?.runId === runId) {
        commitRunDisplay(markRunDisplaySyncing(current));
      }
    },
    [commitRunDisplay, isCurrentTarget],
  );

  const hydrateRunTools = useCallback(
    async (target: ViewTarget, runId: string) => {
      if (!isCurrentTarget(target) || activeRunRef.current?.id !== runId)
        return;
      const display = runDisplayRef.current;
      if (display?.runId !== runId || display.phase === "settled") return;
      const result = await fetchLatestThroughAnchor(
        target.conversationId,
        display.afterMessageId || null,
      );
      if (!isCurrentTarget(target) || activeRunRef.current?.id !== runId)
        return;
      const latest = runDisplayRef.current;
      if (latest?.runId !== runId || latest.phase === "settled") return;
      commitRunDisplay(hydrateRunDisplay(latest, result.items));
    },
    [commitRunDisplay, isCurrentTarget],
  );

  const applyQueueItem = useCallback(
    (target: ViewTarget, item: QueueItemResponse): boolean => {
      if (
        !isCurrentTarget(target) ||
        item.conversation_id !== target.conversationId
      )
        return false;
      const current = queueRef.current?.data.find(
        (entry) => entry.id === item.id,
      );
      if (current && current.revision > item.revision) return false;
      setQueueSnapshot(
        upsertQueueItem(queueRef.current, target.conversationId, item),
      );
      return true;
    },
    [isCurrentTarget, setQueueSnapshot],
  );

  const applySubmissionResult = useCallback(
    (
      target: ViewTarget,
      nextDraft: DraftResponse,
      item: QueueItemResponse,
      followUp: boolean,
    ): boolean => {
      if (draftStoreRef.current?.has(target.conversationId)) {
        const cached = conversationViewCacheRef.current.get(
          target.conversationId,
        );
        if (cached && cached.draft.revision <= nextDraft.revision)
          conversationViewCacheRef.current.set(target.conversationId, {
            ...cached,
            draft: nextDraft,
          });
      }
      if (!isCurrentTarget(target)) return false;
      commitDraft(target, nextDraft);
      if (!applyQueueItem(target, item)) return false;
      if (followUp) setQueueOpen(true);
      return true;
    },
    [applyQueueItem, commitDraft, isCurrentTarget],
  );

  const clearStreamForNewSend = useCallback(
    (target: ViewTarget) => {
      if (isCurrentTarget(target)) commitRunDisplay(null);
    },
    [commitRunDisplay, isCurrentTarget],
  );

  const openQueuePanel = useCallback(
    (target: ViewTarget) => {
      if (isCurrentTarget(target)) setQueueOpen(true);
    },
    [isCurrentTarget],
  );

  const closeQueuePanel = useCallback(() => setQueueOpen(false), []);

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
    draftStoreRef.current?.drop(conversationId);
    conversationViewCacheRef.current.delete(conversationId);
    metadataWritesRef.current.delete(conversationId);
  }, []);

  return {
    activeConversation,
    messages,
    hasMoreEarlier,
    loadingEarlier,
    draft,
    activeRun,
    queueOpen,
    runDisplay,
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
    captureTarget,
    isCurrentTarget,
    readRuntime,
    loadActiveConversation,
    handleLoadEarlier,
    refreshLatestMessages,
    draftStore: draftStoreRef.current,
    applyMetadataField,
    applyQueue,
    applyRun,
    applyQueueItem,
    applyRecoveredDraft: commitDraft,
    applySubmissionResult,
    clearStreamForNewSend,
    applyRunStreamEvent,
    markRunSyncing,
    hydrateRunTools,
    openQueuePanel,
    closeQueuePanel,
    restoreCachedView,
    dropCachedView,
  };
}
