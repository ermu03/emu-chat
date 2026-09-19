import React, { useEffect, useState, useRef } from 'react';
import { LIMITS } from '../../../shared/limits.js';

export interface DraftComposerProps {
  conversationId: string;
  initialDraft?: string;
  initialRevision?: number;
  sendShortcut: 'enter' | 'mod_enter';
  onSaveDraft: (content: string, expectedRevision: number) => Promise<{ revision: number }>;
  onSend: (content: string) => void;
  disabled?: boolean;
}

export const DraftComposer: React.FC<DraftComposerProps> = ({
  conversationId,
  initialDraft = '',
  initialRevision = 0,
  sendShortcut,
  onSaveDraft,
  onSend,
  disabled = false
}) => {
  const [content, setContent] = useState(initialDraft);
  const [revision, setRevision] = useState(initialRevision);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const latestContentRef = useRef(content);
  latestContentRef.current = content;
  const latestRevisionRef = useRef(revision);
  latestRevisionRef.current = revision;

  useEffect(() => {
    setContent(initialDraft);
    setRevision(initialRevision);
    setSaveError(null);
  }, [conversationId, initialDraft, initialRevision]);

  const persistDraft = async (textToSave: string) => {
    try {
      setIsSaving(true);
      setSaveError(null);
      const res = await onSaveDraft(textToSave, latestRevisionRef.current);
      setRevision(res.revision);
    } catch (err: any) {
      setSaveError(err.message || '草稿保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setContent(val);

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      persistDraft(val);
    }, 1000);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;

    const isMod = e.ctrlKey || e.metaKey;
    const isEnter = e.key === 'Enter';

    let shouldSend = false;
    if (sendShortcut === 'mod_enter' && isEnter && isMod) {
      shouldSend = true;
    } else if (sendShortcut === 'enter' && isEnter && !e.shiftKey && !isMod) {
      shouldSend = true;
    }

    if (shouldSend) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    const trimmed = content.trim();
    if (!trimmed || disabled) return;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    onSend(trimmed);
    // Clear draft upon sending
    setContent('');
    persistDraft('');
  };

  const byteCount = new TextEncoder().encode(content).length;
  const isOverLimit = byteCount > LIMITS.USER_INPUT_MAX_BYTES;

  return (
    <div className="composer-container" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <textarea
        value={content}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={
          sendShortcut === 'mod_enter'
            ? '输入消息... (Ctrl+Enter 或 Cmd+Enter 发送)'
            : '输入消息... (Enter 发送, Shift+Enter 换行)'
        }
        rows={4}
        style={{
          width: '100%',
          padding: '8px 12px',
          borderRadius: '6px',
          border: isOverLimit ? '1px solid #ef4444' : '1px solid #d1d5db',
          resize: 'vertical',
          fontFamily: 'inherit',
          fontSize: '14px'
        }}
      />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '12px',
          color: '#6b7280'
        }}
      >
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <span>
            {byteCount} / {LIMITS.USER_INPUT_MAX_BYTES} 字节
          </span>
          {isSaving && <span>草稿保存中...</span>}
          {saveError && <span style={{ color: '#ef4444' }}>{saveError}</span>}
        </div>
        <button
          onClick={handleSend}
          disabled={disabled || !content.trim() || isOverLimit}
          style={{
            padding: '6px 16px',
            backgroundColor: disabled || !content.trim() || isOverLimit ? '#9ca3af' : '#2563eb',
            color: '#ffffff',
            border: 'none',
            borderRadius: '4px',
            cursor: disabled || !content.trim() || isOverLimit ? 'not-allowed' : 'pointer'
          }}
        >
          发送
        </button>
      </div>
    </div>
  );
};
