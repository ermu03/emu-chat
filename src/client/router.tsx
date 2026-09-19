import React from 'react';
import { BrowserRouter, Routes, Route, useParams } from 'react-router-dom';
import { AppShell } from './app.js';

function ConversationView() {
  const { conversationId } = useParams<{ conversationId: string }>();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border-color)',
          fontWeight: 500
        }}
      >
        会话: {conversationId}
      </div>
      <div
        style={{
          flex: 1,
          padding: '16px',
          overflowY: 'auto',
          color: 'var(--text-secondary)'
        }}
      >
        消息加载中...
      </div>
      <div
        style={{
          borderTop: '1px solid var(--border-color)',
          padding: '12px 16px',
          display: 'flex',
          gap: '8px'
        }}
      >
        <textarea
          placeholder="输入给 Hermes Agent 的消息..."
          rows={3}
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: '6px',
            border: '1px solid var(--border-color)',
            resize: 'none',
            fontFamily: 'inherit',
            fontSize: '14px',
            backgroundColor: 'var(--bg-primary)',
            color: 'var(--text-primary)'
          }}
        />
        <button
          style={{
            alignSelf: 'flex-end',
            padding: '8px 16px',
            borderRadius: '6px',
            border: 'none',
            backgroundColor: 'var(--accent-color)',
            color: '#fff',
            cursor: 'pointer',
            fontWeight: 500
          }}
        >
          发送
        </button>
      </div>
    </div>
  );
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <AppShell>
        <Routes>
          <Route
            path="/"
            element={
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
            }
          />
          <Route path="/c/:conversationId" element={<ConversationView />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}
