import type { MessageItem } from "../../../shared/api-schemas.js";

export type RunDisplayBlock =
  | { kind: "text"; id: string; content: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      status: "running" | "completed" | "failed";
      resultPreview: string;
      callContent?: string | undefined;
      resultContent?: string;
      toolCallId?: string;
      ambiguous: boolean;
    };

export interface RunDisplay {
  runId: string;
  afterMessageId: number;
  promptContent: string | null;
  phase: "streaming" | "syncing" | "settled";
  lastSequence: number;
  blocks: RunDisplayBlock[];
  canonicalTurnId: string | null;
}

export function createRunDisplay(
  runId: string,
  afterMessageId: number,
  promptContent: string | null,
): RunDisplay {
  return {
    runId,
    afterMessageId,
    promptContent,
    phase: "streaming",
    lastSequence: 0,
    blocks: [],
    canonicalTurnId: null,
  };
}

export function applyRunDisplayEvent(
  display: RunDisplay,
  sequence: number | null,
  type: string,
  payload: Record<string, unknown>,
): RunDisplay {
  if (display.phase === "settled") return display;
  if (sequence !== null && sequence <= display.lastSequence) return display;

  const blocks = [...display.blocks];
  const id = `${display.runId}:${sequence ?? display.lastSequence + 1}`;

  if (type === "message.delta" && typeof payload.delta === "string") {
    const delta = payload.delta;
    if (delta) {
      const last = blocks.at(-1);
      if (last?.kind === "text") {
        blocks[blocks.length - 1] = { ...last, content: last.content + delta };
      } else {
        blocks.push({ kind: "text", id, content: delta });
      }
    }
  } else if (type === "tool.started") {
    blocks.push({
      kind: "tool",
      id,
      name: toolName(payload),
      status: "running",
      resultPreview: "",
      ambiguous: false,
    });
  } else if (type === "tool.completed") {
    const name = toolName(payload);
    const pending = blocks.flatMap((block, index) =>
      block.kind === "tool" && block.name === name && block.status === "running"
        ? [index]
        : [],
    );
    const status = payload.error === true ? "failed" : "completed";
    const resultPreview =
      typeof payload.preview === "string" ? payload.preview : "";
    const index = pending[0];
    if (index !== undefined && pending.length === 1) {
      const previous = blocks[index];
      if (previous?.kind === "tool") {
        blocks[index] = {
          ...previous,
          status,
          resultPreview,
          ambiguous: false,
        };
      }
    } else {
      for (const pendingIndex of pending) {
        const previous = blocks[pendingIndex];
        if (previous?.kind === "tool") {
          blocks[pendingIndex] = { ...previous, ambiguous: true };
        }
      }
      blocks.push({
        kind: "tool",
        id,
        name,
        status,
        resultPreview,
        ambiguous: pending.length > 1,
      });
    }
  }

  return {
    ...display,
    blocks,
    lastSequence: sequence ?? display.lastSequence,
  };
}

export function hydrateRunDisplay(
  display: RunDisplay,
  messages: MessageItem[],
): RunDisplay {
  if (display.phase === "settled") return display;
  const completed = display.blocks.filter(
    (block): block is Extract<RunDisplayBlock, { kind: "tool" }> =>
      block.kind === "tool" &&
      block.status !== "running" &&
      !block.ambiguous &&
      block.resultContent === undefined,
  );
  if (completed.length === 0) return display;

  const newMessages = messages.filter(
    (message) => message.id > display.afterMessageId,
  );
  const alreadyUsed = new Set(
    display.blocks.flatMap((block) =>
      block.kind === "tool" && block.toolCallId ? [block.toolCallId] : [],
    ),
  );
  const results = newMessages.filter(
    (message) =>
      message.role === "tool" &&
      message.tool_call_id &&
      !alreadyUsed.has(message.tool_call_id),
  );
  let blocks = display.blocks;
  for (const name of new Set(completed.map((block) => block.name))) {
    const pendingForName = completed.filter((block) => block.name === name);
    const resultsForName = results.filter(
      (message) => message.tool_name === name,
    );
    if (pendingForName.length !== 1 || resultsForName.length !== 1) continue;
    const result = resultsForName[0]!;
    const call = newMessages.find(
      (message) =>
        message.role === "assistant" &&
        (message.tool_call_id === result.tool_call_id ||
          message.tool_calls?.some((c) => c.id === result.tool_call_id)),
    );
    const matchingToolCall = call?.tool_calls?.find(
      (c) => c.id === result.tool_call_id,
    );
    blocks = blocks.map((block) =>
      block === pendingForName[0]
        ? {
            ...block,
            ...(result.tool_call_id ? { toolCallId: result.tool_call_id } : {}),
            callContent:
              matchingToolCall?.display_args ??
              call?.content ??
              block.callContent,
            resultContent: result.content,
          }
        : block,
    );
  }
  return blocks === display.blocks ? display : { ...display, blocks };
}

export function markRunDisplaySyncing(display: RunDisplay): RunDisplay {
  return display.phase === "streaming"
    ? { ...display, phase: "syncing" }
    : display;
}

export function markRunDisplaySettled(
  display: RunDisplay,
  canonicalTurnId: string,
): RunDisplay {
  return { ...display, phase: "settled", canonicalTurnId };
}

function toolName(payload: Record<string, unknown>): string {
  return typeof payload.tool === "string" && payload.tool.trim()
    ? payload.tool
    : "工具";
}
