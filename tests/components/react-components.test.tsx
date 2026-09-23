// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ConversationList } from "../../src/client/features/conversations/conversation-list";
import { DraftComposer } from "../../src/client/features/composer/draft-composer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("high-risk component interactions", () => {
  it("requires an explicit checkbox confirmation before deleting a conversation", () => {
    const onDelete = vi.fn();
    render(
      <ConversationList
        conversations={[
          {
            conversation_id: "cv_test",
            hermes_session_id: "ses_test_1",
            effective_hermes_session_id: "ses_test_1",
            title: "Project setup",
            pinned: false,
            tags: [],
            custom_order: null,
            last_active: 0,
            message_count: 0,
            preview: "",
            has_active_run: false,
            queue_size: 0,
            queue_paused: false,
            has_recovery: false,
            delete_state: "none",
            local_revision: 0,
          },
        ]}
        activeConversationId="cv_test"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onFork={vi.fn()}
        onDelete={onDelete}
        onUpdateMetadata={vi.fn()}
        loading={false}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle("更多操作"));
    fireEvent.click(screen.getByTitle("删除会话"));

    const confirm = screen.getByRole("checkbox", {
      name: /我确认删除这个会话/,
    });
    const deleteButton = screen.getByRole("button", {
      name: "删除会话",
    }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    fireEvent.click(deleteButton);
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(confirm);
    expect(deleteButton.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(deleteButton.disabled).toBe(true);
    fireEvent.click(confirm);
    fireEvent.click(deleteButton);
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledWith("cv_test", "ses_test_1", true);
  });

  it("keeps the typed draft after a failed send", async () => {
    const onSaveDraft = vi.fn().mockResolvedValue({ revision: 1 });
    const onSend = vi.fn().mockRejectedValue(new Error("Hermes unavailable"));
    render(
      <DraftComposer
        conversationId="cv_test"
        initialDraft=""
        initialRevision={0}
        sendShortcut="mod_enter"
        onSaveDraft={onSaveDraft}
        onSend={onSend}
      />,
    );

    const textarea = screen.getByRole("textbox", {
      name: "消息输入框",
    }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Retry this message" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      expect(onSaveDraft).toHaveBeenCalledWith("Retry this message", 0);
      expect(onSend).toHaveBeenCalledWith("Retry this message", 1);
      expect(screen.getByText("Hermes unavailable")).toBeDefined();
    });
    expect(textarea.value).toBe("Retry this message");
  });

  it("does not overwrite newer edits when an older save is acknowledged", async () => {
    vi.useFakeTimers();
    let resolveFirstSave: (value: { revision: number }) => void = () => {};
    let resolveSecondSave: (value: { revision: number }) => void = () => {};
    const firstSave = new Promise<{ revision: number }>((resolve) => {
      resolveFirstSave = resolve;
    });
    const secondSave = new Promise<{ revision: number }>((resolve) => {
      resolveSecondSave = resolve;
    });
    const onSaveDraft = vi
      .fn()
      .mockImplementationOnce(() => firstSave)
      .mockImplementationOnce(() => secondSave);
    const onSend = vi.fn();

    const view = render(
      <DraftComposer
        conversationId="cv_test"
        initialDraft=""
        initialRevision={0}
        sendShortcut="mod_enter"
        onSaveDraft={onSaveDraft}
        onSend={onSend}
      />,
    );
    const textarea = screen.getByRole("textbox", {
      name: "消息输入框",
    }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "A" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onSaveDraft).toHaveBeenCalledWith("A", 0);

    fireEvent.change(textarea, { target: { value: "AB" } });
    await act(async () => {
      resolveFirstSave({ revision: 1 });
    });
    expect(onSaveDraft).toHaveBeenNthCalledWith(2, "AB", 1);

    view.rerender(
      <DraftComposer
        conversationId="cv_test"
        initialDraft="A"
        initialRevision={1}
        sendShortcut="mod_enter"
        onSaveDraft={onSaveDraft}
        onSend={onSend}
      />,
    );
    expect(textarea.value).toBe("AB");
    await act(async () => {
      resolveSecondSave({ revision: 2 });
    });
  });
});
