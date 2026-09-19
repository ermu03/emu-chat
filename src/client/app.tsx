import React, { useEffect, useState, useCallback } from 'react';
import { apiClient } from './api/client.js';
import type {
  ConnectionStatusResponse,
  ConversationSummary,
  ConversationDetailResponse
} from '../shared/api-schemas.js';
import type { HermesMessage } from '../shared/hermes-schemas.js';
import { StatusBar } from './features/status/status-bar.js';
import { ConversationList } from './features/conversations/conversation-list.js';
import { CurrentSegmentBanner } from './features/messages/current-segment-banner.js';
import { MessageView } from './features/messages/message-view.js';

export function AppShell() {
  const [status, setStatus] = useState<ConnectionStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeConversation, setActiveConversation] = useState<ConversationDetailResponse | null>(
    null
  );
  const [messages, setMessages] = useState<HermesMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Load status
  const loadStatus = useCallback(async (recheck = false) => {
    setStatusLoading(true);
    try {
      const data = recheck
        ? await apiClient.recheckStatus()
        : await apiClient.getStatus();
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  // Load conversations
  const loadConversations = useCallback(async () => {
    setConversationsLoading(true);
    try {
      const res = await apiClient.listConversations({ limit: 50 });
      setConversations(res.items);
      if (!activeConversationId && res.items.length > 0 && res.items[0]) {
        setActiveConversationId(res.items[0].id);
      }
    } catch (err) {
      console.error('Failed to load conversations', err);
    } finally {
      setConversationsLoading(false);
    }
  }, [activeConversationId]);

  // Load active conversation detail and messages
  const loadActiveConversation = useCallback(async (convId: string) => {
    setMessagesLoading(true);
    try {
      const [conv, msgRes] = await Promise.all([
        apiClient.getConversation(convId),
        apiClient.getMessages(convId, { limit: 100, order: 'oldest' })
      ]);
      setActiveConversation(conv);
      setMessages(msgRes.messages);
    } catch (err) {
      console.error('Failed to load active conversation messages', err);
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    loadConversations();
  }, [loadStatus, loadConversations]);

  useEffect(() => {
    if (activeConversationId) {
      loadActiveConversation(activeConversationId);
    } else {
      setActiveConversation(null);
      setMessages([]);
    }
  }, [activeConversationId, loadActiveConversation]);

  // Handle Create Conversation
  const handleCreateConversation = async () => {
    const title = window.prompt('请输入新会话标题（可选）：', '新会话');
    if (title === null) return;
    try {
      const created = await apiClient.createConversation({ title: title.trim() || undefined });
      await loadConversations();
      setActiveConversationId(created.id);
    } catch (err) {
      alert(`创建会话失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Handle Fork
  const handleFork = async (id: string) => {
    try {
      const forked = await apiClient.forkConversation(id);
      await loadConversations();
      setActiveConversationId(forked.id);
    } catch (err) {
      alert(`分叉会话失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Handle Delete
  const handleDelete = async (id: string, hermesSessionId: string) => {
    try {
      await apiClient.deleteConversation(id, { expected_hermes_session_id: hermesSessionId });
      if (activeConversationId === id) {
        setActiveConversationId(null);
      }
      await loadConversations();
    } catch (err) {
      alert(`删除会话失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Handle Update Hermes Title/Pin
  const handleUpdateMetadata = async (id: string, title: string, pinned: boolean) => {
    try {
      await apiClient.patchHermesMetadata(id, { title, pinned });
      await loadConversations();
      if (activeConversationId === id && activeConversation) {
        setActiveConversation({ ...activeConversation, title, pinned });
      }
    } catch (err) {
      alert(`更新会话失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-neutral-100 dark:bg-neutral-950 font-sans">
      {/* Top Status & Health Bar */}
      <StatusBar
        status={status}
        loading={statusLoading}
        onRecheck={() => loadStatus(true)}
      />

      {/* Main Workspace Layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Conversation List */}
        <ConversationList
          conversations={conversations}
          activeConversationId={activeConversationId}
          onSelect={(id) => setActiveConversationId(id)}
          onCreate={handleCreateConversation}
          onFork={handleFork}
          onDelete={handleDelete}
          onUpdateMetadata={handleUpdateMetadata}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          loading={conversationsLoading}
        />

        {/* Center: Message Stream & Current Segment */}
        <main className="flex-1 flex flex-col h-full overflow-hidden bg-white dark:bg-neutral-900">
          {activeConversation ? (
            <>
              {/* Current Segment Info Banner */}
              <CurrentSegmentBanner conversation={activeConversation} />

              {/* Message Scroll View */}
              <MessageView messages={messages} loading={messagesLoading} />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-neutral-400 text-xs">
              请从左侧选择或新建一个会话
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
