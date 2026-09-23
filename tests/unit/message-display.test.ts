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

  it("groups simple conversation without tools into distinct turns", () => {
    const messages: MessageItem[] = [
      { id: "1", role: "user", content: "Hello", timestamp: 1000 },
      {
        id: "2",
        role: "assistant",
        content: "Hi there!",
        reasoning: "User greeted, reply politely.",
        timestamp: 1001,
      },
    ];

    const turns = groupMessagesIntoTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0].kind).toBe("user");
    expect(turns[1].kind).toBe("assistant_turn");

    const assistantTurn = turns[1] as AssistantTurn;
    expect(assistantTurn.tools).toHaveLength(0);
    expect(assistantTurn.reasonings).toEqual(["User greeted, reply politely."]);
    expect(assistantTurn.finalContent).toBe("Hi there!");
  });

  it("aggregates assistant tool calls, intermediate texts, and final response into one turn", () => {
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
        content: "I found two files: file1.txt and file2.txt.",
        timestamp: 104,
      },
    ];

    const turns = groupMessagesIntoTurns(messages);
    expect(turns).toHaveLength(2);

    const assistantTurn = turns[1] as AssistantTurn;
    expect(assistantTurn.kind).toBe("assistant_turn");
    expect(assistantTurn.tools).toHaveLength(1);
    expect(assistantTurn.tools[0].name).toBe("list_dir");
    expect(assistantTurn.tools[0].resultContent).toBe(
      JSON.stringify({ output: "file1.txt\nfile2.txt" }),
    );
    expect(assistantTurn.tools[0].isError).toBe(false);

    // Intermediate text before tool execution is inside steps, not in finalContent
    expect(
      assistantTurn.steps.some(
        (s) => s.kind === "text" && s.content.includes("check the directory"),
      ),
    ).toBe(true);

    // Final answer after all tools is in finalContent
    expect(assistantTurn.finalContent).toBe(
      "I found two files: file1.txt and file2.txt.",
    );
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
    expect(assistantTurn.tools).toHaveLength(1);
    expect(assistantTurn.tools[0].isError).toBe(true);
    expect(assistantTurn.finalContent).toBe("");
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
