import { useState } from "react";
import type { QueueItemResponse } from "../../../shared/api-schemas.js";

interface AdmissionReviewPanelProps {
  item: QueueItemResponse;
  onRefreshHistory: () => Promise<void>;
  onResumeQueue: () => Promise<void>;
}

/** The upstream may have executed this prompt even though admission was not confirmed. */
export function AdmissionReviewPanel({
  item,
  onRefreshHistory,
  onResumeQueue,
}: AdmissionReviewPanelProps) {
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
    <section className="admission-review" aria-label="运行提交待核对">
      <strong>运行提交结果未确认</strong>
      <p>
        Hermes
        可能已经执行这条消息。此会话的后续队列已暂停；请先刷新并检查历史，避免重复发送。
      </p>
      <div className="admission-review-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => void runAction(onRefreshHistory)}
        >
          刷新历史
        </button>
        {item.content !== null && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void runAction(async () => {
                if (!navigator.clipboard?.writeText)
                  throw new Error("浏览器无法复制，请手动选择下方正文");
                await navigator.clipboard.writeText(item.content ?? "");
                setCopied(true);
              })
            }
          >
            {copied ? "已复制原文" : "复制原文"}
          </button>
        )}
      </div>
      {item.content !== null ? (
        <details>
          <summary>查看待核对正文</summary>
          <pre>{item.content}</pre>
        </details>
      ) : (
        <p>恢复正文已到期或已清除，请以 Hermes 历史为准。</p>
      )}
      <label className="admission-review-confirm">
        <input
          type="checkbox"
          checked={reviewed}
          onChange={(event) => setReviewed(event.target.checked)}
        />
        我已检查 Hermes 历史，了解手动重发可能产生重复消息
      </label>
      <button
        type="button"
        className="admission-review-resume"
        disabled={busy || !reviewed}
        onClick={() => void runAction(onResumeQueue)}
      >
        继续后续队列
      </button>
      {error && <p className="admission-review-error">{error}</p>}
    </section>
  );
}
