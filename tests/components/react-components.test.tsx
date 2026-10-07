// @vitest-environment jsdom
import { createRef } from "react";
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
import {
  DraftComposer,
  type DraftComposerHandle,
} from "../../src/client/features/composer/draft-composer";
import { DraftStore } from "../../src/client/state/draft-store.js";
import { apiClient, ApiClientError } from "../../src/client/api/client.js";
import type { MediaAsset } from "../../src/shared/media-schemas.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("high-risk component interactions", () => {
  it("retains a newer empty draft when an older save fails and fences a deleted draft's late acknowledgement", async () => {
    let reject!: (error: Error) => void;
    let resolve!: (value: { revision: number }) => void;
    const failed = new Promise<{ revision: number }>((_resolve, rejectSave) => {
      reject = rejectSave;
    });
    const late = new Promise<{ revision: number }>((resolveSave) => {
      resolve = resolveSave;
    });
    const save = vi
      .fn()
      .mockImplementationOnce(() => failed)
      .mockImplementationOnce(() => late);
    const store = new DraftStore(save);
    const view = render(
      <DraftComposer
        conversationId="cv_clear"
        draftStore={store}
        sendShortcut="enter"
        onSend={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: "消息输入框" });
    fireEvent.change(input, { target: { value: "Old request" } });
    // Leaving starts the old request immediately; returning and clearing records newer intent.
    view.rerender(
      <DraftComposer
        conversationId="cv_other"
        draftStore={store}
        sendShortcut="enter"
        onSend={vi.fn()}
      />,
    );
    view.rerender(
      <DraftComposer
        conversationId="cv_clear"
        draftStore={store}
        sendShortcut="enter"
        onSend={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "消息输入框" }), {
      target: { value: "" },
    });
    await act(async () => reject(new Error("response lost")));
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith("cv_clear", "", [], 0),
    );
    view.unmount();
    store.drop("cv_clear");
    await act(async () => resolve({ revision: 1 }));
    expect(store.has("cv_clear")).toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("keeps failed text and ready attachments beyond view eviction and resolves CAS only on request", async () => {
    const asset: MediaAsset = {
      asset_id: "asset_draft",
      status: "ready",
      source: { kind: "upload", upload_id: "upload_draft" },
      mime_type: "image/png",
      byte_size: 1,
      width: 1,
      height: 1,
      sha256: "a".repeat(64),
      file_name: "draft.png",
      content_url: "/draft.png",
    };
    const conflict = new ApiClientError({
      error: {
        code: "DRAFT_CONFLICT",
        message: "草稿版本冲突",
        retryable: false,
        action: "resolve_conflict",
        request_id: "rq_test",
      },
    });
    const save = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValue({ revision: 8 });
    const store = new DraftStore(save);
    const remote = { content: "Remote input", attachments: [], revision: 7 };
    vi.spyOn(apiClient, "getDraft").mockResolvedValue({
      object: "emu_chat.draft",
      conversation_id: "cv_original",
      ...remote,
      updated_at: null,
    });
    const ref = createRef<DraftComposerHandle>();
    const composer = (id: string) => (
      <DraftComposer
        ref={ref}
        conversationId={id}
        draftStore={store}
        sendShortcut="enter"
        onSend={vi.fn()}
      />
    );
    const view = render(composer("cv_original"));
    act(() => ref.current!.addAsset(asset));
    fireEvent.change(screen.getByRole("textbox", { name: "消息输入框" }), {
      target: { value: "Local input" },
    });
    view.rerender(composer("cv_other"));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    for (let index = 0; index < 15; index++)
      view.rerender(composer(`cv_other_${index}`));
    view.rerender(composer("cv_original"));
    expect(
      (
        screen.getByRole("textbox", {
          name: "消息输入框",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Local input");
    expect(
      screen.getByRole("button", { name: "移除图片 draft.png" }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "核对草稿冲突" }));
    await screen.findByRole("textbox", { name: "服务端草稿" });
    expect(save).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "保留我的草稿" }));
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(
        "cv_original",
        "Local input",
        [{ asset_id: asset.asset_id, sha256: asset.sha256 }],
        7,
      ),
    );
    expect(
      (
        screen.getByRole("textbox", {
          name: "消息输入框",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Local input");
  });

  it("ignores IME confirmation keys while preserving the normal send shortcut", async () => {
    const send = vi.fn().mockRejectedValue(new Error("offline"));
    render(
      <DraftComposer
        conversationId="cv_ime"
        sendShortcut="enter"
        onSaveDraft={vi.fn().mockResolvedValue({ revision: 1 })}
        onSend={send}
      />,
    );
    const input = screen.getByRole("textbox", { name: "消息输入框" });
    fireEvent.change(input, { target: { value: "输入法内容" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledWith("输入法内容", [], 1));
  });

  it("waits for an older save and the empty draft acknowledgement before copying recovery", async () => {
    vi.useFakeTimers();
    let acknowledgeOld!: (value: { revision: number }) => void;
    let acknowledgeClear!: (value: { revision: number }) => void;
    const oldSave = new Promise<{ revision: number }>((resolve) => {
      acknowledgeOld = resolve;
    });
    const clearSave = new Promise<{ revision: number }>((resolve) => {
      acknowledgeClear = resolve;
    });
    const onSaveDraft = vi
      .fn()
      .mockImplementationOnce(() => oldSave)
      .mockImplementationOnce(() => clearSave);
    const copy = vi.fn(async () => ({
      content: "Recovered task",
      attachments: [],
      revision: 3,
    }));
    const ref = createRef<DraftComposerHandle>();
    render(
      <DraftComposer
        ref={ref}
        conversationId="cv_recovery"
        initialDraft=""
        initialRevision={0}
        sendShortcut="mod_enter"
        onSaveDraft={onSaveDraft}
        onSend={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "消息输入框",
    }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Older snapshot" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onSaveDraft).toHaveBeenCalledWith("Older snapshot", [], 0);
    fireEvent.change(input, { target: { value: "" } });
    let restored!: Promise<void>;
    await act(async () => {
      restored = ref.current!.restoreRecovery(copy);
    });
    expect(copy).not.toHaveBeenCalled();
    await act(async () => {
      acknowledgeOld({ revision: 1 });
    });
    expect(onSaveDraft).toHaveBeenLastCalledWith("", [], 1);
    expect(copy).not.toHaveBeenCalled();
    await act(async () => {
      acknowledgeClear({ revision: 2 });
      await restored;
    });
    expect(copy).toHaveBeenCalledWith(2);
    expect(input.value).toBe("Recovered task");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onSaveDraft).toHaveBeenCalledTimes(2);
  });

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
        status={null}
        statusLoading={false}
        statusError={null}
        onRecheckStatus={vi.fn()}
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
      expect(onSaveDraft).toHaveBeenCalledWith("Retry this message", [], 0);
      expect(onSend).toHaveBeenCalledWith("Retry this message", [], 1);
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
    expect(onSaveDraft).toHaveBeenCalledWith("A", [], 0);

    fireEvent.change(textarea, { target: { value: "AB" } });
    await act(async () => {
      resolveFirstSave({ revision: 1 });
    });
    expect(onSaveDraft).toHaveBeenNthCalledWith(2, "AB", [], 1);

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

  it("keeps user edits when a prompt save finishes and another suggestion is clicked", async () => {
    vi.useFakeTimers();
    const composerRef = createRef<DraftComposerHandle>();
    let resolvePromptSave!: (value: { revision: number }) => void;
    const promptSave = new Promise<{ revision: number }>((resolve) => {
      resolvePromptSave = resolve;
    });
    const onSaveDraft = vi
      .fn()
      .mockImplementationOnce(() => promptSave)
      .mockResolvedValueOnce({ revision: 2 });
    const onSend = vi.fn();
    const view = render(
      <DraftComposer
        ref={composerRef}
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

    act(() => composerRef.current!.selectPrompt("建议内容"));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(onSaveDraft).toHaveBeenCalledWith("建议内容", [], 0);

    fireEvent.change(textarea, { target: { value: "建议内容 + 自己补充" } });
    act(() => composerRef.current!.selectPrompt("另一条建议"));
    expect(textarea.value).toBe("建议内容 + 自己补充");
    expect(
      screen.getByText("输入框已有内容，请先清空后再选择建议"),
    ).toBeDefined();

    await act(async () => resolvePromptSave({ revision: 1 }));
    expect(onSaveDraft).toHaveBeenNthCalledWith(
      2,
      "建议内容 + 自己补充",
      [],
      1,
    );
    view.rerender(
      <DraftComposer
        ref={composerRef}
        conversationId="cv_test"
        initialDraft="建议内容"
        initialRevision={1}
        sendShortcut="mod_enter"
        onSaveDraft={onSaveDraft}
        onSend={onSend}
      />,
    );
    expect(textarea.value).toBe("建议内容 + 自己补充");
  });
});
