import type { ConnectionStatusResponse } from "../../shared/api-schemas.js";
import type { HermesAdapter } from "../hermes/adapter.js";
import { evaluateHermesCapabilities } from "../hermes/capabilities.js";
import {
  HermesAuthFailedError,
  HermesUnavailableError,
} from "../domain/errors.js";
import { logger } from "../logging.js";

export class StatusService {
  private cachedStatus: ConnectionStatusResponse | null = null;
  private checkedAt = 0;
  private probe: Promise<ConnectionStatusResponse> | null = null;
  private readonly ttlMs = 5000;

  constructor(private readonly hermesAdapter: HermesAdapter) {}

  async getStatus(
    isLanHttp = false,
    force = false,
  ): Promise<ConnectionStatusResponse> {
    const now = Date.now();
    if (!force && this.cachedStatus && now - this.checkedAt < this.ttlMs) {
      return {
        ...this.cachedStatus,
        lan_http_warning: isLanHttp,
        pwa_secure_context_required: isLanHttp,
      };
    }
    if (!this.probe) this.probe = this.performProbe();
    try {
      const status = await this.probe;
      this.cachedStatus = status;
      this.checkedAt = Date.now();
      return {
        ...status,
        lan_http_warning: isLanHttp,
        pwa_secure_context_required: isLanHttp,
      };
    } finally {
      this.probe = null;
    }
  }

  recheck(isLanHttp = false): Promise<ConnectionStatusResponse> {
    return this.getStatus(isLanHttp, true);
  }

  private async performProbe(): Promise<ConnectionStatusResponse> {
    const checked = new Date().toISOString();
    if (!this.hermesAdapter.isConfigured()) {
      return {
        status: "config_error",
        hermes_version: null,
        missing_capabilities: [],
        last_checked_at: checked,
        suggested_action: "check_server_configuration",
        lan_http_warning: false,
        pwa_secure_context_required: false,
      };
    }
    try {
      const health = await this.hermesAdapter.getDetailedHealth();
      const capabilities = evaluateHermesCapabilities(health);
      return {
        status: capabilities.healthy ? "healthy" : "incompatible",
        hermes_version: health.version ?? null,
        missing_capabilities: capabilities.missingCapabilities,
        last_checked_at: checked,
        suggested_action: capabilities.healthy
          ? "none"
          : "upgrade_or_reconfigure_hermes",
        lan_http_warning: false,
        pwa_secure_context_required: false,
      };
    } catch (error) {
      logger.warn("Hermes health probe failed", {
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      const auth = error instanceof HermesAuthFailedError;
      return {
        status: auth
          ? "auth_failed"
          : error instanceof HermesUnavailableError
            ? "unavailable"
            : "degraded",
        hermes_version: null,
        missing_capabilities: [],
        last_checked_at: checked,
        suggested_action: auth
          ? "check_server_configuration"
          : "recheck_connection",
        lan_http_warning: false,
        pwa_secure_context_required: false,
      };
    }
  }
}
