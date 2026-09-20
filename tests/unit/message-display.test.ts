import { describe, expect, it } from "vitest";
import type { MessageItem } from "../../src/shared/api-schemas.js";
import {
  getRenderableMessages,
  getToolResultContent,
} from "../../src/client/features/messages/message-display.js";

function message(overrides: Partial<MessageItem>): MessageItem {
  return {
    id: 1,
    session_id: "session_1",
    role: "assistant",
    content: "",
    tool_call_id: null,
    tool_name: null,
    timestamp: 1_726_790_800,
    token_count: null,
    finish_reason: null,
    reasoning: null,
    display_kind: null,
    ...overrides,
  };
}

describe("message display", () => {
  it("hides empty protocol events while retaining visible messages", () => {
    const rendered = getRenderableMessages([
      message({ id: 1, finish_reason: "tool_calls" }),
      message({ id: 2, content: "已完成检查" }),
      message({ id: 3, role: "tool", tool_name: "terminal" }),
    ]);

    expect(rendered.map((item) => item.id)).toEqual([2, 3]);
  });

  it("shows the useful output and error from a Hermes tool result", () => {
    expect(
      getToolResultContent(
        JSON.stringify({
          output: "Filesystem is healthy",
          exit_code: 0,
          error: null,
        }),
      ),
    ).toBe("Filesystem is healthy");

    expect(
      getToolResultContent(
        JSON.stringify({
          output: "",
          exit_code: 1,
          error: "Permission denied",
        }),
      ),
    ).toBe("错误：Permission denied");

    expect(getToolResultContent('{"output":"","exit_code":2}')).toBe(
      "工具执行失败（退出码 2）",
    );
  });
});
