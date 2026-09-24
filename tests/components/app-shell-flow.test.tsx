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
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "../../src/client/app.js";
import { apiClient } from "../../src/client/api/client.js";
import type {
  ConversationDetailResponse,
  ConversationSummary,
  DraftResponse,
  MessageItem,
  MessageListResponse,
  QueueItemResponse,
  QueueListResponse,
  RunResponse,
} from "../../src/shared/api-schemas.js";

function conversation(id: string, title: string): ConversationSummary {
  return {
    conversation_id: id,
    hermes_session_id: `session_${id}`,
    effective_hermes_session_id: `session_${id}`,
    title,
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
  };
}

function detail(summary: ConversationSummary): ConversationDetailResponse {
  return {
    ...summary,
    parent_session_id: null,
    pause_reason: null,
    current_local_run_id: null,
    delete_failed_reason: null,
  };
}

function draft(
  conversationId: string,
  content = "",
  revision = 0,
): DraftResponse {
  return {
    object: "emu_chat.draft",
    conversation_id: conversationId,
    content,
    revision,
    updated_at: null,
  };
}

function queue(
  conversationId: string,
  data: QueueItemResponse[] = [],
): QueueListResponse {
  return {
    object: "emu_chat.queue",
    conversation_id: conversationId,
    paused: false,
    pause_reason: null,
    data,
  };
}

function message(
  id: number,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
): MessageItem {
  return {
    id,
    session_id: sessionId,
    role,
    content,
    tool_call_id: null,
    tool_name: null,
    timestamp: id,
    token_count: null,
    finish_reason: null,
    reasoning: null,
    display_kind: null,
  };
}

function messageList(
  conversationId: string,
  items: MessageItem[],
): MessageListResponse {
  return {
    items,
    effective_hermes_session_id: `session_${conversationId}`,
    limit: 100,
    offset: 0,
    order: "oldest",
    returned: items.length,
    has_more: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function mockCommonApi(summaries: ConversationSummary[]) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.spyOn(apiClient, "getStatus").mockResolvedValue({
    status: "healthy",
    hermes_version: "0.21",
    missing_capabilities: [],
    last_checked_at: "2026-09-23T00:00:00Z",
    suggested_action: "none",
    lan_http_warning: false,
    pwa_secure_context_required: false,
  });
  vi.spyOn(apiClient, "getPreferences").mockResolvedValue({
    theme: "light",
    sidebar_width: 320,
    send_shortcut: "mod_enter",
    revision: 0,
    updated_at: "2026-09-23T00:00:00Z",
  });
  vi.spyOn(apiClient, "listConversations").mockResolvedValue({
    items: summaries,
    limit: 50,
    offset: 0,
    has_more: false,
  });
  vi.spyOn(apiClient, "getConversation").mockImplementation(async (id) => {
    const summary = summaries.find((item) => item.conversation_id === id);
    if (!summary) throw new Error(`Unknown conversation: ${id}`);
    return detail(summary);
  });
  vi.spyOn(apiClient, "getDraft").mockImplementation(async (id) => draft(id));
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  private listeners = new Map<string, (event: Event) => void>();
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, listener);
  }

  close() {}

  emit(type: string, data: Record<string, unknown>) {
    this.listeners.get(type)?.(
      new MessageEvent(type, { data: JSON.stringify(data) }),
    );
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("AppShell async flows", () => {
  it("restores the cached conversation immediately and ignores a late response from the previous selection", async () => {
    const alpha = conversation("cv_alpha", "Alpha");
    const beta = conversation("cv_beta", "Beta");
    const delayedBeta = deferred<MessageListResponse>();
    const delayedAlphaRefresh = deferred<MessageListResponse>();
    let alphaLoads = 0;
    let betaLoads = 0;
    mockCommonApi([alpha, beta]);
    vi.spyOn(apiClient, "getQueue").mockImplementation(async (id) => queue(id));
    vi.spyOn(apiClient, "listMessages").mockImplementation(async (id) => {
      if (id === beta.conversation_id) {
        betaLoads += 1;
        return delayedBeta.promise;
      }
      alphaLoads += 1;
      return alphaLoads === 1
        ? messageList(id, [
            message(1, "session_cv_alpha", "user", "Alpha message"),
          ])
        : delayedAlphaRefresh.promise;
    });

    render(
      <MemoryRouter initialEntries={["/conversations/cv_alpha"]}>
        <AppShell />
      </MemoryRouter>,
    );
    await screen.findByText("Alpha message");
    await screen.findByRole("textbox", { name: "消息输入框" });

    fireEvent.click(
      screen.getByText("Beta", { selector: ".conversation-title" }),
    );
    await waitFor(() => expect(betaLoads).toBe(1));
    expect(screen.getByText("Alpha message")).toBeDefined();
    expect(screen.getByText(/正在加载「Beta」/)).toBeDefined();

    fireEvent.click(
      screen.getByText("Alpha", { selector: ".conversation-title" }),
    );
    await waitFor(() => expect(alphaLoads).toBe(2));
    expect(screen.getByText("Alpha message")).toBeDefined();
    expect(screen.getByRole("textbox", { name: "消息输入框" })).toBeDefined();

    await act(async () => {
      delayedBeta.resolve(
        messageList(beta.conversation_id, [
          message(2, "session_cv_beta", "user", "Late Beta message"),
        ]),
      );
    });
    expect(screen.queryByText("Late Beta message")).toBeNull();
    expect(screen.getByText("Alpha message")).toBeDefined();
    await act(async () => {
      delayedAlphaRefresh.resolve(
        messageList(alpha.conversation_id, [
          message(1, "session_cv_alpha", "user", "Alpha message"),
        ]),
      );
    });
  });

  it("loads the newest history first and reaches older messages after terminal reconciliation shifts offsets", async () => {
    const summary = conversation("cv_history", "History");
    const other = conversation("cv_other", "Other");
    mockCommonApi([summary, other]);
    vi.stubGlobal("EventSource", FakeEventSource);

    const queueItem: QueueItemResponse = {
      object: "emu_chat.queue_item",
      id: "qi_history",
      conversation_id: summary.conversation_id,
      operation_id: "op_history",
      fifo_seq: 1,
      state: "accepted",
      content: "Message 260",
      payload_bytes: 11,
      payload_available: true,
      recovery_expires_at: null,
      payload_expired_at: null,
      local_run_id: "run_history",
      revision: 1,
      created_at: "2026-09-23T00:00:00Z",
      updated_at: "2026-09-23T00:00:00Z",
      last_error_code: null,
    };
    const liveRun: RunResponse = {
      object: "emu_chat.run",
      id: "run_history",
      conversation_id: summary.conversation_id,
      queue_item_id: queueItem.id,
      hermes_run_id: "upstream_history",
      local_state: "accepted",
      upstream_status: "running",
      partial: false,
      last_event_seq: 0,
      events_truncated: false,
      approval: null,
      last_error_code: null,
      started_at: "2026-09-23T00:00:00Z",
      terminal_at: null,
      updated_at: "2026-09-23T00:00:00Z",
    };
    let currentQueue = queue(summary.conversation_id, [queueItem]);
    let currentRun = liveRun;
    let appendedWhilePaging = false;
    const history = Array.from({ length: 260 }, (_, index) =>
      message(index + 1, "session_cv_history", "user", `Message ${index + 1}`),
    );
    vi.spyOn(apiClient, "getQueue").mockImplementation(async (id) =>
      id === summary.conversation_id ? currentQueue : queue(id),
    );
    vi.spyOn(apiClient, "getRun").mockImplementation(async () => currentRun);
    const listMessages = vi
      .spyOn(apiClient, "listMessages")
      .mockImplementation(async (id, params) => {
        if (id === other.conversation_id) {
          return messageList(id, [
            message(1, "session_cv_other", "user", "Other message"),
          ]);
        }
        if (params?.limit === 101 && !appendedWhilePaging) {
          appendedWhilePaging = true;
          for (let newId = 386; newId <= 395; newId++) {
            history.push(
              message(newId, "session_cv_history", "user", `Message ${newId}`),
            );
          }
        }
        const limit = params?.limit ?? 100;
        const offset = params?.offset ?? 0;
        const order = params?.order ?? "oldest";
        const ordered = order === "latest" ? [...history].reverse() : history;
        const items = ordered.slice(offset, offset + limit);
        return {
          ...messageList(id, items),
          limit,
          offset,
          order,
          returned: items.length,
          has_more: offset + items.length < history.length,
          total: history.length,
        };
      });

    render(
      <MemoryRouter initialEntries={["/conversations/cv_history"]}>
        <AppShell />
      </MemoryRouter>,
    );
    await screen.findByText("Message 260");
    expect(screen.queryByText("Message 1")).toBeNull();
    expect(listMessages).toHaveBeenCalledWith(summary.conversation_id, {
      limit: 100,
      offset: 0,
      order: "latest",
    });
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    for (let id = 261; id <= 385; id++) {
      history.push(message(id, "session_cv_history", "user", `Message ${id}`));
    }
    currentQueue = queue(summary.conversation_id, [
      { ...queueItem, state: "done" },
    ]);
    currentRun = {
      ...liveRun,
      local_state: "reconciled",
      upstream_status: "completed",
    };
    act(() => {
      FakeEventSource.instances[0]!.emit("run.event", {
        local_run_id: liveRun.id,
        local_seq: 1,
        type: "run.completed",
        payload: {},
      });
    });
    await screen.findByText("Message 385");
    expect(screen.getByText("Message 261")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "加载更早历史消息" }));
    await screen.findByText("Message 96");
    expect(screen.queryByText("Message 95")).toBeNull();
    expect(appendedWhilePaging).toBe(true);
    expect(listMessages).toHaveBeenCalledWith(summary.conversation_id, {
      limit: 101,
      offset: 99,
      order: "latest",
    });

    fireEvent.click(
      screen.getByText("Other", { selector: ".conversation-title" }),
    );
    await screen.findByText("Other message");
    fireEvent.click(
      screen.getByText("History", { selector: ".conversation-title" }),
    );
    await screen.findByText("Message 395");
    expect(screen.getByText("Message 96")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "加载更早历史消息" }));
    await screen.findByText("Message 1");
    expect(document.querySelectorAll(".message-row.user")).toHaveLength(395);
    expect(
      screen.queryByRole("button", { name: "加载更早历史消息" }),
    ).toBeNull();
  }, 15_000);

  it("keeps an optimistic send through queue acceptance, then replaces the stream after terminal reconciliation", async () => {
    const summary = conversation("cv_alpha", "Alpha");
    mockCommonApi([summary]);
    vi.stubGlobal("EventSource", FakeEventSource);
    const pendingSend =
      deferred<Awaited<ReturnType<typeof apiClient.sendMessage>>>();
    const queueItem: QueueItemResponse = {
      object: "emu_chat.queue_item",
      id: "qi_1",
      conversation_id: summary.conversation_id,
      operation_id: "op_1",
      fifo_seq: 1,
      state: "accepted",
      content: "Check the design",
      payload_bytes: 16,
      payload_available: true,
      recovery_expires_at: null,
      payload_expired_at: null,
      local_run_id: "run_1",
      revision: 1,
      created_at: "2026-09-23T00:00:00Z",
      updated_at: "2026-09-23T00:00:00Z",
      last_error_code: null,
    };
    const liveRun: RunResponse = {
      object: "emu_chat.run",
      id: "run_1",
      conversation_id: summary.conversation_id,
      queue_item_id: queueItem.id,
      hermes_run_id: "upstream_1",
      local_state: "accepted",
      upstream_status: "running",
      partial: false,
      last_event_seq: 0,
      events_truncated: false,
      approval: null,
      last_error_code: null,
      started_at: "2026-09-23T00:00:00Z",
      terminal_at: null,
      updated_at: "2026-09-23T00:00:00Z",
    };
    let currentQueue = queue(summary.conversation_id);
    let currentRun = liveRun;
    let finalMessages: MessageItem[] = [];
    vi.spyOn(apiClient, "getQueue").mockImplementation(
      async () => currentQueue,
    );
    vi.spyOn(apiClient, "getRun").mockImplementation(async () => currentRun);
    vi.spyOn(apiClient, "listMessages").mockImplementation(async (id) =>
      messageList(id, finalMessages),
    );
    vi.spyOn(apiClient, "putDraft").mockResolvedValue(
      draft(summary.conversation_id, "Check the design", 1),
    );
    vi.spyOn(apiClient, "sendMessage").mockImplementation(
      () => pendingSend.promise,
    );

    render(
      <MemoryRouter initialEntries={["/conversations/cv_alpha"]}>
        <AppShell />
      </MemoryRouter>,
    );
    const input = await screen.findByRole("textbox", { name: "消息输入框" });
    fireEvent.change(input, { target: { value: "Check the design" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(apiClient.sendMessage).toHaveBeenCalledOnce());
    expect(apiClient.putDraft).toHaveBeenCalledWith(summary.conversation_id, {
      content: "Check the design",
      expected_revision: 0,
    });
    expect(apiClient.sendMessage).toHaveBeenCalledWith(
      summary.conversation_id,
      expect.objectContaining({ expected_draft_revision: 1 }),
    );
    expect(
      screen.getByText("Check the design", { selector: ".message-body" }),
    ).toBeDefined();

    currentQueue = queue(summary.conversation_id, [queueItem]);
    await act(async () => {
      pendingSend.resolve({
        object: "emu_chat.message_submission",
        replayed: false,
        queue_item: queueItem,
        draft: draft(summary.conversation_id, "", 2),
      });
    });
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toContain("/runs/run_1/events");

    act(() => {
      source.emit("run.event", {
        local_run_id: "run_1",
        local_seq: 1,
        type: "message.delta",
        payload: { delta: "Streaming answer" },
      });
    });
    expect(screen.getByText("Streaming answer")).toBeDefined();

    currentQueue = queue(summary.conversation_id, [
      { ...queueItem, state: "done" },
    ]);
    currentRun = {
      ...liveRun,
      local_state: "reconciled",
      upstream_status: "completed",
    };
    finalMessages = [
      message(1, "session_cv_alpha", "user", "Check the design"),
      message(2, "session_cv_alpha", "assistant", "Final answer"),
    ];
    act(() => {
      source.emit("run.event", {
        local_run_id: "run_1",
        local_seq: 2,
        type: "run.completed",
        payload: {},
      });
    });
    await screen.findByText("Final answer");
    expect(screen.queryByText("Streaming answer")).toBeNull();
  });
});
