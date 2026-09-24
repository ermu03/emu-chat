import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  Square,
  Terminal,
  UserRound,
} from "lucide-react";
import type { MessageItem } from "../../../shared/api-schemas.js";
import {
  type AssistantTurn,
  type ToolCallItem,
  getToolResultContent,
  groupMessagesIntoTurns,
} from "./message-display.js";

export interface MessageViewProps {
  messages: MessageItem[];
  loading: boolean;
  hasMoreEarlier?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: (() => void) | undefined;
  pendingUserMessage?: PendingUserMessage | null;
  isGenerating?: boolean;
  streamingContent?: string;
  onStopGenerating?: (() => void) | undefined;
  onReconcile?: (() => void) | undefined;
  onSelectPrompt?: ((prompt: string) => void) | undefined;
}

export interface PendingUserMessage {
  id: string;
  content: string;
}

const PROMPT_STARTERS = [
  {
    icon: "🔍",
    title: "分析系统架构",
    prompt: "请帮我梳理当前系统的核心分层、模块职责与数据流向。",
  },
  {
    icon: "⚡",
    title: "代码性能优化",
    prompt: "请检查当前代码中的瓶颈或冗余，给出具体的重构与优化建议。",
  },
  {
    icon: "🧪",
    title: "编写高风险测试",
    prompt: "针对并发锁、竞态安全和边界错误情况，设计并编写单元测试。",
  },
  {
    icon: "✨",
    title: "新功能头脑风暴",
    prompt: "针对当前需求设计几个可行的实现方案，并分析各自的优缺点。",
  },
];

export const MessageView: React.FC<MessageViewProps> = ({
  messages,
  loading,
  hasMoreEarlier = false,
  loadingEarlier = false,
  onLoadEarlier,
  pendingUserMessage = null,
  isGenerating = false,
  streamingContent = "",
  onStopGenerating,
  onReconcile,
  onSelectPrompt,
}) => {
  const turns = useMemo(() => groupMessagesIntoTurns(messages), [messages]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const previousScrollHeightRef = useRef<number | null>(null);

  // Preserve scroll offset when earlier messages are loaded prepended to the top
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (previousScrollHeightRef.current !== null) {
      const heightDifference =
        scroller.scrollHeight - previousScrollHeightRef.current;
      if (heightDifference > 0) {
        scroller.scrollTop += heightDifference;
      }
      previousScrollHeightRef.current = null;
    }
  }, [messages.length]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !stickToBottomRef.current) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [isGenerating, pendingUserMessage?.id, streamingContent, turns.length]);

  const handleLoadEarlier = () => {
    if (scrollRef.current) {
      previousScrollHeightRef.current = scrollRef.current.scrollHeight;
    }
    onLoadEarlier?.();
  };

  if (loading && turns.length === 0 && !pendingUserMessage && !isGenerating) {
    return (
      <div className="message-scroll">
        <div className="message-empty">正在加载会话历史</div>
      </div>
    );
  }

  if (turns.length === 0 && !pendingUserMessage && !isGenerating) {
    return (
      <div className="message-scroll">
        <div className="message-empty">
          <div className="empty-greeting">
            <div className="empty-greeting-mark" aria-hidden="true">
              <Sparkles size={24} strokeWidth={2} />
            </div>
            <h2>准备好开始工作</h2>
            <p>发送一条消息或选择快捷建议，Hermes 会在当前会话中继续处理。</p>
            {onSelectPrompt && (
              <div className="prompt-starters-grid">
                {PROMPT_STARTERS.map((starter, index) => (
                  <button
                    key={index}
                    type="button"
                    className="prompt-starter-card"
                    onClick={() => onSelectPrompt(starter.prompt)}
                  >
                    <span className="prompt-starter-icon" aria-hidden="true">
                      {starter.icon}
                    </span>
                    <span className="prompt-starter-title">
                      {starter.title}
                    </span>
                    <span className="prompt-starter-desc">
                      {starter.prompt}
                    </span>
                  </button>
                ))}
              </div>
            )}
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
        {hasMoreEarlier && (
          <div className="message-load-earlier-wrap">
            <button
              type="button"
              className="message-load-earlier-btn"
              disabled={loadingEarlier}
              onClick={handleLoadEarlier}
            >
              {loadingEarlier ? (
                <>
                  <LoaderCircle size={14} className="spin" />
                  <span>正在加载更早历史消息...</span>
                </>
              ) : (
                <span>加载更早历史消息</span>
              )}
            </button>
          </div>
        )}
        {turns.map((turn) => {
          if (turn.kind === "user") {
            return <UserTurnRow key={turn.id} message={turn.message} />;
          }
          if (turn.kind === "system") {
            return <SystemTurnRow key={turn.id} message={turn.message} />;
          }
          return <AssistantTurnRow key={turn.id} turn={turn} />;
        })}
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

const UserTurnRow = memo(function UserTurnRow({
  message,
}: {
  message: MessageItem;
}) {
  return (
    <article className="message-row user">
      <div className="message-avatar" aria-hidden="true">
        <UserRound size={14} strokeWidth={1.8} />
      </div>
      <div className="message-content-wrap">
        <div className="message-meta">
          <span className="message-role">你</span>
          <span className="message-timestamp">
            {formatTimestamp(message.timestamp)}
          </span>
        </div>
        <div className="message-body">
          <MarkdownContent text={message.content} />
        </div>
      </div>
    </article>
  );
});

const SystemTurnRow = memo(function SystemTurnRow({
  message,
}: {
  message: MessageItem;
}) {
  return (
    <article className="message-row system">
      <div className="message-avatar" aria-hidden="true">
        <Terminal size={14} strokeWidth={1.8} />
      </div>
      <div className="message-content-wrap">
        <div className="message-meta">
          <span className="message-role">系统</span>
          <span className="message-timestamp">
            {formatTimestamp(message.timestamp)}
          </span>
        </div>
        <div className="message-body">
          <MarkdownContent text={message.content} />
        </div>
      </div>
    </article>
  );
});

const AssistantTurnRow = memo(function AssistantTurnRow({
  turn,
}: {
  turn: AssistantTurn;
}) {
  const hasTools = turn.tools.length > 0;
  const hasReasonings = turn.reasonings.length > 0;
  const anyToolFailed = turn.tools.some((t) => t.isError);
  const allToolsCompleted =
    hasTools && turn.tools.every((t) => t.resultContent !== undefined);

  const processSummaryLabel = hasTools
    ? hasReasonings
      ? `思考与工具调用 (${turn.tools.length} 个工具)`
      : `工具调用 (${turn.tools.length} 个工具)`
    : "思考过程";

  const processStatusLabel = anyToolFailed
    ? "存在失败"
    : allToolsCompleted
      ? "已完成"
      : "执行中";

  return (
    <article className="message-row assistant">
      <div className="message-avatar" aria-hidden="true">
        <Bot size={14} strokeWidth={1.8} />
      </div>
      <div className="message-content-wrap">
        <div className="message-meta">
          <span className="message-role">Hermes</span>
          <span className="message-timestamp">
            {formatTimestamp(turn.timestamp)}
          </span>
        </div>

        {/* Consolidated turn process card when tools are present */}
        {hasTools && (
          <details
            className="tool-call-card turn-process-card"
            open={!turn.finalContent ? true : undefined}
          >
            <summary className="tool-call-summary turn-process-summary">
              <Terminal size={14} strokeWidth={1.8} />
              <strong>{processSummaryLabel}</strong>
              <span
                className={`tool-call-status ${anyToolFailed ? "danger" : ""}`}
              >
                {processStatusLabel}
              </span>
              <ChevronDown
                size={14}
                strokeWidth={1.8}
                className="tool-call-chevron"
              />
            </summary>
            <div className="tool-call-details turn-process-details">
              <div className="turn-steps-list">
                {turn.steps.map((step) => {
                  if (step.kind === "reasoning") {
                    return (
                      <div
                        key={step.id}
                        className="turn-step turn-step-reasoning"
                      >
                        <div className="turn-step-header">
                          <Bot size={13} strokeWidth={1.8} />
                          <span>思考过程</span>
                        </div>
                        <div className="turn-step-body message-body">
                          <MarkdownContent text={step.content} />
                        </div>
                      </div>
                    );
                  }
                  if (step.kind === "text") {
                    return (
                      <div key={step.id} className="turn-step turn-step-text">
                        <div className="turn-step-body message-body">
                          <MarkdownContent text={step.content} />
                        </div>
                      </div>
                    );
                  }
                  return <ToolStepItem key={step.id} tool={step.tool} />;
                })}
              </div>
            </div>
          </details>
        )}

        {/* Collapsible reasoning card when no tools are present */}
        {!hasTools && hasReasonings && (
          <details
            className="tool-call-card reasoning-card"
            open={!turn.finalContent ? true : undefined}
          >
            <summary className="tool-call-summary reasoning-summary">
              <Sparkles
                size={14}
                strokeWidth={1.8}
                className="reasoning-spark-icon"
              />
              <strong>思考过程</strong>
              <ChevronDown
                size={14}
                strokeWidth={1.8}
                className="tool-call-chevron"
              />
            </summary>
            <div className="tool-call-details reasoning-details">
              <div className="reasoning-trace-line" aria-hidden="true" />
              <div className="reasoning-content-flow">
                {turn.reasonings.map((reasoning, idx) => (
                  <div key={idx} className="message-body reasoning-text">
                    <MarkdownContent text={reasoning} />
                  </div>
                ))}
              </div>
            </div>
          </details>
        )}

        {/* Final response markdown content */}
        {turn.finalContent && (
          <div className="message-body">
            <MarkdownContent text={turn.finalContent} />
          </div>
        )}
      </div>
    </article>
  );
});

const ToolStepItem = memo(function ToolStepItem({
  tool,
}: {
  tool: ToolCallItem;
}) {
  const isCompleted = tool.resultContent !== undefined;
  const statusLabel = tool.isError ? "失败" : isCompleted ? "已完成" : "已调用";

  return (
    <details
      className="tool-call-card tool-item-card"
      open={tool.isError ? true : undefined}
    >
      <summary className="tool-call-summary">
        <Terminal size={13} strokeWidth={1.8} />
        <strong>{tool.name}</strong>
        <span className={`tool-call-status ${tool.isError ? "danger" : ""}`}>
          {statusLabel}
        </span>
        <ChevronDown
          size={13}
          strokeWidth={1.8}
          className="tool-call-chevron"
        />
      </summary>
      <div className="tool-call-details">
        {tool.callContent && (
          <div className="tool-io-section">
            <span className="tool-io-label">输入</span>
            <pre>{tool.callContent}</pre>
          </div>
        )}
        {tool.resultContent && (
          <div className="tool-io-section">
            <span className="tool-io-label">输出</span>
            <pre>{getToolResultContent(tool.resultContent)}</pre>
          </div>
        )}
        {!tool.callContent && !tool.resultContent && <pre>没有内容</pre>}
      </div>
    </details>
  );
});

const PendingUserRow = memo(function PendingUserRow({
  message,
}: {
  message: PendingUserMessage;
}) {
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
});

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

const CodeBlock = memo(function CodeBlock({
  className,
  children,
}: {
  className?: string | undefined;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const language = className?.match(/language-([\w-]+)/)?.[1] ?? "";

  const handleCopy = useCallback(() => {
    const extractText = (node: React.ReactNode): string => {
      if (typeof node === "string") return node;
      if (typeof node === "number") return String(node);
      if (Array.isArray(node)) return node.map(extractText).join("");
      if (React.isValidElement(node) && node.props) {
        return extractText(
          (node.props as { children?: React.ReactNode }).children,
        );
      }
      return "";
    };

    const textToCopy = extractText(children);
    if (!textToCopy) return;

    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(textToCopy)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
        .catch(() => {});
    }
  }, [children]);

  return (
    <div className="message-code">
      <div className="message-code-header">
        <span className="message-code-label">{language || "code"}</span>
        <button
          type="button"
          className={`message-code-copy-btn ${copied ? "is-copied" : ""}`}
          onClick={handleCopy}
          aria-label={copied ? "已复制" : "复制代码"}
          title={copied ? "已复制" : "复制代码"}
        >
          {copied ? (
            <Check size={13} strokeWidth={2.2} />
          ) : (
            <Copy size={13} strokeWidth={1.8} />
          )}
          <span>{copied ? "已复制" : "复制代码"}</span>
        </button>
      </div>
      <pre>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
});

const MarkdownContent = memo(function MarkdownContent({
  text,
}: {
  text: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeHighlight, rehypeKatex]}
      components={{
        pre({ children }) {
          return <>{children}</>;
        },
        code({ className, children, ...props }) {
          const isInline =
            !className &&
            typeof children === "string" &&
            !children.includes("\n");
          if (isInline) {
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          }
          return <CodeBlock className={className}>{children}</CodeBlock>;
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

function formatTimestamp(timestamp: number): string {
  const milliseconds =
    timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
