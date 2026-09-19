import type { ConnectionStatusResponse } from '../../shared/api-schemas.js';
import { HermesAuthFailedError, HermesUnavailableError } from '../domain/errors.js';
import type { HermesAdapter } from '../hermes/adapter.js';
import { evaluateHermesCapabilities } from '../hermes/capabilities.js';
import type { RunRepository } from '../db/repositories/run.repository.js';
import { sanitizedLogger } from '../logging.js';

export class StatusService {
  private cachedStatus: ConnectionStatusResponse | null = null;
  private lastCheckedAt = 0;
  private readonly ttlMs = 5000;

  constructor(
    private readonly hermesAdapter: HermesAdapter,
    private readonly runRepo: RunRepository
  ) {}

  async getStatus(
    isLanHttp = false,
    skipCache = false
  ): Promise<ConnectionStatusResponse> {
    const now = Date.now();
    if (!skipCache && this.cachedStatus && now - this.lastCheckedAt < this.ttlMs) {
      return {
        ...this.cachedStatus,
        lan_http_warning: isLanHttp,
        pwa_secure_context_required: isLanHttp
      };
    }

    let activeRunsCount = 0;
    try {
      // Local active runs count from run repository
      activeRunsCount = this.runRepo.findActiveAll()?.length ?? 0;
    } catch {
      activeRunsCount = 0;
    }

    try {
      const detailed = await this.hermesAdapter.getDetailedHealth();
      const capResult = evaluateHermesCapabilities(detailed);

      const status = capResult.healthy ? 'healthy' : capResult.status;

      const result: ConnectionStatusResponse = {
        status,
        hermes_version: detailed.version,
        capabilities: {
          run_submission: Boolean(detailed.features?.run_submission),
          run_stop: Boolean(detailed.features?.run_stop),
          session_fork: Boolean(detailed.features?.session_fork),
          run_approval: Boolean(detailed.features?.run_approval_response),
          runs_idempotency: Boolean(detailed.features?.runs_idempotency?.supported),
          durable: Boolean(detailed.durable),
          retention_seconds: detailed.retention_seconds ?? 0
        },
        active_runs_count: activeRunsCount,
        lan_http_warning: isLanHttp,
        pwa_secure_context_required: isLanHttp,
        timestamp: new Date().toISOString()
      };

      this.cachedStatus = result;
      this.lastCheckedAt = now;
      return result;
    } catch (err: unknown) {
      sanitizedLogger.warn(`[StatusService] Probe failed: ${(err as Error).message}`);

      let status: 'unreachable' | 'auth_failed' = 'unreachable';
      if (err instanceof HermesAuthFailedError) {
        status = 'auth_failed';
      }

      const result: ConnectionStatusResponse = {
        status,
        capabilities: {
          run_submission: false,
          run_stop: false,
          session_fork: false,
          run_approval: false,
          runs_idempotency: false,
          durable: false,
          retention_seconds: 0
        },
        active_runs_count: activeRunsCount,
        lan_http_warning: isLanHttp,
        pwa_secure_context_required: isLanHttp,
        timestamp: new Date().toISOString()
      };

      this.cachedStatus = result;
      this.lastCheckedAt = now;
      return result;
    }
  }

  async recheck(isLanHttp = false): Promise<ConnectionStatusResponse> {
    return this.getStatus(isLanHttp, true);
  }
}
