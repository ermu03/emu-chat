import type { MessageItem } from "../../../shared/api-schemas.js";

export interface ToolCallItem {
  id: string;
  name: string;
  callContent?: string | undefined;
  resultContent?: string | undefined;
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
  steps: TurnStep[];
  tools: ToolCallItem[];
  reasonings: string[];
  finalContent: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  const hasAnyTools = chunk.some(
    (m) => m.role === "tool" || Boolean(m.tool_name) || Boolean(m.tool_call_id),
  );

  // If there are no tools at all, keep it as a simple conversational turn
  if (!hasAnyTools) {
    const reasonings: string[] = [];
    const contents: string[] = [];
    const steps: TurnStep[] = [];

    for (const msg of chunk) {
      if (msg.reasoning?.trim()) {
        const reasoning = msg.reasoning.trim();
        reasonings.push(reasoning);
        steps.push({
          kind: "reasoning",
          id: `step_reasoning_${msg.id}`,
          content: reasoning,
        });
      }
      if (msg.content.trim()) {
        contents.push(msg.content.trim());
      }
    }

    return {
      kind: "assistant_turn",
      id: turnId,
      role: "assistant",
      timestamp,
      steps,
      tools: [],
      reasonings,
      finalContent: contents.join("\n\n"),
      rawMessages: chunk,
    };
  }

  // There are tools. Find the index of the last tool-related message.
  let lastToolIndex = -1;
  for (let i = chunk.length - 1; i >= 0; i--) {
    const m = chunk[i];
    if (
      m &&
      (m.role === "tool" || Boolean(m.tool_name) || Boolean(m.tool_call_id))
    ) {
      lastToolIndex = i;
      break;
    }
  }

  // Any assistant message after the last tool execution without tool_name is post-tool final text
  const finalMessageIndices = new Set<number>();
  const finalContents: string[] = [];
  if (lastToolIndex >= 0) {
    for (let i = lastToolIndex + 1; i < chunk.length; i++) {
      const m = chunk[i];
      if (m && m.role === "assistant" && !m.tool_name && m.content.trim()) {
        finalMessageIndices.add(i);
        finalContents.push(m.content.trim());
      }
    }
  }

  const steps: TurnStep[] = [];

  for (let i = 0; i < chunk.length; i++) {
    const msg = chunk[i];
    if (!msg) continue;

    if (finalMessageIndices.has(i)) {
      if (msg.reasoning?.trim()) {
        steps.push({
          kind: "reasoning",
          id: `step_reasoning_${msg.id}`,
          content: msg.reasoning.trim(),
        });
      }
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.reasoning?.trim()) {
        steps.push({
          kind: "reasoning",
          id: `step_reasoning_${msg.id}`,
          content: msg.reasoning.trim(),
        });
      }

      if (msg.tool_name || msg.tool_call_id) {
        const toolId = msg.tool_call_id || `call_${msg.id}`;
        const toolItem: ToolCallItem = {
          id: toolId,
          name: msg.tool_name || "tool",
          callContent: msg.content.trim() || undefined,
          isError: false,
        };
        steps.push({
          kind: "tool",
          id: `step_tool_${toolId}`,
          tool: toolItem,
        });
      } else if (msg.content.trim()) {
        steps.push({
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
        matchedToolStep = steps.find(
          (s): s is { kind: "tool"; id: string; tool: ToolCallItem } =>
            s.kind === "tool" &&
            s.tool.id === msg.tool_call_id &&
            s.tool.resultContent === undefined,
        );
      }

      // 2. Match by tool_name (backwards)
      if (!matchedToolStep && msg.tool_name) {
        for (let j = steps.length - 1; j >= 0; j--) {
          const s = steps[j];
          if (
            s &&
            s.kind === "tool" &&
            s.tool.resultContent === undefined &&
            s.tool.name === msg.tool_name
          ) {
            matchedToolStep = s;
            break;
          }
        }
      }

      // 3. Fallback: last unmatched tool
      if (!matchedToolStep) {
        for (let j = steps.length - 1; j >= 0; j--) {
          const s = steps[j];
          if (s && s.kind === "tool" && s.tool.resultContent === undefined) {
            matchedToolStep = s;
            break;
          }
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
        steps.push({
          kind: "tool",
          id: `step_tool_${orphanTool.id}`,
          tool: orphanTool,
        });
      }
    }
  }

  const tools = steps
    .filter(
      (s): s is { kind: "tool"; id: string; tool: ToolCallItem } =>
        s.kind === "tool",
    )
    .map((s) => s.tool);

  const reasonings = steps
    .filter(
      (s): s is { kind: "reasoning"; id: string; content: string } =>
        s.kind === "reasoning",
    )
    .map((s) => s.content);

  return {
    kind: "assistant_turn",
    id: turnId,
    role: "assistant",
    timestamp,
    steps,
    tools,
    reasonings,
    finalContent: finalContents.join("\n\n"),
    rawMessages: chunk,
  };
}
