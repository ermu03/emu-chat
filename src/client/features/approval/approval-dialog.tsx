import React from "react";

interface ApprovalDialogProps {
  isOpen: boolean;
  runId: string;
  reason?: string;
  details?: Record<string, unknown> | undefined;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
  onCancel: () => Promise<void>;
}

export const ApprovalDialog: React.FC<ApprovalDialogProps> = ({
  isOpen,
  runId,
  reason = "tool_approval_required",
  details,
  onApprove,
  onReject,
  onCancel,
}) => {
  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
      }}
    >
      <div
        style={{
          width: 480,
          backgroundColor: "#1f2430",
          borderRadius: 8,
          border: "1px solid #3e4b59",
          color: "#cbccc6",
          padding: 24,
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
      >
        <h3 style={{ margin: "0 0 12px 0", color: "#ffb454" }}>
          ⚠️ 运行等待审批确认
        </h3>
        <p style={{ fontSize: 13, color: "#707a8c", margin: "0 0 16px 0" }}>
          Run ID: {runId} | 原因: {reason}
        </p>

        {details && (
          <pre
            style={{
              backgroundColor: "#151922",
              padding: 12,
              borderRadius: 4,
              fontSize: 12,
              maxHeight: 200,
              overflow: "auto",
              border: "1px solid #2d3345",
              margin: "0 0 20px 0",
            }}
          >
            {JSON.stringify(details, null, 2)}
          </pre>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
          <button
            onClick={onCancel}
            style={{
              backgroundColor: "transparent",
              color: "#cbccc6",
              border: "1px solid #3e4b59",
              borderRadius: 4,
              padding: "6px 12px",
              cursor: "pointer",
            }}
          >
            停止运行
          </button>
          <button
            onClick={onReject}
            style={{
              backgroundColor: "#d95757",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              padding: "6px 12px",
              cursor: "pointer",
            }}
          >
            拒绝
          </button>
          <button
            onClick={onApprove}
            style={{
              backgroundColor: "#7fd962",
              color: "#151922",
              fontWeight: "bold",
              border: "none",
              borderRadius: 4,
              padding: "6px 16px",
              cursor: "pointer",
            }}
          >
            允许一次
          </button>
        </div>
      </div>
    </div>
  );
};
