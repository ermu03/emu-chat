import type { HermesMessageListResponse } from "../../../src/shared/hermes-schemas.js";

export const mockHermesMessageListResponse: HermesMessageListResponse = {
  object: "list",
  session_id: "ses_01j9a8b7c6d5e4f3a2b1c0d9e8",
  data: [
    {
      id: 1,
      session_id: "ses_01j9a8b7c6d5e4f3a2b1c0d9e8",
      role: "user",
      content: "Hello Hermes, how are you?",
      timestamp: 1_774_864_000,
      tool_call_id: null,
      tool_name: null,
      token_count: 5,
      finish_reason: null,
      reasoning: null,
      display_kind: null,
    },
    {
      id: 2,
      session_id: "ses_01j9a8b7c6d5e4f3a2b1c0d9e8",
      role: "assistant",
      content: "I am doing well, ready to help you with emu-chat development!",
      timestamp: 1_774_864_005,
      tool_call_id: null,
      tool_name: null,
      token_count: 12,
      finish_reason: "stop",
      reasoning: null,
      display_kind: null,
    },
  ],
  pagination: {
    limit: 50,
    offset: 0,
    order: "oldest",
    returned: 2,
  },
};
