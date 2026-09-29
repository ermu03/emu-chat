import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Download,
  Play,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { downloadArtifact, type Artifact } from "./artifact.js";
import type { ArtifactTab } from "./use-artifact-preview.js";

interface ArtifactPanelProps {
  artifact: Artifact;
  initialTab: ArtifactTab;
  onClose: () => void;
}

// This fixed prelude is parsed before any untrusted element. Meta CSP is
// effective for the srcdoc document, not its later navigations.
const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "manifest-src 'none'",
].join("; ");

function htmlPreviewDocument(source: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">${source}`;
}

export function ArtifactPanel({
  artifact,
  initialTab,
  onClose,
}: ArtifactPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<ArtifactTab>(initialTab);
  const [hasStartedPreview, setHasStartedPreview] = useState(
    initialTab === "preview",
  );
  const [runVersion, setRunVersion] = useState(0);
  const [svgUrl, setSvgUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [background, setBackground] = useState<"grid" | "light" | "dark">(
    "grid",
  );
  const [copied, setCopied] = useState(false);
  const html = useMemo(
    () =>
      artifact.kind === "html" ? htmlPreviewDocument(artifact.source) : "",
    [artifact],
  );

  useEffect(() => {
    if (artifact.kind !== "svg" || !artifact.previewable || !hasStartedPreview)
      return;
    const url = URL.createObjectURL(
      new Blob([artifact.source], { type: "image/svg+xml" }),
    );
    setSvgUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [artifact, hasStartedPreview]);

  const showPreview = () => {
    setHasStartedPreview(true);
    setTab("preview");
  };

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (
        event.key !== "Tab" ||
        !window.matchMedia("(max-width: 1100px)").matches
      )
        return;
      const buttons = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), iframe, [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = buttons[0];
      const last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first && last) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last && first) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(artifact.source);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <aside
      ref={panelRef}
      className="artifact-panel"
      aria-label={`${artifact.title} 成果面板`}
    >
      <header className="artifact-panel-header">
        <div className="artifact-panel-heading">
          <span className="artifact-panel-type">
            {artifact.kind.toUpperCase()}
          </span>
          <strong title={artifact.title}>{artifact.title}</strong>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="artifact-panel-close"
          onClick={onClose}
          aria-label="返回聊天"
          title="关闭成果面板"
        >
          <X size={17} />
        </button>
      </header>
      <div className="artifact-panel-actions">
        <div className="artifact-tabs" role="tablist" aria-label="成果视图">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "preview"}
            disabled={!artifact.previewable}
            onClick={showPreview}
          >
            预览
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "source"}
            onClick={() => setTab("source")}
          >
            源码
          </button>
        </div>
        <div className="artifact-action-buttons">
          {artifact.kind === "html" &&
            artifact.previewable &&
            hasStartedPreview && (
              <button
                type="button"
                onClick={() => setRunVersion((value) => value + 1)}
                title="重新运行 HTML"
                aria-label="重新运行 HTML"
              >
                <Play size={15} />
              </button>
            )}
          <button
            type="button"
            onClick={() => void copySource()}
            title="复制源码"
            aria-label="复制源码"
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
          <button
            type="button"
            onClick={() => downloadArtifact(artifact)}
            title="下载原始文件"
            aria-label="下载成果"
          >
            <Download size={15} />
          </button>
        </div>
      </div>
      <div className="artifact-panel-content">
        {!artifact.previewable && (
          <p className="artifact-panel-warning">
            SVG 结构无效。请让小H输出完整、独立的 SVG；仍可查看源码或下载。
          </p>
        )}
        {artifact.sizingWarning && (
          <p className="artifact-panel-warning">{artifact.sizingWarning}</p>
        )}
        {artifact.kind === "html" &&
          artifact.previewable &&
          hasStartedPreview && (
            <div className="artifact-preview-area" hidden={tab !== "preview"}>
              <iframe
                key={runVersion}
                className="artifact-html-frame"
                title={`${artifact.title} 预览`}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                srcDoc={html}
              />
            </div>
          )}
        {artifact.kind === "svg" &&
          artifact.previewable &&
          hasStartedPreview && (
            <div className="artifact-preview-area" hidden={tab !== "preview"}>
              <div className="artifact-svg-controls">
                <button
                  type="button"
                  onClick={() =>
                    setZoom((value) =>
                      Math.max(0.25, +(value - 0.25).toFixed(2)),
                    )
                  }
                  aria-label="缩小 SVG"
                >
                  <ZoomOut size={15} />
                </button>
                <span>{Math.round(zoom * 100)}%</span>
                <button
                  type="button"
                  onClick={() =>
                    setZoom((value) => Math.min(4, +(value + 0.25).toFixed(2)))
                  }
                  aria-label="放大 SVG"
                >
                  <ZoomIn size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => setZoom(1)}
                  aria-label="适应面板"
                  title="适应面板"
                >
                  <RotateCcw size={15} />
                </button>
                <select
                  value={background}
                  onChange={(event) =>
                    setBackground(event.target.value as typeof background)
                  }
                  aria-label="SVG 预览背景"
                >
                  <option value="grid">透明棋盘格</option>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                </select>
              </div>
              <div className={`artifact-svg-stage background-${background}`}>
                {svgUrl && (
                  <img
                    src={svgUrl}
                    alt={artifact.title}
                    style={{ transform: `scale(${zoom})` }}
                  />
                )}
              </div>
            </div>
          )}
        <div
          className="artifact-source-area"
          hidden={tab !== "source"}
          tabIndex={0}
        >
          <pre>
            <code>{artifact.source}</code>
          </pre>
        </div>
      </div>
      <footer className="artifact-panel-footer">
        {artifact.kind === "html"
          ? "预览阻止普通外部资源与请求，但作品自身跳转仍可能发出网络请求。下载后打开不受面板限制。"
          : "SVG 按图片预览；下载后作为文档打开不受图片环境限制。"}
      </footer>
    </aside>
  );
}
