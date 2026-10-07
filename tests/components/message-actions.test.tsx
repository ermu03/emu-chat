// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MessageView } from "../../src/client/features/messages/message-view.js";
import { CopyButton } from "../../src/client/features/messages/copy-button.js";
import type { MessageItem } from "../../src/shared/api-schemas.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("copies ordered assistant source without reasoning or tool logs, and fences a late copy across conversations", async () => {
  let resolve!: () => void;
  const writeText = vi.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const messages: MessageItem[] = [
    {
      id: 1,
      session_id: "s",
      timestamp: 1,
      role: "assistant",
      content: "第一段 **正文**",
      reasoning: "私有思考",
      tool_calls: [{ id: "call", name: "terminal", display_args: "参数" }],
    },
    {
      id: 2,
      session_id: "s",
      timestamp: 2,
      role: "tool",
      tool_call_id: "call",
      tool_name: "terminal",
      content: "工具日志",
    },
    {
      id: 3,
      session_id: "s",
      timestamp: 3,
      role: "assistant",
      content: "```js\nconst value = 1;\n```",
    },
  ];
  const view = render(
    <MessageView
      loading={false}
      messages={messages}
      artifactConversationId="cv_a"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "复制回复" }));
  expect(writeText).toHaveBeenCalledWith(
    "第一段 **正文**\n\n```js\nconst value = 1;\n```",
  );
  view.rerender(
    <MessageView
      loading={false}
      messages={messages}
      artifactConversationId="cv_b"
    />,
  );
  await act(async () => resolve());
  expect(screen.queryByRole("button", { name: "已复制" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
  expect(writeText).toHaveBeenLastCalledWith("const value = 1;\n");
});

it("ignores an old clipboard rejection after source changes and exposes current text for manual copying", async () => {
  let reject!: (error: Error) => void;
  const writeText = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    )
    .mockRejectedValue(new Error("denied"));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const view = render(<CopyButton text="old" label="复制回复" />);
  fireEvent.click(screen.getByRole("button", { name: "复制回复" }));
  view.rerender(<CopyButton text="new" label="复制回复" />);
  await act(async () => reject(new Error("late")));
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "复制回复" }));
  await waitFor(() =>
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "new",
    ),
  );
  expect(screen.queryByRole("button", { name: "已复制" })).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("textbox")),
  );
});
