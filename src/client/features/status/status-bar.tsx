import React from "react";
import { RefreshCw, ShieldAlert } from "lucide-react";
import type { ConnectionStatusResponse } from "../../../shared/api-schemas.js";

export interface StatusBarProps {
  status: ConnectionStatusResponse | null;
  loading: boolean;
  onRecheck: () => void;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  status,
  loading,
  onRecheck,
}) => {
  const needsAttention =
    status && status.status !== "healthy" && status.status !== "checking";
  const hasWarning = status?.lan_http_warning || needsAttention;
  if (!hasWarning) return null;

  return (
    <div
      className={`status-strip ${needsAttention ? "workspace-alert error" : ""}`}
      role="status"
    >
      <ShieldAlert size={14} strokeWidth={1.8} />
      <span>{getStatusLabel(status?.status, status?.suggested_action)}</span>
      {status?.hermes_version && <span>v{status.hermes_version}</span>}
      {status?.missing_capabilities.length ? (
        <span>缺少 {status.missing_capabilities.length} 项能力</span>
      ) : null}
      <button type="button" onClick={onRecheck} disabled={loading}>
        <RefreshCw size={12} className={loading ? "spin" : ""} />
        {loading ? "检测中" : "重新检测"}
      </button>
    </div>
  );
};

export function getStatusLabel(status?: string, action?: string): string {
  switch (status) {
    case "healthy":
      return "Hermes 在线";
    case "degraded":
      return action || "Hermes 能力受限";
    case "incompatible":
      return "Hermes 契约不兼容";
    case "auth_failed":
      return "Hermes 认证失败";
    case "unavailable":
      return "Hermes 无法连接";
    case "config_error":
      return "Hermes 配置错误";
    case "checking":
      return "正在检查 Hermes";
    default:
      return "Hermes 状态未知";
  }
}
