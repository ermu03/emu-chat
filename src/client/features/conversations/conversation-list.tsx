import React, { useMemo, useState } from "react";
import {
  Copy,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Search,
  Trash2,
} from "lucide-react";
import type { ConversationSummary } from "../../../shared/api-schemas.js";

export interface ConversationListProps {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onFork: (id: string) => void;
  onDelete: (id: string, hermesSessionId: string, confirmed: boolean) => void;
  onUpdateMetadata: (id: string, title: string, pinned: boolean) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  loading: boolean;
  style?: React.CSSProperties;
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  status?: string | undefined;
}

export const ConversationList: React.FC<ConversationListProps> = ({
  conversations,
  activeConversationId,
  onSelect,
  onCreate,
  onFork,
  onDelete,
  onUpdateMetadata,
  searchQuery,
  onSearchChange,
  loading,
  style,
  collapsed,
  onToggleCollapse,
  mobileOpen = false,
  onMobileClose,
  status,
}) => {
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(
    null,
  );
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return conversations;
    return conversations.filter(
      (conversation) =>
        conversation.title.toLowerCase().includes(query) ||
        conversation.hermes_session_id.toLowerCase().includes(query) ||
        conversation.preview.toLowerCase().includes(query),
    );
  }, [conversations, searchQuery]);

  const pinned = filtered.filter((conversation) => conversation.pinned);
  const recent = filtered.filter((conversation) => !conversation.pinned);

  const select = (id: string) => {
    onSelect(id);
    onMobileClose?.();
  };

  const openDelete = (conversation: ConversationSummary) => {
    setDeleteTarget(conversation);
    setDeleteConfirmed(false);
  };

  return (
    <aside
      className={`conversation-sidebar ${collapsed ? "is-collapsed" : ""} ${mobileOpen ? "is-mobile-open" : ""}`}
      style={style}
      aria-label="会话列表"
    >
      <div className="sidebar-header">
        <div className="brand-row">
          <span className="brand-mark" aria-hidden="true">
            e
          </span>
          <span className="brand-name">emu-chat</span>
          <button
            type="button"
            className="icon-button sidebar-collapse-button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}
            title={collapsed ? "展开侧栏" : "折叠侧栏"}
          >
            {collapsed ? (
              <PanelLeftOpen size={16} strokeWidth={1.8} />
            ) : (
              <PanelLeftClose size={16} strokeWidth={1.8} />
            )}
          </button>
        </div>

        <div className="sidebar-actions">
          <button
            type="button"
            className="new-conversation-button"
            onClick={onCreate}
            disabled={loading}
          >
            <MessageSquarePlus size={16} strokeWidth={1.9} />
            <span>新建会话</span>
          </button>
        </div>

        <label className="search-field">
          <Search size={15} strokeWidth={1.8} aria-hidden="true" />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
          />
        </label>
      </div>

      <div className="conversation-list-scroll">
        {loading && conversations.length === 0 ? (
          <div className="sidebar-loading">正在加载会话</div>
        ) : filtered.length === 0 ? (
          <div className="sidebar-empty">
            {searchQuery.trim() ? "没有匹配的会话" : "还没有会话"}
          </div>
        ) : (
          <>
            {pinned.length > 0 && (
              <ConversationSection
                label="置顶"
                conversations={pinned}
                activeConversationId={activeConversationId}
                onSelect={select}
                onFork={onFork}
                onDelete={openDelete}
                onTogglePin={(conversation) =>
                  onUpdateMetadata(
                    conversation.conversation_id,
                    conversation.title,
                    false,
                  )
                }
              />
            )}
            {recent.length > 0 && (
              <ConversationSection
                label={pinned.length > 0 ? "最近" : undefined}
                conversations={recent}
                activeConversationId={activeConversationId}
                onSelect={select}
                onFork={onFork}
                onDelete={openDelete}
                onTogglePin={(conversation) =>
                  onUpdateMetadata(
                    conversation.conversation_id,
                    conversation.title,
                    true,
                  )
                }
              />
            )}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <span
          className={`status-dot ${status === "healthy" ? "healthy" : status === "degraded" ? "degraded" : status ? "error" : ""}`}
          aria-hidden="true"
        />
        <span>{getStatusLabel(status)}</span>
        <span className="sidebar-footer-provider">Hermes</span>
      </div>

      {deleteTarget && (
        <div
          className="confirmation-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setDeleteTarget(null);
          }}
        >
          <div
            className="confirmation-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-conversation-title"
          >
            <h3 id="delete-conversation-title">删除这个会话？</h3>
            <p>
              这会删除当前会话段以及 Hermes 中对应的会话记录。这个操作不可撤销。
            </p>
            <dl>
              <dt>会话</dt>
              <dd>{deleteTarget.title || "未命名会话"}</dd>
              <dt>Hermes session</dt>
              <dd>
                <code>{deleteTarget.hermes_session_id}</code>
              </dd>
            </dl>
            <label className="delete-confirmation-label">
              <input
                type="checkbox"
                checked={deleteConfirmed}
                onChange={(event) => setDeleteConfirmed(event.target.checked)}
              />
              <span>我确认删除这个会话及其 Hermes 记录。</span>
            </label>
            <div className="confirmation-actions">
              <button
                type="button"
                className="button-secondary"
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="button-danger"
                disabled={!deleteConfirmed}
                onClick={() => {
                  onDelete(
                    deleteTarget.conversation_id,
                    deleteTarget.hermes_session_id,
                    true,
                  );
                  setDeleteTarget(null);
                }}
              >
                删除会话
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};

function ConversationSection({
  label,
  conversations,
  activeConversationId,
  onSelect,
  onFork,
  onDelete,
  onTogglePin,
}: {
  label?: string | undefined;
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  onSelect: (id: string) => void;
  onFork: (id: string) => void;
  onDelete: (conversation: ConversationSummary) => void;
  onTogglePin: (conversation: ConversationSummary) => void;
}) {
  return (
    <section>
      {label && <div className="conversation-section-label">{label}</div>}
      {conversations.map((conversation) => (
        <ConversationRow
          key={conversation.conversation_id}
          conversation={conversation}
          active={conversation.conversation_id === activeConversationId}
          onSelect={onSelect}
          onFork={onFork}
          onDelete={onDelete}
          onTogglePin={onTogglePin}
        />
      ))}
    </section>
  );
}

function ConversationRow({
  conversation,
  active,
  onSelect,
  onFork,
  onDelete,
  onTogglePin,
}: {
  conversation: ConversationSummary;
  active: boolean;
  onSelect: (id: string) => void;
  onFork: (id: string) => void;
  onDelete: (conversation: ConversationSummary) => void;
  onTogglePin: (conversation: ConversationSummary) => void;
}) {
  return (
    <div
      className={`conversation-row ${active ? "active" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(conversation.conversation_id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(conversation.conversation_id);
        }
      }}
    >
      <div className="conversation-row-top">
        <span className="conversation-title">
          {conversation.title || "未命名会话"}
        </span>
        <div className="conversation-row-actions">
          <button
            type="button"
            aria-label={conversation.pinned ? "取消置顶" : "置顶会话"}
            title={conversation.pinned ? "取消置顶" : "置顶"}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePin(conversation);
            }}
          >
            {conversation.pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
          <button
            type="button"
            aria-label="分叉会话"
            title="分叉会话"
            onClick={(event) => {
              event.stopPropagation();
              onFork(conversation.conversation_id);
            }}
          >
            <Copy size={13} />
          </button>
          <button
            type="button"
            className="danger"
            aria-label="删除会话"
            title="删除会话"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(conversation);
            }}
          >
            <Trash2 size={13} />
          </button>
          <button
            type="button"
            aria-label="更多会话操作"
            title="更多操作"
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal size={13} />
          </button>
        </div>
      </div>
      <div className="conversation-row-meta">
        <span>{formatRelativeDate(conversation.last_active)}</span>
        {conversation.message_count > 0 && (
          <span>{conversation.message_count} 条消息</span>
        )}
        {conversation.queue_size > 0 && (
          <span>{conversation.queue_size} 排队</span>
        )}
      </div>
      {conversation.preview && (
        <div className="conversation-preview">{conversation.preview}</div>
      )}
    </div>
  );
}

function formatRelativeDate(value: number): string {
  const timestamp = value > 1_000_000_000_000 ? value : value * 1000;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return date.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

function getStatusLabel(status?: string): string {
  switch (status) {
    case "healthy":
      return "Hermes 在线";
    case "degraded":
      return "Hermes 能力受限";
    case "unavailable":
      return "Hermes 离线";
    case "auth_failed":
      return "Hermes 认证失败";
    case "incompatible":
      return "Hermes 契约不兼容";
    default:
      return "正在检查 Hermes";
  }
}
