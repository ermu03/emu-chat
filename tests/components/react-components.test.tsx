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
import { QueueDrawer } from "../../src/client/features/queue/queue-drawer";
import { ApprovalDialog } from "../../src/client/features/approval/approval-dialog";
import { StatusBar } from "../../src/client/features/status/status-bar";
import { ToolCallCard } from "../../src/client/features/tools/tool-call-card";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("React Components Static Tests", () => {
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

      const textarea = screen.getByPlaceholderText(/输入消息/i);
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

      const textarea = screen.getByPlaceholderText(/输入消息/i);
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
        /输入消息/i,
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

      fireEvent.change(screen.getByPlaceholderText(/输入消息/i), {
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
        /输入消息/i,
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

  describe("QueueDrawer", () => {
    it("renders empty placeholder when queue is empty", () => {
      render(
        <QueueDrawer
          isOpen={true}
          onClose={vi.fn()}
          items={[]}
          onCancelItem={vi.fn().mockResolvedValue(undefined)}
        />,
      );

      expect(screen.getByText(/当前没有排队中的消息/i)).toBeDefined();
    });

    it("renders queued items with status and cancel button", () => {
      const onCancelItem = vi.fn();
      const items = [
        {
          id: "qi_001",
          sequence_number: 1,
          status: "queued" as const,
          created_at: new Date().toISOString(),
          content: "Hello Hermes",
        },
      ];

      render(
        <QueueDrawer
          isOpen={true}
          onClose={vi.fn()}
          items={items}
          onCancelItem={vi
            .fn()
            .mockImplementation(async (id: string) => onCancelItem(id))}
        />,
      );

      expect(screen.getByText(/Hello Hermes/)).toBeDefined();
      const cancelBtn = screen.getByText(/取消排队/i);
      fireEvent.click(cancelBtn);
      expect(onCancelItem).toHaveBeenCalledWith("qi_001");
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

      expect(screen.getByText(/运行等待审批确认/i)).toBeDefined();
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

      expect(screen.getByText(/Hermes 在线/i)).toBeDefined();
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

      expect(screen.getByText(/局域网非安全 HTTP 环境/i)).toBeDefined();
    });
  });

  describe("ToolCallCard", () => {
    it("renders tool call name and toggles arguments view", () => {
      render(
        <ToolCallCard
          toolCallId="tc_001"
          name="calculator"
          argumentsText='{"expression":"40 + 2"}'
          status="completed"
          resultText="42"
        />,
      );

      expect(screen.getByText(/工具调用: calculator/i)).toBeDefined();
      expect(screen.getByText(/成功/i)).toBeDefined();
      fireEvent.click(screen.getByText(/工具调用: calculator/i));
      expect(screen.getByText(/输入参数:/i)).toBeDefined();
      expect(screen.getByText("42")).toBeDefined();
    });
  });
});
