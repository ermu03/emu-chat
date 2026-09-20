import React, { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Send, Sparkles } from "lucide-react";
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const contentRef = useRef(initialDraft);
  const savedContentRef = useRef(initialDraft);
  const revisionRef = useRef(initialRevision);
  const sendingRef = useRef(false);
  const generationRef = useRef(0);
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const conversationRef = useRef(conversationId);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 84), 230)}px`;
  }, []);

  const clearDebounce = useCallback(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [content, resizeTextarea]);

  useEffect(() => {
    if (conversationRef.current === conversationId) return;
    conversationRef.current = conversationId;
    generationRef.current += 1;
    clearDebounce();
    contentRef.current = initialDraft;
    savedContentRef.current = initialDraft;
    revisionRef.current = initialRevision;
    setContent(initialDraft);
    setRevision(initialRevision);
    setSaveError(null);
    setSendError(null);
    sendingRef.current = false;
    setIsSending(false);
  }, [clearDebounce, conversationId, initialDraft, initialRevision]);

  useEffect(() => {
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
  }, [initialDraft, initialRevision]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      clearDebounce();
      sendingRef.current = false;
    };
  }, [clearDebounce]);

  const saveSnapshot = useCallback(
    async (nextContent: string) => {
      const generation = generationRef.current;
      setIsSaving(true);
      setSaveError(null);
      try {
        const result = await onSaveDraft(nextContent, revisionRef.current);
        if (generation !== generationRef.current) return;
        savedContentRef.current = nextContent;
        revisionRef.current = result.revision;
        setRevision(result.revision);
      } catch (error) {
        if (generation === generationRef.current) {
          setSaveError(error instanceof Error ? error.message : "保存失败");
        }
        throw error;
      } finally {
        if (generation === generationRef.current) setIsSaving(false);
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
      const promise = saveSnapshot(snapshot);
      savePromiseRef.current = promise;
      try {
        await promise;
      } finally {
        if (savePromiseRef.current === promise) savePromiseRef.current = null;
      }
    }
  }, [clearDebounce, saveSnapshot]);

  const scheduleSave = useCallback(() => {
    clearDebounce();
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
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
    const current = contentRef.current;
    const isOverLimit =
      new TextEncoder().encode(current).length > LIMITS.INPUT_MAX_BYTES;
    if (
      !current.trim() ||
      disabled ||
      sendDisabled ||
      sendingRef.current ||
      isOverLimit
    )
      return;

    const generation = generationRef.current;
    sendingRef.current = true;
    setIsSending(true);
    setSendError(null);
    try {
      await flushDraft();
      if (generation !== generationRef.current) return;
      const result = await onSend(revisionRef.current);
      if (generation !== generationRef.current) return;
      contentRef.current = result.draft.content;
      savedContentRef.current = result.draft.content;
      revisionRef.current = result.draft.revision;
      setContent(result.draft.content);
      setRevision(result.draft.revision);
      setSaveError(null);
    } catch (error) {
      if (generation === generationRef.current) {
        setSendError(error instanceof Error ? error.message : "发送失败");
      }
    } finally {
      if (generation === generationRef.current) {
        sendingRef.current = false;
        setIsSending(false);
      }
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isMod = event.ctrlKey || event.metaKey;
    const shouldSend =
      (sendShortcut === "mod_enter" && event.key === "Enter" && isMod) ||
      (sendShortcut === "enter" &&
        event.key === "Enter" &&
        !event.shiftKey &&
        !isMod);
    if (shouldSend) {
      event.preventDefault();
      void handleSend();
    }
  };

  const byteCount = new TextEncoder().encode(content).length;
  const isOverLimit = byteCount > LIMITS.INPUT_MAX_BYTES;
  const sendTitle =
    sendShortcut === "mod_enter" ? "发送（⌘/Ctrl + Enter）" : "发送（Enter）";

  return (
    <div className={`composer-container ${isOverLimit ? "over-limit" : ""}`}>
      <textarea
        ref={textareaRef}
        className="composer-textarea"
        value={content}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={disabled || isSending}
        placeholder="写下你的消息..."
        rows={3}
        aria-label="消息输入框"
      />
      <div className="composer-footer">
        <div className="composer-meta">
          <Sparkles size={13} aria-hidden="true" />
          <span>{isSaving ? "保存中" : "草稿已保存"}</span>
          <span className={isOverLimit ? "error" : ""}>
            {byteCount.toLocaleString()} /{" "}
            {LIMITS.INPUT_MAX_BYTES.toLocaleString()} bytes
          </span>
          {saveError && <span className="error">{saveError}</span>}
          {sendError && <span className="error">{sendError}</span>}
        </div>
        <div className="composer-actions">
          {isSending && (
            <LoaderCircle size={15} className="spin" aria-label="发送中" />
          )}
          <button
            type="button"
            className="send-button"
            onClick={() => void handleSend()}
            disabled={
              disabled ||
              sendDisabled ||
              isSending ||
              !content.trim() ||
              isOverLimit
            }
            aria-label={sendTitle}
            title={sendTitle}
          >
            <Send size={15} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
};
