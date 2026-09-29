import type { Code, Root, RootContent } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { parse as parseHtml } from "parse5";

export type ArtifactKind = "html" | "svg";

export interface Artifact {
  readonly key: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly messageId: number;
  readonly blockIndex: number;
  readonly contentHash: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly filename: string;
  readonly source: string;
  readonly previewable: boolean;
  readonly sizingWarning?: string;
}

export interface ArtifactSource {
  conversationId: string;
  sessionId: string;
  messageId: number;
}

// A larger code block stays a normal Markdown code block instead of creating
// another document parser and runnable browsing context.
export const MAX_ARTIFACT_BYTES = 256 * 1024;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

export function extractArtifacts(
  markdown: string,
  source: ArtifactSource,
): Map<number, Artifact> {
  const artifacts = new Map<number, Artifact>();
  if (!markdown.includes("```") && !markdown.includes("~~~")) return artifacts;
  let blockIndex = 0;
  const tree = parser.parse(markdown) as Root;

  const visit = (node: Root | RootContent) => {
    if (node.type === "code") {
      const index = blockIndex++;
      const code = node as Code;
      const offset = code.position?.start.offset;
      const end = code.position?.end.offset;
      if (
        offset === undefined ||
        end === undefined ||
        !isClosedFence(markdown.slice(offset, end)) ||
        new TextEncoder().encode(code.value).byteLength > MAX_ARTIFACT_BYTES
      )
        return;
      const language = code.lang?.toLowerCase();
      const candidate = classifyArtifact(language, code.value);
      if (!candidate) return;
      const contentHash = hashSource(code.value);
      const title = candidate.title.slice(0, 120);
      artifacts.set(offset, {
        key: `${source.conversationId}:${source.sessionId}:${source.messageId}:${index}:${contentHash}`,
        ...source,
        blockIndex: index,
        contentHash,
        kind: candidate.kind,
        title,
        filename: safeFilename(title, candidate.kind),
        source: code.value,
        previewable: candidate.previewable,
        ...(candidate.sizingWarning
          ? { sizingWarning: candidate.sizingWarning }
          : {}),
      });
    }
    if ("children" in node && Array.isArray(node.children))
      for (const child of node.children) visit(child);
  };
  visit(tree);
  return artifacts;
}

function isClosedFence(segment: string): boolean {
  const lines = segment.trimEnd().split(/\r?\n/);
  if (lines.length < 2) return false;
  const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(lines[0] ?? "");
  if (!opening) return false;
  const fence = opening[1];
  if (!fence) return false;
  const closing = (lines.at(-1) ?? "").trim();
  return (
    closing.length >= fence.length &&
    [...closing].every((char) => char === fence[0])
  );
}

function classifyArtifact(
  language: string | undefined,
  source: string,
): {
  kind: ArtifactKind;
  title: string;
  previewable: boolean;
  sizingWarning?: string;
} | null {
  if (language !== "html" && language !== "svg" && language !== "xml")
    return null;

  // XML parsing is inert. A complete SVG root is required even in an html fence.
  if (
    language === "svg" ||
    language === "xml" ||
    /^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(source)
  ) {
    const svg = parseSvg(source);
    if (svg)
      return {
        kind: "svg",
        title: svg.title,
        previewable: true,
        ...(svg.hasSizing
          ? {}
          : {
              sizingWarning:
                "SVG 缺少有效 viewBox 或宽高，浏览器将使用默认尺寸。",
            }),
      };
    return language === "svg"
      ? { kind: "svg", title: "SVG 图标", previewable: false }
      : null;
  }

  if (language !== "html" || !isCompleteHtml(source)) return null;
  return {
    kind: "html",
    title: parseHtmlTitle(source) || "HTML 成果",
    previewable: true,
  };
}

interface HtmlNode {
  nodeName: string;
  childNodes?: HtmlNode[];
  value?: string;
}

function parseHtmlTitle(source: string): string {
  // parse5 does not create browser elements or start image/frame requests.
  const document = parseHtml(source) as HtmlNode;
  const findHead = (node: HtmlNode): HtmlNode | null => {
    if (node.nodeName === "head") return node;
    for (const child of node.childNodes ?? []) {
      const found = findHead(child);
      if (found) return found;
    }
    return null;
  };
  const title = findHead(document)?.childNodes?.find(
    (child) => child.nodeName === "title",
  );
  return (
    title?.childNodes
      ?.map((child) => child.value ?? "")
      .join("")
      .trim() ?? ""
  );
}

function isCompleteHtml(source: string): boolean {
  return /^\s*(?:<!doctype\s+html(?:\s+[^>]*)?>\s*)?<html(?:\s+[^>]*)?>[\s\S]*<\/html>\s*$/i.test(
    source,
  );
}

function parseSvg(
  source: string,
): { title: string; hasSizing: boolean } | null {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source) || /<\?(?!xml\s)/i.test(source))
    return null;
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = document.documentElement;
  if (
    root.localName !== "svg" ||
    root.namespaceURI !== SVG_NAMESPACE ||
    document.getElementsByTagName("parsererror").length > 0
  )
    return null;
  const title = Array.from(root.children).find(
    (child) =>
      child.localName === "title" && child.namespaceURI === SVG_NAMESPACE,
  );
  const viewBox = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const hasViewBox =
    viewBox?.length === 4 &&
    viewBox.every(Number.isFinite) &&
    (viewBox[2] ?? 0) > 0 &&
    (viewBox[3] ?? 0) > 0;
  const hasDimensions = [
    root.getAttribute("width"),
    root.getAttribute("height"),
  ].every((value) => value !== null && parseFloat(value) > 0);
  return {
    title: title?.textContent?.trim() || "SVG 图标",
    hasSizing: Boolean(hasViewBox || hasDimensions),
  };
}

function safeFilename(title: string, kind: ArtifactKind): string {
  const stem = title
    .replace(/[\\/\x00-\x1f<>:"|?*]+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 80);
  return `${stem || (kind === "html" ? "html-artifact" : "svg-icon")}.${kind}`;
}

function hashSource(source: string): string {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function downloadArtifact(artifact: Artifact): void {
  const url = URL.createObjectURL(
    new Blob([artifact.source], {
      type:
        artifact.kind === "html"
          ? "text/html;charset=utf-8"
          : "image/svg+xml;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = artifact.filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
