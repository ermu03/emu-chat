import { useEffect, useRef, useState } from "react";
import { CircleAlert, Image, LoaderCircle, RefreshCw } from "lucide-react";
import type { ToolCallItem } from "../messages/message-display.js";
import type { MediaAsset } from "../../../shared/media-schemas.js";
import { MediaAssets } from "./media-assets.js";

export function GeneratedImageResult({
  tool,
  generating,
  conversationId,
  onReuse,
  onRefresh,
}: {
  tool: ToolCallItem;
  generating: boolean;
  conversationId?: string | null | undefined;
  onReuse?: ((asset: MediaAsset) => void) | undefined;
  onRefresh?: (() => Promise<void>) | undefined;
}) {
  const assets = tool.attachments ?? [];
  const completed =
    tool.status === "completed" || tool.resultContent !== undefined;
  const waiting =
    !tool.isError &&
    !tool.ambiguous &&
    completed &&
    (!assets.length || assets.some((asset) => asset.status === "pending"));
  const [expired, setExpired] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setRefreshing(false);
    setError(null);
    return () => {
      generation.current += 1;
    };
  }, [conversationId, tool.id]);
  useEffect(() => {
    setExpired(false);
    if (!waiting) return;
    const timer = setTimeout(() => setExpired(true), 90_000);
    return () => clearTimeout(timer);
  }, [waiting, conversationId, tool.id]);

  const refresh = async () => {
    if (!onRefresh || refreshing) return;
    const request = generation.current;
    setRefreshing(true);
    setError(null);
    try {
      await onRefresh();
    } catch (cause) {
      if (request === generation.current)
        setError(cause instanceof Error ? cause.message : "刷新图片结果失败");
    } finally {
      if (request === generation.current) setRefreshing(false);
    }
  };
  const running =
    generating && tool.status === "running" && !tool.ambiguous && !tool.isError;
  const label = tool.isError
    ? "图片生成失败"
    : tool.ambiguous
      ? "等待图片结果核对"
      : running
        ? "正在生成图片"
        : waiting
          ? expired
            ? "图片尚未就绪，请刷新结果核对"
            : "正在保存图片"
          : "等待图片结果核对";

  return (
    <div className="generated-image-result">
      {assets.length ? (
        <MediaAssets
          assets={assets}
          conversationId={conversationId}
          {...(onReuse ? { onReuse } : {})}
          presentation="result"
          pendingExpired={expired}
        />
      ) : (
        <div
          className={`generated-image-placeholder ${tool.isError ? "failed" : ""}`}
          role="status"
        >
          {tool.isError ? (
            <CircleAlert size={26} />
          ) : running || (waiting && !expired) ? (
            <LoaderCircle size={26} className="spin" />
          ) : (
            <Image size={26} />
          )}
          <span>{label}</span>
        </div>
      )}
      {onRefresh &&
        !running &&
        (!assets.length ||
          expired ||
          assets.some(
            (asset) =>
              asset.status === "unavailable" ||
              asset.status === "deleted" ||
              asset.status === "capture_failed",
          )) && (
          <button
            type="button"
            className="generated-image-refresh"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} />
            {refreshing ? "正在核对图片…" : "刷新图片结果"}
          </button>
        )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
