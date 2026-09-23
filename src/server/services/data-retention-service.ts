import type Database from "better-sqlite3";
import { LIMITS } from "../../shared/limits.js";
import { QueueRepository } from "../db/repositories/queue.repository.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { logger } from "../logging.js";

const CLEANUP_INTERVAL_MS = 60_000;
const CLEANUP_BATCH_SIZE = 100;

/** Removes expired recovery text and old, inactive local control records. */
export class DataRetentionService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly queueRepo: QueueRepository,
  ) {}

  start(): void {
    if (this.timer) return;
    this.runSafely();
    this.timer = setInterval(() => this.runSafely(), CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  runBatch(now = new Date()): {
    expiredPayloads: number;
    deletedControls: number;
  } {
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const terminalCutoff = new Date(
      nowMs - LIMITS.TERMINAL_CONTROL_RETENTION_MS,
    ).toISOString();
    const discardedCutoff = new Date(
      nowMs - LIMITS.DISCARDED_CONTROL_RETENTION_MS,
    ).toISOString();
    return withImmediateTransaction(this.db, () => ({
      expiredPayloads: this.queueRepo.expireRecoveryPayloads(
        nowIso,
        CLEANUP_BATCH_SIZE,
      ),
      deletedControls: this.queueRepo.deleteExpiredControlRecords(
        terminalCutoff,
        discardedCutoff,
        CLEANUP_BATCH_SIZE,
      ),
    }));
  }

  private runSafely(): void {
    try {
      const result = this.runBatch();
      if (result.expiredPayloads > 0 || result.deletedControls > 0) {
        logger.info("Data retention cleanup completed", {
          details: result,
        });
      }
    } catch (error) {
      logger.error("Data retention cleanup failed", {
        details: {
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}
