import React, { useCallback, useEffect, useRef, useState } from "react";
import { LIMITS } from "../../../shared/limits.js";

export interface DraftSnapshot {
  content: string;
  revision: number;
}

export interface DraftSendResult {
  draft: DraftSnapshot;
}

export interface DraftComposerProps {
  conversationId: string;
  initialDraft?: string;
  initialRevision?: number;
  sendShortcut: "enter" | "mod_enter";
  onSaveDraft: (
    content: string,
    expectedRevision: number,
  ) => Promise<{ revision: number }>;
  onSend: (expectedDraftRevision: number) => Promise<DraftSendResult>;
  disabled?: boolean;
  sendDisabled?: boolean;
}

export const DraftComposer: React.FC<DraftComposerProps> = ({
  conversationId,
  initialDraft = "",
  initialRevision = 0,
  sendShortcut,
  onSaveDraft,
  onSend,
  disabled = false,
  sendDisabled = false,
}) => {
  const [content, setContent] = useState(initialDraft);
  const [, setRevision] = useState(initialRevision);
  const [isSaving, setIsSaving] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const debounceTimerRef = useRef<number | null>(null);
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const contentRef = useRef(initialDraft);
  const savedContentRef = useRef(initialDraft);
  const revisionRef = useRef(initialRevision);
  const generationRef = useRef(0);
  const isSendingRef = useRef(false);
  const synchronizedConversationRef = useRef(conversationId);

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (synchronizedConversationRef.current === conversationId) return;

    synchronizedConversationRef.current = conversationId;
    generationRef.current += 1;
    clearDebounce();
    savePromiseRef.current = null;
    contentRef.current = initialDraft;
    savedContentRef.current = initialDraft;
    revisionRef.current = initialRevision;
    setContent(initialDraft);
    setRevision(initialRevision);
    setSaveError(null);
    setSendError(null);
    setIsSaving(false);
    isSendingRef.current = false;
    setIsSending(false);
  }, [clearDebounce, conversationId, initialDraft, initialRevision]);

  useEffect(() => {
    // Parent snapshots normally arrive after a successful save. Do not apply
    // one over edits made while that earlier request was still in flight.
    if (contentRef.current !== savedContentRef.current) return;
    if (initialRevision < revisionRef.current) return;
    if (
      initialRevision === revisionRef.current &&
      initialDraft === savedContentRef.current
    ) {
      return;
    }

    contentRef.current = initialDraft;
    savedContentRef.current = initialDraft;
    revisionRef.current = initialRevision;
    setContent(initialDraft);
    setRevision(initialRevision);
    setSaveError(null);
  }, [conversationId, initialDraft, initialRevision]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      isSendingRef.current = false;
      clearDebounce();
    };
  }, [clearDebounce]);

  const saveSnapshot = useCallback(
    async (contentToSave: string) => {
      const generation = generationRef.current;
      const expectedRevision = revisionRef.current;

      setIsSaving(true);
      setSaveError(null);

      try {
        const result = await onSaveDraft(contentToSave, expectedRevision);
        if (generation !== generationRef.current) return;

        savedContentRef.current = contentToSave;
        revisionRef.current = result.revision;
        setRevision(result.revision);
      } catch (error: unknown) {
        if (generation === generationRef.current) {
          setSaveError(getErrorMessage(error, "草稿保存失败"));
        }
        throw error;
      } finally {
        if (generation === generationRef.current) {
          setIsSaving(false);
        }
      }
    },
    [onSaveDraft],
  );

  const flushDraft = useCallback(async () => {
    clearDebounce();

    while (savedContentRef.current !== contentRef.current) {
      if (savePromiseRef.current) {
        await savePromiseRef.current;
        continue;
      }

      const snapshot = contentRef.current;
      const savePromise = saveSnapshot(snapshot);
      savePromiseRef.current = savePromise;

      try {
        await savePromise;
      } finally {
        if (savePromiseRef.current === savePromise) {
          savePromiseRef.current = null;
        }
      }
    }
  }, [clearDebounce, saveSnapshot]);

  const scheduleSave = useCallback(() => {
    clearDebounce();
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      void flushDraft().catch(() => undefined);
    }, 500);
  }, [clearDebounce, flushDraft]);

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextContent = event.target.value;
    contentRef.current = nextContent;
    setContent(nextContent);
    setSendError(null);
    scheduleSave();
  };

  const handleSend = async () => {
    const currentContent = contentRef.current;
    const trimmed = currentContent.trim();
    const isOverLimit =
      new TextEncoder().encode(currentContent).length > LIMITS.INPUT_MAX_BYTES;
    if (
      !trimmed ||
      disabled ||
      sendDisabled ||
      isSendingRef.current ||
      isOverLimit
    )
      return;

    const generation = generationRef.current;
    isSendingRef.current = true;
    setIsSending(true);
    setSendError(null);

    try {
      await flushDraft();
    } catch {
      if (generation === generationRef.current) {
        isSendingRef.current = false;
        setIsSending(false);
      }
      return;
    }

    if (generation !== generationRef.current) return;

    try {
      const result = await onSend(revisionRef.current);
      if (generation !== generationRef.current) return;

      contentRef.current = result.draft.content;
      savedContentRef.current = result.draft.content;
      revisionRef.current = result.draft.revision;
      setContent(result.draft.content);
      setRevision(result.draft.revision);
      setSaveError(null);
    } catch (error: unknown) {
      if (generation === generationRef.current) {
        setSendError(getErrorMessage(error, "发送失败"));
      }
    } finally {
      if (generation === generationRef.current) {
        isSendingRef.current = false;
        setIsSending(false);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;

    const isMod = e.ctrlKey || e.metaKey;
    const isEnter = e.key === "Enter";

    let shouldSend = false;
    if (sendShortcut === "mod_enter" && isEnter && isMod) {
      shouldSend = true;
    } else if (sendShortcut === "enter" && isEnter && !e.shiftKey && !isMod) {
      shouldSend = true;
    }

    if (shouldSend) {
      e.preventDefault();
      void handleSend();
    }
  };

  const byteCount = new TextEncoder().encode(content).length;
  const isOverLimit = byteCount > LIMITS.INPUT_MAX_BYTES;

  return (
    <div
      className="composer-container"
      style={{ display: "flex", flexDirection: "column", gap: "8px" }}
    >
      <textarea
        value={content}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={disabled || isSending}
        placeholder={
          sendShortcut === "mod_enter"
            ? "输入消息... (Ctrl+Enter 或 Cmd+Enter 发送)"
            : "输入消息... (Enter 发送, Shift+Enter 换行)"
        }
        rows={4}
        style={{
          width: "100%",
          padding: "8px 12px",
          borderRadius: "6px",
          border: isOverLimit ? "1px solid #ef4444" : "1px solid #d1d5db",
          resize: "vertical",
          fontFamily: "inherit",
          fontSize: "14px",
        }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: "12px",
          color: "#6b7280",
        }}
      >
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <span>
            {byteCount} / {LIMITS.INPUT_MAX_BYTES} 字节
          </span>
          {isSaving && <span>草稿保存中...</span>}
          {saveError && <span style={{ color: "#ef4444" }}>{saveError}</span>}
          {isSending && <span>发送中...</span>}
          {sendError && <span style={{ color: "#ef4444" }}>{sendError}</span>}
        </div>
        <button
          onClick={() => void handleSend()}
          disabled={
            disabled ||
            sendDisabled ||
            isSending ||
            !content.trim() ||
            isOverLimit
          }
          style={{
            padding: "6px 16px",
            backgroundColor:
              disabled ||
              sendDisabled ||
              isSending ||
              !content.trim() ||
              isOverLimit
                ? "#9ca3af"
                : "#2563eb",
            color: "#ffffff",
            border: "none",
            borderRadius: "4px",
            cursor:
              disabled ||
              sendDisabled ||
              isSending ||
              !content.trim() ||
              isOverLimit
                ? "not-allowed"
                : "pointer",
          }}
        >
          {isSending ? "发送中..." : "发送"}
        </button>
      </div>
    </div>
  );
};

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
