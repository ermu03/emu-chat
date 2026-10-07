import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
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

import { DraftStore, type DraftSnapshot } from "../../state/draft-store.js";
export type { DraftSnapshot } from "../../state/draft-store.js";

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
  draftStore?: DraftStore;
  initialDraft?: string;
  initialRevision?: number;
  initialAttachments?: MediaAsset[];
  sendShortcut: "enter" | "mod_enter";
  onSaveDraft?: (
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
    draftStore,
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
  const saveCallbacks = useRef(
    new Map<string, DraftComposerProps["onSaveDraft"]>(),
  );
  saveCallbacks.current.set(conversationId, onSaveDraft);
  const [fallbackStore] = useState(
    () =>
      new DraftStore((id, text, refs, revision) => {
        const save = saveCallbacks.current.get(id);
        if (!save) throw new Error("草稿保存未配置");
        return save(text, refs, revision);
      }),
  );
  const store = draftStore ?? fallbackStore;
  const session = store.get(conversationId, {
    content: initialDraft,
    attachments: initialAttachments,
    revision: initialRevision,
  });
  const {
    content,
    attachments,
    busy: isSending,
    saveError,
  } = useSyncExternalStore(session.subscribe, session.getSnapshot);
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
  const [sendError, setSendError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const generationRef = useRef(0);
  const selectedPromptRef = useRef<string | null>(null);
  const composingRef = useRef(false);
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
    const style = getComputedStyle(textarea);
    const minimum = parseFloat(style.minHeight) || 84;
    const maximum = parseFloat(style.maxHeight) || 230;
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minimum), maximum)}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [content, resizeTextarea]);
  useEffect(() => {
    let frame = 0;
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resizeTextarea);
    };
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, [resizeTextarea]);
  useEffect(() => {
    session.acceptServer({
      content: initialDraft,
      attachments: initialAttachments,
      revision: initialRevision,
    });
  }, [session, initialDraft, initialAttachments, initialRevision]);
  useEffect(() => {
    selectedPromptRef.current = null;
    composingRef.current = false;
    uploadsRef.current = [];
    setUploads([]);
    setSendError(null);
    return () => {
      generationRef.current += 1;
      for (const controller of controllersRef.current.values())
        controller.abort();
      controllersRef.current.clear();
      session.leave();
    };
  }, [session]);
  const flushDraft = useCallback(() => session.flush(), [session]);
  const scheduleSave = useCallback(() => session.schedule(), [session]);

  const selectPrompt = useCallback(
    (prompt: string) => {
      if (disabled || session.getSnapshot().busy) return;
      if (
        session.getSnapshot().content &&
        session.getSnapshot().content !== selectedPromptRef.current
      ) {
        setSendError("输入框已有内容，请先清空后再选择建议");
        textareaRef.current?.focus();
        return;
      }
      selectedPromptRef.current = prompt;
      session.edit(prompt);
      setSendError(null);
      scheduleSave();
      textareaRef.current?.focus();
    },
    [disabled, scheduleSave],
  );

  const addAsset = useCallback(
    (asset: MediaAsset) => {
      if (asset.status !== "ready" || disabled || session.getSnapshot().busy)
        return;
      if (
        session
          .getSnapshot()
          .attachments.some((entry) => entry.asset_id === asset.asset_id)
      ) {
        textareaRef.current?.focus();
        return;
      }
      if (
        session.getSnapshot().attachments.length + uploadsRef.current.length >=
        4
      ) {
        setSendError("一条消息最多附加 4 张图片");
        return;
      }
      const next = [...session.getSnapshot().attachments, asset];
      session.edit(session.getSnapshot().content, next);
      scheduleSave();
      textareaRef.current?.focus();
    },
    [disabled, scheduleSave],
  );

  const restoreRecovery = useCallback(
    async (copy: (expectedRevision: number) => Promise<DraftSnapshot>) => {
      const hasInput = () =>
        session.getSnapshot().content.length > 0 ||
        session.getSnapshot().attachments.length > 0 ||
        uploadsRef.current.length > 0;
      if (disabled || session.getSnapshot().busy)
        throw new Error("输入框暂不可用，请稍后重试");
      if (hasInput())
        throw new Error("输入框已有内容或图片，请先保存或移走后再恢复中断项");
      const generation = generationRef.current;
      session.setBusy(true);
      try {
        await flushDraft();
        if (generation !== generationRef.current)
          throw new Error("会话已切换，请在原会话重试");
        if (hasInput()) throw new Error("输入框内容已变化，请重新检查");
        const before = session.getSnapshot();
        const recovered = await copy(before.revision);
        if (recovered.revision < session.getSnapshot().revision)
          throw new Error("草稿版本已变化，请核对后重试");
        session.acknowledgeAction(recovered, before);
        if (generation === generationRef.current) textareaRef.current?.focus();
      } finally {
        session.setBusy(false);
      }
    },
    [disabled, flushDraft, session],
  );

  useImperativeHandle(
    ref,
    () => ({ selectPrompt, addAsset, restoreRecovery }),
    [selectPrompt, addAsset, restoreRecovery],
  );

  const removeAsset = (assetId: string) => {
    const next = session
      .getSnapshot()
      .attachments.filter((asset) => asset.asset_id !== assetId);
    session.edit(session.getSnapshot().content, next);
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
    if (
      session.getSnapshot().attachments.length + uploadsRef.current.length >=
      4
    ) {
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
    session.edit(nextContent);
    setSendError(null);
    scheduleSave();
  };

  const handleSend = async () => {
    const current = session.getSnapshot().content;
    const currentAttachments = session.getSnapshot().attachments;
    const isOverLimit =
      new TextEncoder().encode(current).length > LIMITS.INPUT_MAX_BYTES;
    if (
      (!current.trim() && currentAttachments.length === 0) ||
      (currentAttachments.length > 0 && !capabilities) ||
      uploadsRef.current.length > 0 ||
      currentAttachments.some((asset) => asset.status !== "ready") ||
      disabled ||
      sendDisabled ||
      session.getSnapshot().busy ||
      isOverLimit
    )
      return;

    const generation = generationRef.current;
    session.setBusy(true);
    setSendError(null);
    try {
      await flushDraft();
      if (generation !== generationRef.current) return;
      const before = session.getSnapshot();
      const result = await onSend(
        before.content,
        before.attachments,
        before.revision,
      );
      session.acknowledgeAction(result.draft, before);
      if (generation === generationRef.current)
        selectedPromptRef.current = null;
    } catch (error) {
      if (generation === generationRef.current)
        setSendError(error instanceof Error ? error.message : "发送失败");
    } finally {
      session.setBusy(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      composingRef.current ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return;
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
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onPaste={(event) => {
          const images = Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith("image/"),
          );
          if (images.length) addFiles(images);
        }}
        disabled={disabled || isSending}
        placeholder="写下你的消息..."
        rows={1}
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
      {session.getSnapshot().remote && (
        <div
          className="composer-conflict"
          role="group"
          aria-label="草稿冲突核对"
        >
          <p>服务端草稿已变化，请核对后选择：</p>
          <textarea
            readOnly
            aria-label="服务端草稿"
            value={session.getSnapshot().remote!.content}
          />
          <MediaAssets
            assets={session.getSnapshot().remote!.attachments}
            conversationId={conversationId}
            compact
          />
          <button
            type="button"
            disabled={disabled || isSending}
            onClick={() => session.resolveConflict(true)}
          >
            保留我的草稿
          </button>
          <button
            type="button"
            disabled={disabled || isSending}
            onClick={() => session.resolveConflict(false)}
          >
            使用服务端草稿
          </button>
        </div>
      )}
      <div className="composer-footer">
        <div
          className={`composer-meta ${saveError || sendError || capabilityError || byteCount >= LIMITS.INPUT_MAX_BYTES * 0.9 ? "has-feedback" : ""}`}
        >
          <span
            className={`composer-byte-counter ${byteCount >= LIMITS.INPUT_MAX_BYTES * 0.9 ? "near-limit" : ""} ${isOverLimit ? "error" : ""}`}
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
          {saveError && (
            <>
              <span className="error">{saveError}</span>
              <button
                type="button"
                disabled={disabled || isSending}
                onClick={() => {
                  if (session.getSnapshot().conflict) {
                    const generation = generationRef.current;
                    void apiClient
                      .getDraft(session.id)
                      .then((remote) => session.showConflict(remote))
                      .catch(
                        (error) =>
                          generation === generationRef.current &&
                          setSendError(
                            error instanceof Error
                              ? error.message
                              : "读取草稿失败",
                          ),
                      );
                  } else void flushDraft().catch(() => undefined);
                }}
              >
                {session.getSnapshot().conflict ? "核对草稿冲突" : "重试保存"}
              </button>
            </>
          )}
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
