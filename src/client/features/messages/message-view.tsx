import React from 'react';
import type { HermesMessage } from '../../../shared/hermes-schemas.js';

export interface MessageViewProps {
  messages: HermesMessage[];
  loading: boolean;
}

export const MessageView: React.FC<MessageViewProps> = ({ messages, loading }) => {
  if (loading && messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-neutral-400 text-xs">
        从 Hermes 加载会话历史中...
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-neutral-400 text-xs">
        <p className="font-medium text-neutral-500">会话暂无消息</p>
        <p className="mt-1 text-[11px]">发送消息将直接提交至 Hermes 运行队列</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
    </div>
  );
};

interface MessageBubbleProps {
  message: HermesMessage;
}

const MessageBubble: React.FC<MessageBubbleProps> = ({ message }) => {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isTool = message.role === 'tool';

  return (
    <div
      className={`flex flex-col ${
        isUser ? 'items-end' : 'items-start'
      } max-w-4xl mx-auto`}
    >
      {/* Role and Time Badge */}
      <div className="flex items-center space-x-1.5 mb-1 px-1 text-[10px] text-neutral-400">
        <span
          className={`font-semibold uppercase tracking-wider ${
            isUser
              ? 'text-blue-600 dark:text-blue-400'
              : isSystem
              ? 'text-neutral-500'
              : isTool
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-emerald-600 dark:text-emerald-400'
          }`}
        >
          {message.role}
        </span>
        {message.created_at && (
          <span>• {new Date(message.created_at).toLocaleTimeString()}</span>
        )}
      </div>

      {/* Bubble Container */}
      <div
        className={`rounded-lg px-4 py-2.5 text-xs leading-relaxed max-w-[85%] break-words shadow-2xs ${
          isUser
            ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
            : isSystem
            ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 italic border border-neutral-200 dark:border-neutral-700'
            : isTool
            ? 'bg-amber-500/5 text-neutral-800 dark:text-neutral-200 border border-amber-500/20'
            : 'bg-white dark:bg-neutral-800/90 text-neutral-800 dark:text-neutral-200 border border-neutral-200 dark:border-neutral-700'
        }`}
      >
        {/* Tool call meta or direct content */}
        {message.tool_calls && message.tool_calls.length > 0 && (
          <div className="mb-2 space-y-1.5">
            {message.tool_calls.map((tc, idx) => (
              <details
                key={tc.id || idx}
                className="bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded p-2 text-[11px]"
              >
                <summary className="font-mono font-semibold cursor-pointer text-amber-700 dark:text-amber-400">
                  工具调用: {tc.function.name}
                </summary>
                <pre className="mt-1 overflow-x-auto font-mono text-[10px] text-neutral-600 dark:text-neutral-400 whitespace-pre-wrap">
                  {tc.function.arguments}
                </pre>
              </details>
            ))}
          </div>
        )}

        {/* Safe text content */}
        <SafeTextRenderer text={message.content} isUser={isUser} />
      </div>
    </div>
  );
};

interface SafeTextRendererProps {
  text: string;
  isUser: boolean;
}

/**
 * Pure virtual DOM safe rendering without dangerouslySetInnerHTML.
 * Parses basic markdown blocks (code fences, paragraphs, lists, links) securely.
 */
const SafeTextRenderer: React.FC<SafeTextRendererProps> = ({ text, isUser }) => {
  if (!text) return null;

  // Split code blocks safely
  const parts = text.split(/(```[\s\S]*?```)/g);

  return (
    <div className="space-y-2">
      {parts.map((part, index) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          const lines = part.slice(3, -3).trim().split('\n');
          const lang = lines[0]?.trim() || '';
          const code = (lines.length > 1 ? lines.slice(1).join('\n') : lines[0]) ?? '';

          return (
            <div
              key={index}
              className="my-2 overflow-hidden rounded bg-neutral-950 text-neutral-200 border border-neutral-800 font-mono text-[11px]"
            >
              {lang && (
                <div className="px-3 py-1 bg-neutral-900 text-neutral-400 text-[10px] border-b border-neutral-800 select-none">
                  {lang}
                </div>
              )}
              <pre className="p-3 overflow-x-auto whitespace-pre">
                <code>{code}</code>
              </pre>
            </div>
          );
        }

        // Inline paragraphs & safe links
        return (
          <p key={index} className="whitespace-pre-wrap">
            {renderInlineLinks(part, isUser)}
          </p>
        );
      })}
    </div>
  );
};

function renderInlineLinks(text: string, isUser: boolean): React.ReactNode[] {
  // Safe URL regex pattern
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const tokens = text.split(urlRegex);

  return tokens.map((token, i) => {
    if (token.match(urlRegex)) {
      return (
        <a
          key={i}
          href={token}
          target="_blank"
          rel="noreferrer noopener"
          className={`underline underline-offset-2 ${
            isUser
              ? 'text-neutral-100 hover:text-white'
              : 'text-blue-600 dark:text-blue-400 hover:underline'
          }`}
        >
          {token}
        </a>
      );
    }
    return token;
  });
}
