import type { MessageItem } from "../../../shared/api-schemas.js";

export interface ToolCallItem {
  id: string;
  name: string;
  callContent?: string | undefined;
  resultContent?: string | undefined;
  resultPreview?: string | undefined;
  status?: "running" | "completed" | "failed" | undefined;
  ambiguous?: boolean | undefined;
  isError: boolean;
}

export type TurnStep =
  | { kind: "reasoning"; id: string; content: string }
  | { kind: "tool"; id: string; tool: ToolCallItem }
  | { kind: "text"; id: string; content: string };

export interface AssistantTurn {
  kind: "assistant_turn";
  id: string;
  role: "assistant";
  timestamp: number;
  blocks: TurnStep[];
  rawMessages: MessageItem[];
}

export interface UserTurn {
  kind: "user";
  id: string;
  message: MessageItem;
}

export interface SystemTurn {
  kind: "system";
  id: string;
  message: MessageItem;
}

export type DisplayTurn = UserTurn | SystemTurn | AssistantTurn;

export function getRenderableMessages(messages: MessageItem[]): MessageItem[] {
  return messages.filter(
    (message) =>
      Boolean(message.content.trim()) ||
      Boolean(message.tool_name) ||
      Boolean(message.tool_call_id) ||
      Boolean(message.tool_calls && message.tool_calls.length > 0) ||
      Boolean(message.reasoning?.trim()),
  );
}

export function isToolError(content: string): boolean {
  try {
    const payload: unknown = JSON.parse(content);
    if (!isRecord(payload)) return false;
    if (typeof payload.error === "string" && payload.error.trim().length > 0) {
      return true;
    }
    if (typeof payload.exit_code === "number" && payload.exit_code !== 0) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function getToolResultContent(content: string): string {
  const fallback = content.trim() || "没有返回内容";

  try {
    const payload: unknown = JSON.parse(content);
    if (!isRecord(payload)) return fallback;

    const output = typeof payload.output === "string" ? payload.output : "";
    const error =
      typeof payload.error === "string" && payload.error.trim()
        ? `错误：${payload.error.trim()}`
        : getExitCodeFailure(payload.exit_code);

    return [output.trim(), error].filter(Boolean).join("\n\n") || fallback;
  } catch {
    return fallback;
  }
}

function getExitCodeFailure(exitCode: unknown): string {
  return typeof exitCode === "number" && exitCode !== 0
    ? `工具执行失败（退出码 ${exitCode}）`
    : "";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges newly fetched messages into the current message list, deduplicating by ID
 * and preserving natural chronological display order (sorted by ID or timestamp).
 */
export function mergeMessages(
  existing: MessageItem[],
  incoming: MessageItem[],
): MessageItem[] {
  const map = new Map<number, MessageItem>();
  for (const m of existing) {
    map.set(m.id, m);
  }
  for (const m of incoming) {
    map.set(m.id, m);
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.id !== b.id) return a.id - b.id;
    return a.timestamp - b.timestamp;
  });
}

export function groupMessagesIntoTurns(messages: MessageItem[]): DisplayTurn[] {
  const renderable = getRenderableMessages(messages);
  const turns: DisplayTurn[] = [];

  let currentAssistantChunk: MessageItem[] = [];

  const flushAssistantTurn = () => {
    if (currentAssistantChunk.length === 0) return;
    turns.push(buildAssistantTurn(currentAssistantChunk));
    currentAssistantChunk = [];
  };

  for (const message of renderable) {
    if (message.role === "user") {
      flushAssistantTurn();
      turns.push({
        kind: "user",
        id: `turn_user_${message.id}`,
        message,
      });
    } else if (message.role === "system") {
      flushAssistantTurn();
      turns.push({
        kind: "system",
        id: `turn_system_${message.id}`,
        message,
      });
    } else {
      currentAssistantChunk.push(message);
    }
  }

  flushAssistantTurn();
  return turns;
}

function buildAssistantTurn(chunk: MessageItem[]): AssistantTurn {
  const firstMsg = chunk[0];
  if (!firstMsg) {
    throw new Error("Assistant chunk cannot be empty");
  }

  const lastMsg = chunk[chunk.length - 1];
  const timestamp = lastMsg?.timestamp || firstMsg.timestamp;
  const turnId = `turn_assistant_${firstMsg.id}`;
  const blocks: TurnStep[] = [];

  // Hermes does not mark a final-answer phase, so keep every saved message in order.
  for (const msg of chunk) {
    if (msg.role === "assistant") {
      if (msg.reasoning?.trim()) {
        blocks.push({
          kind: "reasoning",
          id: `step_reasoning_${msg.id}`,
          content: msg.reasoning.trim(),
        });
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        if (msg.content.trim()) {
          blocks.push({
            kind: "text",
            id: `step_text_${msg.id}`,
            content: msg.content.trim(),
          });
        }
        for (const call of msg.tool_calls) {
          const toolItem: ToolCallItem = {
            id: call.id,
            name: call.name,
            callContent: call.display_args,
            isError: false,
          };
          blocks.push({
            kind: "tool",
            id: `step_tool_${call.id}`,
            tool: toolItem,
          });
        }
      } else if (msg.tool_name || msg.tool_call_id) {
        const toolId = msg.tool_call_id || `call_${msg.id}`;
        const toolItem: ToolCallItem = {
          id: toolId,
          name: msg.tool_name || "tool",
          callContent: msg.content.trim() || undefined,
          isError: false,
        };
        blocks.push({
          kind: "tool",
          id: `step_tool_${toolId}`,
          tool: toolItem,
        });
      } else if (msg.content.trim()) {
        blocks.push({
          kind: "text",
          id: `step_text_${msg.id}`,
          content: msg.content.trim(),
        });
      }
    } else if (msg.role === "tool") {
      let matchedToolStep:
        { kind: "tool"; id: string; tool: ToolCallItem } | undefined;

      // 1. Match by tool_call_id
      if (msg.tool_call_id) {
        matchedToolStep = blocks.find(
          (s): s is { kind: "tool"; id: string; tool: ToolCallItem } =>
            s.kind === "tool" &&
            s.tool.id === msg.tool_call_id &&
            s.tool.resultContent === undefined,
        );
      }

      // 2. Match by tool_name only if exactly one unmatched candidate exists (do not guess for concurrent calls)
      if (!matchedToolStep && !msg.tool_call_id && msg.tool_name) {
        const candidates = blocks.filter(
          (s): s is { kind: "tool"; id: string; tool: ToolCallItem } =>
            s.kind === "tool" &&
            s.tool.resultContent === undefined &&
            s.tool.name === msg.tool_name,
        );
        if (candidates.length === 1) {
          matchedToolStep = candidates[0];
        }
      }

      // 3. Fallback: only if exactly one unmatched tool exists overall
      if (!matchedToolStep && !msg.tool_call_id) {
        const candidates = blocks.filter(
          (s): s is { kind: "tool"; id: string; tool: ToolCallItem } =>
            s.kind === "tool" && s.tool.resultContent === undefined,
        );
        if (candidates.length === 1) {
          matchedToolStep = candidates[0];
        }
      }

      if (matchedToolStep) {
        matchedToolStep.tool.resultContent = msg.content;
        matchedToolStep.tool.isError = isToolError(msg.content);
        if (matchedToolStep.tool.name === "tool" && msg.tool_name) {
          matchedToolStep.tool.name = msg.tool_name;
        }
      } else {
        const orphanTool: ToolCallItem = {
          id: msg.tool_call_id || `tool_${msg.id}`,
          name: msg.tool_name || "tool",
          resultContent: msg.content,
          isError: isToolError(msg.content),
        };
        blocks.push({
          kind: "tool",
          id: `step_tool_${orphanTool.id}`,
          tool: orphanTool,
        });
      }
    }
  }

  return {
    kind: "assistant_turn",
    id: turnId,
    role: "assistant",
    timestamp,
    blocks,
    rawMessages: chunk,
  };
}
