import { describe, it, expect } from 'vitest';
import { evaluateHermesCapabilities } from '../../src/server/hermes/capabilities.js';
import {
  validCapabilitiesHealthResponse,
  incompatibleMissingEndpointsHealthResponse,
  incompatibleDisabledFeatureHealthResponse,
  incompatibleShortRetentionHealthResponse
} from '../fixtures/hermes/health.fixture.js';

describe('Hermes Capabilities Evaluator', () => {
  it('evaluates fully compliant Hermes instance as healthy', () => {
    const result = evaluateHermesCapabilities(validCapabilitiesHealthResponse);
    expect(result.status).toBe('healthy');
    expect(result.reasons).toEqual([]);
    expect(result.capabilities.run_submission).toBe(true);
    expect(result.capabilities.runs_idempotency).toBe(true);
  });

  it('marks instance as incompatible when endpoints are missing', () => {
    const result = evaluateHermesCapabilities(incompatibleMissingEndpointsHealthResponse);
    expect(result.status).toBe('incompatible');
    expect(result.reasons.some((r) => r.includes('Missing required endpoint'))).toBe(true);
  });

  it('marks instance as incompatible when essential feature is disabled', () => {
    const result = evaluateHermesCapabilities(incompatibleDisabledFeatureHealthResponse);
    expect(result.status).toBe('incompatible');
    expect(result.reasons.some((r) => r.includes('session_fork'))).toBe(true);
  });

  it('marks instance as incompatible when retention is less than 86400s', () => {
    const result = evaluateHermesCapabilities(incompatibleShortRetentionHealthResponse);
    expect(result.status).toBe('incompatible');
    expect(result.reasons.some((r) => r.includes('retention_seconds'))).toBe(true);
  });
});
