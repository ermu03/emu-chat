import React, { useState } from "react";
import type { QueueItemResponse } from "../../../shared/api-schemas.js";

type LegacyQueueStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";

/**
 * The optional legacy fields keep this presentational component usable by the
 * existing component tests while the application passes QueueItemResponse.
 */
export interface QueueDrawerItem {
  id: string;
  content: string | null;
  created_at: string;
  fifo_seq?: number;
  sequence_number?: number;
  state?: QueueItemResponse["state"];
  status?: LegacyQueueStatus;
  revision?: number;
  payload_available?: boolean;
  recovery_expires_at?: string | null;
  last_error_code?: string | null;
}

interface QueueDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  items: QueueDrawerItem[];
  paused?: boolean;
  pauseReason?: string | null;
  onCancelItem: (itemId: string, expectedRevision?: number) => Promise<void>;
  onEditItem?: (
    itemId: string,
    content: string,
    expectedRevision: number,
  ) => Promise<void>;
  onResume?: () => Promise<void>;
  onCopyToDraft?: (itemId: string) => Promise<void>;
  onDiscardRecovery?: (itemId: string) => Promise<void>;
}

export const QueueDrawer: React.FC<QueueDrawerProps> = ({
  isOpen,
  onClose,
  items,
  paused = false,
  pauseReason = null,
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

  const beginEdit = (item: QueueDrawerItem) => {
    setEditingItemId(item.id);
    setEditedContent(item.content ?? "");
    setActionError(null);
  };

  const runAction = async (action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "队列操作失败");
    }
  };

  return (
    <div
      role="dialog"
      aria-label="会话消息队列"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(360px, 100vw)",
        backgroundColor: "#1f2430",
        color: "#cbccc6",
        boxShadow: "-4px 0 16px rgba(0,0,0,0.5)",
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "16px",
          borderBottom: "1px solid #2d3345",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>
          会话消息队列 ({items.length})
        </h3>
        <button
          aria-label="关闭队列"
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "#cbccc6",
            cursor: "pointer",
            fontSize: 18,
          }}
        >
          x
        </button>
      </div>

      {paused && (
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid #57411f",
            background: "#372d18",
          }}
        >
          <div style={{ color: "#ffcc66", fontSize: 13 }}>
            队列已暂停{pauseReason ? `: ${pauseReason}` : ""}
          </div>
          {onResume && (
            <button
              onClick={() => void runAction(onResume)}
              style={secondaryButtonStyle}
            >
              继续后续队列
            </button>
          )}
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          style={{ padding: "10px 16px", color: "#ff9999", fontSize: 12 }}
        >
          {actionError}
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {items.length === 0 ? (
          <div style={{ color: "#707a8c", textAlign: "center", marginTop: 40 }}>
            当前没有排队中的消息
          </div>
        ) : (
          items.map((item) => {
            const state = item.state ?? item.status ?? "queued";
            const queued = state === "queued";
            const recovery = ["paused", "review_required", "rejected"].includes(
              state,
            );
            const sequence = item.fifo_seq ?? item.sequence_number ?? 0;
            const editing = editingItemId === item.id;

            return (
              <div
                key={item.id}
                style={{
                  backgroundColor: "#151922",
                  borderRadius: 6,
                  padding: 12,
                  marginBottom: 12,
                  border: "1px solid #2d3345",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    marginBottom: 8,
                    fontSize: 12,
                    color: "#707a8c",
                  }}
                >
                  <span>#{sequence}</span>
                  <span style={{ color: getStateColor(state) }}>
                    {getStateLabel(state)}
                  </span>
                </div>

                {editing ? (
                  <>
                    <textarea
                      aria-label={`编辑队列消息 ${sequence}`}
                      value={editedContent}
                      onChange={(event) => setEditedContent(event.target.value)}
                      rows={4}
                      style={{ ...editorStyle, marginBottom: 8 }}
                    />
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "flex-end",
                        gap: 8,
                      }}
                    >
                      <button
                        onClick={() => setEditingItemId(null)}
                        style={secondaryButtonStyle}
                      >
                        取消
                      </button>
                      <button
                        disabled={!editedContent.trim() || !onEditItem}
                        onClick={() => {
                          if (!onEditItem) return;
                          void runAction(async () => {
                            await onEditItem(
                              item.id,
                              editedContent,
                              item.revision ?? 0,
                            );
                            setEditingItemId(null);
                          });
                        }}
                        style={primaryButtonStyle}
                      >
                        保存修改
                      </button>
                    </div>
                  </>
                ) : (
                  <div
                    style={{
                      fontSize: 14,
                      lineHeight: 1.4,
                      maxHeight: 60,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "pre-wrap",
                      marginBottom: 8,
                    }}
                  >
                    {item.content ?? "正文已清除"}
                  </div>
                )}

                {!editing && queued && (
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      gap: 8,
                    }}
                  >
                    {onEditItem && (
                      <button
                        onClick={() => beginEdit(item)}
                        style={secondaryButtonStyle}
                      >
                        编辑
                      </button>
                    )}
                    <button
                      onClick={() =>
                        void runAction(() =>
                          onCancelItem(item.id, item.revision),
                        )
                      }
                      style={dangerButtonStyle}
                    >
                      取消排队
                    </button>
                  </div>
                )}

                {!editing && recovery && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      justifyContent: "flex-end",
                      gap: 8,
                    }}
                  >
                    {item.payload_available !== false && onCopyToDraft && (
                      <button
                        onClick={() =>
                          void runAction(() => onCopyToDraft(item.id))
                        }
                        style={secondaryButtonStyle}
                      >
                        复制为新草稿
                      </button>
                    )}
                    {onDiscardRecovery && (
                      <button
                        onClick={() =>
                          void runAction(() => onDiscardRecovery(item.id))
                        }
                        style={dangerButtonStyle}
                      >
                        丢弃恢复副本
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

function getStateLabel(state: string): string {
  const labels: Record<string, string> = {
    queued: "等待发送",
    dispatching: "正在提交",
    accepted: "运行中",
    reconciling: "正在核对结果",
    done: "已完成",
    paused: "已暂停",
    review_required: "需要人工复核",
    rejected: "提交被拒绝",
    cancelled: "已取消",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
  };
  return labels[state] ?? state;
}

function getStateColor(state: string): string {
  if (state === "queued") return "#73d0ff";
  if (state === "dispatching" || state === "accepted" || state === "running")
    return "#ffb454";
  if (state === "done" || state === "completed") return "#7fd962";
  if (
    state === "paused" ||
    state === "review_required" ||
    state === "rejected" ||
    state === "failed"
  )
    return "#ff9999";
  return "#cbccc6";
}

const primaryButtonStyle: React.CSSProperties = {
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  padding: "5px 9px",
  fontSize: 12,
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  background: "transparent",
  color: "#cbccc6",
  border: "1px solid #3e4b59",
  borderRadius: 4,
  padding: "5px 9px",
  fontSize: 12,
  cursor: "pointer",
  marginTop: 8,
};

const dangerButtonStyle: React.CSSProperties = {
  background: "#b84545",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  padding: "5px 9px",
  fontSize: 12,
  cursor: "pointer",
};

const editorStyle: React.CSSProperties = {
  width: "100%",
  resize: "vertical",
  color: "#cbccc6",
  background: "#0f131c",
  border: "1px solid #3e4b59",
  borderRadius: 4,
  padding: 8,
  font: "inherit",
};
