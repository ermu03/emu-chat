import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Download,
  Image as ImageIcon,
  Plus,
  RefreshCw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { MediaAsset } from "../../../shared/media-schemas.js";
import { apiClient } from "../../api/client.js";

export function MediaAssets({
  assets,
  conversationId,
  onReuse,
  onRemove,
  compact = false,
}: {
  assets: MediaAsset[];
  conversationId?: string | null | undefined;
  onReuse?: (asset: MediaAsset) => void;
  onRemove?: (assetId: string) => void;
  compact?: boolean;
}) {
  const [selected, setSelected] = useState<MediaAsset | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryOverrides, setRetryOverrides] = useState<
    Record<string, MediaAsset>
  >({});
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const retryDetailsRef = useRef<{
    assetId: string;
    conversationId: string;
    toolCallId: string;
    deadline: number;
  } | null>(null);
  useEffect(() => {
    setSelected(null);
    setRetrying(null);
    setRetryOverrides({});
    setError(null);
    retryDetailsRef.current = null;
  }, [conversationId]);

  useEffect(() => {
    if (!retrying || !conversationId) return;
    const retry = retryDetailsRef.current;
    if (
      !retry ||
      retry.assetId !== retrying ||
      retry.conversationId !== conversationId
    )
      return;

    let active = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      if (Date.now() >= retry.deadline) {
        retryDetailsRef.current = null;
        setRetrying((current) => (current === retrying ? null : current));
        return;
      }
      inFlight = true;
      try {
        const result = await apiClient.listMediaAssets(conversationId, {
          tool_call_id: retry.toolCallId,
          limit: 16,
        });
        const latest = result.data.find((item) => item.asset_id === retrying);
        if (!active || retryDetailsRef.current !== retry || !latest) return;
        setRetryOverrides((current) => ({ ...current, [retrying]: latest }));
        if (latest.status === "ready" || latest.status === "unavailable") {
          retryDetailsRef.current = null;
          setRetrying((current) => (current === retrying ? null : current));
        }
      } catch {
        // Keep checking until the bounded retry window expires.
      } finally {
        inFlight = false;
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [retrying, conversationId]);

  if (!assets.length) return null;
  return (
    <>
      <div className={`media-assets ${compact ? "compact" : ""}`}>
        {assets.map((sourceAsset) => {
          const asset = retryOverrides[sourceAsset.asset_id] ?? sourceAsset;
          const retryToolCallId =
            asset.source.kind === "tool" ? asset.source.tool_call_id : null;
          return (
            <div className="media-asset" key={asset.asset_id}>
              {asset.status === "ready" ? (
                <button
                  type="button"
                  className="media-asset-open"
                  aria-label={`查看图片 ${asset.file_name}`}
                  onClick={(event) => {
                    triggerRef.current = event.currentTarget;
                    setSelected(asset);
                  }}
                >
                  <img
                    src={asset.content_url}
                    alt={asset.file_name || "图片"}
                    loading="lazy"
                  />
                </button>
              ) : (
                <div className="media-asset-placeholder">
                  <ImageIcon size={18} />
                  <span>
                    {asset.status === "pending"
                      ? "图片保存中"
                      : asset.status === "capture_failed"
                        ? "图片保存失败"
                        : "图片暂不可用"}
                  </span>
                </div>
              )}
              {onRemove && (
                <button
                  type="button"
                  className="media-asset-remove"
                  aria-label={`移除图片 ${asset.file_name}`}
                  onClick={() => onRemove(asset.asset_id)}
                >
                  <X size={13} />
                </button>
              )}
              {asset.status === "capture_failed" &&
                conversationId &&
                retryToolCallId && (
                  <button
                    type="button"
                    className="media-asset-retry"
                    disabled={retrying === asset.asset_id}
                    onClick={() => {
                      retryDetailsRef.current = {
                        assetId: asset.asset_id,
                        conversationId,
                        toolCallId: retryToolCallId,
                        deadline: Date.now() + 90_000,
                      };
                      setRetrying(asset.asset_id);
                      setError(null);
                      void apiClient
                        .retryMediaCapture(conversationId, asset.asset_id)
                        .catch((cause) => {
                          setError(
                            cause instanceof Error ? cause.message : "重试失败",
                          );
                          retryDetailsRef.current = null;
                          setRetrying((current) =>
                            current === asset.asset_id ? null : current,
                          );
                        });
                    }}
                  >
                    <RefreshCw size={13} />
                    重试保存
                  </button>
                )}
            </div>
          );
        })}
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {selected &&
        createPortal(
          <MediaViewer
            asset={selected}
            onClose={() => {
              setSelected(null);
              triggerRef.current?.focus();
            }}
            {...(onReuse ? { onReuse } : {})}
          />,
          document.body,
        )}
    </>
  );
}

function MediaViewer({
  asset,
  onClose,
  onReuse,
}: {
  asset: MediaAsset;
  onClose: () => void;
  onReuse?: (asset: MediaAsset) => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="media-viewer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="media-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={`图片预览 ${asset.file_name}`}
      >
        <header className="media-viewer-toolbar">
          <span>{asset.file_name}</span>
          <div>
            <button
              type="button"
              onClick={() =>
                setZoom((current) => Math.max(0.25, current / 1.25))
              }
              aria-label="缩小图片"
            >
              <ZoomOut size={17} />
            </button>
            <button
              type="button"
              onClick={() => setZoom((current) => Math.min(4, current * 1.25))}
              aria-label="放大图片"
            >
              <ZoomIn size={17} />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <a
              href={asset.content_url}
              download={asset.file_name || "image"}
              aria-label="下载图片"
            >
              <Download size={17} />
            </a>
            {onReuse && (
              <button
                type="button"
                onClick={() => {
                  onReuse(asset);
                  onClose();
                }}
                aria-label="用于下一条消息"
              >
                <Plus size={17} />
                用于下一条消息
              </button>
            )}
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="关闭图片预览"
            >
              <X size={19} />
            </button>
          </div>
        </header>
        <div className="media-viewer-canvas">
          <img
            src={asset.content_url}
            alt={asset.file_name || "图片"}
            style={{ transform: `scale(${zoom})` }}
          />
        </div>
      </div>
    </div>
  );
}
