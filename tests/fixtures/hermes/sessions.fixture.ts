import type {
  HermesSessionDetailResponse,
  HermesSessionListResponse
} from '../../../src/shared/hermes-schemas.js';

export const mockHermesSession1: HermesSessionDetailResponse = {
  id: 'ses_01j9a8b7c6d5e4f3a2b1c0d9e8',
  title: 'Project Setup Discussion',
  pinned: true,
  created_at: '2026-03-30T10:00:00.000Z',
  updated_at: '2026-03-30T10:15:00.000Z',
  last_active_at: '2026-03-30T10:15:00.000Z',
  message_count: 4,
  preview: 'Let us start by setting up the repository structure.',
  model: 'hermes-3-llama-3.1-70b',
  system_prompt: 'You are an expert AI assistant.',
  parent_session_id: null
};

export const mockHermesSession2: HermesSessionDetailResponse = {
  id: 'ses_01j9a8b7c6d5e4f3a2b1c0d9e9',
  title: 'Bugfix in Database Migration',
  pinned: false,
  created_at: '2026-03-30T11:00:00.000Z',
  updated_at: '2026-03-30T11:20:00.000Z',
  last_active_at: '2026-03-30T11:20:00.000Z',
  message_count: 2,
  preview: 'Check the unique constraint on leases table.',
  model: 'hermes-3-llama-3.1-70b',
  system_prompt: 'You are an expert AI assistant.',
  parent_session_id: 'ses_01j9a8b7c6d5e4f3a2b1c0d9e8'
};

export const mockHermesSessionListResponse: HermesSessionListResponse = {
  sessions: [mockHermesSession1, mockHermesSession2],
  total: 2,
  limit: 50,
  offset: 0,
  has_more: false
};
