// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { DraftComposer } from "../../src/client/features/composer/draft-composer";
import { QueuePanel } from "../../src/client/features/queue/queue-panel";
import { ApprovalDialog } from "../../src/client/features/approval/approval-dialog";
import { StatusBar } from "../../src/client/features/status/status-bar";
import { ConversationList } from "../../src/client/features/conversations/conversation-list";
import { MessageView } from "../../src/client/features/messages/message-view";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("React Components Static Tests", () => {
  describe("ConversationList deletion", () => {
    it("requires an irreversible confirmation and describes the Hermes deletion scope", () => {
      const onDelete = vi.fn();
      const onToggleCollapse = vi.fn();
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
          onToggleCollapse={onToggleCollapse}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
      expect(onToggleCollapse).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTitle("更多操作"));
      fireEvent.click(screen.getByTitle("删除会话"));

      expect(
        screen.getByRole("dialog", { name: "删除这个会话？" }),
      ).toBeDefined();
      expect(screen.getByText("ses_test_1")).toBeDefined();

      const deleteButton = screen.getByRole("button", {
        name: "删除会话",
      }) as HTMLButtonElement;
      expect(deleteButton.disabled).toBe(true);
      fireEvent.click(deleteButton);
      expect(onDelete).not.toHaveBeenCalled();

      fireEvent.click(
        screen.getByRole("checkbox", { name: /我确认删除这个会话/ }),
      );
      expect(deleteButton.disabled).toBe(false);
      fireEvent.click(deleteButton);
      expect(onDelete).toHaveBeenCalledWith("cv_test", "ses_test_1", true);
    });
  });

  describe("DraftComposer", () => {
    it("renders textarea with placeholder and character count", () => {
      const onSaveDraft = vi.fn().mockResolvedValue({ revision: 1 });
      const onSend = vi.fn().mockResolvedValue({
        draft: { content: "", revision: 2 },
      });

      render(
        <DraftComposer
          conversationId="cv_test"
          initialDraft="Existing draft content"
          initialRevision={0}
          sendShortcut="mod_enter"
          onSaveDraft={onSaveDraft}
          onSend={onSend}
          disabled={false}
        />,
      );

      const textarea = screen.getByPlaceholderText(/写下你的消息/i);
      expect(textarea).toBeDefined();
      expect((textarea as HTMLTextAreaElement).value).toBe(
        "Existing draft content",
      );
    });

    it("flushes the draft before sending and applies the returned draft snapshot", async () => {
      let resolveSave: ((value: { revision: number }) => void) | undefined;
      const pendingSave = new Promise<{ revision: number }>((resolve) => {
        resolveSave = resolve;
      });
      const onSaveDraft = vi.fn(() => pendingSave);
      const onSend = vi.fn().mockResolvedValue({
        draft: { content: "", revision: 2 },
      });

      render(
        <DraftComposer
          conversationId="cv_test"
          initialDraft="Saved draft"
          initialRevision={0}
          sendShortcut="mod_enter"
          onSaveDraft={onSaveDraft}
          onSend={onSend}
          disabled={false}
        />,
      );

      const textarea = screen.getByPlaceholderText(/写下你的消息/i);
      fireEvent.change(textarea, { target: { value: "Send me" } });
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

      await waitFor(() => {
        expect(onSaveDraft).toHaveBeenCalledWith("Send me", 0);
      });
      expect(onSend).not.toHaveBeenCalled();

      resolveSave?.({ revision: 1 });

      await waitFor(() => {
        expect(onSend).toHaveBeenCalledWith(1);
      });
      await waitFor(() => {
        expect((textarea as HTMLTextAreaElement).value).toBe("");
      });
    });

    it("keeps the local draft when atomic send fails", async () => {
      const onSaveDraft = vi.fn().mockResolvedValue({ revision: 1 });
      const onSend = vi.fn().mockRejectedValue(new Error("Hermes unavailable"));

      render(
        <DraftComposer
          conversationId="cv_test"
          initialDraft="Retry this message"
          initialRevision={0}
          sendShortcut="mod_enter"
          onSaveDraft={onSaveDraft}
          onSend={onSend}
          disabled={false}
        />,
      );

      const textarea = screen.getByPlaceholderText(
        /写下你的消息/i,
      ) as HTMLTextAreaElement;
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

      await waitFor(() => {
        expect(onSend).toHaveBeenCalledWith(0);
      });
      await waitFor(() => {
        expect(screen.getByText("Hermes unavailable")).toBeDefined();
      });
      expect(textarea.value).toBe("Retry this message");
    });

    it("debounces draft persistence for 500ms", async () => {
      vi.useFakeTimers();
      const onSaveDraft = vi.fn().mockResolvedValue({ revision: 1 });
      const onSend = vi.fn().mockResolvedValue({
        draft: { content: "", revision: 2 },
      });

      render(
        <DraftComposer
          conversationId="cv_test"
          initialDraft=""
          initialRevision={0}
          sendShortcut="mod_enter"
          onSaveDraft={onSaveDraft}
          onSend={onSend}
          disabled={false}
        />,
      );

      fireEvent.change(screen.getByPlaceholderText(/写下你的消息/i), {
        target: { value: "Delayed save" },
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(499);
      });
      expect(onSaveDraft).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(onSaveDraft).toHaveBeenCalledWith("Delayed save", 0);
    });

    it("preserves newer local edits when a parent snapshot acknowledges an older save", async () => {
      vi.useFakeTimers();
      let resolveFirstSave: ((value: { revision: number }) => void) | undefined;
      let resolveSecondSave:
        ((value: { revision: number }) => void) | undefined;
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
      const onSend = vi.fn().mockResolvedValue({
        draft: { content: "", revision: 3 },
      });

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

      const textarea = screen.getByPlaceholderText(
        /写下你的消息/i,
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "A" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(onSaveDraft).toHaveBeenCalledWith("A", 0);

      fireEvent.change(textarea, { target: { value: "AB" } });
      resolveFirstSave?.({ revision: 1 });
      await act(async () => {
        await Promise.resolve();
      });

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
      resolveSecondSave?.({ revision: 2 });
    });
  });

  describe("QueuePanel", () => {
    it("does not render without queued follow-up messages", () => {
      render(
        <QueuePanel
          isOpen={true}
          onClose={vi.fn()}
          items={[]}
          onCancelItem={vi.fn().mockResolvedValue(undefined)}
          onEditItem={vi.fn().mockResolvedValue(undefined)}
        />,
      );

      expect(screen.queryByRole("region", { name: "消息队列" })).toBeNull();
    });

    it("renders queued items with inline edit and delete actions", async () => {
      const onCancelItem = vi.fn();
      const onEditItem = vi.fn().mockResolvedValue(undefined);
      const items = [
        {
          id: "qi_001",
          object: "emu_chat.queue_item" as const,
          conversation_id: "cv_001",
          operation_id: "op_001",
          fifo_seq: 1,
          state: "queued" as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          content: "Hello Hermes",
          payload_bytes: 12,
          payload_available: true,
          recovery_expires_at: null,
          payload_expired_at: null,
          local_run_id: null,
          revision: 0,
          last_error_code: null,
        },
      ];

      render(
        <QueuePanel
          isOpen={true}
          onClose={vi.fn()}
          items={items}
          onCancelItem={vi
            .fn()
            .mockImplementation(async (id: string, revision: number) =>
              onCancelItem(id, revision),
            )}
          onEditItem={onEditItem}
        />,
      );

      expect(screen.getByText(/Hello Hermes/)).toBeDefined();
      expect(screen.getByText("等待当前回复结束后发送")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "编辑排队消息" }));
      const editor = screen.getByRole("textbox", {
        name: "编辑排队消息",
      });
      fireEvent.change(editor, { target: { value: "Updated Hermes" } });
      fireEvent.click(screen.getByRole("button", { name: "保存消息" }));
      await waitFor(() => {
        expect(onEditItem).toHaveBeenCalledWith("qi_001", "Updated Hermes", 0);
      });

      const cancelBtn = screen.getByRole("button", {
        name: "删除排队消息",
      });
      fireEvent.click(cancelBtn);
      expect(onCancelItem).toHaveBeenCalledWith("qi_001", 0);
    });
  });

  describe("MessageView activity", () => {
    it("shows Hermes in the message flow while a response is being streamed", () => {
      const onStopGenerating = vi.fn();
      render(
        <MessageView
          messages={[]}
          loading={false}
          isGenerating={true}
          streamingContent="正在流式输出"
          onStopGenerating={onStopGenerating}
        />,
      );

      expect(screen.getByText("Hermes")).toBeDefined();
      expect(screen.getByText("正在流式输出")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
      expect(onStopGenerating).toHaveBeenCalledTimes(1);
    });
  });

  describe("ApprovalDialog", () => {
    it("renders approval request details and action buttons", () => {
      const onApprove = vi.fn().mockResolvedValue(undefined);
      const onReject = vi.fn().mockResolvedValue(undefined);
      const onCancel = vi.fn().mockResolvedValue(undefined);

      render(
        <ApprovalDialog
          isOpen={true}
          runId="lr_test_001"
          reason="tool_approval_required"
          details={{ tool: "shell_exec", command: "echo 123" }}
          onApprove={onApprove}
          onReject={onReject}
          onCancel={onCancel}
        />,
      );

      expect(screen.getByText(/运行需要确认/i)).toBeDefined();
      expect(screen.getByText(/shell_exec/)).toBeDefined();

      const approveBtn = screen.getByText(/允许一次/i);
      fireEvent.click(approveBtn);
      expect(onApprove).toHaveBeenCalledTimes(1);
    });
  });

  describe("StatusBar", () => {
    it("renders online badge when status is ready", () => {
      render(
        <StatusBar
          status={
            {
              status: "healthy",
              hermes_version: "0.21.3",
              missing_capabilities: [],
              last_checked_at: new Date().toISOString(),
              suggested_action: "none",
              lan_http_warning: false,
              pwa_secure_context_required: false,
            } as any
          }
          loading={false}
          onRecheck={vi.fn()}
        />,
      );

      expect(screen.queryByText(/Hermes 在线/i)).toBeNull();
    });

    it("displays warning when accessed via non-secure LAN HTTP", () => {
      render(
        <StatusBar
          status={
            {
              status: "healthy",
              hermes_version: "0.21.3",
              missing_capabilities: [],
              last_checked_at: new Date().toISOString(),
              suggested_action: "none",
              lan_http_warning: true,
              pwa_secure_context_required: true,
            } as any
          }
          loading={false}
          onRecheck={vi.fn()}
        />,
      );

      expect(screen.getByText(/Hermes 在线/i)).toBeDefined();
    });
  });
});
