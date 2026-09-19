import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HermesClient } from '../../src/server/hermes/client.js';
import {
  HermesAuthFailedError,
  HermesNotFoundError,
  HermesTemporaryFailureError,
  HermesProtocolError
} from '../../src/server/domain/errors.js';

describe('HermesClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('injects Bearer token, Accept, User-Agent, and never sets X-Hermes-Session-Key', async () => {
    let capturedHeaders: HeadersInit | undefined;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    const client = new HermesClient({
      baseUrl: 'http://127.0.0.1:8642',
      token: 'secret-test-token',
      timeoutMs: 5000
    });

    const data = await client.get('/test');
    expect(data).toEqual({ status: 'ok' });

    const headers = capturedHeaders as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-test-token');
    expect(headers['Accept']).toBe('application/json');
    expect(headers['User-Agent']).toBe('emu-chat/0.1.0');
    expect(headers['X-Hermes-Session-Key']).toBeUndefined();
  });

  it('maps 401 to HermesAuthFailedError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401 })
    );

    const client = new HermesClient({
      baseUrl: 'http://127.0.0.1:8642',
      token: 'bad-token'
    });

    await expect(client.get('/health')).rejects.toThrow(HermesAuthFailedError);
  });

  it('maps 404 to HermesNotFoundError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Not Found', { status: 404 })
    );

    const client = new HermesClient({
      baseUrl: 'http://127.0.0.1:8642',
      token: 'test-token'
    });

    await expect(client.get('/sessions/not-found')).rejects.toThrow(HermesNotFoundError);
  });

  it('maps 503 to HermesTemporaryFailureError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Service Unavailable', { status: 503 })
    );

    const client = new HermesClient({
      baseUrl: 'http://127.0.0.1:8642',
      token: 'test-token'
    });

    await expect(client.get('/health')).rejects.toThrow(HermesTemporaryFailureError);
  });

  it('maps invalid JSON response to HermesProtocolError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<html>Bad Gateway</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      })
    );

    const client = new HermesClient({
      baseUrl: 'http://127.0.0.1:8642',
      token: 'test-token'
    });

    await expect(client.get('/json')).rejects.toThrow(HermesProtocolError);
  });
});
