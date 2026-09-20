import React, { useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronUp,
  CircleDot,
  Copy,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import type { QueueItemResponse } from "../../../shared/api-schemas.js";

interface QueueDrawerProps {
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

export const QueueDrawer: React.FC<QueueDrawerProps> = ({
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

  if (!isOpen) return null;

  const runAction = async (action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "队列操作失败");
    }
  };

  const activeItems = items.filter((item) => item.state !== "cancelled");

  return (
    <section className="queue-panel" aria-label="消息队列">
      <div className="queue-header">
        <div className="queue-header-title">
          <CircleDot size={14} strokeWidth={1.8} />
          <span>消息队列</span>
          <span className="queue-count">{activeItems.length}</span>
        </div>
        <button type="button" onClick={onClose} aria-label="收起消息队列">
          <ChevronUp size={14} strokeWidth={1.8} />
          收起
        </button>
      </div>

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

      <div className="queue-items">
        {activeItems.length === 0 ? (
          <div className="sidebar-empty">队列为空</div>
        ) : (
          activeItems.map((item) => {
            const editing = editingItemId === item.id;
            const recovery = ["paused", "review_required", "rejected"].includes(
              item.state,
            );
            return (
              <div className="queue-item" key={item.id}>
                <span className="queue-number">{item.fifo_seq}</span>
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
                      />
                      <div className="queue-edit-actions">
                        <button
                          type="button"
                          onClick={() => setEditingItemId(null)}
                        >
                          <X size={12} />
                          取消
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
                        >
                          <Check size={12} />
                          保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <span
                        className={`queue-item-state ${getStateClass(item.state)}`}
                      >
                        {getStateIcon(item.state)}
                        {getStateLabel(item.state)}
                      </span>
                      <span className="queue-item-content">
                        {item.content || "正文已清除"}
                      </span>
                    </>
                  )}
                </div>

                {!editing && (
                  <div className="queue-item-actions">
                    {item.state === "queued" && (
                      <>
                        <button
                          type="button"
                          title="编辑消息"
                          aria-label="编辑消息"
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
                          title="取消排队"
                          aria-label="取消排队"
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
                        <X size={13} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
};

function getStateLabel(state: string): string {
  const labels: Record<string, string> = {
    queued: "等待发送",
    dispatching: "正在提交",
    accepted: "运行中",
    reconciling: "核对结果",
    done: "已完成",
    paused: "已暂停",
    review_required: "需要复核",
    rejected: "已拒绝",
    cancelled: "已取消",
  };
  return labels[state] ?? state;
}

function getStateClass(state: string): string {
  if (state === "queued") return "queued";
  if (["dispatching", "accepted", "reconciling"].includes(state))
    return "running";
  if (["paused", "review_required", "rejected"].includes(state))
    return "recovery";
  if (state === "done") return "done";
  return "";
}

function getStateIcon(state: string) {
  if (["dispatching", "accepted", "reconciling"].includes(state)) {
    return <LoaderCircle size={12} className="spin" />;
  }
  if (state === "done") return <Check size={12} />;
  if (["paused", "review_required", "rejected"].includes(state)) {
    return <AlertCircle size={12} />;
  }
  return <Send size={12} />;
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
