import { describe, it, expect, beforeEach } from "vitest";
import { FakeHermesServer } from "../fixtures/fake-hermes/fake-hermes-server.js";
import { SSEHub } from "../../src/server/sse/sse-hub.js";

describe("Phase 5 Stream & Recovery Tests", () => {
  let fakeHermes: FakeHermesServer;
  let sseHub: SSEHub;

  beforeEach(() => {
    fakeHermes = new FakeHermesServer();
    sseHub = new SSEHub();
  });

  it("Hermes 触发暂停审批时，能够正确接收审批决策并恢复", async () => {
    fakeHermes.pauseNextRun = true;
    const runResult = fakeHermes.startRun("ses_test_1", "需要审批的危险指令");

    expect(runResult.status).toBe("paused");
    expect(runResult.pause_reason).toBe("tool_approval");
    expect(runResult.pause_metadata?.tool).toBe("shell_exec");

    // 提交批准
    const approveResult = fakeHermes.submitApproval(
      runResult.run_id,
      "approve",
    );
    expect(approveResult.status).toBe("completed");

    // 确认 Hermes 会话消息已被唯一持久化
    const messages = fakeHermes.getMessages("ses_test_1");
    expect(messages?.length).toBe(4);
    expect(messages?.[messages.length - 1].role).toBe("assistant");
    expect(messages?.[messages.length - 1].content).toMatch(
      /approval completed/i,
    );
  });

  it("SSEHub 在重连时能够通过 Last-Event-ID 重放未接收的增量事件", () => {
    const conversationId = "cv_recovery_test";

    // 广播 5 条事件
    for (let i = 1; i <= 5; i++) {
      sseHub.broadcast(conversationId, {
        session_id: "ses_1",
        run_id: "run_1",
        event_id: `evt_${i}`,
        seq: i,
        timestamp: Date.now(),
        type: "chunk",
        data: { text: `token_${i}` },
      });
    }

    // 模拟客户端在 evt_2 断开，重连请求 Last-Event-ID = evt_2
    const missed = sseHub.getMissedEvents(conversationId, "evt_2");
    expect(missed.length).toBe(3);
    expect(missed[0].event_id).toBe("evt_3");
    expect(missed[1].event_id).toBe("evt_4");
    expect(missed[2].event_id).toBe("evt_5");
  });

  it("Fake Hermes 注入失败时，抛出明确错误供上层协调器重试或降级", async () => {
    fakeHermes.failNextRun = true;
    expect(() => {
      fakeHermes.startRun("ses_test_1", "故障测试");
    }).toThrowError(/fake hermes run failure/i);
  });
});
