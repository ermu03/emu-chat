import { describe, expect, it } from "vitest";
import type { MessageItem } from "../../src/shared/api-schemas.js";
import {
  applyRunDisplayEvent,
  createRunDisplay,
  hydrateRunDisplay,
  markRunDisplaySettled,
} from "../../src/client/features/messages/run-display.js";

describe("Run display event reconciliation", () => {
  it("keeps event order and refuses to assign concurrent same-name results by guess", () => {
    let display = createRunDisplay("run_1", 10, "inspect");
    display = applyRunDisplayEvent(display, 1, "message.delta", {
      delta: "before",
    });
    display = applyRunDisplayEvent(display, 2, "tool.started", {
      tool: "bash",
    });
    display = applyRunDisplayEvent(display, 3, "tool.started", {
      tool: "bash",
    });
    display = applyRunDisplayEvent(display, 4, "tool.completed", {
      tool: "bash",
      preview: "second output",
      error: false,
    });
    expect(display.blocks.map((block) => block.kind)).toEqual([
      "text",
      "tool",
      "tool",
      "tool",
    ]);
    const toolBlocks = display.blocks.filter((block) => block.kind === "tool");
    expect(toolBlocks.map((block) => block.status)).toEqual([
      "running",
      "running",
      "completed",
    ]);
    expect(toolBlocks.every((block) => block.ambiguous)).toBe(true);

    const result = (id: number, callId: string): MessageItem => ({
      id,
      session_id: "session_1",
      role: "tool",
      content: `output for ${callId}`,
      tool_call_id: callId,
      tool_name: "bash",
      timestamp: id,
      token_count: null,
      finish_reason: null,
      reasoning: null,
      display_kind: null,
    });
    display = hydrateRunDisplay(display, [
      result(11, "call_1"),
      result(12, "call_2"),
    ]);
    expect(display.blocks.filter((block) => block.kind === "tool")).toEqual(
      toolBlocks,
    );

    expect(
      applyRunDisplayEvent(display, 4, "tool.completed", { tool: "bash" }),
    ).toBe(display);
    display = applyRunDisplayEvent(display, 5, "message.delta", {
      delta: "after",
    });
    expect(display.blocks.at(-1)).toMatchObject({
      kind: "text",
      content: "after",
    });
    const settled = markRunDisplaySettled(display, "turn_assistant_11");
    expect(
      applyRunDisplayEvent(settled, 6, "tool.started", { tool: "bash" }),
    ).toBe(settled);
  });
});
