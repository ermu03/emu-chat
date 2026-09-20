import React from "react";
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
  const getStatusColor = (s: string | undefined) => {
    switch (s) {
      case "healthy":
        return "bg-emerald-500";
      case "degraded":
        return "bg-amber-500";
      case "incompatible":
      case "auth_failed":
      case "unavailable":
        return "bg-rose-500";
      default:
        return "bg-neutral-400";
    }
  };

  const getStatusLabel = (s: string | undefined) => {
    switch (s) {
      case "healthy":
        return "Hermes 在线";
      case "incompatible":
        return "Hermes 契约不兼容";
      case "auth_failed":
        return "Hermes 认证失败";
      case "unavailable":
        return "Hermes 离线 / 无法连接";
      case "config_error":
        return "Hermes 服务器配置错误";
      case "degraded":
        return "Hermes 能力受限";
      case "checking":
        return "正在检查 Hermes...";
      default:
        return "检查连接中...";
    }
  };

  return (
    <div className="flex flex-col border-b border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900 text-xs">
      {status?.lan_http_warning && (
        <div
          role="alert"
          className="px-4 py-1.5 bg-amber-500/10 border-b border-amber-500/20 text-amber-700 dark:text-amber-400 font-medium flex items-center justify-between"
        >
          <span>
            当前处于局域网非安全 HTTP 环境，PWA
            离线存储与后台通知已受限。建议配置 HTTPS 反向代理。
          </span>
          <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 bg-amber-500/20 rounded">
            Insecure Context
          </span>
        </div>
      )}

      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-1.5">
            <span
              className={`w-2.5 h-2.5 rounded-full ${getStatusColor(
                status?.status,
              )} inline-block animate-pulse`}
            />
            <span className="font-semibold text-neutral-800 dark:text-neutral-200">
              {getStatusLabel(status?.status)}
            </span>
          </div>

          {status?.hermes_version && (
            <span className="text-neutral-500 dark:text-neutral-400 font-mono">
              v{status.hermes_version}
            </span>
          )}

          {status && status.missing_capabilities.length > 0 && (
            <div className="hidden sm:flex items-center space-x-1">
              <span className="px-1.5 py-0.5 bg-neutral-200 dark:bg-neutral-800 rounded text-[10px] text-neutral-600 dark:text-neutral-400">
                缺少能力: {status.missing_capabilities.length}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={onRecheck}
            disabled={loading}
            className="px-2 py-1 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 disabled:opacity-50 transition-colors"
          >
            {loading ? "检测中..." : "重新检测"}
          </button>
        </div>
      </div>
    </div>
  );
};
