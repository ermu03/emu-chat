import { describe, expect, it } from "vitest";
import type { MessageItem } from "../../src/shared/api-schemas.js";
import {
  groupMessagesIntoTurns,
  isToolError,
  getToolResultContent,
  mergeMessages,
  type AssistantTurn,
} from "../../src/client/features/messages/message-display.js";

describe("message-display turn aggregation", () => {
  it("detects tool errors correctly from JSON payloads", () => {
    expect(isToolError(JSON.stringify({ error: "Command not found" }))).toBe(
      true,
    );
    expect(isToolError(JSON.stringify({ exit_code: 1 }))).toBe(true);
    expect(
      isToolError(JSON.stringify({ exit_code: 0, output: "Success" })),
    ).toBe(false);
    expect(isToolError("plain text error output")).toBe(false);
  });

  it("extracts tool result content properly", () => {
    const successResult = getToolResultContent(
      JSON.stringify({ output: "Files: a.ts, b.ts" }),
    );
    expect(successResult).toBe("Files: a.ts, b.ts");

    const failedResult = getToolResultContent(
      JSON.stringify({ output: "Failed to read", exit_code: 2 }),
    );
    expect(failedResult).toContain("Failed to read");
    expect(failedResult).toContain("工具执行失败（退出码 2）");
  });

  it("keeps reasoning and text interleaved across messages without tools", () => {
    const messages: MessageItem[] = [
      { id: "1", role: "user", content: "Hello", timestamp: 1000 },
      {
        id: "2",
        role: "assistant",
        content: "Let me check.",
        reasoning: "First thought",
        timestamp: 1001,
      },
      {
        id: "3",
        role: "assistant",
        content: "Hi there!",
        reasoning: "Second thought",
        timestamp: 1002,
      },
    ];

    const turns = groupMessagesIntoTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0].kind).toBe("user");
    expect(turns[1].kind).toBe("assistant_turn");

    const assistantTurn = turns[1] as AssistantTurn;
    expect(
      assistantTurn.blocks.map((block) => [
        block.kind,
        block.kind === "tool" ? block.tool.name : block.content,
      ]),
    ).toEqual([
      ["reasoning", "First thought"],
      ["text", "Let me check."],
      ["reasoning", "Second thought"],
      ["text", "Hi there!"],
    ]);
  });

  it("keeps text, reasoning, and tool calls in message order", () => {
    const messages: MessageItem[] = [
      { id: "u1", role: "user", content: "Search for files", timestamp: 100 },
      {
        id: "a1",
        role: "assistant",
        content: "I will check the directory first.",
        timestamp: 101,
      },
      {
        id: "a2",
        role: "assistant",
        content: JSON.stringify({ path: "." }),
        tool_name: "list_dir",
        tool_call_id: "call_1",
        timestamp: 102,
      },
      {
        id: "t1",
        role: "tool",
        content: JSON.stringify({ output: "file1.txt\nfile2.txt" }),
        tool_name: "list_dir",
        tool_call_id: "call_1",
        timestamp: 103,
      },
      {
        id: "a3",
        role: "assistant",
        content: "I found two files. I will read the first one.",
        reasoning: "Inspect the directory result",
        timestamp: 104,
      },
      {
        id: "a4",
        role: "assistant",
        content: JSON.stringify({ path: "file1.txt" }),
        tool_name: "read_file",
        tool_call_id: "call_2",
        timestamp: 105,
      },
      {
        id: "t2",
        role: "tool",
        content: JSON.stringify({ output: "File contents" }),
        tool_name: "read_file",
        tool_call_id: "call_2",
        timestamp: 106,
      },
      {
        id: "a5",
        role: "assistant",
        content: "The first file has useful context.",
        timestamp: 107,
      },
      {
        id: "a6",
        role: "assistant",
        content: "The first file contains the answer.",
        reasoning: "Check the file content",
        timestamp: 108,
      },
    ];

    const turns = groupMessagesIntoTurns(messages);
    expect(turns).toHaveLength(2);

    const assistantTurn = turns[1] as AssistantTurn;
    expect(assistantTurn.kind).toBe("assistant_turn");
    const tools = assistantTurn.blocks.filter((block) => block.kind === "tool");
    expect(tools.map((block) => block.tool.name)).toEqual([
      "list_dir",
      "read_file",
    ]);
    expect(tools[0]?.tool.resultContent).toBe(
      JSON.stringify({ output: "file1.txt\nfile2.txt" }),
    );
    expect(tools[1]?.tool.resultContent).toBe(
      JSON.stringify({ output: "File contents" }),
    );
    expect(assistantTurn.blocks.map((block) => block.kind)).toEqual([
      "text",
      "tool",
      "reasoning",
      "text",
      "tool",
      "text",
      "reasoning",
      "text",
    ]);
    expect(assistantTurn.blocks.at(-1)).toMatchObject({
      kind: "text",
      content: "The first file contains the answer.",
    });
  });

  it("correctly handles turns with tools but no final text (e.g. error/interrupted)", () => {
    const messages: MessageItem[] = [
      { id: "u1", role: "user", content: "Run bash command", timestamp: 100 },
      {
        id: "a1",
        role: "assistant",
        content: "Running command...",
        tool_name: "bash",
        tool_call_id: "call_bash",
        timestamp: 101,
      },
      {
        id: "t1",
        role: "tool",
        content: JSON.stringify({ error: "Permission denied", exit_code: 126 }),
        tool_name: "bash",
        tool_call_id: "call_bash",
        timestamp: 102,
      },
    ];

    const turns = groupMessagesIntoTurns(messages);
    expect(turns).toHaveLength(2);
    const assistantTurn = turns[1] as AssistantTurn;
    expect(assistantTurn.blocks).toHaveLength(1);
    expect(assistantTurn.blocks[0]).toMatchObject({
      kind: "tool",
      tool: { isError: true },
    });
  });

  it("does not attach a result to a different tool_call_id even when names match", () => {
    const turns = groupMessagesIntoTurns([
      { id: 1, role: "user", content: "run", timestamp: 1 },
      {
        id: 2,
        role: "assistant",
        content: "first call",
        tool_name: "bash",
        tool_call_id: "call_1",
        timestamp: 2,
      },
      {
        id: 3,
        role: "tool",
        content: "second result",
        tool_name: "bash",
        tool_call_id: "call_2",
        timestamp: 3,
      },
    ]);
    const assistantTurn = turns[1] as AssistantTurn;
    const tools = assistantTurn.blocks.filter((block) => block.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]?.tool.resultContent).toBeUndefined();
    expect(tools[1]?.tool.resultContent).toBe("second result");
  });

  it("merges messages, deduplicates by id, and sorts in ascending chronological order", () => {
    const existing: MessageItem[] = [
      { id: 1, role: "user", content: "first", timestamp: 100 },
      { id: 2, role: "assistant", content: "second", timestamp: 101 },
    ];
    const incoming: MessageItem[] = [
      { id: 2, role: "assistant", content: "second updated", timestamp: 101 },
      { id: 3, role: "user", content: "third", timestamp: 102 },
    ];

    const merged = mergeMessages(existing, incoming);
    expect(merged).toHaveLength(3);
    expect(merged.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(merged[1].content).toBe("second updated");
  });
});
