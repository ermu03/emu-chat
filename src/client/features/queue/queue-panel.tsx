import React, { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import type { QueueItemResponse } from "../../../shared/api-schemas.js";

interface QueuePanelProps {
  isOpen: boolean;
  onClose: () => void;
  items: QueueItemResponse[];
  onCancelItem: (itemId: string, expectedRevision: number) => Promise<void>;
  onEditItem: (
    itemId: string,
    content: string,
    expectedRevision: number,
  ) => Promise<void>;
}

export const QueuePanel: React.FC<QueuePanelProps> = ({
  isOpen,
  onClose,
  items,
  onCancelItem,
  onEditItem,
}) => {
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  if (!isOpen || items.length === 0) return null;

  const queuedItems = [...items].sort(
    (left, right) => left.fifo_seq - right.fifo_seq,
  );

  const runAction = async (action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "队列操作失败");
    }
  };

  return (
    <section className="queue-panel" aria-label="消息队列">
      <header className="queue-header">
        <div className="queue-header-title">
          <Clock3 size={14} strokeWidth={1.8} />
          <span>消息队列</span>
          <span className="queue-count">{queuedItems.length}</span>
        </div>
        <div className="queue-header-actions">
          <button
            type="button"
            className="queue-collapse-button"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "展开消息队列" : "收起消息队列"}
            title={collapsed ? "展开消息队列" : "收起消息队列"}
          >
            {collapsed ? (
              <ChevronDown size={14} strokeWidth={1.8} />
            ) : (
              <ChevronUp size={14} strokeWidth={1.8} />
            )}
          </button>
          <button
            type="button"
            className="queue-close-button"
            onClick={onClose}
            aria-label="隐藏消息队列"
            title="隐藏消息队列"
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      {!collapsed && (
        <>
          {actionError && <div className="queue-error">{actionError}</div>}

          <div className="queue-items" aria-live="polite">
            {queuedItems.map((item) => {
              const editing = editingItemId === item.id;

              return (
                <div className="queue-item" key={item.id}>
                  <div className="queue-item-leading">
                    <span className="queue-number">{item.fifo_seq}</span>
                    <span className="queue-item-state queued">
                      <Clock3 size={13} />
                    </span>
                  </div>

                  <div className="queue-item-main">
                    {editing ? (
                      <div className="queue-edit-content">
                        <textarea
                          className="queue-edit"
                          value={editedContent}
                          onChange={(event) =>
                            setEditedContent(event.target.value)
                          }
                          rows={3}
                          aria-label={`编辑第 ${item.fifo_seq} 条队列消息`}
                          autoFocus
                        />
                        <div className="queue-edit-actions">
                          <button
                            type="button"
                            onClick={() => setEditingItemId(null)}
                            aria-label="取消编辑"
                            title="取消编辑"
                          >
                            <X size={13} />
                          </button>
                          <button
                            type="button"
                            className="primary"
                            disabled={!editedContent.trim()}
                            onClick={() =>
                              void runAction(async () => {
                                await onEditItem(
                                  item.id,
                                  editedContent,
                                  item.revision,
                                );
                                setEditingItemId(null);
                              })
                            }
                            aria-label="保存消息"
                            title="保存消息"
                          >
                            <Check size={13} />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="queue-item-label">等待当前回复完成</div>
                        <div className="queue-item-content">
                          {item.content || "正文已清除"}
                        </div>
                      </>
                    )}
                  </div>

                  {!editing && (
                    <div className="queue-item-actions">
                      <button
                        type="button"
                        title="编辑排队消息"
                        aria-label="编辑排队消息"
                        onClick={() => {
                          setEditedContent(item.content ?? "");
                          setEditingItemId(item.id);
                          setActionError(null);
                        }}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="danger"
                        title="删除排队消息"
                        aria-label="删除排队消息"
                        onClick={() =>
                          void runAction(() =>
                            onCancelItem(item.id, item.revision),
                          )
                        }
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
};
