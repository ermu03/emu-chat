import React, { useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Copy,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import type { QueueItemResponse } from "../../../shared/api-schemas.js";

interface QueuePanelProps {
  isOpen: boolean;
  onClose: () => void;
  items: QueueItemResponse[];
  paused: boolean;
  pauseReason: string | null;
  onCancelItem: (itemId: string, expectedRevision: number) => Promise<void>;
  onEditItem: (
    itemId: string,
    content: string,
    expectedRevision: number,
  ) => Promise<void>;
  onResume: () => Promise<void>;
  onCopyToDraft: (itemId: string) => Promise<void>;
  onDiscardRecovery: (itemId: string) => Promise<void>;
}

export const QueuePanel: React.FC<QueuePanelProps> = ({
  isOpen,
  onClose,
  items,
  paused,
  pauseReason,
  onCancelItem,
  onEditItem,
  onResume,
  onCopyToDraft,
  onDiscardRecovery,
}) => {
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  if (!isOpen) return null;

  const activeItems = items
    .filter((item) => item.state !== "cancelled" && item.state !== "done")
    .sort((left, right) => left.fifo_seq - right.fifo_seq);

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
          <span className="queue-count">{activeItems.length}</span>
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
          {paused && (
            <div className="queue-warning">
              <span>
                队列已暂停
                {pauseReason ? ` · ${formatPauseReason(pauseReason)}` : ""}
              </span>
              <button type="button" onClick={() => void runAction(onResume)}>
                <RotateCcw size={12} />
                继续
              </button>
            </div>
          )}

          {actionError && <div className="queue-error">{actionError}</div>}

          <div className="queue-items" aria-live="polite">
            {activeItems.length === 0 ? (
              <div className="queue-empty">队列为空</div>
            ) : (
              activeItems.map((item) => {
                const editing = editingItemId === item.id;
                const recovery = [
                  "paused",
                  "review_required",
                  "rejected",
                ].includes(item.state);
                const editable = item.state === "queued";

                return (
                  <div className="queue-item" key={item.id}>
                    <div className="queue-item-leading">
                      <span className="queue-number">{item.fifo_seq}</span>
                      <span
                        className={`queue-item-state ${getStateClass(item.state)}`}
                      >
                        {getStateIcon(item.state)}
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
                          <div className="queue-item-label">
                            {getStateLabel(item.state)}
                          </div>
                          <div className="queue-item-content">
                            {item.content || "正文已清除"}
                          </div>
                        </>
                      )}
                    </div>

                    {!editing && (
                      <div className="queue-item-actions">
                        {editable && (
                          <>
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
                          </>
                        )}
                        {recovery && item.payload_available && (
                          <button
                            type="button"
                            title="复制到草稿"
                            aria-label="复制到草稿"
                            onClick={() =>
                              void runAction(() => onCopyToDraft(item.id))
                            }
                          >
                            <Copy size={13} />
                          </button>
                        )}
                        {recovery && (
                          <button
                            type="button"
                            className="danger"
                            title="丢弃恢复副本"
                            aria-label="丢弃恢复副本"
                            onClick={() =>
                              void runAction(() => onDiscardRecovery(item.id))
                            }
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </section>
  );
};

function getStateLabel(state: string): string {
  const labels: Record<string, string> = {
    queued: "排队中",
    dispatching: "提交中",
    accepted: "运行中",
    reconciling: "核对中",
    paused: "已暂停",
    review_required: "需要复核",
    rejected: "已拒绝",
  };
  return labels[state] ?? state;
}

function getStateClass(state: string): string {
  if (state === "queued") return "queued";
  if (["dispatching", "accepted", "reconciling"].includes(state))
    return "running";
  if (["paused", "review_required", "rejected"].includes(state))
    return "recovery";
  return "";
}

function getStateIcon(state: string) {
  if (["dispatching", "accepted", "reconciling"].includes(state)) {
    return <LoaderCircle size={13} className="spin" />;
  }
  if (["paused", "review_required", "rejected"].includes(state)) {
    return <AlertCircle size={13} />;
  }
  return <Clock3 size={13} />;
}

function formatPauseReason(reason: string): string {
  const labels: Record<string, string> = {
    run_failed: "运行失败",
    run_partial: "运行不完整",
    run_cancelled: "运行已取消",
    run_interrupted: "运行被中断",
    user_stopped: "手动停止",
    submission_rejected: "提交被拒绝",
    reconciliation_failed: "状态核对失败",
    review_required: "需要人工复核",
    manual_resume_required: "等待手动继续",
  };
  return labels[reason] ?? reason;
}
