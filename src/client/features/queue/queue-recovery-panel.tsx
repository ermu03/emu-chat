import { useState } from "react";
import type {
  QueueItemResponse,
  QueueListResponse,
} from "../../../shared/api-schemas.js";

interface QueueRecoveryPanelProps {
  queue: QueueListResponse;
  item: QueueItemResponse | undefined;
  runActive: boolean;
  onRefreshHistory: () => Promise<void>;
  onResumeQueue: () => Promise<void>;
  onCopyToDraft: () => Promise<void>;
}

const pauseDescriptions: Record<
  NonNullable<QueueListResponse["pause_reason"]>,
  string
> = {
  run_cancelled: "任务已取消，后续队列已暂停。",
  run_failed: "任务执行失败，后续队列已暂停。",
  run_interrupted: "任务已中断，后续队列已暂停。",
  run_partial: "任务只完成了一部分，后续队列已暂停。",
  user_stopped: "你已要求停止，后续队列保持暂停。",
  submission_rejected: "任务提交被拒绝，后续队列已暂停。",
  reconciliation_failed: "任务已结束，但历史尚未核对成功。",
  review_required: "运行结果需要核对，后续队列已暂停。",
  manual_resume_required: "运行提交结果未确认，Hermes 可能已经执行这条消息。",
};

export function QueueRecoveryPanel({
  queue,
  item,
  runActive,
  onRefreshHistory,
  onResumeQueue,
  onCopyToDraft,
}: QueueRecoveryPanelProps) {
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsReview =
    item?.state === "review_required" ||
    queue.pause_reason === "manual_resume_required" ||
    queue.pause_reason === "reconciliation_failed" ||
    queue.pause_reason === "review_required";
  const canRecover = item?.payload_available && item.content !== null;
  const queuedCount = queue.data.filter(
    (entry) => entry.state === "queued",
  ).length;

  const runAction = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admission-review" aria-label="队列暂停与恢复">
      <strong>{needsReview ? "运行结果待核对" : "队列已暂停"}</strong>
      <p>
        {queue.pause_reason
          ? pauseDescriptions[queue.pause_reason]
          : "后续队列已暂停。"}
        {runActive && "当前任务仍在执行或核对，请等待终态确认。"}
      </p>
      <p>
        恢复将继续执行 {queuedCount}{" "}
        条待发消息，不会自动重发原中断项。复制到草稿后重新发送可能重复已有的部分效果。
      </p>
      <div className="admission-review-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => void runAction(onRefreshHistory)}
        >
          刷新历史
        </button>
        {canRecover && (
          <button
            type="button"
            disabled={busy || runActive || (needsReview && !reviewed)}
            onClick={() => void runAction(onCopyToDraft)}
          >
            复制中断项到草稿
          </button>
        )}
      </div>
      {item &&
        (canRecover ? (
          <details>
            <summary>查看待核对正文</summary>
            <pre>{item.content}</pre>
          </details>
        ) : (
          <p>恢复正文已到期或已清除，请以 Hermes 历史为准。</p>
        ))}
      {needsReview && (
        <label className="admission-review-confirm">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(event) => setReviewed(event.target.checked)}
          />
          我已检查 Hermes 历史，了解手动重发可能产生重复消息
        </label>
      )}
      <button
        type="button"
        className="admission-review-resume"
        disabled={busy || runActive || (needsReview && !reviewed)}
        onClick={() => void runAction(onResumeQueue)}
      >
        恢复后续队列
      </button>
      {error && <p className="admission-review-error">{error}</p>}
    </section>
  );
}
