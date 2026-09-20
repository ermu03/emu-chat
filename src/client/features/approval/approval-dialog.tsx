import React from "react";
import { ShieldAlert, X } from "lucide-react";

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
    <div className="confirmation-backdrop" role="presentation">
      <div
        className="approval-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
      >
        <h3 id="approval-title" className="approval-title">
          <ShieldAlert size={18} />
          运行需要确认
        </h3>
        <p>Hermes 正在等待工具审批。你可以允许这一次、拒绝，或停止当前运行。</p>
        <p>
          <code>{runId}</code> · {reason}
        </p>
        {details && <pre>{JSON.stringify(details, null, 2)}</pre>}
        <div className="approval-actions">
          <button
            type="button"
            className="button-secondary"
            onClick={() => void onCancel()}
          >
            <X size={13} />
            停止运行
          </button>
          <button
            type="button"
            className="button-danger"
            onClick={() => void onReject()}
          >
            拒绝
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={() => void onApprove()}
          >
            允许一次
          </button>
        </div>
      </div>
    </div>
  );
};
