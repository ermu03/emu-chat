/**
 * Edge cases and security fixtures for unit/integration/e2e tests
 * Covered scenarios:
 * 1. XSS payloads
 * 2. Long Markdown & KaTeX rendering
 * 3. SSE events gap & stream reconnection
 * 4. Approval request variants (once, deny)
 * 5. Session rollover
 * 6. Delete confirmation with active agent / 404
 */

export const XSS_FIXTURES = [
  {
    name: 'Script tag in message',
    input: '<script>alert("xss")</script>',
    expectedClean: true,
  },
  {
    name: 'Image onerror attribute',
    input: '<img src="invalid" onerror="alert(1)" />',
    expectedClean: true,
  },
  {
    name: 'Dangerous javascript: URI link',
    input: '[Click me](javascript:alert(document.cookie))',
    expectedClean: true,
  },
  {
    name: 'Nested SVG onload payload',
    input: '<svg><animatetransform onbegin="alert(1)"></animatetransform></svg>',
    expectedClean: true,
  },
];

export const LONG_MARKDOWN_FIXTURE = {
  title: 'Long Markdown with Code and KaTeX',
  content: `
# Deep Research and Analysis

This is a comprehensive document testing virtualized / high-volume markdown rendering.

## Mathematical Formulation
Euler's formula states:
$$e^{i\\pi} + 1 = 0$$

The standard normal distribution probability density function is:
$$f(x) = \\frac{1}{\\sigma \\sqrt{2\\pi}} e^{-\\frac{1}{2}\\left(\\frac{x-\\mu}{\\sigma}\\right)^2}$$

## Large Code Block
\`\`\`typescript
export function computeLargeArray(len: number): number[] {
  const arr = new Array(len);
  for (let i = 0; i < len; i++) {
    arr[i] = Math.sin(i) * Math.cos(i);
  }
  return arr;
}
\`\`\`

` + 'Long paragraph repetition for stress testing buffer and virtual scroll performance. '.repeat(200),
};

export const SSE_STREAM_GAP_FIXTURES = {
  sequenceBeforeGap: [
    { id: 'ev_1', seq: 1, type: 'message.chunk', data: { text: 'Hello ' } },
    { id: 'ev_2', seq: 2, type: 'message.chunk', data: { text: 'world' } },
  ],
  gapEvent: {
    id: 'ev_gap',
    seq: 5,
    type: 'stream.gap',
    data: { missing_from_seq: 3, up_to_seq: 4, reason: 'ring_buffer_evicted' },
  },
  sequenceAfterGap: [
    { id: 'ev_5', seq: 5, type: 'message.completed', data: { finish_reason: 'stop' } },
  ],
};

export const APPROVAL_SCENARIO_FIXTURES = {
  pendingApproval: {
    approval_request_id: 'rq_test_approval_001',
    tool_call_id: 'call_bash_exec_001',
    tool_name: 'bash_exec',
    parameters: {
      command: 'rm -rf /tmp/scratchpad',
    },
    risk_level: 'high',
  },
  approveDecision: {
    decision: 'once' as const,
    reason: 'Verified safe temp directory cleanup',
  },
  denyDecision: {
    decision: 'deny' as const,
    reason: 'Destructive command prohibited',
  },
};

export const SESSION_ROLLOVER_FIXTURES = {
  originalSessionId: 'cv_original_001',
  rolledOverSessionId: 'cv_original_001_s2',
  reason: 'context_window_full',
};

export const DELETE_GUARD_FIXTURES = {
  sessionWithActiveRuns: {
    id: 'cv_active_001',
    active_runs_count: 1,
    expected_status: 409,
    expected_code: 'ACTIVE_RUN_CONFLICT',
  },
  sessionNotFoundUpstream: {
    id: 'cv_missing_001',
    hermes_session_id: 'hermes_missing_999',
    expected_status: 404,
    expected_code: 'CONVERSATION_NOT_FOUND',
  },
};
