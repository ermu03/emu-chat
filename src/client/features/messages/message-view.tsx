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
  type TurnStep,
  getToolResultContent,
  groupMessagesIntoTurns,
} from "./message-display.js";
import type { RunDisplay } from "./run-display.js";

export interface MessageViewProps {
  messages: MessageItem[];
  loading: boolean;
  hasMoreEarlier?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: (() => void) | undefined;
  pendingUserMessage?: PendingUserMessage | null;
  isGenerating?: boolean;
  runDisplay?: RunDisplay | null;
  activeRunId?: string | null;
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
  runDisplay = null,
  activeRunId = null,
  onStopGenerating,
  onReconcile,
  onSelectPrompt,
}) => {
  const turns = useMemo(() => groupMessagesIntoTurns(messages), [messages]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const previousScrollHeightRef = useRef<number | null>(null);
  const canonicalTurnId = runDisplay?.canonicalTurnId;
  const liveTurn =
    runDisplay && runDisplay.phase !== "settled"
      ? {
          timestamp: 0,
          blocks: runDisplay.blocks.map((block): TurnStep => {
            if (block.kind !== "tool") return block;
            return {
              kind: "tool",
              id: block.id,
              tool: {
                id: block.id,
                name: block.name,
                callContent: block.callContent,
                resultContent: block.resultContent,
                resultPreview: block.resultPreview,
                status: block.status,
                ambiguous: block.ambiguous,
                isError: block.status === "failed",
              },
            };
          }),
        }
      : null;
  const displayRows: React.ReactNode[] = turns.flatMap((turn) => {
    if (
      turn.kind === "assistant_turn" &&
      runDisplay &&
      runDisplay.phase !== "settled" &&
      runDisplay.afterMessageId > 0 &&
      turn.rawMessages.some((message) => message.id > runDisplay.afterMessageId)
    ) {
      return [];
    }
    if (turn.kind === "user") {
      return [<UserTurnRow key={turn.id} message={turn.message} />];
    }
    if (turn.kind === "system") {
      return [<SystemTurnRow key={turn.id} message={turn.message} />];
    }
    return [
      <AssistantTurnRow
        key={turn.id === canonicalTurnId ? `run:${runDisplay?.runId}` : turn.id}
        turn={turn}
      />,
    ];
  });
  if (pendingUserMessage) {
    displayRows.push(
      <PendingUserRow
        key={pendingUserMessage.id}
        message={pendingUserMessage}
      />,
    );
  }
  if (liveTurn || (isGenerating && runDisplay?.phase !== "settled")) {
    displayRows.push(
      <AssistantTurnRow
        key={`run:${runDisplay?.runId ?? activeRunId ?? "pending"}`}
        turn={liveTurn ?? { timestamp: 0, blocks: [] }}
        livePhase={runDisplay?.phase === "syncing" ? "syncing" : "streaming"}
        onStopGenerating={onStopGenerating}
        onReconcile={onReconcile}
      />,
    );
  }

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
  }, [isGenerating, pendingUserMessage?.id, runDisplay, turns.length]);

  const handleLoadEarlier = () => {
    if (scrollRef.current) {
      previousScrollHeightRef.current = scrollRef.current.scrollHeight;
    }
    onLoadEarlier?.();
  };

  if (
    loading &&
    turns.length === 0 &&
    !pendingUserMessage &&
    !isGenerating &&
    !runDisplay
  ) {
    return (
      <div className="message-scroll">
        <div className="message-empty">正在加载会话历史</div>
      </div>
    );
  }

  if (
    turns.length === 0 &&
    !pendingUserMessage &&
    !isGenerating &&
    !runDisplay
  ) {
    return (
      <div className="message-scroll">
        <div className="message-empty">
          <div className="empty-greeting">
            <div className="empty-greeting-mark" aria-hidden="true">
              <Sparkles size={24} strokeWidth={2} />
            </div>
            <h2>准备好开始工作</h2>
            <p>发送一条消息或选择快捷建议，小H会在当前会话中继续处理。</p>
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
        {displayRows}
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
          <span className="message-role">MuMu</span>
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
  livePhase,
  onStopGenerating,
  onReconcile,
}: {
  turn: Pick<AssistantTurn, "timestamp" | "blocks">;
  livePhase?: "streaming" | "syncing" | undefined;
  onStopGenerating?: (() => void) | undefined;
  onReconcile?: (() => void) | undefined;
}) {
  const [expandedTools, setExpandedTools] = useState<Record<number, boolean>>(
    {},
  );
  let toolOrdinal = -1;

  return (
    <article
      className={`message-row assistant ${livePhase ? "assistant-live" : ""}`}
      role={livePhase ? "status" : undefined}
    >
      <div className="message-avatar" aria-hidden="true">
        <Bot size={14} strokeWidth={1.8} />
      </div>
      <div className="message-content-wrap">
        <div
          className={`message-meta ${livePhase ? "assistant-live-meta" : ""}`}
        >
          <span className="message-role">小H</span>
          {turn.timestamp > 0 && (
            <span className="message-timestamp">
              {formatTimestamp(turn.timestamp)}
            </span>
          )}
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

        {turn.blocks.map((block, index) => {
          if (block.kind === "tool") {
            toolOrdinal += 1;
            const ordinal = toolOrdinal;
            return (
              <ToolStepItem
                key={block.id}
                tool={block.tool}
                open={expandedTools[ordinal] ?? block.tool.isError}
                onToggle={(open) =>
                  setExpandedTools((current) => ({
                    ...current,
                    [ordinal]: open,
                  }))
                }
              />
            );
          }
          if (block.kind === "reasoning") {
            return (
              <details key={block.id} className="tool-call-card reasoning-card">
                <summary className="tool-call-summary reasoning-summary">
                  <Sparkles size={14} className="reasoning-spark-icon" />
                  <strong>思考过程</strong>
                  <ChevronDown size={14} className="tool-call-chevron" />
                </summary>
                <div className="tool-call-details reasoning-details message-body">
                  <MarkdownContent text={block.content} />
                </div>
              </details>
            );
          }
          return (
            <div
              key={block.id}
              className={`message-body ${livePhase === "streaming" && index === turn.blocks.length - 1 ? "is-streaming" : ""}`}
            >
              <MarkdownContent text={block.content} />
            </div>
          );
        })}
        {livePhase && turn.blocks.length === 0 && (
          <div className="assistant-thinking" aria-label="小H正在生成">
            <LoaderCircle size={16} strokeWidth={1.9} />
            <span className="assistant-stream-cursor" aria-hidden="true" />
          </div>
        )}
        {livePhase === "syncing" && (
          <span className="assistant-syncing">正在核对回复…</span>
        )}
      </div>
    </article>
  );
});

const ToolStepItem = memo(function ToolStepItem({
  tool,
  open,
  onToggle,
}: {
  tool: ToolCallItem;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const isCompleted =
    tool.status === "completed" || tool.resultContent !== undefined;
  const statusLabel = tool.isError
    ? "失败"
    : tool.ambiguous && tool.status === "running"
      ? "待核对"
      : tool.status === "running"
        ? "执行中"
        : isCompleted
          ? "已完成"
          : "已调用";
  const result =
    tool.resultContent !== undefined
      ? getToolResultContent(tool.resultContent)
      : tool.resultPreview?.trim();

  return (
    <details
      className="tool-call-card tool-item-card"
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary className="tool-call-summary">
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
        {result && (
          <div className="tool-io-section">
            <span className="tool-io-label">输出</span>
            <pre>{result}</pre>
          </div>
        )}
        {!tool.callContent && !result && <pre>等待结果…</pre>}
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
          <span className="message-role">MuMu</span>
        </div>
        <div className="message-body">{message.content}</div>
      </div>
    </article>
  );
});

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
