import React, { useState } from "react";
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
  mobileOpen?: boolean;
  onMobileClose?: () => void;
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
  mobileOpen = false,
  onMobileClose,
}) => {
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(
    null,
  );
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);

  const openDeleteConfirmation = (conversation: ConversationSummary) => {
    setDeleteConfirmed(false);
    setDeleteTarget(conversation);
  };

  const closeDeleteConfirmation = () => {
    setDeleteConfirmed(false);
    setDeleteTarget(null);
  };

  // Exact ID / Title filter
  const filtered = conversations.filter((c) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.trim().toLowerCase();
    return (
      c.hermes_session_id.toLowerCase() === q ||
      c.title.toLowerCase().includes(q)
    );
  });

  const pinned = filtered.filter((c) => c.pinned);
  const unpinned = filtered.filter((c) => !c.pinned);

  return (
    <aside
      className={`conversation-sidebar w-80 h-full flex flex-col border-r border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 select-none ${
        mobileOpen ? "is-mobile-open" : ""
      }`}
      style={style}
    >
      {/* Search and New */}
      <div className="p-3 border-b border-neutral-200 dark:border-neutral-800 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
            会话列表
          </span>
          <button
            onClick={onCreate}
            disabled={loading}
            className="px-2.5 py-1 text-xs font-medium bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 rounded hover:opacity-90 transition-opacity"
          >
            + 新建会话
          </button>
        </div>
        <div>
          <input
            type="text"
            placeholder="精确搜索会话 ID 或标题..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full px-2.5 py-1.5 text-xs bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400"
          />
        </div>
      </div>

      {/* List content */}
      <div className="flex-1 overflow-y-auto divide-y divide-neutral-100 dark:divide-neutral-800/50">
        {loading && conversations.length === 0 ? (
          <div className="p-6 text-center text-xs text-neutral-400">
            加载会话中...
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-center text-xs text-neutral-400">
            暂无匹配的会话
          </div>
        ) : (
          <>
            {pinned.length > 0 && (
              <div>
                <div className="px-3 py-1 text-[11px] font-semibold text-neutral-400 tracking-wider uppercase bg-neutral-50 dark:bg-neutral-900/50">
                  置顶
                </div>
                {pinned.map((item) => (
                  <ConversationItemRow
                    key={item.conversation_id}
                    item={item}
                    isActive={item.conversation_id === activeConversationId}
                    onSelect={() => {
                      onSelect(item.conversation_id);
                      onMobileClose?.();
                    }}
                    onFork={() => onFork(item.conversation_id)}
                    onDelete={() => openDeleteConfirmation(item)}
                    onTogglePin={() =>
                      onUpdateMetadata(
                        item.conversation_id,
                        item.title,
                        !item.pinned,
                      )
                    }
                  />
                ))}
              </div>
            )}

            <div>
              {pinned.length > 0 && unpinned.length > 0 && (
                <div className="px-3 py-1 text-[11px] font-semibold text-neutral-400 tracking-wider uppercase bg-neutral-50 dark:bg-neutral-900/50">
                  常规
                </div>
              )}
              {unpinned.map((item) => (
                <ConversationItemRow
                  key={item.conversation_id}
                  item={item}
                  isActive={item.conversation_id === activeConversationId}
                  onSelect={() => {
                    onSelect(item.conversation_id);
                    onMobileClose?.();
                  }}
                  onFork={() => onFork(item.conversation_id)}
                  onDelete={() => openDeleteConfirmation(item)}
                  onTogglePin={() =>
                    onUpdateMetadata(
                      item.conversation_id,
                      item.title,
                      !item.pinned,
                    )
                  }
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-conversation-heading"
            className="bg-white dark:bg-neutral-800 rounded-lg max-w-lg w-full p-5 shadow-xl border border-neutral-200 dark:border-neutral-700"
          >
            <h3
              id="delete-conversation-heading"
              className="text-sm font-semibold text-neutral-900 dark:text-neutral-100"
            >
              删除当前 Hermes 会话段
            </h3>
            <dl className="mt-3 space-y-2 text-xs text-neutral-600 dark:text-neutral-300">
              <div>
                <dt className="font-medium text-neutral-800 dark:text-neutral-100">
                  目标 Hermes session ID
                </dt>
                <dd>
                  <code className="font-mono text-rose-600 dark:text-rose-400 break-all">
                    {deleteTarget.hermes_session_id}
                  </code>
                </dd>
              </div>
              <div>
                <dt className="font-medium text-neutral-800 dark:text-neutral-100">
                  会话标题（仅用于辅助确认）
                </dt>
                <dd>{deleteTarget.title || "未命名会话"}</dd>
              </div>
            </dl>
            <ul className="mt-4 space-y-2 text-xs text-neutral-600 dark:text-neutral-300 list-disc pl-4">
              <li>目标段及 Hermes 定义的 delegate children 将被删除。</li>
              <li>
                branch/compression children 不会级联删除，可能成为 orphan。
              </li>
              <li>
                长期记忆、附件、artifact、工具生成文件和日志不会随之删除。
              </li>
              <li>Hermes 不提供原子 lineage/subtree 删除范围。</li>
            </ul>
            <label className="mt-4 flex items-start gap-2 text-xs text-neutral-800 dark:text-neutral-100 cursor-pointer">
              <input
                type="checkbox"
                checked={deleteConfirmed}
                onChange={(event) => setDeleteConfirmed(event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-rose-600"
              />
              <span>我已了解以上影响，并确认此操作不可逆。</span>
            </label>
            <div className="mt-4 flex items-center justify-end space-x-2">
              <button
                onClick={closeDeleteConfirmation}
                className="px-3 py-1.5 text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => {
                  onDelete(
                    deleteTarget.conversation_id,
                    deleteTarget.hermes_session_id,
                    deleteConfirmed,
                  );
                  closeDeleteConfirmation();
                }}
                disabled={!deleteConfirmed}
                className="px-3 py-1.5 text-xs font-medium bg-rose-600 hover:bg-rose-700 text-white rounded transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                删除当前 Hermes 会话段
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};

interface ConversationItemRowProps {
  item: ConversationSummary;
  isActive: boolean;
  onSelect: () => void;
  onFork: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}

const ConversationItemRow: React.FC<ConversationItemRowProps> = ({
  item,
  isActive,
  onSelect,
  onFork,
  onDelete,
  onTogglePin,
}) => {
  return (
    <div
      onClick={onSelect}
      className={`group px-3 py-2.5 cursor-pointer flex flex-col gap-1 border-l-2 transition-colors ${
        isActive
          ? "bg-neutral-100 dark:bg-neutral-800/80 border-neutral-900 dark:border-neutral-100"
          : "border-transparent hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-xs text-neutral-900 dark:text-neutral-100 truncate flex-1">
          {item.title || "未命名会话"}
        </span>
        <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            title={item.pinned ? "取消置顶" : "置顶"}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            className="p-1 text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            {item.pinned ? "★" : "☆"}
          </button>
          <button
            title="分叉会话 (Fork)"
            onClick={(e) => {
              e.stopPropagation();
              onFork();
            }}
            className="p-1 text-[11px] text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            ⌥
          </button>
          <button
            title="删除当前 Hermes 会话段"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="p-1 text-[11px] text-neutral-400 hover:text-rose-500"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px] text-neutral-400">
        <span className="font-mono truncate max-w-[140px]">
          {item.hermes_session_id.slice(0, 16)}...
        </span>
        {typeof item.message_count === "number" && (
          <span>{item.message_count} 条消息</span>
        )}
      </div>

      {item.preview && (
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
          {item.preview}
        </p>
      )}
    </div>
  );
};
