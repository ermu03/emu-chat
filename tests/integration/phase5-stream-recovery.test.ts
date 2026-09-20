import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply } from "fastify";
import { FakeHermesServer } from "../fixtures/fake-hermes/fake-hermes-server.js";
import { HermesAdapter } from "../../src/server/hermes/adapter.js";
import { HermesClient } from "../../src/server/hermes/client.js";
import { HermesUnavailableError } from "../../src/server/domain/errors.js";
import { SSEHub } from "../../src/server/sse/sse-hub.js";

function makeReply() {
  const writes: string[] = [];
  const raw = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }),
    on: vi.fn(),
    end: vi.fn(),
  };
  return { reply: { raw } as unknown as FastifyReply, writes };
}

describe("Phase 5 Stream & Recovery Tests", () => {
  let fakeHermes: FakeHermesServer;
  let sseHub: SSEHub;
  let adapter: HermesAdapter;

  beforeEach(async () => {
    fakeHermes = new FakeHermesServer();
    const baseUrl = await fakeHermes.start();
    adapter = new HermesAdapter(
      new HermesClient({ baseUrl, token: "test-token" }),
    );
    sseHub = new SSEHub();
  });

  afterEach(async () => {
    sseHub.close();
    await fakeHermes.close();
  });

  it("Hermes 触发暂停审批时，能够正确接收审批决策并恢复", async () => {
    fakeHermes.pauseNextRun = true;
    const runResult = await adapter.startRun("ses_test_1", {
      prompt: "需要审批的危险指令",
    });
    const waiting = await adapter.getRunStatus(runResult.run_id);

    expect(waiting.status).toBe("waiting_for_approval");
    expect(waiting.approval?.choices).toEqual(["once", "deny"]);

    await adapter.submitApproval(
      runResult.run_id,
      "once",
      waiting.approval?.request_id,
    );
    expect((await adapter.getRunStatus(runResult.run_id)).status).toBe(
      "running",
    );
    fakeHermes.completeApprovalRun(runResult.run_id);
    expect((await adapter.getRunStatus(runResult.run_id)).status).toBe(
      "completed",
    );

    const messages = fakeHermes.getMessages("ses_test_1");
    expect(messages?.length).toBe(4);
    expect(messages?.[messages.length - 1].role).toBe("assistant");
    expect(messages?.[messages.length - 1].content).toMatch(
      /approval completed/i,
    );
  });

  it("SSEHub 在重连时能够从数字 local_seq cursor 重放未接收的事件", () => {
    const conversationId = "cv_recovery_test";

    // 持久化 5 条单调递增的本地 run 事件。
    for (let i = 1; i <= 5; i++) {
      sseHub.publishRunEvent(conversationId, i, "message.delta", {
        delta: `token_${i}`,
      });
    }

    // 客户端已消费 local_seq=2 后重连，只接收 3、4、5。
    const { reply, writes } = makeReply();
    sseHub.subscribe(conversationId, reply, 2);

    const replayFrames = writes.filter((frame) =>
      frame.includes("event: run.event"),
    );
    expect(replayFrames).toHaveLength(3);
    expect(replayFrames[0]).toContain("id: 3");
    expect(replayFrames[1]).toContain("id: 4");
    expect(replayFrames[2]).toContain("id: 5");
  });

  it("Fake Hermes 注入失败时，HTTP adapter 返回可重试上游错误", async () => {
    fakeHermes.failNextRun = true;
    await expect(
      adapter.startRun("ses_test_1", { prompt: "故障测试" }),
    ).rejects.toBeInstanceOf(HermesUnavailableError);
  });
});
