import React from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Bot, ChevronDown, Terminal, UserRound, Wrench } from "lucide-react";
import type { MessageItem } from "../../../shared/api-schemas.js";

export interface MessageViewProps {
  messages: MessageItem[];
  loading: boolean;
}

export const MessageView: React.FC<MessageViewProps> = ({
  messages,
  loading,
}) => {
  if (loading && messages.length === 0) {
    return (
      <div className="message-scroll">
        <div className="message-empty">正在加载会话历史</div>
      </div>
    );
  }

  if (messages.length === 0) {
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
    <div className="message-scroll" aria-label="聊天消息">
      <div className="message-list" role="log" aria-live="polite">
        {messages.map((message) => (
          <MessageRow key={message.id} message={message} />
        ))}
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
          <span>{formatTimestamp(message.timestamp)}</span>
          {message.finish_reason && <span>· {message.finish_reason}</span>}
        </div>

        {message.tool_name && (
          <ToolCallSummary
            name={message.tool_name}
            callId={message.tool_call_id}
            content={message.content}
          />
        )}

        {message.reasoning && (
          <details className="tool-call-card">
            <summary className="tool-call-summary">
              <ChevronDown size={14} strokeWidth={1.8} />
              <strong>运行思路</strong>
              <span className="tool-call-status">点击展开</span>
            </summary>
            <div className="tool-call-details">
              <div className="tool-call-details-label">Reasoning</div>
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

function ToolCallSummary({
  name,
  callId,
  content,
}: {
  name: string;
  callId: string | null;
  content: string;
}) {
  return (
    <details className="tool-call-card">
      <summary className="tool-call-summary">
        <Terminal size={14} strokeWidth={1.8} />
        <strong>{name}</strong>
        <span className="tool-call-status">
          {callId ? "工具调用" : "工具结果"}
        </span>
        <ChevronDown size={14} strokeWidth={1.8} />
      </summary>
      <div className="tool-call-details">
        {callId && (
          <div className="tool-call-details-label">Call ID: {callId}</div>
        )}
        <pre>{content || "没有返回内容"}</pre>
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
