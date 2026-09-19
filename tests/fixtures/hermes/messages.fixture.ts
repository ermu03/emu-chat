import type { HermesMessageListResponse } from '../../../src/shared/hermes-schemas.js';

export const mockHermesMessageListResponse: HermesMessageListResponse = {
  session_id: 'ses_01j9a8b7c6d5e4f3a2b1c0d9e8',
  messages: [
    {
      id: 'msg_01j9a8b7c6d5e4f30000000001',
      role: 'user',
      content: 'Hello Hermes, how are you?',
      created_at: '2026-03-30T10:00:00.000Z',
      meta: {}
    },
    {
      id: 'msg_01j9a8b7c6d5e4f30000000002',
      role: 'assistant',
      content: 'I am doing well, ready to help you with emu-chat development!',
      created_at: '2026-03-30T10:00:05.000Z',
      meta: {
        model: 'hermes-3-llama-3.1-70b',
        finish_reason: 'stop'
      }
    }
  ],
  total: 2,
  limit: 50,
  offset: 0,
  order: 'oldest',
  has_more: false
};
