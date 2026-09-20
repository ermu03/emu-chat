import { describe, expect, it } from "vitest";
import type {
  QueueItemResponse,
  QueueListResponse,
} from "../../src/shared/api-schemas.js";
import {
  getQueuedFollowUps,
  isAgentGenerating,
} from "../../src/client/features/queue/queue-state.js";

const now = "2026-09-20T14:00:00.000Z";

function queueItem(id: string, sequence: number): QueueItemResponse {
  return {
    object: "emu_chat.queue_item",
    id,
    conversation_id: "cv_queue_state",
    operation_id: `op_${id}`,
    fifo_seq: sequence,
    state: "queued",
    content: `Message ${sequence}`,
    payload_bytes: 9,
    payload_available: true,
    recovery_expires_at: null,
    payload_expired_at: null,
    local_run_id: null,
    revision: 0,
    created_at: now,
    updated_at: now,
    last_error_code: null,
  };
}

function queue(data: QueueItemResponse[]): QueueListResponse {
  return {
    object: "emu_chat.queue",
    conversation_id: "cv_queue_state",
    paused: false,
    pause_reason: null,
    data,
  };
}

describe("queue presentation state", () => {
  it("keeps the first submitted message out of the visible queue", () => {
    const firstMessage = queueItem("qi_first", 1);
    const state = queue([firstMessage]);

    expect(isAgentGenerating(null, state)).toBe(true);
    expect(getQueuedFollowUps(state, null)).toEqual([]);
  });

  it("shows only messages sent after the active submission", () => {
    const firstMessage = queueItem("qi_first", 1);
    const secondMessage = queueItem("qi_second", 2);
    const thirdMessage = queueItem("qi_third", 3);
    const state = queue([firstMessage, secondMessage, thirdMessage]);

    expect(getQueuedFollowUps(state, null).map((item) => item.id)).toEqual([
      "qi_second",
      "qi_third",
    ]);
  });
});
