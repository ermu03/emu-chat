import React, { useEffect, useState } from 'react';
import { apiClient } from './api/client.js';
import type { ConnectionStatusResponse } from '../shared/api-schemas.js';

export function AppShell({ children }: { children?: React.ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatusResponse | null>(null);
  const [isLanHttp, setIsLanHttp] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(320);

  useEffect(() => {
    // Check if running on non-localhost HTTP
    const isLocalhost =
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname === '::1';
    const isHttp = window.location.protocol === 'http:';
    if (isHttp && !isLocalhost) {
      setIsLanHttp(true);
    }

    // Fetch initial status
    apiClient
      .getStatus()
      .then((s) => setStatus(s))
      .catch(() => {
        setStatus({
          status: 'unavailable',
          hermes_version: null,
          missing_capabilities: [],
          last_checked_at: new Date().toISOString(),
          suggested_action: 'Check server logs and upstream Hermes Agent availability',
          lan_http_warning: isHttp && !isLocalhost,
          pwa_secure_context_required: isHttp && !isLocalhost
        });
      });
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden'
      }}
    >
      {/* LAN HTTP Warning Banner */}
      {isLanHttp && (
        <div
          role="alert"
          style={{
            backgroundColor: 'var(--warning-bg)',
            color: 'var(--warning-text)',
            padding: '8px 16px',
            fontSize: '13px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid rgba(0, 0, 0, 0.1)',
            zIndex: 100
          }}
        >
          <span>
            当前正在通过局域网非安全 HTTP 访问（{window.location.hostname}）。PWA
            安装、离线能力和某些高级安全 API
            要求安全上下文（HTTPS/localhost）。基本工作台功能仍可正常使用。
          </span>
          <button
            onClick={() => setIsLanHttp(false)}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 'bold',
              padding: '2px 8px'
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Top Header */}
      <header
        style={{
          height: '48px',
          borderBottom: '1px solid var(--border-color)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px',
          backgroundColor: 'var(--bg-secondary)',
          flexShrink: 0
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <strong style={{ fontSize: '16px' }}>emu-chat</strong>
          <span
            style={{
              fontSize: '12px',
              padding: '2px 8px',
              borderRadius: '12px',
              backgroundColor:
                status?.status === 'healthy'
                  ? 'rgba(34, 197, 94, 0.15)'
                  : 'rgba(234, 179, 8, 0.15)',
              color:
                status?.status === 'healthy'
                  ? '#16a34a'
                  : status?.status === 'checking'
                    ? '#ca8a04'
                    : '#dc2626'
            }}
          >
            Hermes: {status?.status || 'checking'}
          </span>
        </div>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
          {status?.hermes_version ? `v${status.hermes_version}` : ''}
        </div>
      </header>

      {/* Main Workspace Layout */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left Sidebar Skeleton */}
        <aside
          style={{
            width: `${sidebarWidth}px`,
            borderRight: '1px solid var(--border-color)',
            backgroundColor: 'var(--bg-secondary)',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
            overflowY: 'auto'
          }}
        >
          <div
            style={{
              padding: '12px',
              borderBottom: '1px solid var(--border-color)',
              display: 'flex',
              gap: '8px'
            }}
          >
            <button
              style={{
                flex: 1,
                padding: '8px 12px',
                borderRadius: '6px',
                border: 'none',
                backgroundColor: 'var(--accent-color)',
                color: '#fff',
                cursor: 'pointer',
                fontWeight: 500
              }}
            >
              新建会话
            </button>
          </div>
          <div style={{ padding: '16px', color: 'var(--text-secondary)', fontSize: '13px' }}>
            会话列表加载中...
          </div>
        </aside>

        {/* Content Area */}
        <main
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: 'var(--bg-primary)',
            overflow: 'hidden'
          }}
        >
          {children || (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)'
              }}
            >
              选择或新建一个会话开始使用 emu-chat
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
