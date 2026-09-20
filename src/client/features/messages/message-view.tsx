import React, { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  Bot,
  ChevronDown,
  LoaderCircle,
  RefreshCw,
  Square,
  Terminal,
  UserRound,
  Wrench,
} from "lucide-react";
import type { MessageItem } from "../../../shared/api-schemas.js";
import {
  getRenderableMessages,
  getToolResultContent,
} from "./message-display.js";

export interface MessageViewProps {
  messages: MessageItem[];
  loading: boolean;
  pendingUserMessage?: PendingUserMessage | null;
  isGenerating?: boolean;
  streamingContent?: string;
  onStopGenerating?: (() => void) | undefined;
  onReconcile?: (() => void) | undefined;
}

export interface PendingUserMessage {
  id: string;
  content: string;
}

export const MessageView: React.FC<MessageViewProps> = ({
  messages,
  loading,
  pendingUserMessage = null,
  isGenerating = false,
  streamingContent = "",
  onStopGenerating,
  onReconcile,
}) => {
  const renderableMessages = getRenderableMessages(messages);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !stickToBottomRef.current) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [
    isGenerating,
    pendingUserMessage?.id,
    renderableMessages.length,
    streamingContent,
  ]);

  if (
    loading &&
    renderableMessages.length === 0 &&
    !pendingUserMessage &&
    !isGenerating
  ) {
    return (
      <div className="message-scroll">
        <div className="message-empty">正在加载会话历史</div>
      </div>
    );
  }

  if (renderableMessages.length === 0 && !pendingUserMessage && !isGenerating) {
    return (
      <div className="message-scroll">
        <div className="message-empty">
          <div className="empty-greeting">
            <div className="empty-greeting-mark" aria-hidden="true">
              e
            </div>
            <h2>准备好开始工作</h2>
            <p>发送一条消息，Hermes 会在当前会话中继续处理。</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="message-scroll"
      aria-label="聊天消息"
      onScroll={(event) => {
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
        stickToBottomRef.current = scrollHeight - scrollTop - clientHeight < 80;
      }}
    >
      <div className="message-list" role="log" aria-live="polite">
        {renderableMessages.map((message) => (
          <MessageRow key={message.id} message={message} />
        ))}
        {pendingUserMessage && <PendingUserRow message={pendingUserMessage} />}
        {isGenerating && (
          <LiveAssistantRow
            content={streamingContent}
            onStopGenerating={onStopGenerating}
            onReconcile={onReconcile}
          />
        )}
      </div>
    </div>
  );
};

function MessageRow({ message }: { message: MessageItem }) {
  const role = message.role;
  const isUser = role === "user";
  const isTool = role === "tool";
  const isSystem = role === "system";
  const label = isUser ? "你" : isTool ? "工具" : isSystem ? "系统" : "Hermes";

  return (
    <article className={`message-row ${role}`}>
      <div className="message-avatar" aria-hidden="true">
        {isUser ? (
          <UserRound size={14} strokeWidth={1.8} />
        ) : isTool ? (
          <Wrench size={14} strokeWidth={1.8} />
        ) : isSystem ? (
          <Terminal size={14} strokeWidth={1.8} />
        ) : (
          <Bot size={14} strokeWidth={1.8} />
        )}
      </div>
      <div className="message-content-wrap">
        <div className="message-meta">
          <span className="message-role">{label}</span>
          <span className="message-timestamp">
            {formatTimestamp(message.timestamp)}
          </span>
        </div>

        {message.tool_name && (
          <ToolCallSummary
            name={message.tool_name}
            content={message.content}
            isResult={isTool}
          />
        )}

        {message.reasoning && (
          <details className="tool-call-card">
            <summary className="tool-call-summary">
              <ChevronDown size={14} strokeWidth={1.8} />
              <strong>思考过程</strong>
            </summary>
            <div className="tool-call-details">
              <div className="message-body">
                <MarkdownContent text={message.reasoning} />
              </div>
            </div>
          </details>
        )}

        {message.content && !message.tool_name && (
          <div className="message-body">
            <MarkdownContent text={message.content} />
          </div>
        )}
      </div>
    </article>
  );
}

function PendingUserRow({ message }: { message: PendingUserMessage }) {
  return (
    <article
      className="message-row user message-pending"
      data-message-id={message.id}
    >
      <div className="message-avatar" aria-hidden="true">
        <UserRound size={14} strokeWidth={1.8} />
      </div>
      <div className="message-content-wrap">
        <div className="message-meta">
          <span className="message-role">你</span>
        </div>
        <div className="message-body">{message.content}</div>
      </div>
    </article>
  );
}

function LiveAssistantRow({
  content,
  onStopGenerating,
  onReconcile,
}: {
  content: string;
  onStopGenerating?: (() => void) | undefined;
  onReconcile?: (() => void) | undefined;
}) {
  return (
    <article className="message-row assistant assistant-live" role="status">
      <div className="message-avatar" aria-hidden="true">
        <Bot size={14} strokeWidth={1.8} />
      </div>
      <div className="message-content-wrap">
        <div className="message-meta assistant-live-meta">
          <span className="message-role">Hermes</span>
          {(onStopGenerating || onReconcile) && (
            <div className="assistant-live-actions">
              {onReconcile && (
                <button
                  type="button"
                  className="assistant-live-action"
                  onClick={onReconcile}
                  aria-label="重新核对运行状态"
                  title="重新核对运行状态"
                >
                  <RefreshCw size={13} strokeWidth={1.8} />
                </button>
              )}
              {onStopGenerating && (
                <button
                  type="button"
                  className="assistant-live-action danger"
                  onClick={onStopGenerating}
                  aria-label="停止生成"
                  title="停止生成"
                >
                  <Square size={11} fill="currentColor" />
                </button>
              )}
            </div>
          )}
        </div>
        {content ? (
          <div className="message-body is-streaming">
            <MarkdownContent text={content} />
          </div>
        ) : (
          <div className="assistant-thinking" aria-label="Hermes 正在生成">
            <LoaderCircle size={16} strokeWidth={1.9} />
            <span className="assistant-stream-cursor" aria-hidden="true" />
          </div>
        )}
      </div>
    </article>
  );
}

function ToolCallSummary({
  name,
  content,
  isResult,
}: {
  name: string;
  content: string;
  isResult: boolean;
}) {
  return (
    <details className="tool-call-card">
      <summary className="tool-call-summary">
        <Terminal size={14} strokeWidth={1.8} />
        <strong>{name}</strong>
        <span className="tool-call-status">
          {isResult ? "已完成" : "已调用"}
        </span>
        <ChevronDown size={14} strokeWidth={1.8} />
      </summary>
      <div className="tool-call-details">
        <pre>{getToolResultContent(content)}</pre>
      </div>
    </details>
  );
}

function MarkdownContent({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeHighlight, rehypeKatex]}
      components={{
        pre({ children }) {
          return <div className="message-code">{children}</div>;
        },
        code({ className, children }) {
          const language = className?.match(/language-([\w-]+)/)?.[1] ?? "";
          return (
            <>
              {language && <div className="message-code-label">{language}</div>}
              <pre>
                <code className={className}>{children}</code>
              </pre>
            </>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function formatTimestamp(timestamp: number): string {
  const milliseconds =
    timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
