import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ImagePlus, LoaderCircle, Send, X } from "lucide-react";
import { LIMITS } from "../../../shared/limits.js";
import type {
  AttachmentRef,
  MediaAsset,
  MediaCapabilities,
} from "../../../shared/media-schemas.js";
import { apiClient } from "../../api/client.js";
import { generateBrowserUuid } from "../../state/app-shell-utils.js";
import { MediaAssets } from "../media/media-assets.js";

export interface DraftSnapshot {
  content: string;
  attachments: MediaAsset[];
  revision: number;
}

export interface DraftSendResult {
  draft: DraftSnapshot;
}

export interface DraftComposerHandle {
  selectPrompt: (prompt: string) => void;
  addAsset: (asset: MediaAsset) => void;
  restoreRecovery: (
    copy: (expectedRevision: number) => Promise<DraftSnapshot>,
  ) => Promise<void>;
}

export interface DraftComposerProps {
  conversationId: string;
  initialDraft?: string;
  initialRevision?: number;
  initialAttachments?: MediaAsset[];
  sendShortcut: "enter" | "mod_enter";
  onSaveDraft: (
    content: string,
    attachments: AttachmentRef[],
    expectedRevision: number,
  ) => Promise<{ revision: number }>;
  onSend: (
    content: string,
    attachments: MediaAsset[],
    expectedDraftRevision: number,
  ) => Promise<DraftSendResult>;
  disabled?: boolean;
  sendDisabled?: boolean;
}

export const DraftComposer = React.forwardRef<
  DraftComposerHandle,
  DraftComposerProps
>(function DraftComposer(
  {
    conversationId,
    initialDraft = "",
    initialRevision = 0,
    initialAttachments = [],
    sendShortcut,
    onSaveDraft,
    onSend,
    disabled = false,
    sendDisabled = false,
  },
  ref,
) {
  const [content, setContent] = useState(initialDraft);
  const [attachments, setAttachments] =
    useState<MediaAsset[]>(initialAttachments);
  const [uploads, setUploads] = useState<
    Array<{
      id: string;
      file: File;
      state: "uploading" | "failed";
      error?: string;
    }>
  >([]);
  const [capabilities, setCapabilities] = useState<MediaCapabilities | null>(
    null,
  );
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadsRef = useRef(uploads);
  const controllersRef = useRef(new Map<string, AbortController>());
  const attachmentsRef = useRef(initialAttachments);
  const savedAttachmentsRef = useRef(initialAttachments);
  const [, setRevision] = useState(initialRevision);
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
  const selectedPromptRef = useRef<string | null>(null);
  const refs = (items: MediaAsset[]): AttachmentRef[] =>
    items.map((asset) => ({
      asset_id: asset.asset_id,
      sha256: asset.sha256,
    }));
  const sameAssets = (left: MediaAsset[], right: MediaAsset[]) =>
    JSON.stringify(refs(left)) === JSON.stringify(refs(right));

  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);
  useEffect(() => {
    let current = true;
    setCapabilities(null);
    setCapabilityError(null);
    void apiClient
      .getMediaCapabilities(conversationId)
      .then((value) => {
        if (current) setCapabilities(value);
      })
      .catch((error) => {
        if (current)
          setCapabilityError(
            error instanceof Error ? error.message : "图片功能暂不可用",
          );
      });
    return () => {
      current = false;
    };
  }, [conversationId]);

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
    savePromiseRef.current = null;
    selectedPromptRef.current = null;
    for (const controller of controllersRef.current.values())
      controller.abort();
    controllersRef.current.clear();
    uploadsRef.current = [];
    setUploads([]);
    contentRef.current = initialDraft;
    savedContentRef.current = initialDraft;
    attachmentsRef.current = initialAttachments;
    savedAttachmentsRef.current = initialAttachments;
    setAttachments(initialAttachments);
    revisionRef.current = initialRevision;
    setContent(initialDraft);
    setRevision(initialRevision);
    setSaveError(null);
    setSendError(null);
    sendingRef.current = false;
    setIsSending(false);
  }, [
    clearDebounce,
    conversationId,
    initialDraft,
    initialRevision,
    initialAttachments,
  ]);

  useEffect(() => {
    if (
      contentRef.current !== savedContentRef.current ||
      !sameAssets(attachmentsRef.current, savedAttachmentsRef.current)
    )
      return;
    if (initialRevision < revisionRef.current) return;
    if (
      initialRevision === revisionRef.current &&
      initialDraft === savedContentRef.current &&
      sameAssets(initialAttachments, savedAttachmentsRef.current)
    ) {
      return;
    }
    contentRef.current = initialDraft;
    savedContentRef.current = initialDraft;
    attachmentsRef.current = initialAttachments;
    savedAttachmentsRef.current = initialAttachments;
    setAttachments(initialAttachments);
    selectedPromptRef.current = null;
    revisionRef.current = initialRevision;
    setContent(initialDraft);
    setRevision(initialRevision);
    setSaveError(null);
  }, [initialDraft, initialRevision, initialAttachments]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      clearDebounce();
      for (const controller of controllersRef.current.values())
        controller.abort();
      sendingRef.current = false;
    };
  }, [clearDebounce]);

  const saveSnapshot = useCallback(
    async (nextContent: string, nextAttachments: MediaAsset[]) => {
      const generation = generationRef.current;
      setSaveError(null);
      try {
        const result = await onSaveDraft(
          nextContent,
          refs(nextAttachments),
          revisionRef.current,
        );
        if (generation !== generationRef.current) return;
        savedContentRef.current = nextContent;
        savedAttachmentsRef.current = nextAttachments;
        revisionRef.current = result.revision;
        setRevision(result.revision);
      } catch (error) {
        if (generation === generationRef.current) {
          setSaveError(error instanceof Error ? error.message : "保存失败");
        }
        throw error;
      }
    },
    [onSaveDraft],
  );

  const flushDraft = useCallback(async () => {
    clearDebounce();
    const generation = generationRef.current;
    while (
      generation === generationRef.current &&
      (savedContentRef.current !== contentRef.current ||
        !sameAssets(savedAttachmentsRef.current, attachmentsRef.current))
    ) {
      if (savePromiseRef.current) {
        await savePromiseRef.current;
        continue;
      }
      const snapshot = contentRef.current;
      const snapshotAttachments = attachmentsRef.current;
      const promise = saveSnapshot(snapshot, snapshotAttachments);
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

  const selectPrompt = useCallback(
    (prompt: string) => {
      if (disabled || sendingRef.current) return;
      if (
        contentRef.current &&
        contentRef.current !== selectedPromptRef.current
      ) {
        setSendError("输入框已有内容，请先清空后再选择建议");
        textareaRef.current?.focus();
        return;
      }
      selectedPromptRef.current = prompt;
      contentRef.current = prompt;
      setContent(prompt);
      setSaveError(null);
      setSendError(null);
      scheduleSave();
      textareaRef.current?.focus();
    },
    [disabled, scheduleSave],
  );

  const addAsset = useCallback(
    (asset: MediaAsset) => {
      if (asset.status !== "ready" || disabled || sendingRef.current) return;
      if (
        attachmentsRef.current.some(
          (entry) => entry.asset_id === asset.asset_id,
        )
      ) {
        textareaRef.current?.focus();
        return;
      }
      if (attachmentsRef.current.length + uploadsRef.current.length >= 4) {
        setSendError("一条消息最多附加 4 张图片");
        return;
      }
      const next = [...attachmentsRef.current, asset];
      attachmentsRef.current = next;
      setAttachments(next);
      scheduleSave();
      textareaRef.current?.focus();
    },
    [disabled, scheduleSave],
  );

  const restoreRecovery = useCallback(
    async (copy: (expectedRevision: number) => Promise<DraftSnapshot>) => {
      const hasInput = () =>
        contentRef.current.length > 0 ||
        attachmentsRef.current.length > 0 ||
        uploadsRef.current.length > 0;
      if (disabled || sendingRef.current)
        throw new Error("输入框暂不可用，请稍后重试");
      if (hasInput())
        throw new Error("输入框已有内容或图片，请先保存或移走后再恢复中断项");
      const generation = generationRef.current;
      sendingRef.current = true;
      setIsSending(true);
      try {
        // Wait for earlier saves, including clearing a previous draft, before CAS.
        if (savePromiseRef.current) await savePromiseRef.current;
        if (generation !== generationRef.current)
          throw new Error("会话已切换，请在原会话重试");
        await flushDraft();
        if (generation !== generationRef.current)
          throw new Error("会话已切换，请在原会话重试");
        if (hasInput()) throw new Error("输入框内容已变化，请重新检查");
        const recovered = await copy(revisionRef.current);
        if (generation !== generationRef.current) return;
        if (recovered.revision < revisionRef.current)
          throw new Error("草稿版本已变化，请核对后重试");
        savedContentRef.current = recovered.content;
        savedAttachmentsRef.current = recovered.attachments;
        revisionRef.current = recovered.revision;
        setRevision(recovered.revision);
        if (!hasInput()) {
          contentRef.current = recovered.content;
          attachmentsRef.current = recovered.attachments;
          setContent(recovered.content);
          setAttachments(recovered.attachments);
        } else scheduleSave();
        setSaveError(null);
        textareaRef.current?.focus();
      } finally {
        if (generation === generationRef.current) {
          sendingRef.current = false;
          setIsSending(false);
        }
      }
    },
    [disabled, flushDraft, scheduleSave],
  );

  useImperativeHandle(
    ref,
    () => ({ selectPrompt, addAsset, restoreRecovery }),
    [selectPrompt, addAsset, restoreRecovery],
  );

  const removeAsset = (assetId: string) => {
    const next = attachmentsRef.current.filter(
      (asset) => asset.asset_id !== assetId,
    );
    attachmentsRef.current = next;
    setAttachments(next);
    scheduleSave();
  };

  const uploadFile = (
    file: File,
    id = `upload_${generateBrowserUuid().replaceAll("-", "")}`,
  ) => {
    const allowed = ["image/png", "image/jpeg", "image/webp"];
    if (!allowed.includes(file.type)) {
      setSendError(`${file.name}: 只支持静态 PNG、JPEG、WebP 图片`);
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setSendError(`${file.name}: 图片超过 8 MiB`);
      return;
    }
    if (attachmentsRef.current.length + uploadsRef.current.length >= 4) {
      setSendError("一条消息最多附加 4 张图片");
      return;
    }
    const generation = generationRef.current;
    const controller = new AbortController();
    controllersRef.current.set(id, controller);
    const pending = [
      ...uploadsRef.current,
      { id, file, state: "uploading" as const },
    ];
    uploadsRef.current = pending;
    setUploads(pending);
    setSendError(null);
    void apiClient
      .uploadMedia(conversationId, file, id, controller.signal)
      .then((asset) => {
        if (
          generation !== generationRef.current ||
          !uploadsRef.current.some((item) => item.id === id)
        )
          return;
        uploadsRef.current = uploadsRef.current.filter(
          (item) => item.id !== id,
        );
        setUploads(uploadsRef.current);
        if (asset.status !== "ready") throw new Error("图片尚未就绪");
        addAsset(asset);
      })
      .catch((error) => {
        if (
          generation !== generationRef.current ||
          !uploadsRef.current.some((item) => item.id === id)
        )
          return;
        uploadsRef.current = uploadsRef.current.map((item) =>
          item.id === id
            ? {
                ...item,
                state: "failed",
                error: error instanceof Error ? error.message : "上传失败",
              }
            : item,
        );
        setUploads(uploadsRef.current);
      })
      .finally(() => controllersRef.current.delete(id));
  };

  const addFiles = (files: FileList | File[]) => {
    if (!capabilities) {
      setSendError(capabilityError ?? "图片服务暂不可用");
      return;
    }
    for (const file of Array.from(files)) uploadFile(file);
  };

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextContent = event.target.value;
    selectedPromptRef.current = null;
    contentRef.current = nextContent;
    setContent(nextContent);
    setSendError(null);
    scheduleSave();
  };

  const handleSend = async () => {
    const current = contentRef.current;
    const currentAttachments = attachmentsRef.current;
    const isOverLimit =
      new TextEncoder().encode(current).length > LIMITS.INPUT_MAX_BYTES;
    if (
      (!current.trim() && currentAttachments.length === 0) ||
      (currentAttachments.length > 0 && !capabilities) ||
      uploadsRef.current.length > 0 ||
      currentAttachments.some((asset) => asset.status !== "ready") ||
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
      const result = await onSend(
        current,
        currentAttachments,
        revisionRef.current,
      );
      if (generation !== generationRef.current) return;
      const changedDuringSend =
        contentRef.current !== current ||
        !sameAssets(attachmentsRef.current, currentAttachments);
      savedContentRef.current = result.draft.content;
      savedAttachmentsRef.current = result.draft.attachments;
      selectedPromptRef.current = null;
      revisionRef.current = result.draft.revision;
      if (!changedDuringSend) {
        contentRef.current = result.draft.content;
        attachmentsRef.current = result.draft.attachments;
        setContent(result.draft.content);
        setAttachments(result.draft.attachments);
      } else scheduleSave();
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
    <div
      className={`composer-container ${isOverLimit ? "over-limit" : ""}`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        addFiles(event.dataTransfer.files);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <textarea
        ref={textareaRef}
        className="composer-textarea"
        value={content}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={(event) => {
          const images = Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith("image/"),
          );
          if (images.length) addFiles(images);
        }}
        disabled={disabled || isSending}
        placeholder="写下你的消息..."
        rows={3}
        aria-label="消息输入框"
      />
      <MediaAssets
        assets={attachments}
        conversationId={conversationId}
        onRemove={removeAsset}
        compact
      />
      {uploads.length > 0 && (
        <div className="composer-uploads">
          {uploads.map((entry) => (
            <div className="composer-upload" key={entry.id}>
              <span>
                {entry.file.name}:{" "}
                {entry.state === "uploading" ? "上传中…" : entry.error}
              </span>
              {entry.state === "failed" && (
                <button
                  type="button"
                  onClick={() => {
                    uploadsRef.current = uploadsRef.current.filter(
                      (item) => item.id !== entry.id,
                    );
                    setUploads(uploadsRef.current);
                    uploadFile(entry.file, entry.id);
                  }}
                >
                  重试
                </button>
              )}
              <button
                type="button"
                aria-label={`移除 ${entry.file.name}`}
                onClick={() => {
                  controllersRef.current.get(entry.id)?.abort();
                  uploadsRef.current = uploadsRef.current.filter(
                    (item) => item.id !== entry.id,
                  );
                  setUploads(uploadsRef.current);
                }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-footer">
        <div className="composer-meta">
          <span
            className={`composer-byte-counter ${isOverLimit ? "error" : ""}`}
          >
            {byteCount.toLocaleString()} /{" "}
            {LIMITS.INPUT_MAX_BYTES.toLocaleString()} bytes
          </span>
          <span className="composer-shortcut-hint" title="发送快捷键">
            {sendShortcut === "mod_enter" ? (
              <>
                <kbd className="kbd-cap">⌘ / Ctrl</kbd>
                <span className="kbd-sep">+</span>
                <kbd className="kbd-cap">↵</kbd>
                <span className="kbd-action">发送</span>
              </>
            ) : (
              <>
                <kbd className="kbd-cap">↵</kbd>
                <span className="kbd-action">发送</span>
              </>
            )}
          </span>
          {saveError && <span className="error">{saveError}</span>}
          {sendError && sendError !== saveError && (
            <span className="error">{sendError}</span>
          )}
          {capabilityError && (
            <span
              className="composer-media-unavailable"
              title={capabilityError}
            >
              图片暂不可用
            </span>
          )}
        </div>
        <div className="composer-actions">
          <button
            type="button"
            className="composer-attach"
            aria-label="添加图片"
            title="添加图片"
            disabled={
              disabled ||
              isSending ||
              !capabilities ||
              attachments.length + uploads.length >= 4
            }
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus size={17} />
          </button>
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
              (!content.trim() && attachments.length === 0) ||
              (attachments.length > 0 && !capabilities) ||
              uploads.length > 0 ||
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
});
