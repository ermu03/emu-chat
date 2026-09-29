import type Database from "better-sqlite3";
import { LIMITS } from "../../shared/limits.js";
import { QueueRepository } from "../db/repositories/queue.repository.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { logger } from "../logging.js";
import { enqueueMediaSync, hasLocalMediaReference } from "../media/sync.js";

const CLEANUP_INTERVAL_MS = 60_000;
const CLEANUP_BATCH_SIZE = 100;

/** Removes expired recovery text and old, inactive local control records. */
export class DataRetentionService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly queueRepo: QueueRepository,
    private readonly mediaConfigured = false,
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
    return withImmediateTransaction(this.db, () => {
      if (this.mediaConfigured) this.queueUnboundUploads(nowMs);
      return {
        expiredPayloads: this.queueRepo.expireRecoveryPayloads(
          nowIso,
          CLEANUP_BATCH_SIZE,
        ),
        deletedControls: this.queueRepo.deleteExpiredControlRecords(
          terminalCutoff,
          discardedCutoff,
          CLEANUP_BATCH_SIZE,
        ),
      };
    });
  }

  private queueUnboundUploads(nowMs: number): void {
    const cutoff = new Date(nowMs - 24 * 3600_000).toISOString();
    const candidates = this.db
      .prepare(
        `
      SELECT a.conversation_id,a.asset_id FROM media_assets a
      JOIN conversations c ON c.id=a.conversation_id
      WHERE a.status='ready' AND c.delete_state='none'
        AND json_extract(a.source_json,'$.kind')='upload'
        AND a.created_at<=?
        AND NOT EXISTS (SELECT 1 FROM media_outbox o
          WHERE o.id='orphan_' || a.conversation_id || '_' || a.asset_id)
      ORDER BY a.created_at LIMIT 100
    `,
      )
      .all(cutoff) as { conversation_id: string; asset_id: string }[];
    for (const { conversation_id, asset_id } of candidates) {
      if (hasLocalMediaReference(this.db, conversation_id, asset_id)) continue;
      enqueueMediaSync(
        this.db,
        `orphan_${conversation_id}_${asset_id}`,
        conversation_id,
        "orphan_release",
        { asset_id },
      );
      this.db
        .prepare(
          `UPDATE media_assets SET status='unavailable',updated_at=?
        WHERE conversation_id=? AND asset_id=? AND status='ready'`,
        )
        .run(new Date(nowMs).toISOString(), conversation_id, asset_id);
    }
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
